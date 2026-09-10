"""Pre-flight for the 24-hour production KPI, to be run ON THE PLANT SERVER.

    python Backend/scripts/preflight_production_kpi.py

Run this AFTER copying routes/production_kpi.py across and BEFORE restarting
Flask. It answers, in order, the two questions that matter:

  1. Does the new module import here?  app.py imports it at start-up, so an
     ImportError does not just disable this one card -- it stops the whole
     backend from booting and takes the working dashboard down with it. The
     likely cause is an older utils/timezone.py on this machine that predates
     one of the helpers the module needs.

  2. Does the query actually run against this database?  The SQL Server is on
     the plant network and unreachable from any development machine, so this
     query has never executed anywhere else. This runs it read-only, for the
     last 24 hours, and prints either the shape of what came back or the
     driver's own words.

Nothing here writes: one SELECT, no app context, no Flask.

Exit codes:
  0  imports fine and the query ran
  1  imports fine but the query failed -- the message is the finding
  2  could not even get that far (bad import, missing driver, no config)
"""

from __future__ import annotations

import os
import sys
import traceback
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
sys.path.insert(0, BACKEND)

UTC = timezone.utc


def heading(text):
    print(f"\n{text}\n{'-' * len(text)}")


# ---------------------------------------------------------------- 1. imports
heading("1. imports")

REQUIRED_TZ_HELPERS = (
    "BUSINESS_TZ",
    "format_db_datetime_utc_iso",
    "parse_calendar_range",
    "production_day_bounds_utc",
    "saudi_local_to_utc_naive",
)

try:
    import utils.timezone as tz
except Exception as exc:
    print(f"  CANNOT RUN: utils.timezone will not import: {exc!r}")
    sys.exit(2)

missing = [name for name in REQUIRED_TZ_HELPERS if not hasattr(tz, name)]
for name in REQUIRED_TZ_HELPERS:
    print(f"  {'ok  ' if hasattr(tz, name) else 'MISSING'}  utils.timezone.{name}")

if missing:
    print(
        f"\n  CANNOT RUN: utils/timezone.py on this machine is missing {', '.join(missing)}.\n"
        "  Copy the newer utils/timezone.py across as well, or the backend will\n"
        "  fail to start once app.py imports routes/production_kpi.py."
    )
    sys.exit(2)

try:
    from config import SQLSERVER_BATCH_MATERIALS_TABLE, SQLSERVER_DATABASE
    from routes.production_kpi import (
        BATCH_ROLLUP_SQL,
        DOSING_TOLERANCE_PCT,
        RUNNING_BATCH_MAX_HOURS,
        compute_production_kpi,
    )
except Exception as exc:
    print(f"  CANNOT RUN: {exc!r}")
    traceback.print_exc()
    sys.exit(2)

print("  ok    routes.production_kpi imports")
print(f"  ok    target: [{SQLSERVER_DATABASE}].[dbo].[{SQLSERVER_BATCH_MATERIALS_TABLE}]")

# ---------------------------------------------------------------- 2. the query
heading("2. the query, against this database")

try:
    from sqlalchemy import create_engine, text

    from config import SQLSERVER_ODBC_CONNECT
except Exception as exc:
    print(f"  CANNOT RUN: {exc!r}")
    sys.exit(2)

from urllib.parse import quote_plus  # noqa: E402

url = f"mssql+pyodbc:///?odbc_connect={quote_plus(SQLSERVER_ODBC_CONNECT)}"
now = datetime.now(UTC).replace(tzinfo=None)
window_start, window_end = now - timedelta(hours=24), now

sql = BATCH_ROLLUP_SQL.format(
    database=SQLSERVER_DATABASE, table=SQLSERVER_BATCH_MATERIALS_TABLE
)
params = {
    "window_start": window_start,
    "window_end": window_end,
    "lookback": window_start - timedelta(hours=RUNNING_BATCH_MAX_HOURS),
    "tolerance": DOSING_TOLERANCE_PCT,
}

print(f"  window {window_start:%Y-%m-%d %H:%M} .. {window_end:%Y-%m-%d %H:%M} UTC")

try:
    engine = create_engine(url)
    with engine.connect() as conn:
        rows = conn.execute(text(sql), params).mappings().all()
except Exception as exc:
    print(f"\n  QUERY FAILED\n  {type(exc).__name__}: {exc}")
    print(
        "\n  That message is the finding. If it names a column, the shadow table\n"
        "  on this server differs from the one the query was written against; if\n"
        "  it is a login or driver error, nothing is wrong with the SQL itself."
    )
    sys.exit(1)

print(f"  ok    the query ran and returned {len(rows)} batch rows")

if not rows:
    print(
        "\n  No batches in the last 24 hours. That is a legitimate answer -- the\n"
        "  card will read 0% and say so -- but it does not exercise the numbers.\n"
        "  Re-run with a window you know has production if you want to see them."
    )
    sys.exit(0)

sample = rows[0]
print("\n  first row back:")
for key in ("guid", "act_start", "act_end", "product", "category",
            "actual_kg", "setpoint_kg", "scored_rows", "on_target_rows", "material_rows"):
    print(f"    {key:<16} {sample[key]!r}")

# ---------------------------------------------------------------- 3. the numbers
heading("3. what the card would show")

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
print(f"  batches        {kpi['batches']}  (+{kpi['batches_running']} still running)")
print(f"  tonnage        {kpi['tons']:.2f} t")
print(f"  running        {kpi['running_hours']:.2f} h    idle {kpi['idle_hours']:.2f} h")
print(f"  EFFICIENCY     {kpi['availability_pct']:.1f} %")
print(f"  throughput     {kpi['throughput_tph']:.2f} t/h running, "
      f"{kpi['throughput_window_tph']:.2f} t/h over the window")
print(f"  on target      {kpi['on_target_pct']}%  (+/-{kpi['dosing_tolerance_pct']}%)")
print(f"  concurrency    {kpi['concurrency']}x")
print(f"  outloading     {kpi['non_production']['tons']:.2f} t (excluded)")

print(
    "\n  Sanity-check these against the plant before showing anyone: efficiency\n"
    "  is running time over 24 h, so it cannot exceed 100, and concurrency above\n"
    "  1 is expected here -- it is why running time is a union and not a sum."
)
sys.exit(0)
