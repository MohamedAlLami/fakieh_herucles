"""Temporary silos 1001-1200 (ground storage). Database only; no PLC involved."""
from __future__ import annotations

from flask import Blueprint, jsonify, request

from constants.material_codes import is_valid_material_code, resolve_material_name
from services import temp_silos

temp_silo_bp = Blueprint("temp_silos", __name__, url_prefix="/api/temp-silos")


@temp_silo_bp.route("", methods=["GET"])
@temp_silo_bp.route("/", methods=["GET"])
def list_temp_silos():
    try:
        return jsonify(temp_silos.list_all()), 200
    except Exception as e:
        return jsonify({"error": "Failed to load temporary silos", "detail": str(e)}), 500


@temp_silo_bp.route("/<int:silo_no>", methods=["PUT"])
def edit_temp_silo(silo_no: int):
    """Hand edit: {material_code, quantity_kg}. Quantity 0 empties the silo and frees it."""
    if not temp_silos.is_temp_silo(silo_no):
        return jsonify({"error": f"Silo {silo_no} is not a temporary silo"}), 404
    data = request.get_json(force=True, silent=True) or {}
    code = str(data.get("material_code") or "").strip()
    qty = data.get("quantity_kg")
    if isinstance(qty, bool) or qty is None or qty == "":
        return jsonify({"error": "quantity_kg is required"}), 400
    if code and not is_valid_material_code(code):
        return jsonify({"error": f"Invalid material_code: {code}"}), 400
    try:
        from models.truck_weigh_order import OPEN_STATUSES, TruckWeighOrder
        open_trip = TruckWeighOrder.query.filter(
            TruckWeighOrder.silo_no == silo_no,
            TruckWeighOrder.status.in_(list(OPEN_STATUSES)),
        ).first()
        if open_trip is not None and not temp_silos.same_material(open_trip.material_code, code):
            return jsonify({
                "error": f"Trip {open_trip.ticket} is open on this silo with material "
                         f"{open_trip.material_code}; finish or cancel it first",
            }), 409
        row = temp_silos.set_manual(
            silo_no, code, resolve_material_name(code) or "", qty, note=str(data.get("note") or "")
        )
    except temp_silos.TempSiloError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": "Failed to save temporary silo", "detail": str(e)}), 500
    return jsonify(row), 200


@temp_silo_bp.route("/<int:silo_no>/log", methods=["GET"])
def temp_silo_log(silo_no: int):
    if not temp_silos.is_temp_silo(silo_no):
        return jsonify({"error": f"Silo {silo_no} is not a temporary silo"}), 404
    try:
        return jsonify(temp_silos.log_for(silo_no)), 200
    except Exception as e:
        return jsonify({"error": "Failed to load the log", "detail": str(e)}), 500
