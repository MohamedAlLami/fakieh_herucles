"""REST API for stored pallet history, event orders, and current DB7 state."""

from datetime import datetime, time, timezone

from flask import Blueprint, jsonify, request
from sqlalchemy import String, cast, or_

from models.pallet_order import PalletOrder
from models.pallet_report import PalletReport
from services.pallet_report_service import (
    PalletPLCReadError,
    build_history_sessions,
    build_live_lines,
    read_pallet_db7,
)
from utils.timezone import BUSINESS_TZ

pallet_report_bp = Blueprint("pallet_report", __name__, url_prefix="/api/pallet-report")
VALID_LINES = ("ALL", "P1", "P2", "P3", "P4")
VALID_STATUSES = ("ALL", "RUNNING", "COMPLETED")


def _parse_datetime(value: str, *, end_of_date: bool = False):
    normalized = value.strip().replace("Z", "+00:00")
    if len(normalized) == 10:
        parsed_date = datetime.fromisoformat(normalized).date()
        parsed = datetime.combine(
            parsed_date, time.max if end_of_date else time.min, tzinfo=BUSINESS_TZ
        )
    else:
        parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=BUSINESS_TZ)
    return parsed.astimezone(timezone.utc)


def _filtered_order_query():
    query = PalletOrder.query
    line = request.args.get("line", "ALL").strip().upper()
    status = request.args.get("status", "ALL").strip().upper()
    if line not in VALID_LINES:
        raise ValueError("line must be ALL, P1, P2, P3, or P4")
    if status not in VALID_STATUSES:
        raise ValueError("status must be ALL, RUNNING, or COMPLETED")
    if line != "ALL":
        query = query.filter(PalletOrder.line == line)
    if status != "ALL":
        query = query.filter(PalletOrder.status == status)
    if request.args.get("start_date"):
        query = query.filter(
            PalletOrder.actual_start_time >= _parse_datetime(request.args["start_date"])
        )
    if request.args.get("end_date"):
        query = query.filter(
            PalletOrder.actual_start_time <= _parse_datetime(
                request.args["end_date"], end_of_date=True
            )
        )
    search = request.args.get("search", "").strip()
    if search:
        pattern = f"%{search}%"
        query = query.filter(
            or_(
                PalletOrder.order_description.ilike(pattern),
                PalletOrder.production_name.ilike(pattern),
                PalletOrder.material.ilike(pattern),
                cast(PalletOrder.source1, String).ilike(pattern),
                cast(PalletOrder.source2, String).ilike(pattern),
                cast(PalletOrder.destination1, String).ilike(pattern),
                cast(PalletOrder.destination2, String).ilike(pattern),
            )
        )
    return query


def _filtered_history_query():
    """Build a query against persisted minute snapshots, never live PLC state."""
    query = PalletReport.query
    line = request.args.get("line", "ALL").strip().upper()
    if line not in VALID_LINES:
        raise ValueError("line must be ALL, P1, P2, P3, or P4")
    if line != "ALL":
        query = query.filter(PalletReport.line == line)
    if request.args.get("start_date"):
        query = query.filter(
            PalletReport.recorded_at >= _parse_datetime(request.args["start_date"])
        )
    if request.args.get("end_date"):
        query = query.filter(
            PalletReport.recorded_at <= _parse_datetime(
                request.args["end_date"], end_of_date=True
            )
        )
    return query


def _filtered_history_sessions():
    rows = (
        _filtered_history_query()
        .order_by(PalletReport.line, PalletReport.recorded_at, PalletReport.id)
        .all()
    )
    sessions = build_history_sessions(rows)
    status = request.args.get("status", "ALL").strip().upper()
    if status not in VALID_STATUSES:
        raise ValueError("status must be ALL, RUNNING, or COMPLETED")
    if status != "ALL":
        sessions = [session for session in sessions if session["status"] == status]

    search = request.args.get("search", "").strip().lower()
    if search:
        sessions = [
            session
            for session in sessions
            if any(
                search in str(value).lower()
                for value in (
                    session["line"],
                    session["order_description"],
                    session["source1"],
                    session["source2"],
                    session["destination1"],
                    session["destination2"],
                    session["selection"],
                    f"P{session['selection']}" if session["selection"] else None,
                )
                if value is not None
            )
        ]
    return sessions


@pallet_report_bp.get("/live")
def pallet_live():
    try:
        timestamp = datetime.now(timezone.utc)
        lines = build_live_lines(read_pallet_db7())
        active_orders = {
            order.line: order
            for order in PalletOrder.query.filter(PalletOrder.status == "RUNNING").all()
        }
        for line, values in lines.items():
            order = active_orders.get(line)
            values["production_name"] = order.production_name if order else None
            values["material"] = order.material if order else None
            values["current_order"] = None
            values["paused"] = bool(order) and not values["running"]
            if order:
                full_seconds, actual_seconds = order.run_seconds(timestamp)
                values["current_order"] = {
                    "id": order.id,
                    "order_sequence": order.order_sequence,
                    "order_description": order.order_description,
                    "actual_start_time": order.actual_start_time.isoformat(),
                    "elapsed_seconds": full_seconds,
                    "full_run_seconds": full_seconds,
                    "actual_run_seconds": actual_seconds,
                }
        return jsonify({"success": True, "timestamp": timestamp.isoformat(), "lines": lines})
    except PalletPLCReadError as exc:
        return jsonify({"success": False, "error": "PLC unavailable", "detail": str(exc)}), 503


@pallet_report_bp.get("/orders")
def pallet_orders():
    """Return event-based production orders for integrations that need them."""
    try:
        page = max(1, int(request.args.get("page", 1)))
        page_size = int(request.args.get("page_size", 50))
        if page_size not in (25, 50, 100):
            raise ValueError("page_size must be 25, 50, or 100")
        query = _filtered_order_query()
        total = query.count()
        pages = (total + page_size - 1) // page_size
        items = (
            query.order_by(PalletOrder.actual_start_time.desc(), PalletOrder.id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
            .all()
        )
        return jsonify(
            {
                "success": True,
                "items": [item.to_dict() for item in items],
                "pagination": {
                    "page": page,
                    "page_size": page_size,
                    "total": total,
                    "pages": pages,
                },
            }
        )
    except (TypeError, ValueError) as exc:
        return jsonify({"success": False, "error": f"Invalid query parameter: {exc}"}), 400


@pallet_report_bp.get("/history")
def pallet_history():
    """Return one production report row per inferred line run."""
    try:
        page = max(1, int(request.args.get("page", 1)))
        page_size = int(request.args.get("page_size", 50))
        if page_size not in (25, 50, 100):
            raise ValueError("page_size must be 25, 50, or 100")
        sessions = _filtered_history_sessions()
        total = len(sessions)
        pages = (total + page_size - 1) // page_size
        start = (page - 1) * page_size
        items = sessions[start:start + page_size]
        return jsonify(
            {
                "success": True,
                "items": items,
                "pagination": {
                    "page": page,
                    "page_size": page_size,
                    "total": total,
                    "pages": pages,
                },
            }
        )
    except (TypeError, ValueError) as exc:
        return jsonify({"success": False, "error": f"Invalid query parameter: {exc}"}), 400


@pallet_report_bp.get("/summary")
def pallet_summary():
    try:
        sessions = _filtered_history_sessions()
        per_line = {
            line: sum(1 for session in sessions if session["line"] == line)
            for line in VALID_LINES[1:]
        }
        return jsonify(
            {
                "success": True,
                "total_orders": len(sessions),
                "running_orders": sum(
                    1 for session in sessions if session["status"] == "RUNNING"
                ),
                "completed_orders": sum(
                    1 for session in sessions if session["status"] == "COMPLETED"
                ),
                "total_product_kg": float(
                    sum(session["product_kg"] for session in sessions)
                ),
                "per_line": per_line,
            }
        )
    except (TypeError, ValueError) as exc:
        return jsonify({"success": False, "error": f"Invalid query parameter: {exc}"}), 400
