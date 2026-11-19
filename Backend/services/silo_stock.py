"""Silo stock adjustment driven by weighbridge trips.

Pure helpers (compute_new_qty) plus apply_stock_delta, which talks to the PLC
and database only through injectable callables so it is unit-testable.

PLC writes are OFF until switched on (see plc_writes_enabled), never happen in DEMO_MODE, go to the
silo's own block only, and every write is checked before, straight after and again two seconds later.
"""
from __future__ import annotations

import os
from typing import Callable, Optional, Tuple

READBACK_TOLERANCE_KG = 0.01
NOT_CONFIRMED_NOTE = "PLC write not confirmed"


def compute_new_qty(current_kg: float, delta_kg: float) -> Tuple[float, bool]:
    """Return (new_kg, below_zero).

    The result is NOT clamped at zero. The PLC itself runs silo quantities negative when more is
    dosed out than was booked in (silo 314 read -6005 kg on site), so a negative figure is the
    honest one and keeps later corrections arithmetically right. below_zero flags it for the note.
    """
    raw = round(float(current_kg) + float(delta_kg), 3)
    return raw, raw < 0


PLC_WRITE_FLAG_FILE = "enable_weighbridge_plc_write.txt"


def plc_write_flag_path() -> str:
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), PLC_WRITE_FLAG_FILE)


def plc_writes_enabled() -> bool:
    """Whether a weighbridge trip may write the silo quantity to the PLC. OFF unless switched on.

    Switch: the file Backend/enable_weighbridge_plc_write.txt exists (create it to switch on, delete
    it to switch off; read on every trip, no restart needed). The environment variable
    WEIGHBRIDGE_WRITE_SILO_QTY=true|false, when set, overrides the file. Never in DEMO_MODE.
    """
    env = os.getenv("WEIGHBRIDGE_WRITE_SILO_QTY", "").strip().lower()
    if env in ("true", "false"):
        on = env == "true"
    else:
        on = os.path.exists(plc_write_flag_path())
    if not on:
        return False
    try:
        from routes import plc_routes
        return not plc_routes.DEMO_MODE
    except Exception:
        return False


# ---- default I/O (lazy imports: no snap7 / DB needed to import this module) ----

def _default_reader(silo_no: int) -> Optional[float]:
    """Fresh quantity from the silo's own PLC block.

    Raises services.silo_blocks.SiloBlockError with the reason when the block cannot be used.
    """
    from routes import plc_routes
    svc = plc_routes.silo_block_service()
    if svc is None:
        return None
    return svc.read_fresh_checked(silo_no)


def _default_writer(silo_no: int, new_kg: float) -> None:
    """Write the silo's own PLC block (what SCADA shows). DB5 is a copy and is never written."""
    from routes import plc_routes
    from services import silo_blocks
    svc = plc_routes.silo_block_service()
    if svc is None:
        raise RuntimeError("silo block reading is switched off")
    silo_blocks.write_one(
        read80=lambda db: plc_routes._plc_read_raw(db, 0, silo_blocks.BLOCK_LEN),
        write_real=lambda db, off, value: plc_routes._db_write(db, off, plc_routes._pack_real(value)),
        mapping=svc.mapping(),
        silo_no=silo_no,
        new_kg=new_kg,
    )
    svc.invalidate()


def _default_db_updater(silo_no: int, delta_kg: float,
                        absolute_kg: Optional[float]) -> Tuple[float, float]:
    """Update public.silo_status.quantity_kg. Returns (before, after).

    absolute_kg given -> set to it; otherwise stored qty (COALESCE 0) + delta.
    """
    from routes import plc_routes
    engine = plc_routes._engine_app()
    with engine.begin() as conn:
        row = conn.exec_driver_sql(
            "SELECT COALESCE(quantity_kg, 0) FROM public.silo_status WHERE silo_no = %(s)s FOR UPDATE",
            {"s": silo_no},
        ).fetchone()
        if row is None:
            raise LookupError(f"silo {silo_no} not in silo_status")
        before = float(row[0])
        after = absolute_kg if absolute_kg is not None else compute_new_qty(before, delta_kg)[0]
        conn.exec_driver_sql(
            "UPDATE public.silo_status SET quantity_kg = %(q)s, updated_at = NOW() WHERE silo_no = %(s)s",
            {"q": after, "s": silo_no},
        )
    return before, float(after)


def _has_plc_address(silo_no: int) -> bool:
    from routes import plc_routes
    svc = plc_routes.silo_block_service()
    return svc is not None and int(silo_no) in svc.mapping()


def apply_stock_delta(
    silo_no: int,
    delta_kg: float,
    *,
    reader: Optional[Callable[[int], Optional[float]]] = None,
    writer: Optional[Callable[[int, float], None]] = None,
    db_updater: Optional[Callable[[int, float, Optional[float]], Tuple[float, float]]] = None,
    writes_enabled: Optional[bool] = None,
    has_address: Optional[bool] = None,
    db_already_applied: bool = False,
    plc_before_attempt: Optional[float] = None,
) -> dict:
    """Apply a signed kg delta to a silo.

    Returns {status: 'applied'|'pending'|'skipped', qty_before, qty_after, note, db_applied}.
    Never raises for PLC/DB problems; those come back as 'pending' with a note.

    db_already_applied: retry of an order whose database quantity was already moved;
        the DB is not touched again, only the PLC write remains.
    plc_before_attempt: on retry after "PLC write not confirmed", the PLC value seen
        before the first attempt; if the PLC now already holds before+delta the write
        landed after all and nothing is written again.
    """
    silo_no = int(silo_no)
    delta_kg = float(delta_kg)
    if delta_kg == 0:
        return {"status": "skipped", "qty_before": None, "qty_after": None,
                "note": "zero delta", "db_applied": db_already_applied}

    reader = reader or _default_reader
    writer = writer or _default_writer
    db_updater = db_updater or _default_db_updater
    if writes_enabled is None:
        writes_enabled = plc_writes_enabled()
    if has_address is None:
        try:
            has_address = _has_plc_address(silo_no)
        except Exception:
            has_address = False

    def db_only(note: str, plc_base: Optional[float] = None) -> dict:
        """Move only the stored quantity; leave the order pending for a PLC retry."""
        if db_already_applied:
            return {"status": "pending", "qty_before": None, "qty_after": None,
                    "note": note, "db_applied": True}
        try:
            before, after = db_updater(silo_no, delta_kg, None)
        except Exception as e:
            return {"status": "pending", "qty_before": None, "qty_after": None,
                    "note": f"{note}; database update failed: {e}", "db_applied": False}
        return {"status": "pending", "qty_before": before, "qty_after": after,
                "note": note, "db_applied": True}

    if not writes_enabled:
        return db_only("PLC write disabled")
    if not has_address:
        return db_only("silo has no known PLC block")

    read_note = "PLC not reachable"
    try:
        current = reader(silo_no)
    except Exception as e:
        current = None
        if type(e).__name__ == "SiloBlockError" and str(e):
            read_note = str(e)
    if current is None:
        return db_only(read_note)

    current = float(current)
    new_qty, clamped = compute_new_qty(current, delta_kg)
    clamp_note = " (below zero)" if clamped else ""

    if plc_before_attempt is not None:
        landed, _ = compute_new_qty(plc_before_attempt, delta_kg)
        if abs(current - landed) < READBACK_TOLERANCE_KG:
            # The earlier write did land; only bookkeeping remains.
            res = {"status": "applied", "qty_before": plc_before_attempt, "qty_after": current,
                   "note": "PLC already held the new quantity", "db_applied": db_already_applied}
            return _sync_db(res, silo_no, delta_kg, current, db_updater, db_already_applied)

    try:
        writer(silo_no, new_qty)
        back = reader(silo_no)
    except Exception as e:
        out = db_only(f"{NOT_CONFIRMED_NOTE}: {e}")
        out["qty_before"] = current
        out["qty_after"] = new_qty
        return out
    if back is None or abs(float(back) - new_qty) >= READBACK_TOLERANCE_KG:
        out = db_only(NOT_CONFIRMED_NOTE)
        out["qty_before"] = current
        out["qty_after"] = new_qty
        return out

    res = {"status": "applied", "qty_before": current, "qty_after": new_qty,
           "note": ("applied" + clamp_note), "db_applied": db_already_applied}
    return _sync_db(res, silo_no, delta_kg, new_qty, db_updater, db_already_applied)


def _sync_db(res: dict, silo_no: int, delta_kg: float, plc_qty: float,
             db_updater, db_already_applied: bool) -> dict:
    """PLC is authoritative once confirmed: store its value in silo_status."""
    try:
        db_updater(silo_no, delta_kg, plc_qty)
        res["db_applied"] = True
    except Exception as e:
        res["note"] += f"; database sync failed: {e}"
        res["db_applied"] = db_already_applied
    return res


# ---- silo listing for the weighbridge dropdown ----

UNASSIGNED_CODES = frozenset({"", "0", "00", "000"})
# Only the raw-material groups (100-400) can be "unassigned" for a truck. The 600 (pellet) and
# 900 (micro-ingredient) bins have no material name in Hercules, but that is missing data, not
# an empty silo: they hold stock, and a truck never unloads into them.
UNASSIGNED_MAX_SILO_NO = 499
OUT_OF_SERVICE_CODE = "999"


def normalise_code(code) -> str:
    """Strip, drop leading zeros ("012" -> "12"); "000" -> "0"; None -> ""."""
    s = str(code if code is not None else "").strip()
    if not s:
        return ""
    stripped = s.lstrip("0")
    return stripped if stripped else "0"


def _silo_int(v) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return 10 ** 9


def classify_silos(silos: list, material_code: str) -> dict:
    """Split silo rows (camelCase, as GET /api/plc/silos) into matching / unassigned."""
    want = normalise_code(material_code)
    matching, unassigned = [], []
    for s in silos:
        raw_code = str(s.get("materialCode") or "").strip()
        name = str(s.get("materialName") or "").strip()
        item = {
            "siloNo": s.get("siloNo"),
            "materialCode": raw_code,
            "materialName": name,
            "quantityKg": s.get("quantityKg"),
            "lockActive": bool(s.get("lockActive")),
        }
        norm = normalise_code(raw_code)
        if norm == OUT_OF_SERVICE_CODE:
            continue
        if want and norm == want and norm != "0":
            matching.append(item)
        elif not name and raw_code in UNASSIGNED_CODES and _silo_int(s.get("siloNo")) <= UNASSIGNED_MAX_SILO_NO:
            unassigned.append(item)
    return {"matching": matching, "unassigned": unassigned}
