"""24-hour production performance KPI.

The dashboard card this feeds answers one question: over the last 24 hours, how
much of the time was the plant actually making feed, how fast was it making it,
and how accurately did it dose?

Four things about the source data drive the shape of this module.

1. `BatchMaterials_Shadow` holds one row per MATERIAL, not per batch. A single
   batch of ruminant feed is 14 rows. Tonnage is therefore SUM([Actual Value
   Float]) over a batch's rows -- NOT [Quantity], which is a per-material lot
   size and genuinely varies inside one batch (1000/2000/3000 kg in the same
   premix batch; 6000 and 12000 in the same feed batch). Reading [Quantity] as
   the batch weight overstates a 3 t batch as 12 t.

2. Batches overlap. `[Batch Act Start]` is stamped when the batching system
   releases a batch, so a seven-batch order shows seven starts inside 40
   seconds and seven ends spread over three hours. Summing batch durations
   therefore double-counts badly -- measured concurrency on real days is 2.7x,
   which is why the older OEE code in utils/dashboard_kpi_stream.py has to
   clamp with min(availability, 100) and reads 100% on any busy day. Running
   time has to be the length of the UNION of the intervals.

3. `OutLoading` is not production. It is finished feed leaving on a truck, so
   counting its tonnage alongside the mills would book the same feed twice.
   It is excluded from the headline and reported separately.

4. Rows whose product is literally "Not Selected" are batching-system
   placeholders. Every other KPI endpoint drops them, and they are the source
   of this table's absurd outliers -- the highest apparent rate in the sample
   extract, 18 t/h, is one. The filter below copies the strictest sibling
   (kpi_material_routes.get_reports_product_summary), which also trims
   whitespace and rejects blank product names, rather than the looser one in
   kpi_calendar_routes.

Two attribution rules keep this card consistent with the pages beside it:

  * TONNAGE follows the batch's START, because that is how /api/kpi_calendar
    assigns a batch to a production day. A card that put a batch on a
    different day from the Batch Calendar would be worse than no card.
  * TIME is clipped to the window, so a batch running across the opening edge
    contributes only the part that falls inside it.

That is an agreement about WHICH DAY a batch belongs to, not about totals. The
totals here are deliberately smaller than the calendar's for the same day: this
endpoint excludes OutLoading and blank product names, and books nothing for a
batch that has not finished, while the calendar sums every surviving material
row. Do not "reconcile" the two by removing those rules.

Everything above the route is pure: it takes batch dicts and a window and
returns numbers. That is deliberate -- the SQL Server this queries lives on the
plant network and is unreachable from a dev machine, so the arithmetic is
tested against a captured extract instead
(Backend/scripts/test_production_kpi.py).
"""

from __future__ import annotations

import logging
import math
import os
import re
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, request
from sqlalchemy import text

from config import SQLSERVER_BATCH_MATERIALS_TABLE, SQLSERVER_DATABASE
from models import db
from utils.timezone import (
    BUSINESS_TZ,
    format_db_datetime_utc_iso,
    parse_calendar_range,
    production_day_bounds_utc,
    saudi_local_to_utc_naive,
)

UTC = timezone.utc

logger = logging.getLogger(__name__)

production_kpi_bp = Blueprint("production_kpi", __name__)

# Categories that move existing feed rather than make new feed. Their tonnage
# would be a second booking of tonnage the mills already reported.
NON_PRODUCTION_CATEGORIES = ("OutLoading",)

DEFAULT_WINDOW_HOURS = 24.0

# The client has already been shown a definition of "on target" in writing: the
# Hercules AI page reports Yield as the share of doses inside +/-2%. Reusing
# that tolerance means the two pages cannot disagree about the same batches.
DOSING_TOLERANCE_PCT = float(os.getenv("AI_DOSING_TOLERANCE_PCT", "2.0"))

# A batch with no end timestamp is only believable as "still running" for so
# long; past this it is an abandoned row, not a running mixer.
RUNNING_BATCH_MAX_HOURS = 12

# The rolling path clamps ?hours; a custom range needs the same ceiling, or one
# query string can ask for a decade of GROUP BY and a 262,800-entry hour array.
MAX_WINDOW = timedelta(days=31)

DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


# --------------------------------------------------------------------------
# pure arithmetic
# --------------------------------------------------------------------------


def merge_intervals(intervals):
    """Union of possibly-overlapping (start, end) pairs, in order.

    Overlapping batches are the norm in this plant, not an anomaly, so this is
    what separates "the plant was busy for 16.5 h" from "the batches add up to
    46.6 h" -- which over a 24 h day would be a nonsense 194%.
    """
    ordered = sorted((s, e) for s, e in intervals if e > s)
    merged = []
    for start, end in ordered:
        if merged and start <= merged[-1][1]:
            if end > merged[-1][1]:
                merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    return merged


def _clip(start, end, lo, hi):
    """Intersect (start, end) with (lo, hi), or None when they do not meet."""
    s = max(start, lo)
    e = min(end, hi)
    return (s, e) if e > s else None


def batch_matches_window(start, end, window_start, window_end, lookback):
    """Whether a batch belongs to this window at all.

    This is the single statement of the rule; BATCH_ROLLUP_SQL's WHERE clause
    mirrors it in T-SQL, and the checks in scripts/test_production_kpi.py test
    this rather than restating the SQL. Change one, change both.

    A batch qualifies when it starts before the window closes AND any of:
      * it started inside the window          -- its tonnage is booked here
      * it was still open when the window opened -- it contributes time
      * it has no end and started recently enough to still be running

    The second and third clauses are why a skewed end (end < start, which clock
    drift between batching servers does produce) cannot hide a batch that
    plainly started inside the window.
    """
    if start is None or start >= window_end:
        return False
    if start >= window_start:
        return True
    if end is None:
        return start >= lookback
    return end >= window_start


def compute_production_kpi(
    batches,
    window_start: datetime,
    window_end: datetime,
    now: datetime | None = None,
    non_production_categories: tuple[str, ...] = NON_PRODUCTION_CATEGORIES,
) -> dict:
    """Roll batch-level rows up into the card's numbers.

    Each batch dict carries: guid, start, end (None while running), category,
    product, actual_kg, setpoint_kg, deviation_kg (the sum of per-material
    |actual - setpoint|), on_target_rows, scored_rows.

    Callers pass every batch that OVERLAPS the window; this decides what each
    one contributes.
    """
    # Naive UTC throughout: the SQL Server columns are naive UTC.
    now = now or datetime.now(UTC).replace(tzinfo=None)
    horizon = min(window_end, now)

    production, non_production = [], []
    for b in batches:
        bucket = non_production if b.get("category") in non_production_categories else production
        bucket.append(b)

    def summarise(rows):
        spans = []
        tons = setpoint_kg = deviation_kg = 0.0
        on_target_rows = scored_rows = 0
        completed = running = 0
        first_start = last_end = None
        sum_hours = 0.0

        for b in rows:
            start, end = b.get("start"), b.get("end")
            if start is None:
                continue

            if end is None:
                # Believe a running batch for RUNNING_BATCH_MAX_HOURS from ITS
                # OWN start, not to the end of the window. Extending an
                # abandoned row to the horizon let a single un-ended batch from
                # 30 hours ago paint the whole 24 h as running: 100%
                # efficiency on a payload that also said zero batches.
                effective_end = min(horizon, start + timedelta(hours=RUNNING_BATCH_MAX_HOURS))
            elif end < start:
                # Clock skew between batching servers produces these. A
                # negative duration is not evidence of anything, so the batch
                # keeps its tonnage and loses its time contribution.
                effective_end = start
            else:
                effective_end = end

            # TIME: every overlapping batch contributes, clipped to the window.
            clipped = _clip(start, effective_end, window_start, horizon)
            if clipped:
                spans.append(clipped)
                sum_hours += (clipped[1] - clipped[0]).total_seconds() / 3600.0

            # TONNAGE and counts: only batches that STARTED in the window, so
            # this card and /api/kpi_calendar book the same batch to the same
            # day.
            if not (window_start <= start < window_end):
                continue

            if end is None:
                running += 1
            else:
                completed += 1
                tons += (b.get("actual_kg") or 0.0) / 1000.0
                setpoint_kg += b.get("setpoint_kg") or 0.0
                deviation_kg += b.get("deviation_kg") or 0.0
                on_target_rows += b.get("on_target_rows") or 0
                scored_rows += b.get("scored_rows") or 0
                if last_end is None or end > last_end:
                    last_end = end

            if first_start is None or start < first_start:
                first_start = start

        merged = merge_intervals(spans)
        running_hours = sum((e - s).total_seconds() for s, e in merged) / 3600.0

        return {
            "batches": completed,
            "batches_running": running,
            "tons": round(tons, 3),
            "running_hours": running_hours,
            "sum_batch_hours": sum_hours,
            "concurrency": round(sum_hours / running_hours, 2) if running_hours > 0 else None,
            "first_batch_start": first_start,
            "last_batch_end": last_end,
            "setpoint_kg": round(setpoint_kg, 3),
            "deviation_kg": round(deviation_kg, 3),
            "on_target_rows": on_target_rows,
            "scored_rows": scored_rows,
            "merged_spans": merged,
        }

    prod = summarise(production)
    other = summarise(non_production)

    window_hours = (window_end - window_start).total_seconds() / 3600.0
    elapsed_hours = max((horizon - window_start).total_seconds() / 3600.0, 0.0)

    running_hours = prod["running_hours"]
    idle_hours = max(window_hours - running_hours, 0.0)

    # Measured against the window the user asked for (24 h), not against how
    # much of it has elapsed, so a card refreshed at 09:00 is not reporting a
    # flattering 100%. Called availability, never "utilisation": that word is
    # already spoken for on the Plant 3D KPI strip, where it means silo fill.
    availability_pct = (running_hours / window_hours * 100.0) if window_hours > 0 else 0.0

    throughput_running = (prod["tons"] / running_hours) if running_hours > 0 else 0.0
    throughput_window = (prod["tons"] / window_hours) if window_hours > 0 else 0.0

    # Mass-weighted, so a 0.04 kg vitamin dosed at 0.09 kg cannot swamp a 3 t
    # batch. The per-material relative error has a median of 4.6% and a p90 of
    # 14.8% purely because of micro-ingredients; weighted by mass the same
    # batches sit at 99.2%.
    if prod["setpoint_kg"] > 0:
        dosing_accuracy_pct = max(0.0, 100.0 - prod["deviation_kg"] / prod["setpoint_kg"] * 100.0)
    else:
        dosing_accuracy_pct = None

    on_target_pct = (
        prod["on_target_rows"] / prod["scored_rows"] * 100.0 if prod["scored_rows"] > 0 else None
    )

    return {
        "window": {
            "start": window_start,
            "end": window_end,
            "hours": round(window_hours, 4),
            "elapsed_hours": round(elapsed_hours, 4),
        },
        "batches": prod["batches"],
        "batches_running": prod["batches_running"],
        "tons": prod["tons"],
        "first_batch_start": prod["first_batch_start"],
        "last_batch_end": prod["last_batch_end"],
        "running_hours": round(running_hours, 4),
        "idle_hours": round(idle_hours, 4),
        "availability_pct": round(availability_pct, 2),
        "throughput_tph": round(throughput_running, 3),
        "throughput_window_tph": round(throughput_window, 3),
        "on_target_pct": round(on_target_pct, 2) if on_target_pct is not None else None,
        "on_target_rows": prod["on_target_rows"],
        "scored_rows": prod["scored_rows"],
        "dosing_tolerance_pct": DOSING_TOLERANCE_PCT,
        "dosing_accuracy_pct": (
            round(dosing_accuracy_pct, 2) if dosing_accuracy_pct is not None else None
        ),
        "concurrency": prod["concurrency"],
        "timeline": prod["merged_spans"],
        "by_hour": _tons_by_hour(production, window_start, window_end),
        "non_production": {
            "categories": list(non_production_categories),
            "batches": other["batches"],
            "tons": other["tons"],
        },
    }


def _tons_by_hour(batches, window_start, window_end):
    """Tonnage per hour of the window, bucketed by the hour a batch started.

    Bucketed by start for the same reason tonnage is attributed by start: to
    agree with the calendar. A batch's weight is never split across two hours;
    the batching system reports batches, not a continuous rate.
    """
    # ceil rather than round: rounding a 2.4 h window down to 2 buckets would
    # silently drop every batch in the final 24 minutes.
    total_hours = math.ceil((window_end - window_start).total_seconds() / 3600.0)
    if total_hours <= 0:
        return []
    tons = [0.0] * total_hours
    counts = [0] * total_hours

    for b in batches:
        start, end = b.get("start"), b.get("end")
        if start is None or end is None:
            continue
        if not (window_start <= start < window_end):
            continue
        idx = int((start - window_start).total_seconds() // 3600)
        if 0 <= idx < total_hours:
            tons[idx] += (b.get("actual_kg") or 0.0) / 1000.0
            counts[idx] += 1

    return [
        {
            "hour_start": window_start + timedelta(hours=i),
            "tons": round(tons[i], 3),
            "batches": counts[i],
        }
        for i in range(total_hours)
    ]


# --------------------------------------------------------------------------
# route
# --------------------------------------------------------------------------


# The WHERE clause here is the T-SQL mirror of batch_matches_window() above.
#
# It filters MATERIAL ROWS before GROUP BY, which is only equivalent to
# filtering batches because [Batch Act Start]/[Batch Act End] come from the
# vendor's BatchCopy row and are therefore constant across a batch's materials
# (verified on the captured extract: 0 of 78 batches carry more than one
# distinct value, and the check suite asserts it). Filtering per row is what
# every sibling endpoint does and is what lets an index on [Batch Act Start]
# help; grouping first would mean scanning the table. If that invariant ever
# breaks, this query starts truncating batches rather than excluding them.
#
# The divisor is NULLIF(..., 0) rather than a `WHEN [SetPoint Float] > 0 AND
# ... / [SetPoint Float]` guard: SQL Server does not promise to evaluate the
# two sides of an AND inside one WHEN left to right, so the optimiser is free
# to run the division first and raise "Divide by zero error encountered". With
# NULLIF the division yields NULL, the comparison is not true, and the row
# scores 0 -- which is what a zero setpoint should score anyway, since
# scored_rows already refuses to count it.
BATCH_ROLLUP_SQL = """
    SELECT
        [Batch GUID]                                         AS guid,
        MIN([Batch Act Start])                               AS act_start,
        MAX([Batch Act End])                                 AS act_end,
        MIN([Product Name])                                  AS product,
        MIN([FormulaCategoryName])                           AS category,
        SUM(CAST([Actual Value Float] AS float))             AS actual_kg,
        SUM(CAST([SetPoint Float] AS float))                 AS setpoint_kg,
        SUM(ABS(CAST([Actual Value Float] AS float)
              - CAST([SetPoint Float] AS float)))            AS deviation_kg,
        SUM(CASE WHEN CAST([SetPoint Float] AS float) > 0 THEN 1 ELSE 0 END)
                                                             AS scored_rows,
        SUM(CASE WHEN ABS(CAST([Actual Value Float] AS float)
                        - CAST([SetPoint Float] AS float))
                      / NULLIF(CAST([SetPoint Float] AS float), 0) * 100.0
                      <= :tolerance
                 THEN 1 ELSE 0 END)                          AS on_target_rows,
        COUNT(*)                                             AS material_rows
    FROM [{database}].[dbo].[{table}]
    WHERE LOWER(LTRIM(RTRIM([Product Name]))) <> 'not selected'
      AND [Product Name] IS NOT NULL
      AND LTRIM(RTRIM([Product Name])) <> ''
      AND [Batch Act Start] < :window_end
      AND (
            [Batch Act Start] >= :window_start
         OR [Batch Act End] >= :window_start
         OR ([Batch Act End] IS NULL AND [Batch Act Start] >= :lookback)
          )
    GROUP BY [Batch GUID]
"""


def _resolve_window():
    """Work out the window from the query string.

    ?date=YYYY-MM-DD      that production day, 07:00 AST to 07:00 AST
    ?mode=production_day  the production day in progress right now
    ?startDate=&endDate=  an explicit range, read the way the Batch Calendar
                          reads one
    default               rolling, ending now, ?hours= long (24 by default)

    Raises ValueError for input the caller got wrong; the route turns that into
    a 400.
    """
    date_str = request.args.get("date")
    if date_str:
        # production_day_bounds_utc parses date_str[:10], so it would read
        # "2026-09-10garbage" as a valid day. Be strict about our own input
        # rather than changing a helper the other endpoints share.
        if not DATE_RE.fullmatch(date_str):
            raise ValueError("date must be YYYY-MM-DD")
        start, end = production_day_bounds_utc(date_str)
        return start, end, "production_day"

    mode = (request.args.get("mode") or "").strip().lower()
    if mode == "production_day":
        now_local = datetime.now(BUSINESS_TZ)
        day = now_local.date() if now_local.hour >= 7 else (now_local - timedelta(days=1)).date()
        start = saudi_local_to_utc_naive(day.year, day.month, day.day, 7, 0)
        return start, start + timedelta(days=1), "production_day"

    start_str = request.args.get("startDate")
    end_str = request.args.get("endDate")
    if start_str or end_str:
        if not (start_str and end_str):
            # /kpi_calendar rejects a half-given range rather than quietly
            # ignoring it, and a silently different window is exactly the kind
            # of wrong number this card exists to avoid.
            raise ValueError("startDate and endDate must be given together")
        # parse_calendar_range, not parse_request_datetime: the former reads a
        # naive "2025-03-28T07:00" as Saudi wall time the way the Batch Calendar
        # does, the latter would read it as UTC and land the window three hours
        # off the calendar's for the identical query string.
        start, end = parse_calendar_range(start_str, end_str)
        if end - start > MAX_WINDOW:
            raise ValueError(f"window longer than {MAX_WINDOW.days} days")
        return start, end, "custom"

    # `or DEFAULT` would swallow hours=0, since 0.0 is falsy; every other
    # out-of-range value gets clamped, so that one should too. And a typo is
    # rejected rather than answered with a believable 24 hours the caller did
    # not ask for.
    if "hours" in request.args:
        hours = request.args.get("hours", type=float)
        if hours is None:
            raise ValueError("hours must be a number")
    else:
        hours = DEFAULT_WINDOW_HOURS
    hours = min(max(hours, 1.0), MAX_WINDOW.total_seconds() / 3600.0)
    end = datetime.now(UTC).replace(tzinfo=None)
    return end - timedelta(hours=hours), end, "rolling"


@production_kpi_bp.route("/api/sqlserver/production-kpi", methods=["GET"])
def get_production_kpi():
    try:
        window_start, window_end, mode = _resolve_window()
    except ValueError as exc:
        return jsonify({"success": False, "error": "Invalid window", "message": str(exc)}), 400

    if window_end <= window_start:
        return jsonify({"success": False, "error": "Window ends before it starts"}), 400

    sql = BATCH_ROLLUP_SQL.format(
        database=SQLSERVER_DATABASE, table=SQLSERVER_BATCH_MATERIALS_TABLE
    )
    params = {
        "window_start": window_start,
        "window_end": window_end,
        "lookback": window_start - timedelta(hours=RUNNING_BATCH_MAX_HOURS),
        "tolerance": DOSING_TOLERANCE_PCT,
    }

    try:
        engine = db.get_engine(bind="sqlserver")
        with engine.connect() as conn:
            rows = conn.execute(text(sql), params).mappings().all()
    except Exception as exc:  # pragma: no cover - depends on the plant network
        logger.error("Error fetching production KPI: %s", exc)
        return jsonify(
            {"success": False, "error": "Failed to fetch production KPI", "message": str(exc)}
        ), 500

    # The WHERE clause is meant to be the T-SQL mirror of batch_matches_window.
    # Applying the Python original to what came back keeps that from being a
    # claim in a docstring: if the two ever drift, the Python one wins and the
    # rule the checks exercise is the rule the endpoint enforces.
    lookback = params["lookback"]
    rows = [
        r
        for r in rows
        if batch_matches_window(r["act_start"], r["act_end"], window_start, window_end, lookback)
    ]

    batches = [
        {
            "guid": r["guid"],
            "start": r["act_start"],
            "end": r["act_end"],
            "product": r["product"],
            "category": r["category"],
            "actual_kg": float(r["actual_kg"] or 0.0),
            "setpoint_kg": float(r["setpoint_kg"] or 0.0),
            "deviation_kg": float(r["deviation_kg"] or 0.0),
            "on_target_rows": int(r["on_target_rows"] or 0),
            "scored_rows": int(r["scored_rows"] or 0),
        }
        for r in rows
    ]

    kpi = compute_production_kpi(batches, window_start, window_end)
    return jsonify({"success": True, "mode": mode, **_serialise(kpi)}), 200


def _serialise(kpi: dict) -> dict:
    """Datetimes out as the same UTC ISO strings the rest of the API emits."""
    out = dict(kpi)
    out["window"] = {
        **kpi["window"],
        "start": format_db_datetime_utc_iso(kpi["window"]["start"]),
        "end": format_db_datetime_utc_iso(kpi["window"]["end"]),
    }
    out["first_batch_start"] = format_db_datetime_utc_iso(kpi["first_batch_start"])
    out["last_batch_end"] = format_db_datetime_utc_iso(kpi["last_batch_end"])
    out["timeline"] = [
        {"start": format_db_datetime_utc_iso(s), "end": format_db_datetime_utc_iso(e)}
        for s, e in kpi["timeline"]
    ]
    out["by_hour"] = [
        {**h, "hour_start": format_db_datetime_utc_iso(h["hour_start"])} for h in kpi["by_hour"]
    ]
    return out
