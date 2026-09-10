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
        DOSING_TOLERANCE_PCT,
        NON_PRODUCTION_CATEGORIES,
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


def load_batches(path: str) -> list[dict]:
    """Roll the material-row extract up to batches, mirroring BATCH_ROLLUP_SQL."""
    with open(path, encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))

    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        grouped[row["Batch GUID"]].append(row)

    batches = []
    for guid, materials in grouped.items():
        setpoint_kg = 0.0
        actual_kg = 0.0
        deviation_kg = 0.0
        on_target = 0
        scored = 0
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
                "start": parse_dt(materials[0]["Batch Act Start"]),
                "end": parse_dt(materials[0]["Batch Act End"]),
                "product": materials[0]["Product Name"],
                "category": materials[0]["FormulaCategoryName"],
                "actual_kg": actual_kg,
                "setpoint_kg": setpoint_kg,
                "deviation_kg": deviation_kg,
                "on_target_rows": on_target,
                "scored_rows": scored,
            }
        )
    return batches


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

    empty = compute_production_kpi([], ws, we, now=we)
    check("empty window: no divide by zero", empty["throughput_tph"], 0.0)
    check("empty window: availability is zero", empty["availability_pct"], 0.0)
    check("empty window: no on-target rate to report", empty["on_target_pct"], None)
    check("empty window: start is null", empty["first_batch_start"], None)


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

    batches = load_batches(EXTRACT)
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
    overlapping = [
        b
        for b in batches
        if b["start"] and b["start"] < we and (b["end"] is None or b["end"] >= ws)
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
    test_window_clipping()
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
    main()
