"""REST API for event-based pallet orders and current DB7 state."""

from datetime import datetime, time, timezone

from flask import Blueprint, jsonify, request
from sqlalchemy import String, cast, func, or_

from models.pallet_order import PalletOrder
from services.pallet_report_service import PalletPLCReadError, build_live_lines, read_pallet_db7
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
            if order:
                values["current_order"] = {
                    "id": order.id,
                    "order_sequence": order.order_sequence,
                    "order_description": order.order_description,
                    "actual_start_time": order.actual_start_time.isoformat(),
                    "elapsed_seconds": max(
                        0, int((timestamp - order.actual_start_time).total_seconds())
                    ),
                }
        return jsonify({"success": True, "timestamp": timestamp.isoformat(), "lines": lines})
    except PalletPLCReadError as exc:
        return jsonify({"success": False, "error": "PLC unavailable", "detail": str(exc)}), 503


@pallet_report_bp.get("/orders")
@pallet_report_bp.get("/history")
def pallet_orders():
    """Paginated event orders; /history remains as a compatibility alias."""
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

@pallet_report_bp.get("/summary")
def pallet_summary():
    try:
        query = _filtered_order_query()
        total_orders = query.count()
        running_orders = query.filter(PalletOrder.status == "RUNNING").count()
        completed_orders = query.filter(PalletOrder.status == "COMPLETED").count()
        total_kg = query.with_entities(
            func.coalesce(func.sum(func.coalesce(PalletOrder.final_qty, PalletOrder.latest_qty)), 0.0)
        ).scalar()
        per_line = dict(
            query.with_entities(PalletOrder.line, func.count(PalletOrder.id))
            .group_by(PalletOrder.line)
            .all()
        )
        return jsonify(
            {
                "success": True,
                "total_orders": total_orders,
                "running_orders": running_orders,
                "completed_orders": completed_orders,
                "total_product_kg": float(total_kg or 0),
                "per_line": {line: int(per_line.get(line, 0)) for line in VALID_LINES[1:]},
            }
        )
    except (TypeError, ValueError) as exc:
        return jsonify({"success": False, "error": f"Invalid query parameter: {exc}"}), 400
