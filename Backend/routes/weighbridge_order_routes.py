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


def _fill_product_names(orders: list) -> None:
    """An imported order may have been saved before its product was in the material list."""
    cache = {}
    for order in orders:
        if not order.get("product_name"):
            code = order.get("product_code")
            if code not in cache:
                cache[code] = resolve_material_name(code) or ""
            order["product_name"] = cache[code]


@weighbridge_order_bp.route("", methods=["GET"])
@weighbridge_order_bp.route("/", methods=["GET"])
def list_orders():
    status = str(request.args.get("status") or "").strip() or None
    if status and status not in wo.STATUSES:
        return jsonify({"error": "status must be open, in_progress or closed"}), 400
    try:
        orders = wo.list_orders(status)
        _fill_product_names(orders)
        return jsonify({"orders": orders, "next_order_no": wo.next_number()}), 200
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
    _fill_product_names([row])
    return jsonify(row), 200


@weighbridge_order_bp.route("/import", methods=["POST"])
def import_orders():
    """Orders from the planning Excel sheet. Body: {"rows": [{farm_code, farm_name, quantity_exp,
    feed_code, production_num, row}], "dry_run": bool}. Existing order numbers are left alone."""
    data = request.get_json(force=True, silent=True) or {}
    try:
        plan = wo.plan_import(data.get("rows"))
        summary = {"rows": len(plan["items"]) + len(plan["errors"]), "errors": plan["errors"][:200],
                   "error_count": len(plan["errors"])}
        if data.get("dry_run"):
            summary.update(created=0, already_there=0, new_clients=0, unknown_products=[], dry_run=True)
            return jsonify(summary), 200
        summary.update(wo.import_orders(plan["items"], lambda code: resolve_material_name(code) or ""))
        return jsonify(summary), 200
    except Exception as e:
        return _fail(e, "Failed to import the orders")


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
