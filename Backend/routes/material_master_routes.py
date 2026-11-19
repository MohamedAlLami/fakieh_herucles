"""The live material list (kept in step with the batch system's Materials.xml). Read only."""
from __future__ import annotations

from flask import Blueprint, jsonify, request

from services import material_master

material_master_bp = Blueprint("material_master", __name__, url_prefix="/api/material-master")


@material_master_bp.route("", methods=["GET"])
@material_master_bp.route("/", methods=["GET"])
def get_material_master():
    """{materials: active [{code, name}], inactive: [{code, name}], status: {...}}."""
    try:
        if request.args.get("refresh") == "1":
            material_master.sync_from_file(force=True)
        return jsonify({
            "materials": material_master.active_materials(),
            "inactive": material_master.inactive_materials(),
            "status": material_master.status(),
        }), 200
    except Exception as e:
        return jsonify({"error": "Failed to load the material list", "detail": str(e)}), 500
