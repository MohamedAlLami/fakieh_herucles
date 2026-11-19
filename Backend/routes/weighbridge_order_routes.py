"""Weighbridge orders (Management > Weighbridge Orders). Database only."""
from __future__ import annotations

from flask import Blueprint, jsonify, request

from constants.material_codes import is_valid_material_code, resolve_material_name
from services import weighbridge_orders as wo

weighbridge_order_bp = Blueprint("weighbridge_orders", __name__, url_prefix="/api/weighbridge-orders")


def _fail(e: Exception, what: str):
    if isinstance(e, wo.OrderError):
        return jsonify({"error": str(e)}), e.code
    return jsonify({"error": what, "detail": str(e)}), 500


def _resolve(data: dict):
    """Validated fields plus the product and client names to store."""
    fields = wo.clean_fields(
        data.get("order_no"), data.get("product_code"), data.get("quantity_kg"), data.get("client_id")
    )
    if not is_valid_material_code(fields["product_code"]):
        raise wo.OrderError(f"unknown product code {fields['product_code']}")
    from models.client import Client
    client = Client.query.get(fields["client_id"])
    if client is None:
        raise wo.OrderError("client not found")
    return fields, resolve_material_name(fields["product_code"]) or "", client.name


@weighbridge_order_bp.route("", methods=["GET"])
@weighbridge_order_bp.route("/", methods=["GET"])
def list_orders():
    status = str(request.args.get("status") or "").strip() or None
    if status and status not in wo.STATUSES:
        return jsonify({"error": "status must be open, in_progress or closed"}), 400
    try:
        return jsonify({"orders": wo.list_orders(status), "next_order_no": wo.next_number()}), 200
    except Exception as e:
        return _fail(e, "Failed to load orders")


@weighbridge_order_bp.route("/by-number/<int:order_no>", methods=["GET"])
def get_order(order_no: int):
    try:
        row = wo.get_by_no(order_no)
    except Exception as e:
        return _fail(e, "Failed to load the order")
    if row is None:
        return jsonify({"error": f"Order {order_no} not found"}), 404
    return jsonify(row), 200


@weighbridge_order_bp.route("", methods=["POST"])
@weighbridge_order_bp.route("/", methods=["POST"])
def create_order():
    data = request.get_json(force=True, silent=True) or {}
    try:
        fields, product_name, client_name = _resolve(data)
        return jsonify(wo.create(fields, product_name, client_name)), 201
    except Exception as e:
        return _fail(e, "Failed to save the order")


@weighbridge_order_bp.route("/<int:order_id>", methods=["PUT"])
def update_order(order_id: int):
    data = request.get_json(force=True, silent=True) or {}
    try:
        fields, product_name, client_name = _resolve(data)
        return jsonify(wo.update(order_id, fields, product_name, client_name)), 200
    except Exception as e:
        return _fail(e, "Failed to save the order")


@weighbridge_order_bp.route("/<int:order_id>", methods=["DELETE"])
def delete_order(order_id: int):
    try:
        wo.delete(order_id)
        return jsonify({"ok": True}), 200
    except Exception as e:
        return _fail(e, "Failed to delete the order")
