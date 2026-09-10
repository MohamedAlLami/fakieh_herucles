"""REST API for Pallet Report live state and PostgreSQL history."""

from datetime import datetime, time, timezone

from flask import Blueprint, jsonify, request
from sqlalchemy import func

from models.pallet_report import PalletReport
from services.pallet_report_service import PalletPLCReadError, build_live_lines, read_pallet_db7
from utils.timezone import BUSINESS_TZ

pallet_report_bp = Blueprint("pallet_report", __name__, url_prefix="/api/pallet-report")


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
        # The dashboard's established convention treats timezone-free user
        # input as Saudi local time.
        parsed = parsed.replace(tzinfo=BUSINESS_TZ)
    return parsed.astimezone(timezone.utc)


@pallet_report_bp.get("/live")
def pallet_live():
    try:
        lines = build_live_lines(read_pallet_db7())
        return jsonify(
            {"success": True, "timestamp": datetime.now(timezone.utc).isoformat(), "lines": lines}
        )
    except PalletPLCReadError as exc:
        return jsonify({"success": False, "error": "PLC unavailable", "detail": str(exc)}), 503


@pallet_report_bp.get("/history")
def pallet_history():
    try:
        page = max(1, int(request.args.get("page", 1)))
        page_size = int(request.args.get("page_size", 50))
        if page_size not in (25, 50, 100):
            return jsonify({"success": False, "error": "page_size must be 25, 50, or 100"}), 400

        line = request.args.get("line", "ALL").strip().upper()
        if line not in ("ALL", "P1", "P2", "P3", "P4"):
            return jsonify({"success": False, "error": "line must be ALL, P1, P2, P3, or P4"}), 400

        query = PalletReport.query
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

        total = query.count()
        pages = (total + page_size - 1) // page_size
        items = (
            query.order_by(PalletReport.recorded_at.desc(), PalletReport.id.desc())
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
    rows = (
        PalletReport.query.with_entities(
            PalletReport.line,
            func.count(PalletReport.id),
            func.max(PalletReport.recorded_at),
        )
        .group_by(PalletReport.line)
        .order_by(PalletReport.line)
        .all()
    )
    return jsonify(
        {
            "success": True,
            "lines": {
                line: {
                    "samples": count,
                    "last_recorded_at": latest.isoformat() if latest else None,
                }
                for line, count, latest in rows
            },
        }
    )
