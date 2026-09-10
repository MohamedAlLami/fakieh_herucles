"""PLC decoding and historian business logic for the Pallet Report module."""

from __future__ import annotations

import logging
import math
import struct
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Mapping, Optional

logger = logging.getLogger(__name__)

PALLET_DB_NUMBER = 7
PALLET_DB_START = 0
PALLET_DB_SIZE = 42
PALLET_HISTORY_LOCK_KEY = 7_061_001

P1_SOURCE1_OFFSET = 0
P1_SOURCE2_OFFSET = 2
P1_DEST1_OFFSET = 4
P1_DEST2_OFFSET = 6
P1_RUNNING_BYTE = 8
P1_RUNNING_BIT = 0
P1_QTY_OFFSET = 10

P2_SOURCE1_OFFSET = 14
P2_SOURCE2_OFFSET = 16
P2_DEST1_OFFSET = 18
P2_DEST2_OFFSET = 20
P2_RUNNING_BYTE = 22
P2_RUNNING_BIT = 0
P2_QTY_OFFSET = 24

P3_P4_SOURCE_OFFSET = 28
P3_P4_DEST1_OFFSET = 30
P3_P4_DEST2_OFFSET = 32
P3_P4_RUNNING_BYTE = 34
P3_P4_RUNNING_BIT = 0
P3_P4_SELECTION_OFFSET = 36
P3_P4_QTY_OFFSET = 38


class PalletPLCReadError(RuntimeError):
    """Raised when DB7 cannot be read or decoded safely."""


def decode_int(buffer: bytes | bytearray, offset: int) -> int:
    """Decode a Siemens S7 signed 16-bit big-endian INT."""
    return struct.unpack_from(">h", buffer, offset)[0]


def decode_real(buffer: bytes | bytearray, offset: int) -> float:
    """Decode a Siemens S7 IEEE-754 32-bit big-endian REAL."""
    return struct.unpack_from(">f", buffer, offset)[0]


def decode_bool(buffer: bytes | bytearray, byte_offset: int, bit_offset: int) -> bool:
    """Decode one Siemens BOOL bit without treating it as a full byte."""
    return bool(buffer[byte_offset] & (1 << bit_offset))


def decode_pallet_db7(buffer: bytes | bytearray) -> Dict[str, Dict[str, Any]]:
    """Decode the complete DB7 pallet structure from one PLC response."""
    if len(buffer) < PALLET_DB_SIZE:
        raise PalletPLCReadError(
            f"Malformed DB7 response: expected {PALLET_DB_SIZE} bytes, got {len(buffer)}"
        )

    try:
        decoded = {
            "P1": {
                "source1": decode_int(buffer, P1_SOURCE1_OFFSET),
                "source2": decode_int(buffer, P1_SOURCE2_OFFSET),
                "destination1": decode_int(buffer, P1_DEST1_OFFSET),
                "destination2": decode_int(buffer, P1_DEST2_OFFSET),
                "running": decode_bool(buffer, P1_RUNNING_BYTE, P1_RUNNING_BIT),
                "quantity": decode_real(buffer, P1_QTY_OFFSET),
            },
            "P2": {
                "source1": decode_int(buffer, P2_SOURCE1_OFFSET),
                "source2": decode_int(buffer, P2_SOURCE2_OFFSET),
                "destination1": decode_int(buffer, P2_DEST1_OFFSET),
                "destination2": decode_int(buffer, P2_DEST2_OFFSET),
                "running": decode_bool(buffer, P2_RUNNING_BYTE, P2_RUNNING_BIT),
                "quantity": decode_real(buffer, P2_QTY_OFFSET),
            },
            "P3_P4": {
                "source": decode_int(buffer, P3_P4_SOURCE_OFFSET),
                "destination1": decode_int(buffer, P3_P4_DEST1_OFFSET),
                "destination2": decode_int(buffer, P3_P4_DEST2_OFFSET),
                "running": decode_bool(buffer, P3_P4_RUNNING_BYTE, P3_P4_RUNNING_BIT),
                "selection": decode_int(buffer, P3_P4_SELECTION_OFFSET),
                "quantity": decode_real(buffer, P3_P4_QTY_OFFSET),
            },
        }
        quantities = (
            decoded["P1"]["quantity"],
            decoded["P2"]["quantity"],
            decoded["P3_P4"]["quantity"],
        )
        if not all(math.isfinite(value) for value in quantities):
            raise PalletPLCReadError("Invalid DB7 pallet data: non-finite REAL quantity")
        return decoded
    except (IndexError, struct.error, TypeError) as exc:
        raise PalletPLCReadError(f"Invalid DB7 pallet data: {exc}") from exc


def read_pallet_db7() -> Dict[str, Dict[str, Any]]:
    """Read DB7 once via the application's existing Snap7 connection manager."""
    try:
        from routes.plc_routes import DEMO_MODE, read_db_bytes

        if DEMO_MODE:
            raise PalletPLCReadError("Live pallet data is unavailable in PLC demo mode")
        raw = read_db_bytes(PALLET_DB_NUMBER, PALLET_DB_SIZE)
        if raw is None:
            raise PalletPLCReadError("PLC unavailable or DB7 could not be read")
        data = decode_pallet_db7(raw)
        logger.debug("DB7 pallet values successfully read")
        return data
    except PalletPLCReadError:
        raise
    except Exception as exc:
        raise PalletPLCReadError(str(exc)) from exc


def build_live_lines(data: Mapping[str, Mapping[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Resolve shared P3/P4 PLC values into four independently displayed lines."""
    lines: Dict[str, Dict[str, Any]] = {}
    for line in ("P1", "P2"):
        source = data[line]
        lines[line] = {"line": line, **dict(source)}

    shared = data["P3_P4"]
    selection = int(shared["selection"])
    shared_running = bool(shared["running"])
    for line, selected_values in (("P3", (3, 5)), ("P4", (4, 5))):
        selected = selection in selected_values
        lines[line] = {
            "line": line,
            "source1": shared["source"],
            "source2": None,
            "destination1": shared["destination1"],
            "destination2": shared["destination2"],
            "quantity": shared["quantity"],
            "running": shared_running and selected,
            "selected": selected,
            "selection": selection,
        }
    return lines


def build_snapshot_rows(
    data: Mapping[str, Mapping[str, Any]],
    recorded_at: Optional[datetime] = None,
) -> List[Dict[str, Any]]:
    """Return only running-line snapshots, including both rows for selection 5."""
    # One canonical timestamp per minute also makes the database uniqueness
    # guard effective when two application processes fire a few seconds apart.
    timestamp = (recorded_at or datetime.now(timezone.utc)).replace(second=0, microsecond=0)
    rows: List[Dict[str, Any]] = []

    for line in ("P1", "P2"):
        values = data[line]
        if values["running"]:
            rows.append(
                {
                    "line": line,
                    "source1": values["source1"],
                    "source2": values["source2"],
                    "destination1": values["destination1"],
                    "destination2": values["destination2"],
                    "quantity": values["quantity"],
                    "running": True,
                    "selection": None,
                    "recorded_at": timestamp,
                }
            )

    shared = data["P3_P4"]
    if shared["running"]:
        selection = int(shared["selection"])
        selected_lines = {3: ("P3",), 4: ("P4",), 5: ("P3", "P4")}.get(selection, ())
        if not selected_lines:
            logger.warning("Invalid P3/P4 selection value: %s", selection)
        for line in selected_lines:
            rows.append(
                {
                    "line": line,
                    "source1": shared["source"],
                    "source2": None,
                    "destination1": shared["destination1"],
                    "destination2": shared["destination2"],
                    "quantity": shared["quantity"],
                    "running": True,
                    "selection": selection,
                    "recorded_at": timestamp,
                }
            )
    return rows


def collect_pallet_history(
    reader: Callable[[], Dict[str, Dict[str, Any]]] = read_pallet_db7,
    session: Any = None,
    use_advisory_lock: bool = True,
    model_factory: Any = None,
) -> Dict[str, Any]:
    """Read DB7 and store one transactional minute snapshot for running lines.

    A transaction-scoped PostgreSQL advisory lock prevents duplicate rows when
    more than one backend worker happens to register the interval job.
    """
    if session is None:
        from models import db
        active_session = db.session
    else:
        active_session = session
    try:
        if use_advisory_lock:
            from sqlalchemy import text
            acquired = active_session.execute(
                text("SELECT pg_try_advisory_xact_lock(:key)"),
                {"key": PALLET_HISTORY_LOCK_KEY},
            ).scalar()
            if not acquired:
                active_session.rollback()
                return {"success": True, "stored": 0, "skipped": "another worker is collecting"}

        rows = build_snapshot_rows(reader())
        if rows:
            if model_factory is None:
                from models.pallet_report import PalletReport
                model_factory = PalletReport
            active_session.add_all(model_factory(**row) for row in rows)
        active_session.commit()
        stored_lines = [row["line"] for row in rows]
        if stored_lines:
            logger.info("Stored pallet snapshots: %s", ", ".join(stored_lines))
        return {"success": True, "stored": len(rows), "lines": stored_lines}
    except PalletPLCReadError as exc:
        active_session.rollback()
        logger.error("Pallet DB7 read failed: %s", exc)
        return {"success": False, "stored": 0, "error": str(exc), "kind": "plc"}
    except Exception as exc:
        active_session.rollback()
        logger.error("Failed to save pallet snapshot: %s", exc, exc_info=True)
        return {"success": False, "stored": 0, "error": str(exc), "kind": "database"}
