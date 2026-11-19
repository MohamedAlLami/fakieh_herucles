"""Temporary silos 1001-1200: ground storage used when the real silos are full.

They exist only in the Hercules database (tables temp_silos / temp_silo_log). Nothing here reads
from or writes to the PLC, and they are deliberately NOT rows of silo_status, so the PLC sync,
the order pages and SCADA-facing code never see them.

Rules:
- a silo with no material is free and can take any material;
- the first weighbridge trip (or a hand edit) gives it a material;
- when its quantity returns to exactly zero it becomes free again;
- every change is written to temp_silo_log with the before and after values.
"""
from __future__ import annotations

import threading
from typing import Optional, Tuple

TEMP_SILO_FIRST = 1001
TEMP_SILO_LAST = 1200
ZERO_TOLERANCE_KG = 0.0005
TEMP_NOTE = "temporary silo (Hercules only, no PLC)"


class TempSiloError(Exception):
    """A rule was broken; the message is safe to show to the operator."""


def is_temp_silo(silo_no) -> bool:
    try:
        return TEMP_SILO_FIRST <= int(silo_no) <= TEMP_SILO_LAST
    except (TypeError, ValueError):
        return False


def _norm(code) -> str:
    s = str(code if code is not None else "").strip()
    if not s:
        return ""
    return s.lstrip("0") or "0"


def same_material(a, b) -> bool:
    return _norm(a) == _norm(b)


# ---- pure decisions (unit-tested without a database) ----

def plan_trip(cur_code: str, cur_qty: float, order_code: str, order_name: str,
              delta_kg: float) -> Tuple[str, str, float]:
    """New (material_code, material_name, quantity_kg) after a weighbridge trip.

    Raises TempSiloError when the silo holds a different material.
    The quantity is not clamped at zero, the same as for real silos.
    """
    cur_code = str(cur_code or "").strip()
    order_code = str(order_code or "").strip()
    if not order_code:
        raise TempSiloError("the trip has no material")
    if cur_code and not same_material(cur_code, order_code):
        raise TempSiloError(f"temporary silo holds material {cur_code}, the trip is material {order_code}")
    new_qty = round(float(cur_qty or 0) + float(delta_kg), 3)
    if abs(new_qty) < ZERO_TOLERANCE_KG:
        return "", "", 0.0
    return (cur_code or order_code), (order_name or ""), new_qty


def plan_manual(material_code: str, material_name: str, quantity_kg) -> Tuple[str, str, float]:
    """New (material_code, material_name, quantity_kg) for a hand edit."""
    try:
        qty = round(float(quantity_kg), 3)
    except (TypeError, ValueError):
        raise TempSiloError("quantity must be a number")
    if qty != qty or qty in (float("inf"), float("-inf")):
        raise TempSiloError("quantity must be a number")
    if qty < 0:
        raise TempSiloError("quantity cannot be below zero")
    code = str(material_code or "").strip()
    if qty < ZERO_TOLERANCE_KG:
        return "", "", 0.0
    if not code:
        raise TempSiloError("select a material for a quantity above zero")
    return code, (material_name or ""), qty


# ---- database ----

_ensure_lock = threading.Lock()
_ensured = False

_DDL = [
    """CREATE TABLE IF NOT EXISTS public.temp_silos (
           silo_no INTEGER PRIMARY KEY,
           material_code VARCHAR(50) NOT NULL DEFAULT '',
           material_name VARCHAR(200) NOT NULL DEFAULT '',
           quantity_kg DOUBLE PRECISION NOT NULL DEFAULT 0,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )""",
    f"""INSERT INTO public.temp_silos (silo_no)
        SELECT g FROM generate_series({TEMP_SILO_FIRST}, {TEMP_SILO_LAST}) AS g
        ON CONFLICT (silo_no) DO NOTHING""",
    """CREATE TABLE IF NOT EXISTS public.temp_silo_log (
           id BIGSERIAL PRIMARY KEY,
           silo_no INTEGER NOT NULL,
           changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           source VARCHAR(20) NOT NULL,
           order_id BIGINT,
           material_code_before VARCHAR(50),
           material_code_after VARCHAR(50),
           qty_before DOUBLE PRECISION,
           qty_after DOUBLE PRECISION,
           note VARCHAR(255)
       )""",
    "CREATE INDEX IF NOT EXISTS ix_temp_silo_log_silo ON public.temp_silo_log (silo_no, changed_at)",
    """CREATE UNIQUE INDEX IF NOT EXISTS ux_temp_silo_log_order
       ON public.temp_silo_log (order_id) WHERE source = 'weighbridge'""",
]


def _engine():
    from routes import plc_routes
    return plc_routes._engine_app()


def ensure_tables(engine=None) -> None:
    """Create the two tables and the 200 rows if missing (idempotent, once per process)."""
    global _ensured
    if _ensured:
        return
    with _ensure_lock:
        if _ensured:
            return
        engine = engine or _engine()
        with engine.begin() as conn:
            for stmt in _DDL:
                conn.exec_driver_sql(stmt)
        _ensured = True


def _row_dict(r) -> dict:
    return {
        "siloNo": int(r[0]),
        "dbNo": None,
        "binName": f"Silo {int(r[0])}",
        "materialCode": r[1] or "",
        "materialName": r[2] or "",
        "hlActive": False,
        "lockActive": False,
        "quantityKg": float(r[3] or 0),
        "updatedAt": r[4].isoformat() if r[4] else None,
        "temp": True,
    }


def list_all(engine=None) -> list:
    engine = engine or _engine()
    ensure_tables(engine)
    with engine.connect() as conn:
        rows = conn.exec_driver_sql(
            "SELECT silo_no, material_code, material_name, quantity_kg, updated_at "
            "FROM public.temp_silos ORDER BY silo_no"
        ).fetchall()
    return [_row_dict(r) for r in rows]


def get_one(silo_no: int, engine=None) -> Optional[dict]:
    engine = engine or _engine()
    ensure_tables(engine)
    with engine.connect() as conn:
        r = conn.exec_driver_sql(
            "SELECT silo_no, material_code, material_name, quantity_kg, updated_at "
            "FROM public.temp_silos WHERE silo_no = %(s)s", {"s": int(silo_no)}
        ).fetchone()
    return _row_dict(r) if r else None


def classify(rows: list, material_code: str) -> dict:
    """Split temp silo rows into those holding `material_code` and the free ones."""
    matching, free = [], []
    for s in rows:
        item = {
            "siloNo": s["siloNo"], "materialCode": s["materialCode"], "materialName": s["materialName"],
            "quantityKg": s["quantityKg"], "lockActive": False, "temp": True,
        }
        if not s["materialCode"]:
            free.append(item)
        elif same_material(s["materialCode"], material_code):
            matching.append(item)
    return {"matching": matching, "free": free}


def _write(conn, silo_no, code, name, qty, source, order_id, before_code, before_qty, note):
    conn.exec_driver_sql(
        "UPDATE public.temp_silos SET material_code = %(c)s, material_name = %(n)s, "
        "quantity_kg = %(q)s, updated_at = NOW() WHERE silo_no = %(s)s",
        {"c": code, "n": name, "q": qty, "s": silo_no},
    )
    conn.exec_driver_sql(
        "INSERT INTO public.temp_silo_log (silo_no, source, order_id, material_code_before, "
        "material_code_after, qty_before, qty_after, note) "
        "VALUES (%(s)s, %(src)s, %(o)s, %(cb)s, %(ca)s, %(qb)s, %(qa)s, %(note)s)",
        {"s": silo_no, "src": source, "o": order_id, "cb": before_code, "ca": code,
         "qb": before_qty, "qa": qty, "note": (note or "")[:255]},
    )


def apply_trip(silo_no: int, delta_kg: float, material_code: str, material_name: str,
               order_id: int, engine=None) -> Tuple[float, float]:
    """Apply a weighbridge trip to a temp silo. Returns (qty_before, qty_after).

    Safe to call twice for the same order: the second call changes nothing and returns the
    figures recorded the first time.
    """
    silo_no = int(silo_no)
    if not is_temp_silo(silo_no):
        raise TempSiloError(f"silo {silo_no} is not a temporary silo")
    engine = engine or _engine()
    ensure_tables(engine)
    with engine.begin() as conn:
        row = conn.exec_driver_sql(
            "SELECT material_code, quantity_kg FROM public.temp_silos WHERE silo_no = %(s)s FOR UPDATE",
            {"s": silo_no},
        ).fetchone()
        if row is None:
            raise TempSiloError(f"temporary silo {silo_no} not found")
        done = conn.exec_driver_sql(
            "SELECT qty_before, qty_after FROM public.temp_silo_log "
            "WHERE order_id = %(o)s AND source = 'weighbridge'", {"o": int(order_id)},
        ).fetchone()
        if done is not None:
            return float(done[0]), float(done[1])
        before_code, before_qty = row[0] or "", float(row[1] or 0)
        code, name, qty = plan_trip(before_code, before_qty, material_code, material_name, delta_kg)
        _write(conn, silo_no, code, name, qty, "weighbridge", int(order_id), before_code, before_qty,
               f"trip {order_id}, {float(delta_kg):+.1f} kg")
    return before_qty, qty


def set_manual(silo_no: int, material_code: str, material_name: str, quantity_kg,
               note: str = "", engine=None) -> dict:
    """Hand edit of a temp silo. Returns the new row."""
    silo_no = int(silo_no)
    if not is_temp_silo(silo_no):
        raise TempSiloError(f"silo {silo_no} is not a temporary silo")
    code, name, qty = plan_manual(material_code, material_name, quantity_kg)
    engine = engine or _engine()
    ensure_tables(engine)
    with engine.begin() as conn:
        row = conn.exec_driver_sql(
            "SELECT material_code, quantity_kg FROM public.temp_silos WHERE silo_no = %(s)s FOR UPDATE",
            {"s": silo_no},
        ).fetchone()
        if row is None:
            raise TempSiloError(f"temporary silo {silo_no} not found")
        _write(conn, silo_no, code, name, qty, "manual", None, row[0] or "", float(row[1] or 0),
               note or "hand edit")
    return get_one(silo_no, engine)


def log_for(silo_no: int, limit: int = 50, engine=None) -> list:
    engine = engine or _engine()
    ensure_tables(engine)
    with engine.connect() as conn:
        rows = conn.exec_driver_sql(
            "SELECT changed_at, source, order_id, material_code_before, material_code_after, "
            "qty_before, qty_after, note FROM public.temp_silo_log WHERE silo_no = %(s)s "
            "ORDER BY id DESC LIMIT %(l)s", {"s": int(silo_no), "l": int(limit)},
        ).fetchall()
    return [{
        "changedAt": r[0].isoformat() if r[0] else None, "source": r[1], "orderId": r[2],
        "materialCodeBefore": r[3] or "", "materialCodeAfter": r[4] or "",
        "qtyBefore": r[5], "qtyAfter": r[6], "note": r[7] or "",
    } for r in rows]
