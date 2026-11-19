"""Weighbridge orders: what a truck is coming for (product, quantity, client).

Entered on Management > Weighbridge Orders, picked by number on the weighbridge.
Life of an order:  open  ->  in_progress (a truck trip is using it)  ->  closed (that truck exited).
Cancelling the trip puts the order back to open. One order is one truck trip.

Database only; nothing here touches the PLC.
"""
from __future__ import annotations

import threading
from typing import Optional

STATUSES = ("open", "in_progress", "closed")


class OrderError(Exception):
    """A rule was broken; the message is safe to show. `code` is the HTTP status to answer with."""

    def __init__(self, message: str, code: int = 400):
        super().__init__(message)
        self.code = code


# ---- pure validation (unit-tested without a database) ----

def clean_fields(order_no, product_code, quantity_kg, client_id) -> dict:
    """Validate and normalise what the form sends. order_no None = give the next number."""
    out = {}
    if order_no is None or order_no == "":
        out["order_no"] = None
    else:
        if isinstance(order_no, bool):
            raise OrderError("order number must be a whole number")
        try:
            n = int(str(order_no).strip())
        except (TypeError, ValueError):
            raise OrderError("order number must be a whole number")
        if n < 1 or n > 2_000_000_000:
            raise OrderError("order number must be 1 or more")
        out["order_no"] = n
    code = str(product_code or "").strip()
    if not code:
        raise OrderError("select a product")
    out["product_code"] = code
    if isinstance(quantity_kg, bool):
        raise OrderError("quantity must be a number")
    try:
        qty = round(float(quantity_kg), 3)
    except (TypeError, ValueError):
        raise OrderError("quantity must be a number")
    if qty != qty or qty in (float("inf"), float("-inf")) or qty <= 0:
        raise OrderError("quantity must be above zero")
    out["quantity_kg"] = qty
    if isinstance(client_id, bool) or client_id is None or client_id == "":
        raise OrderError("select a client")
    try:
        out["client_id"] = int(client_id)
    except (TypeError, ValueError):
        raise OrderError("select a client")
    return out


# ---- database ----

_ensure_lock = threading.Lock()
_ensured = False

_DDL = [
    """CREATE TABLE IF NOT EXISTS public.weighbridge_orders (
           id BIGSERIAL PRIMARY KEY,
           order_no INTEGER NOT NULL UNIQUE,
           product_code VARCHAR(50) NOT NULL,
           product_name VARCHAR(200) NOT NULL DEFAULT '',
           quantity_kg DOUBLE PRECISION NOT NULL,
           client_id INTEGER,
           client_name VARCHAR(200) NOT NULL DEFAULT '',
           status VARCHAR(20) NOT NULL DEFAULT 'open',
           trip_id BIGINT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           closed_at TIMESTAMPTZ
       )""",
    "CREATE INDEX IF NOT EXISTS ix_weighbridge_orders_status ON public.weighbridge_orders (status)",
]

_COLS = ("id, order_no, product_code, product_name, quantity_kg, client_id, client_name, "
         "status, trip_id, created_at, closed_at")


def _engine():
    from routes import plc_routes
    return plc_routes._engine_app()


def ensure_tables(engine=None) -> None:
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


def _row(r) -> dict:
    return {
        "id": int(r[0]), "order_no": int(r[1]), "product_code": r[2], "product_name": r[3] or "",
        "quantity_kg": float(r[4]), "client_id": r[5], "client_name": r[6] or "",
        "status": r[7], "trip_id": r[8],
        "created_at": r[9].isoformat() if r[9] else None,
        "closed_at": r[10].isoformat() if r[10] else None,
    }


def list_orders(status: Optional[str] = None, engine=None) -> list:
    engine = engine or _engine()
    ensure_tables(engine)
    sql = f"SELECT {_COLS} FROM public.weighbridge_orders"
    params = {}
    if status:
        sql += " WHERE status = %(st)s"
        params["st"] = status
    sql += " ORDER BY order_no DESC"
    with engine.connect() as conn:
        return [_row(r) for r in conn.exec_driver_sql(sql, params).fetchall()]


def next_number(engine=None) -> int:
    engine = engine or _engine()
    ensure_tables(engine)
    with engine.connect() as conn:
        return int(conn.exec_driver_sql(
            "SELECT COALESCE(MAX(order_no), 0) + 1 FROM public.weighbridge_orders").scalar())


def get_by_no(order_no: int, engine=None) -> Optional[dict]:
    engine = engine or _engine()
    ensure_tables(engine)
    with engine.connect() as conn:
        r = conn.exec_driver_sql(
            f"SELECT {_COLS} FROM public.weighbridge_orders WHERE order_no = %(n)s", {"n": int(order_no)}
        ).fetchone()
    return _row(r) if r else None


def create(fields: dict, product_name: str, client_name: str, engine=None) -> dict:
    """fields: output of clean_fields. order_no None -> next free number."""
    engine = engine or _engine()
    ensure_tables(engine)
    with engine.begin() as conn:
        # One writer at a time for numbering, so two people saving together never get the same number.
        conn.exec_driver_sql("LOCK TABLE public.weighbridge_orders IN SHARE ROW EXCLUSIVE MODE")
        no = fields["order_no"]
        if no is None:
            no = int(conn.exec_driver_sql(
                "SELECT COALESCE(MAX(order_no), 0) + 1 FROM public.weighbridge_orders").scalar())
        elif conn.exec_driver_sql(
                "SELECT 1 FROM public.weighbridge_orders WHERE order_no = %(n)s", {"n": no}).fetchone():
            raise OrderError(f"order number {no} already exists", 409)
        r = conn.exec_driver_sql(
            "INSERT INTO public.weighbridge_orders "
            "(order_no, product_code, product_name, quantity_kg, client_id, client_name) "
            "VALUES (%(n)s, %(pc)s, %(pn)s, %(q)s, %(ci)s, %(cn)s) RETURNING " + _COLS,
            {"n": no, "pc": fields["product_code"], "pn": product_name or "", "q": fields["quantity_kg"],
             "ci": fields["client_id"], "cn": client_name or ""},
        ).fetchone()
    return _row(r)


def update(order_id: int, fields: dict, product_name: str, client_name: str, engine=None) -> dict:
    """Only an open order can be changed. The order number itself is not changed."""
    engine = engine or _engine()
    ensure_tables(engine)
    with engine.begin() as conn:
        cur = conn.exec_driver_sql(
            "SELECT status FROM public.weighbridge_orders WHERE id = %(i)s FOR UPDATE", {"i": int(order_id)}
        ).fetchone()
        if cur is None:
            raise OrderError("order not found", 404)
        if cur[0] != "open":
            raise OrderError("only an open order can be changed", 409)
        r = conn.exec_driver_sql(
            "UPDATE public.weighbridge_orders SET product_code = %(pc)s, product_name = %(pn)s, "
            "quantity_kg = %(q)s, client_id = %(ci)s, client_name = %(cn)s WHERE id = %(i)s RETURNING " + _COLS,
            {"pc": fields["product_code"], "pn": product_name or "", "q": fields["quantity_kg"],
             "ci": fields["client_id"], "cn": client_name or "", "i": int(order_id)},
        ).fetchone()
    return _row(r)


def delete(order_id: int, engine=None) -> None:
    engine = engine or _engine()
    ensure_tables(engine)
    with engine.begin() as conn:
        cur = conn.exec_driver_sql(
            "SELECT status FROM public.weighbridge_orders WHERE id = %(i)s FOR UPDATE", {"i": int(order_id)}
        ).fetchone()
        if cur is None:
            raise OrderError("order not found", 404)
        if cur[0] != "open":
            raise OrderError("only an open order can be deleted", 409)
        conn.exec_driver_sql("DELETE FROM public.weighbridge_orders WHERE id = %(i)s", {"i": int(order_id)})


def attach(order_no: int, trip_id: int, engine=None) -> dict:
    """A truck trip takes the order: open -> in_progress. Raises if it is not open any more."""
    engine = engine or _engine()
    ensure_tables(engine)
    with engine.begin() as conn:
        r = conn.exec_driver_sql(
            "UPDATE public.weighbridge_orders SET status = 'in_progress', trip_id = %(t)s "
            "WHERE order_no = %(n)s AND status = 'open' RETURNING " + _COLS,
            {"t": int(trip_id), "n": int(order_no)},
        ).fetchone()
    if r is None:
        raise OrderError(f"order {order_no} is not open any more", 409)
    return _row(r)


def release(trip_id: int, engine=None) -> None:
    """The trip was cancelled: its order is open again."""
    engine = engine or _engine()
    ensure_tables(engine)
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "UPDATE public.weighbridge_orders SET status = 'open', trip_id = NULL "
            "WHERE trip_id = %(t)s AND status = 'in_progress'", {"t": int(trip_id)})


def close(trip_id: int, engine=None) -> None:
    """The truck exited: its order is closed."""
    engine = engine or _engine()
    ensure_tables(engine)
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "UPDATE public.weighbridge_orders SET status = 'closed', closed_at = NOW() "
            "WHERE trip_id = %(t)s AND status = 'in_progress'", {"t": int(trip_id)})
