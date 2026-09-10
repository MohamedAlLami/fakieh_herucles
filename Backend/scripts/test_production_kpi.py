"""Executable check for the 24-hour production KPI arithmetic.

Run:  python Backend/scripts/test_production_kpi.py

The SQL Server this KPI reads (DESKTOP-N8PGI9S\\FAKIEH_REPORTING) lives on the
plant network and is not reachable from a dev machine, so the arithmetic is
checked against `fakieh_sql.csv` -- a captured extract of BatchMaterials_Shadow
at the repository root -- rolled up here exactly the way BATCH_ROLLUP_SQL rolls
it up in the database.

Where a number can be checked, it is checked against a SECOND, deliberately
different implementation: running time is verified by sweeping the window
minute by minute and asking "was any batch open?", which shares no code with
the interval merge it is testing.

Exit codes are distinct on purpose:
  0  every check passed
  1  a check failed
  2  the checks could not run (missing extract, bad import) -- NOT a pass
"""

from __future__ import annotations

import csv
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
REPO = os.path.dirname(BACKEND)
sys.path.insert(0, BACKEND)

EXTRACT = os.path.join(REPO, "fakieh_sql.csv")

try:
    from routes.production_kpi import (
        BATCH_ROLLUP_SQL,
        DOSING_TOLERANCE_PCT,
        NON_PRODUCTION_CATEGORIES,
        RUNNING_BATCH_MAX_HOURS,
        batch_matches_window,
        compute_production_kpi,
        merge_intervals,
    )
except Exception as exc:  # pragma: no cover
    print(f"CANNOT RUN: importing routes.production_kpi failed: {exc!r}")
    sys.exit(2)


failures: list[str] = []
checks = 0


def check(label: str, got, want, tol=None):
    global checks
    checks += 1
    if tol is not None:
        ok = got is not None and abs(got - want) <= tol
        detail = f"got {got!r}, want {want!r} (+/-{tol})"
    else:
        ok = got == want
        detail = f"got {got!r}, want {want!r}"
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}: {detail}")
    if not ok:
        failures.append(f"{label}: {detail}")


# ---------------------------------------------------------------- fixtures


def parse_dt(value: str):
    value = (value or "").strip()
    if not value:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    return None


def as_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def load_batches(path: str) -> tuple[list[dict], int]:
    """Roll the material-row extract up to batches, mirroring BATCH_ROLLUP_SQL.

    Including the placeholder filter: the query drops rows whose product is
    "Not Selected" BEFORE grouping, so a batch that carries a mix of real and
    placeholder rows keeps the batch and loses only those rows. The extract
    really does contain such rows, so a loader that skipped this would be
    testing a query we do not run.
    """
    with open(path, encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))

    dropped = 0
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        product = (row["Product Name"] or "").strip()
        # The same three conditions the query applies, in the same order.
        if not product or product.lower() == "not selected":
            dropped += 1
            continue
        grouped[row["Batch GUID"]].append(row)

    batches = []
    for guid, materials in grouped.items():
        setpoint_kg = 0.0
        actual_kg = 0.0
        deviation_kg = 0.0
        on_target = 0
        scored = 0
        starts = [d for d in (parse_dt(m["Batch Act Start"]) for m in materials) if d]
        ends = [d for d in (parse_dt(m["Batch Act End"]) for m in materials) if d]
        distinct_starts = len(set(starts))
        distinct_ends = len(set(ends))
        for m in materials:
            sp = as_float(m["SetPoint Float"]) or 0.0
            av = as_float(m["Actual Value Float"]) or 0.0
            setpoint_kg += sp
            actual_kg += av
            deviation_kg += abs(av - sp)
            if sp > 0:
                scored += 1
                if abs(av - sp) / sp * 100.0 <= DOSING_TOLERANCE_PCT:
                    on_target += 1
        batches.append(
            {
                "guid": guid,
                "distinct_starts": distinct_starts,
                "distinct_ends": distinct_ends,
                # MIN/MAX, as the query does -- not materials[0], which would
                # hide a batch whose material rows disagreed about its times.
                "start": min(starts) if starts else None,
                "end": max(ends) if ends else None,
                "product": min(m["Product Name"] for m in materials),
                "category": min(m["FormulaCategoryName"] for m in materials),
                "actual_kg": actual_kg,
                "setpoint_kg": setpoint_kg,
                "deviation_kg": deviation_kg,
                "on_target_rows": on_target,
                "scored_rows": scored,
            }
        )
    return batches, dropped


def brute_force_running_hours(batches, window_start, window_end, step_seconds=30) -> float:
    """Independent oracle: sweep the window and count the time any batch is open.

    Shares no logic with merge_intervals -- if the merge is wrong, these two
    numbers will not agree.
    """
    spans = [
        (b["start"], b["end"])
        for b in batches
        if b["start"] and b["end"] and b["end"] > b["start"]
    ]
    busy = 0
    step = timedelta(seconds=step_seconds)
    cursor = window_start
    while cursor < window_end:
        if any(s <= cursor < e for s, e in spans):
            busy += step_seconds
        cursor += step
    return busy / 3600.0


# ---------------------------------------------------------------- unit tests


def test_merge_intervals():
    print("\nmerge_intervals")
    d = datetime(2025, 3, 28, 8, 0)
    h = timedelta(hours=1)

    check("disjoint pairs stay separate", len(merge_intervals([(d, d + h), (d + 2 * h, d + 3 * h)])), 2)
    check("overlapping pairs collapse", merge_intervals([(d, d + 2 * h), (d + h, d + 3 * h)]), [(d, d + 3 * h)])
    check("touching pairs collapse", merge_intervals([(d, d + h), (d + h, d + 2 * h)]), [(d, d + 2 * h)])
    check("fully contained is absorbed", merge_intervals([(d, d + 3 * h), (d + h, d + 2 * h)]), [(d, d + 3 * h)])
    check("zero-length is dropped", merge_intervals([(d, d)]), [])
    check("reversed is dropped", merge_intervals([(d + h, d)]), [])
    check("empty input", merge_intervals([]), [])

    # The real shape of this data: seven batches released within a minute,
    # finishing over three hours. Summing durations gives ~14 h; the union is 3.
    starts = [d + timedelta(seconds=i * 6) for i in range(7)]
    ends = [d + timedelta(minutes=40 + i * 20) for i in range(7)]
    merged = merge_intervals(list(zip(starts, ends)))
    union_hours = sum((e - s).total_seconds() for s, e in merged) / 3600.0
    sum_hours = sum((e - s).total_seconds() for s, e in zip(starts, ends)) / 3600.0
    # Seven batches released at once; the last finishes 40 + 6*20 = 160 min in,
    # so the union is that 160 min however the durations are summed.
    check("queued order collapses to one span", len(merged), 1)
    check("union of a queued order", round(union_hours, 3), 160 / 60, tol=0.02)
    check("sum of durations is much larger", sum_hours > 3 * union_hours, True)


def test_window_predicate():
    """Which batches the query should return at all.

    batch_matches_window is the single statement of this rule and
    BATCH_ROLLUP_SQL's WHERE clause mirrors it, so these checks describe the
    intent rather than echoing the SQL text back at itself.
    """
    print("\nwindow predicate")
    ws = datetime(2025, 3, 28, 4, 0)
    we = ws + timedelta(hours=24)
    lookback = ws - timedelta(hours=RUNNING_BATCH_MAX_HOURS)
    m = lambda s, e: batch_matches_window(s, e, ws, we, lookback)  # noqa: E731
    h = timedelta(hours=1)

    check("ordinary batch inside the window", m(ws + h, ws + 2 * h), True)
    check("batch that ended before the window opened", m(ws - 3 * h, ws - 2 * h), False)
    check("batch open across the opening edge", m(ws - h, ws + h), True)
    check("batch open across the closing edge", m(we - h, we + h), True)
    check("batch starting exactly at the close", m(we, we + h), False)
    check("batch starting exactly at the open", m(ws, ws + h), True)
    check("batch entirely after the window", m(we + h, we + 2 * h), False)

    # The case the SQL used to lose: a batch that plainly started inside the
    # window but whose end drifted behind its own start. compute_production_kpi
    # has an explicit branch for this, which is dead code if the query never
    # returns the row.
    check("skewed end, before its own start", m(ws + 4 * h, ws + 3 * h), True)
    check("skewed end, before the window opened", m(ws + 4 * h, ws - h), True)

    # Still-running batches, which the extract contains none of.
    check("running batch started inside the window", m(ws + h, None), True)
    check("running batch started just before the window", m(ws - h, None), True)
    check("running batch older than the lookback is abandoned", m(lookback - h, None), False)
    check("running batch exactly at the lookback edge", m(lookback, None), True)

    check("a batch with no start is not a batch", m(None, ws + h), False)


def test_rollup_sql_shape():
    """The query text cannot be executed here, so assert what it must contain.

    A weak check, but the alternative is zero coverage of a string that decides
    every number on the card. It exists to fail loudly if someone reintroduces
    the guarded-divide or drops the placeholder filter.
    """
    print("\nBATCH_ROLLUP_SQL")
    sql = BATCH_ROLLUP_SQL

    check("divides through NULLIF, not a guarded AND", "NULLIF(CAST([SetPoint Float] AS float), 0)" in sql, True)
    check(
        "no bare guarded divide by [SetPoint Float]",
        "/ CAST([SetPoint Float] AS float)" in sql,
        False,
    )
    check("drops 'Not Selected' placeholder rows", "'not selected'" in sql.lower(), True)
    check("trims before comparing, as the strictest sibling does", "LTRIM(RTRIM([Product Name]))" in sql, True)
    check("rejects null product names explicitly", "[Product Name] IS NOT NULL" in sql, True)
    check("admits batches that started inside the window", "[Batch Act Start] >= :window_start" in sql, True)
    check("admits batches still open at the window edge", "[Batch Act End] >= :window_start" in sql, True)
    check("admits running batches within the lookback", "[Batch Act End] IS NULL" in sql, True)
    check("groups to one row per batch", "GROUP BY [Batch GUID]" in sql, True)

    # Every placeholder must be one the route actually binds.
    supplied = {"window_start", "window_end", "lookback", "tolerance"}
    used = set(re.findall(r":([a-z_]+)", sql))
    check("no unbound placeholders", sorted(used - supplied), [])
    check("no unused bindings", sorted(supplied - used), [])
    check("table and database are the only interpolations", sorted(re.findall(r"\{(\w+)\}", sql)), ["database", "table"])


def test_resolve_window():
    """How the query string becomes a window, including the hostile cases."""
    print("\nwindow resolution")
    try:
        from flask import Flask

        from routes.production_kpi import MAX_WINDOW, _resolve_window
        from utils.timezone import parse_calendar_range
    except Exception as exc:  # pragma: no cover
        print(f"CANNOT RUN: {exc!r}")
        sys.exit(2)

    app = Flask(__name__)

    def resolve(query: str):
        with app.test_request_context(query):
            return _resolve_window()

    start, end, mode = resolve("/?hours=24")
    check("default rolling window is 24 h", round((end - start).total_seconds() / 3600, 3), 24.0)
    check("default mode is rolling", mode, "rolling")

    # 0.0 is falsy, so `hours or DEFAULT` used to hand back 24 h here while
    # every other bad value got clamped.
    start, end, _ = resolve("/?hours=0")
    check("hours=0 clamps to the 1 h floor", round((end - start).total_seconds() / 3600, 3), 1.0)
    start, end, _ = resolve("/?hours=-5")
    check("negative hours clamps to the floor", round((end - start).total_seconds() / 3600, 3), 1.0)
    start, end, _ = resolve("/?hours=1e9")
    check(
        "absurd hours clamps to the ceiling",
        round((end - start).total_seconds() / 3600, 3),
        MAX_WINDOW.total_seconds() / 3600,
    )
    start, end, _ = resolve("/")
    check("no hours at all is 24 h", round((end - start).total_seconds() / 3600, 3), 24.0)

    # The window must land where the Batch Calendar would put it. Reading a
    # naive "07:00" as UTC rather than Saudi wall time put this card three
    # hours away from the calendar for the identical query string.
    q = "startDate=2025-03-28T07:00:00&endDate=2025-03-29T07:00:00"
    start, end, mode = resolve("/?" + q)
    cal_start, cal_end = parse_calendar_range("2025-03-28T07:00:00", "2025-03-29T07:00:00")
    check("custom mode is reported", mode, "custom")
    check("custom start agrees with the Batch Calendar", start, cal_start)
    check("custom end agrees with the Batch Calendar", end, cal_end)

    def raises(query: str) -> bool:
        try:
            resolve(query)
            return False
        except ValueError:
            return True

    check("startDate without endDate is rejected", raises("/?startDate=2025-03-28T07:00:00"), True)
    check("endDate without startDate is rejected", raises("/?endDate=2025-03-29T07:00:00"), True)
    check(
        "an unbounded custom range is rejected",
        raises("/?startDate=2000-01-01T00:00:00&endDate=2030-01-01T00:00:00"),
        True,
    )
    check("an impossible calendar date is rejected", raises("/?date=2026-02-30"), True)
    check("a garbage date is rejected", raises("/?date=garbage"), True)
    # production_day_bounds_utc parses date_str[:10], so this used to slip past.
    check("a date with trailing junk is rejected", raises("/?date=2026-09-10garbage"), True)
    # A typo must not be answered with a believable window nobody asked for.
    check("unparseable hours is rejected", raises("/?hours=abc"), True)

    start, end, mode = resolve("/?date=2025-03-28")
    check("a production day is exactly 24 h", round((end - start).total_seconds() / 3600, 3), 24.0)
    check("a production day reports its mode", mode, "production_day")
    # 07:00 Asia/Riyadh is 04:00 UTC, and the columns are naive UTC.
    check("a production day opens at 07:00 plant time", start.hour, 4)

    _, _, mode = resolve("/?mode=PRODUCTION_DAY")
    check("mode matching is case-insensitive", mode, "production_day")


def test_window_clipping():
    print("\nwindow clipping and in-progress batches")
    ws = datetime(2025, 3, 28, 4, 0)
    we = ws + timedelta(hours=24)

    # Straddles the opening edge: 06:00-08:00 against a window opening 07:00.
    straddle = [
        {
            "guid": "a",
            "start": ws - timedelta(hours=1),
            "end": ws + timedelta(hours=1),
            "category": "FeedMill_Hammer",
            "actual_kg": 3000.0,
            "setpoint_kg": 3000.0,
            "deviation_kg": 0.0,
            "on_target_rows": 10,
            "scored_rows": 10,
        }
    ]
    kpi = compute_production_kpi(straddle, ws, we, now=we)
    check("time before the window is clipped off", kpi["running_hours"], 1.0, tol=0.001)
    check("tonnage follows the start, so this batch is not booked here", kpi["tons"], 0.0)
    check("nor is it counted as one of this window's batches", kpi["batches"], 0)
    check("and it does not set the window's first start", kpi["first_batch_start"], None)

    # Starts inside, still running when the window closes: the mirror image.
    # Its time is clipped at the closing edge, its tonnage is booked whole
    # because that is the day the calendar will book it to.
    overrun = [
        {
            "guid": "a2",
            "start": we - timedelta(hours=1),
            "end": we + timedelta(hours=1),
            "category": "FeedMill_Hammer",
            "actual_kg": 3000.0,
            "setpoint_kg": 3000.0,
            "deviation_kg": 0.0,
            "on_target_rows": 10,
            "scored_rows": 10,
        }
    ]
    kpi = compute_production_kpi(overrun, ws, we, now=we + timedelta(hours=2))
    check("time after the window is clipped off", kpi["running_hours"], 1.0, tol=0.001)
    check("tonnage of a batch that started inside is booked whole", kpi["tons"], 3.0, tol=0.001)
    check("first start is the batch's own start", kpi["first_batch_start"], we - timedelta(hours=1))

    # Still running: books time up to now, but no tonnage.
    now = ws + timedelta(hours=5)
    running = [
        {
            "guid": "b",
            "start": ws + timedelta(hours=3),
            "end": None,
            "category": "FeedMill_Hammer",
            "actual_kg": 3000.0,
            "setpoint_kg": 3000.0,
            "deviation_kg": 0.0,
            "on_target_rows": 10,
            "scored_rows": 10,
        }
    ]
    kpi = compute_production_kpi(running, ws, we, now=now)
    check("a running batch books time to now", kpi["running_hours"], 2.0, tol=0.001)
    check("a running batch books no tonnage", kpi["tons"], 0.0)
    check("a running batch is counted separately", kpi["batches_running"], 1)
    check("a running batch is not a completed batch", kpi["batches"], 0)
    check(
        "availability divides by the full window, not the elapsed part",
        kpi["availability_pct"],
        round(2.0 / 24.0 * 100, 2),
        tol=0.01,
    )

    # end < start, which clock skew between batching servers has produced.
    skewed = [
        {
            "guid": "c",
            "start": ws + timedelta(hours=2),
            "end": ws + timedelta(hours=1),
            "category": "FeedMill_Hammer",
            "actual_kg": 3000.0,
            "setpoint_kg": 3000.0,
            "deviation_kg": 0.0,
            "on_target_rows": 10,
            "scored_rows": 10,
        }
    ]
    kpi = compute_production_kpi(skewed, ws, we, now=we)
    check("a negative duration contributes no time", kpi["running_hours"], 0.0)
    check("a negative duration keeps its tonnage", kpi["tons"], 3.0, tol=0.001)

    # An abandoned row -- no end, started long before the window. Believing it
    # to the window horizon painted the whole 24 h as running: 100% efficiency
    # on a payload that also reported zero batches. It may only be believed for
    # RUNNING_BATCH_MAX_HOURS from its own start.
    now = ws + timedelta(hours=24)
    ghost = [
        {
            "guid": "ghost",
            "start": ws - timedelta(hours=6),
            "end": None,
            "category": "FeedMill_Hammer",
            "actual_kg": 0.0,
            "setpoint_kg": 0.0,
            "deviation_kg": 0.0,
            "on_target_rows": 0,
            "scored_rows": 0,
        }
    ]
    kpi = compute_production_kpi(ghost, ws, we, now=now)
    check(
        "an abandoned batch is believed only to its own cutoff",
        kpi["running_hours"],
        float(RUNNING_BATCH_MAX_HOURS - 6),
        tol=0.001,
    )
    check("an abandoned batch cannot fill the window", kpi["availability_pct"] < 100.0, True)

    # ... while a batch that really is running is unaffected by that cap.
    live = [dict(ghost[0], guid="live", start=now - timedelta(hours=2))]
    kpi = compute_production_kpi(live, ws, we, now=now)
    check("a genuinely running batch keeps its time", kpi["running_hours"], 2.0, tol=0.001)
    check("a genuinely running batch is counted", kpi["batches_running"], 1)

    empty = compute_production_kpi([], ws, we, now=we)
    check("empty window: no divide by zero", empty["throughput_tph"], 0.0)
    check("empty window: availability is zero", empty["availability_pct"], 0.0)
    check("empty window: no on-target rate to report", empty["on_target_pct"], None)
    check("empty window: start is null", empty["first_batch_start"], None)


def test_clock_hour_buckets():
    """Buckets are real clock hours, not offsets from a ragged window start."""
    print("\nhourly buckets")
    # A window opening at 11:38, which is what a rolling 24 h looks like at
    # any moment that is not exactly on the hour.
    ws = datetime(2025, 3, 28, 11, 38)
    we = ws + timedelta(hours=24)
    rows = [
        {
            "guid": "a",
            "start": datetime(2025, 3, 28, 12, 30),
            "end": datetime(2025, 3, 28, 13, 30),
            "category": "FeedMill_Hammer",
            "actual_kg": 3000.0,
            "setpoint_kg": 3000.0,
            "deviation_kg": 0.0,
            "on_target_rows": 10,
            "scored_rows": 10,
        }
    ]
    kpi = compute_production_kpi(rows, ws, we, now=we)
    buckets = kpi["by_hour"]

    check("every bucket starts on the hour", all(h["hour_start"].minute == 0 for h in buckets), True)
    check("every bucket is one hour long",
          all((h["hour_end"] - h["hour_start"]) == timedelta(hours=1) for h in buckets), True)
    check("the first bucket opens on the hour before the window", buckets[0]["hour_start"],
          datetime(2025, 3, 28, 11, 0))
    check("buckets span the ragged window", len(buckets), 25)
    check("no gaps between buckets",
          all(buckets[i]["hour_start"] == buckets[i - 1]["hour_end"] for i in range(1, len(buckets))),
          True)

    holding = [h for h in buckets if h["batches"]]
    check("the batch lands in its own clock hour", len(holding), 1)
    check("which is 12:00, not the window's opening minute", holding[0]["hour_start"],
          datetime(2025, 3, 28, 12, 0))
    check("and the bucket reports when it really started", holding[0]["first_start"],
          datetime(2025, 3, 28, 12, 30))
    check("tonnage still sums to the total", round(sum(h["tons"] for h in buckets), 3), kpi["tons"])

    # A batch outside the window must not be booked to a bucket that overlaps it.
    early = [dict(rows[0], guid="b", start=datetime(2025, 3, 28, 11, 10),
                  end=datetime(2025, 3, 28, 11, 30))]
    kpi2 = compute_production_kpi(early, ws, we, now=we)
    check("a batch before the window is not booked to the overhanging bucket",
          sum(h["batches"] for h in kpi2["by_hour"]), 0)


def test_outloading_excluded():
    print("\nOutLoading is not production")
    ws = datetime(2025, 3, 28, 4, 0)
    we = ws + timedelta(hours=24)
    rows = [
        {
            "guid": "mill",
            "start": ws + timedelta(hours=1),
            "end": ws + timedelta(hours=2),
            "category": "FeedMill_Hammer",
            "actual_kg": 3000.0,
            "setpoint_kg": 3000.0,
            "deviation_kg": 0.0,
            "on_target_rows": 10,
            "scored_rows": 10,
        },
        {
            "guid": "truck",
            "start": ws + timedelta(hours=5),
            "end": ws + timedelta(hours=6),
            "category": "OutLoading",
            "actual_kg": 20000.0,
            "setpoint_kg": 20000.0,
            "deviation_kg": 0.0,
            "on_target_rows": 1,
            "scored_rows": 1,
        },
    ]
    kpi = compute_production_kpi(rows, ws, we, now=we)
    check("outloaded tonnage is not counted as produced", kpi["tons"], 3.0, tol=0.001)
    check("outloading time is not counted as production time", kpi["running_hours"], 1.0, tol=0.001)
    check("outloading is reported separately", kpi["non_production"]["tons"], 20.0, tol=0.001)
    check("outloading batch count is reported", kpi["non_production"]["batches"], 1)
    check("NON_PRODUCTION_CATEGORIES is what we think", NON_PRODUCTION_CATEGORIES, ("OutLoading",))


# ---------------------------------------------------------- real extract


def test_against_real_extract():
    print("\nreal extract: fakieh_sql.csv")
    if not os.path.exists(EXTRACT):
        print(f"CANNOT RUN: extract not found at {EXTRACT}")
        sys.exit(2)

    batches, dropped_placeholders = load_batches(EXTRACT)
    # The extract really does carry placeholder rows, so this filter is load
    # bearing rather than defensive.
    check("the extract contains 'Not Selected' rows to drop", dropped_placeholders > 0, True)

    # BATCH_ROLLUP_SQL filters material rows before GROUP BY, which only equals
    # filtering batches because the timestamps come from the vendor's per-batch
    # row and are constant across a batch's materials. Assert the invariant the
    # query leans on, so a future extract that breaks it fails here.
    mixed = [
        b for b in batches if b["distinct_starts"] > 1 or b["distinct_ends"] > 1
    ]
    check("batch timestamps are constant across material rows", len(mixed), 0)
    print(f"  loaded {len(batches)} batches from the extract")
    if len(batches) < 50:
        print("CANNOT RUN: extract has fewer batches than expected; is it truncated?")
        sys.exit(2)

    # The extract's busiest stretch. Chosen as a plain 24 h window over the
    # naive timestamps so the expected numbers can be derived by hand.
    ws = datetime(2025, 3, 28, 6, 0)
    we = ws + timedelta(hours=24)

    # What the route hands the function: every batch OVERLAPPING the window,
    # which is what BATCH_ROLLUP_SQL selects.
    lookback = ws - timedelta(hours=RUNNING_BATCH_MAX_HOURS)
    overlapping = [
        b for b in batches if batch_matches_window(b["start"], b["end"], ws, we, lookback)
    ]
    started_inside = [b for b in overlapping if ws <= b["start"] < we]
    print(
        f"  {len(overlapping)} batches overlap {ws} .. {we}, "
        f"{len(started_inside)} of them started inside it"
    )
    if not started_inside:
        print("CANNOT RUN: chosen window contains no batches; extract may have changed")
        sys.exit(2)

    kpi = compute_production_kpi(overlapping, ws, we, now=we)

    production_started = [
        b for b in started_inside if b["category"] not in NON_PRODUCTION_CATEGORIES
    ]
    check("batch count is the batches that started in the window", kpi["batches"], len(production_started))

    expected_tons = sum(b["actual_kg"] for b in production_started) / 1000.0
    check("tonnage is the sum of actual dosed weight", kpi["tons"], round(expected_tons, 3), tol=0.002)

    # The independent oracle: time comes from everything overlapping, not just
    # what started inside.
    production_overlapping = [
        b for b in overlapping if b["category"] not in NON_PRODUCTION_CATEGORIES
    ]
    oracle = brute_force_running_hours(production_overlapping, ws, we)
    check("running hours match a minute-by-minute sweep", kpi["running_hours"], oracle, tol=0.02)

    check(
        "availability is running hours over the window",
        kpi["availability_pct"],
        round(kpi["running_hours"] / 24.0 * 100, 2),
        tol=0.02,
    )
    check(
        "idle plus running accounts for the whole window",
        round(kpi["running_hours"] + kpi["idle_hours"], 3),
        24.0,
        tol=0.01,
    )
    check(
        "throughput is tonnage over running hours",
        kpi["throughput_tph"],
        round(kpi["tons"] / kpi["running_hours"], 3),
        tol=0.01,
    )

    # Guard rails: these are the numbers that would embarrass us on a wall
    # display. They are wide on purpose -- they catch nonsense, not drift.
    check("availability is a real percentage", 0.0 <= kpi["availability_pct"] <= 100.0, True)
    check("concurrency is above 1 (batches really do overlap)", kpi["concurrency"] > 1.0, True)
    check("throughput is plausible for this mill (1-30 t/h)", 1.0 <= kpi["throughput_tph"] <= 30.0, True)
    check("on-target rate is a real percentage", 0.0 <= (kpi["on_target_pct"] or 0) <= 100.0, True)
    check("dosing accuracy is a real percentage", 0.0 <= (kpi["dosing_accuracy_pct"] or 0) <= 100.0, True)

    # The bug this module exists to avoid: using sum-of-durations as busy time.
    naive_pct = sum(
        (b["end"] - b["start"]).total_seconds()
        for b in production_overlapping
        if b["end"]
    ) / 3600.0 / 24.0 * 100.0
    check("the naive sum-of-durations really would exceed 100%", naive_pct > 100.0, True)
    check("the merged figure does not", kpi["availability_pct"] < 100.0, True)

    # The other bug: reading [Quantity] as the batch weight.
    check("hourly buckets cover the window", len(kpi["by_hour"]), 24)
    check(
        "hourly tonnage sums to the total",
        round(sum(h["tons"] for h in kpi["by_hour"]), 2),
        round(kpi["tons"], 2),
        tol=0.02,
    )
    check(
        "timeline spans sum to the running hours",
        round(sum((e - s).total_seconds() for s, e in kpi["timeline"]) / 3600.0, 3),
        kpi["running_hours"],
        tol=0.002,
    )

    print(
        f"\n  window {ws:%Y-%m-%d %H:%M} .. {we:%H:%M}\n"
        f"    batches           {kpi['batches']}\n"
        f"    tonnage           {kpi['tons']:.2f} t\n"
        f"    running           {kpi['running_hours']:.2f} h   idle {kpi['idle_hours']:.2f} h\n"
        f"    availability      {kpi['availability_pct']:.1f} %\n"
        f"    throughput        {kpi['throughput_tph']:.2f} t/h running, "
        f"{kpi['throughput_window_tph']:.2f} t/h over the window\n"
        f"    on target (+/-{kpi['dosing_tolerance_pct']}%)  {kpi['on_target_pct']}%\n"
        f"    dosing accuracy   {kpi['dosing_accuracy_pct']}%\n"
        f"    concurrency       {kpi['concurrency']}x\n"
        f"    outloading        {kpi['non_production']['tons']:.2f} t (excluded)"
    )


def main():
    print("production KPI checks")
    test_merge_intervals()
    test_window_predicate()
    test_rollup_sql_shape()
    test_resolve_window()
    test_window_clipping()
    test_clock_hour_buckets()
    test_outloading_excluded()
    test_against_real_extract()

    print(f"\n{checks - len(failures)}/{checks} checks passed")
    if failures:
        print("\nFAILURES:")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        # A permission error or a malformed extract is "could not run", which
        # must not share an exit code with "a check failed".
        print(f"CANNOT RUN: {exc!r}")
        sys.exit(2)
