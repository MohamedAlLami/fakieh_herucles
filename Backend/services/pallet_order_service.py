"""Restart-safe event state machine for DB7 pallet production orders."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Mapping, Optional

from services.pallet_report_service import PalletPLCReadError, read_pallet_db7

logger = logging.getLogger(__name__)

PALLET_MONITOR_LOCK_KEY = 7_062_001
RUNNING = "RUNNING"
COMPLETED = "COMPLETED"
ROUTING_FIELDS = ("source1", "source2", "destination1", "destination2", "selection")


def effective_line_values(data: Mapping[str, Mapping[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Normalize one DB7 read into four independent line state inputs."""
    lines: Dict[str, Dict[str, Any]] = {}
    for line in ("P1", "P2"):
        values = data[line]
        lines[line] = {
            "running": bool(values["running"]),
            "source1": values["source1"],
            "source2": values["source2"],
            "destination1": values["destination1"],
            "destination2": values["destination2"],
            "quantity": values["quantity"],
            "selection": None,
        }

    shared = data["P3_P4"]
    selection = int(shared["selection"])
    shared_running = bool(shared["running"])
    for line, selected_values in (("P3", (3, 5)), ("P4", (4, 5))):
        lines[line] = {
            "running": shared_running and selection in selected_values,
            "source1": shared["source"],
            "source2": None,
            "destination1": shared["destination1"],
            "destination2": shared["destination2"],
            "quantity": shared["quantity"],
            "selection": selection,
        }
    return lines


def process_line_state(
    line: str,
    values: Mapping[str, Any],
    repository: Any,
    observed_at: Optional[datetime] = None,
) -> str:
    """Apply one line's effective running state to its persisted active order."""
    timestamp = observed_at or datetime.now(timezone.utc)
    active = repository.get_active(line)
    if values["running"]:
        if active is None:
            repository.start(line, values, timestamp)
            return "started"
        repository.update(active, values, timestamp)
        return "continued"
    if active is not None:
        repository.complete(active, values, timestamp)
        return "completed"
    return "idle"


def process_monitor_data(
    data: Mapping[str, Mapping[str, Any]],
    repository: Any,
    observed_at: Optional[datetime] = None,
) -> Dict[str, str]:
    """Feed all four effective states through the same generic state machine."""
    timestamp = observed_at or datetime.now(timezone.utc)
    return {
        line: process_line_state(line, values, repository, timestamp)
        for line, values in effective_line_values(data).items()
    }


class SQLAlchemyPalletOrderRepository:
    """PostgreSQL persistence adapter for the generic state machine."""

    def __init__(self, session: Any):
        self.session = session

    def get_active(self, line: str):
        from models.pallet_order import PalletOrder

        return (
            self.session.query(PalletOrder)
            .filter(PalletOrder.line == line, PalletOrder.status == RUNNING)
            .with_for_update()
            .first()
        )

    def _next_sequence(self, line: str) -> int:
        from sqlalchemy import text

        return int(
            self.session.execute(
                text(
                    """
                    INSERT INTO pallet_order_sequences AS sequence_row (line, last_sequence)
                    VALUES (:line, 1)
                    ON CONFLICT (line) DO UPDATE
                    SET last_sequence = sequence_row.last_sequence + 1
                    RETURNING last_sequence
                    """
                ),
                {"line": line},
            ).scalar_one()
        )

    @staticmethod
    def _movement_values(values: Mapping[str, Any]) -> Dict[str, Any]:
        return {field: values.get(field) for field in ROUTING_FIELDS}

    def _add_movement(self, order: Any, values: Mapping[str, Any], timestamp: datetime):
        from models.pallet_order import PalletOrderMovement

        current = self._movement_values(values)
        last = order.movements[-1] if order.movements else None
        if last is not None and all(getattr(last, field) == current[field] for field in ROUTING_FIELDS):
            return False
        order.movements.append(
            PalletOrderMovement(
                **current,
                quantity=values.get("quantity"),
                observed_at=timestamp,
            )
        )
        return True

    def start(self, line: str, values: Mapping[str, Any], timestamp: datetime):
        from models.pallet_order import PalletOrder

        sequence = self._next_sequence(line)
        order = PalletOrder(
            line=line,
            order_sequence=sequence,
            order_description=f"L{sequence}",
            source1=values.get("source1"),
            source2=values.get("source2"),
            destination1=values.get("destination1"),
            destination2=values.get("destination2"),
            production_name=None,
            material=None,
            start_qty=values.get("quantity"),
            latest_qty=values.get("quantity"),
            final_qty=None,
            running=True,
            status=RUNNING,
            selection=values.get("selection"),
            actual_start_time=timestamp,
            created_at=timestamp,
            updated_at=timestamp,
        )
        self.session.add(order)
        self.session.flush()
        self._add_movement(order, values, timestamp)
        logger.info("Started pallet order %s %s", line, order.order_description)
        return order

    def update(self, order: Any, values: Mapping[str, Any], timestamp: datetime):
        for field in ROUTING_FIELDS:
            setattr(order, field, values.get(field))
        order.latest_qty = values.get("quantity")
        order.running = True
        order.updated_at = timestamp
        self._add_movement(order, values, timestamp)
        return order

    def complete(self, order: Any, values: Mapping[str, Any], timestamp: datetime):
        # Keep the last active source/destination/selection identity. The
        # current shared selection may already belong to a different line.
        order.latest_qty = values.get("quantity")
        order.final_qty = values.get("quantity")
        order.running = False
        order.status = COMPLETED
        order.actual_end_time = timestamp
        order.updated_at = timestamp
        logger.info("Completed pallet order %s %s", order.line, order.order_description)
        return order


def monitor_pallet_orders(
    reader: Callable[[], Dict[str, Dict[str, Any]]] = read_pallet_db7,
    session: Any = None,
    repository: Any = None,
    use_advisory_lock: bool = True,
) -> Dict[str, Any]:
    """Run one safe PLC-to-order transition cycle and commit atomically."""
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
                {"key": PALLET_MONITOR_LOCK_KEY},
            ).scalar()
            if not acquired:
                active_session.rollback()
                return {"success": True, "skipped": "another worker owns this cycle"}

        data = reader()
        repo = repository or SQLAlchemyPalletOrderRepository(active_session)
        actions = process_monitor_data(data, repo)
        active_session.commit()
        return {"success": True, "actions": actions}
    except PalletPLCReadError as exc:
        active_session.rollback()
        logger.error("Pallet order monitor PLC read failed: %s", exc)
        return {"success": False, "kind": "plc", "error": str(exc)}
    except Exception as exc:
        active_session.rollback()
        logger.error("Pallet order monitor failed: %s", exc, exc_info=True)
        return {"success": False, "kind": "database", "error": str(exc)}
