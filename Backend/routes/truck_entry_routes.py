from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, request

from constants.material_codes import is_valid_material_code, resolve_material_name
from models import db
from models.truck import Driver, Truck
from models.truck_weigh_order import OPEN_STATUSES, TruckWeighOrder
from utils.baykon_scales import SCALES, get_scale, read_live_weight
from utils.timezone import BUSINESS_TZ, BUSINESS_TZ_NAME

truck_entry_bp = Blueprint("truck_entry", __name__, url_prefix="/api/truck-entry")

# The plant is in Saudi Arabia. This used to be hardcoded to "Asia/Kolkata",
# which put the business-day boundary 2.5h off and made "today" wrong for
# operators. Sourced from utils.timezone so it stays consistent app-wide.
TIMEZONE_NAME = BUSINESS_TZ_NAME


LOADING_POINTS = (1, 2, 3)


def _utcnow():
    return datetime.now(timezone.utc)


def _new_ticket() -> str:
    return f"TE-{uuid.uuid4().hex[:8].upper()}"


def _parse_date_yyyy_mm_dd(value: str):
    try:
        return datetime.fromisoformat(value).date()
    except Exception:
        return None


def _enrich_truck_maps(truck_ids: set[int]):
    truck_map: dict[int, Truck] = {}
    driver_map: dict[int, Driver] = {}

    if not truck_ids:
        return truck_map, driver_map

    trucks = Truck.query.filter(Truck.id.in_(truck_ids)).all()
    truck_map = {t.id: t for t in trucks}

    drows = Driver.query.filter(Driver.truck_id.in_(truck_ids)).all()
    for d in drows:
        prev = driver_map.get(d.truck_id)
        if prev is None:
            driver_map[d.truck_id] = d
        elif prev.status != "Active" and d.status == "Active":
            driver_map[d.truck_id] = d
        elif prev.status == d.status and d.id > prev.id:
            driver_map[d.truck_id] = d

    return truck_map, driver_map


def _order_dict(order: TruckWeighOrder, truck_map=None, driver_map=None):
    truck_map = truck_map or {}
    driver_map = driver_map or {}
    t = truck_map.get(order.truck_id)
    d = driver_map.get(order.truck_id)
    return order.to_dict(
        truck_plate=getattr(t, "license", None) if t else None,
        # The driver chosen on the weighbridge for this trip wins over the truck's usual driver.
        truck_driver=order.wb_driver_name or (getattr(d, "name", None) if d else None),
        truck_company=getattr(t, "company", None) if t else None,
    )


def _apply_memo_details(order: TruckWeighOrder, data: dict):
    """Optional memo details (bags, notes, scale operator). Returns an error text or None.

    Only the keys that are present are touched, so an exit capture that sends none of them
    behaves exactly as before.
    """
    if "bags" in data:
        raw = data.get("bags")
        if raw is None or str(raw).strip() == "":
            order.bags = None
        else:
            try:
                bags = int(str(raw).strip())
            except (TypeError, ValueError):
                return "bags must be a whole number"
            if bags < 0 or bags > 100000:
                return "bags must be between 0 and 100000"
            order.bags = bags
    if "notes" in data:
        order.memo_notes = (str(data.get("notes") or "").strip()[:500]) or None
    if "operator" in data:
        order.exit_operator = (str(data.get("operator") or "").strip()[:100]) or None
    return None


def _open_order_for_truck(truck_id: int):
    return (
        TruckWeighOrder.query.filter(
            TruckWeighOrder.truck_id == int(truck_id),
            TruckWeighOrder.status.in_(list(OPEN_STATUSES)),
        )
        .order_by(TruckWeighOrder.created_at.desc())
        .first()
    )


@truck_entry_bp.route("/scales", methods=["GET"])
def list_scales():
    """List configured weighbridge scales (1=entry, 2=exit)."""
    items = []
    for sid, meta in SCALES.items():
        items.append({
            "scale": sid,
            "name": meta["name"],
            "role": meta["role"],
            "ip": meta["ip"],
            "mac": meta["mac"],
        })
    return jsonify({"scales": items}), 200


@truck_entry_bp.route("/scales/<int:scale_id>/live", methods=["GET"])
def scale_live(scale_id: int):
    """
    Live weight from Baykon indicator.
    Scale 1 = entry (IN), Scale 2 = exit (OUT).
    """
    if get_scale(scale_id) is None:
        return jsonify({"ok": False, "error": "scale must be 1 (entry) or 2 (exit)"}), 400
    reading = read_live_weight(scale_id)
    status = 200 if reading.get("ok") else 502
    return jsonify(reading), status


@truck_entry_bp.route("/silos", methods=["GET"])
def list_silos_for_material():
    """Silos holding `material_code` (matching) and silos with no material (unassigned)."""
    from services.silo_stock import classify_silos

    material_code = str(request.args.get("material_code") or "").strip()
    if not material_code:
        return jsonify({"error": "material_code is required"}), 400
    try:
        # Reuse the Storage page source (silo_status + live PLC quantity merge).
        from routes.plc_routes import silos_from_db_under_plc_prefix
        silos = silos_from_db_under_plc_prefix().get_json() or []
    except Exception as e:
        return jsonify({"error": "Failed to load silos", "detail": str(e)}), 502
    out = classify_silos(silos, material_code)
    # Temporary silos 1001-1200 (ground storage, database only).
    try:
        from services import temp_silos
        t = temp_silos.classify(temp_silos.list_all(), material_code)
        out["tempMatching"], out["tempFree"] = t["matching"], t["free"]
    except Exception:
        out["tempMatching"], out["tempFree"] = [], []
    return jsonify(out), 200


def _silo_exists(silo_no: int) -> bool:
    from services import temp_silos
    if temp_silos.is_temp_silo(silo_no):
        return temp_silos.get_one(silo_no) is not None
    from routes.plc_routes import _app_rows
    rows = _app_rows("SELECT 1 FROM public.silo_status WHERE silo_no = %(s)s", {"s": silo_no})
    return bool(rows)


def _run_stock_update(order: TruckWeighOrder, retry: bool = False):
    """Apply the order's signed delta to its silo and record the outcome.

    Never raises: a weighbridge trip must not fail because of stock bookkeeping.
    Uses its own commit, after the trip itself is already committed.

    Retry design: stock_applied_at is stamped the moment the database quantity has
    been moved (even while stock_status is still 'pending'). A retry sees it and
    passes db_already_applied=True, so only the PLC write and status change remain.
    """
    try:
        from services import temp_silos
        from services.silo_stock import NOT_CONFIRMED_NOTE, apply_stock_delta

        if temp_silos.is_temp_silo(order.silo_no):
            _run_temp_stock_update(order, retry)
            return

        if retry:
            delta = float(order.stock_delta_kg)
        else:
            delta = float(order.first_weight_kg) - float(order.second_weight_kg)
            order.stock_delta_kg = delta
        db_done = retry and order.stock_applied_at is not None
        plc_before = (
            order.stock_qty_before
            if retry and (order.stock_note or "").startswith(NOT_CONFIRMED_NOTE)
            else None
        )
        res = apply_stock_delta(
            order.silo_no, delta, db_already_applied=db_done, plc_before_attempt=plc_before
        )
        order.stock_status = res["status"]
        if res.get("qty_before") is not None:
            order.stock_qty_before = res["qty_before"]
        if res.get("qty_after") is not None:
            order.stock_qty_after = res["qty_after"]
        if res["status"] == "applied" or (res.get("db_applied") and not db_done):
            order.stock_applied_at = _utcnow()
        order.stock_note = (res.get("note") or "")[:255]
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        try:
            order.stock_status = "pending"
            order.stock_note = f"stock update error: {e}"[:255]
            db.session.commit()
        except Exception:
            db.session.rollback()


def _run_temp_stock_update(order: TruckWeighOrder, retry: bool):
    """Temporary silo (1001-1200): database only, never the PLC. Raises to the caller's handler."""
    from services import temp_silos

    if retry and order.stock_delta_kg is not None:
        delta = float(order.stock_delta_kg)
    else:
        delta = float(order.first_weight_kg) - float(order.second_weight_kg)
        order.stock_delta_kg = delta
    if delta == 0:
        order.stock_status = "skipped"
        order.stock_note = "zero delta"
        db.session.commit()
        return
    try:
        before, after = temp_silos.apply_trip(
            order.silo_no, delta, order.material_code, order.material_name or "", order.id
        )
    except temp_silos.TempSiloError as e:
        order.stock_status = "pending"
        order.stock_note = str(e)[:255]
        db.session.commit()
        return
    order.stock_status = "applied"
    order.stock_qty_before = before
    order.stock_qty_after = after
    order.stock_applied_at = _utcnow()
    order.stock_note = temp_silos.TEMP_NOTE + (" (below zero)" if after < 0 else "")
    db.session.commit()


def _temp_silo_conflict(silo_no: int, material_code: str):
    """Why a temporary silo cannot take this material, or None."""
    from services import temp_silos

    row = temp_silos.get_one(silo_no)
    if row and row["materialCode"] and not temp_silos.same_material(row["materialCode"], material_code):
        return f"Temporary silo {silo_no} holds material {row['materialCode']} {row['materialName']}".strip()
    others = TruckWeighOrder.query.filter(
        TruckWeighOrder.silo_no == silo_no,
        TruckWeighOrder.status.in_(list(OPEN_STATUSES)),
    ).all()
    for o in others:
        if not temp_silos.same_material(o.material_code, material_code):
            return (f"Temporary silo {silo_no} is taken by open trip {o.ticket} "
                    f"with material {o.material_code}")
    return None


@truck_entry_bp.route("/orders/<int:order_id>/apply-stock", methods=["POST"])
def apply_stock(order_id: int):
    """Retry the silo stock update of a completed order whose stock_status is 'pending'."""
    order = TruckWeighOrder.query.filter_by(id=order_id).with_for_update().first()
    if not order:
        return jsonify({"error": "Order not found"}), 404
    if order.stock_status == "applied":
        return jsonify({"error": "Stock already applied", "stock_status": "applied"}), 409
    if order.stock_status != "pending" or order.silo_no is None or order.stock_delta_kg is None:
        return jsonify({"error": "Order has no pending stock update"}), 409

    _run_stock_update(order, retry=True)
    truck_map, driver_map = _enrich_truck_maps({order.truck_id})
    return jsonify(_order_dict(order, truck_map, driver_map)), 200


@truck_entry_bp.route("/orders", methods=["POST"])
def create_order():
    data = request.get_json(force=True) or {}
    truck_id = data.get("truck_id")
    material_code = str(data.get("material_code") or "").strip()

    if truck_id is None:
        return jsonify({"error": "truck_id is required"}), 400

    # Optional weighbridge order: the trip takes its product, client and quantity from it.
    wb_order = None
    raw_order_no = data.get("order_no")
    if raw_order_no is not None and raw_order_no != "":
        if isinstance(raw_order_no, bool) or not str(raw_order_no).strip().isdigit():
            return jsonify({"error": "order_no must be a whole number"}), 400
        from services import weighbridge_orders as wo
        try:
            wb_order = wo.get_by_no(int(str(raw_order_no).strip()))
        except Exception as e:
            return jsonify({"error": "Could not load the order", "detail": str(e)}), 500
        if wb_order is None:
            return jsonify({"error": f"Order {raw_order_no} not found"}), 400
        if wb_order["status"] != "open":
            what = "already closed" if wb_order["status"] == "closed" else "already in use by another truck"
            return jsonify({"error": f"Order {wb_order['order_no']} is {what}"}), 409
        if not material_code:
            material_code = wb_order["product_code"]
        elif material_code != wb_order["product_code"]:
            return jsonify({
                "error": f"Order {wb_order['order_no']} is for product {wb_order['product_code']}, "
                         f"not {material_code}",
            }), 400

    # Optional driver (from Management > Drivers) and loading point (1, 2 or 3).
    wb_driver = None
    raw_driver = data.get("driver_id")
    if raw_driver is not None and raw_driver != "":
        if isinstance(raw_driver, bool) or not str(raw_driver).strip().isdigit():
            return jsonify({"error": "driver_id must be a whole number"}), 400
        wb_driver = Driver.query.get(int(str(raw_driver).strip()))
        if wb_driver is None:
            return jsonify({"error": f"Driver {raw_driver} not found"}), 400
    loading_point = None
    raw_lp = data.get("loading_point")
    if raw_lp is not None and raw_lp != "":
        if isinstance(raw_lp, bool) or not str(raw_lp).strip().isdigit() or int(str(raw_lp).strip()) not in LOADING_POINTS:
            return jsonify({"error": "loading_point must be 1, 2 or 3"}), 400
        loading_point = int(str(raw_lp).strip())

    if not material_code:
        return jsonify({"error": "material_code is required"}), 400
    if not is_valid_material_code(material_code):
        return jsonify({"error": f"Invalid material_code: {material_code}"}), 400

    silo_no = None
    raw_silo = data.get("silo_no")
    if raw_silo is not None and raw_silo != "":
        if isinstance(raw_silo, bool) or not isinstance(raw_silo, (int, str)) or (
            isinstance(raw_silo, str) and not raw_silo.strip().lstrip("-").isdigit()
        ):
            return jsonify({"error": "silo_no must be an integer"}), 400
        silo_no = int(raw_silo)
        try:
            exists = _silo_exists(silo_no)
        except Exception as e:
            return jsonify({"error": "Could not verify silo", "detail": str(e)}), 500
        if not exists:
            return jsonify({"error": f"Silo {silo_no} not found"}), 400
        from services import temp_silos
        if temp_silos.is_temp_silo(silo_no):
            try:
                conflict = _temp_silo_conflict(silo_no, material_code)
            except Exception as e:
                return jsonify({"error": "Could not verify silo", "detail": str(e)}), 500
            if conflict:
                return jsonify({"error": conflict}), 400

    truck = Truck.query.get(int(truck_id))
    if not truck:
        return jsonify({"error": f"Truck {truck_id} not found"}), 404

    existing = _open_order_for_truck(int(truck_id))
    if existing:
        return jsonify({
            "error": "Truck already has an open weigh order",
            "order_id": existing.id,
            "ticket": existing.ticket,
            "status": existing.status,
        }), 409

    material_name = resolve_material_name(material_code)
    order = TruckWeighOrder(
        ticket=_new_ticket(),
        truck_id=int(truck_id),
        material_code=material_code,
        material_name=material_name,
        silo_no=silo_no,
        status="awaiting_first",
        created_at=_utcnow(),
        wb_order_no=wb_order["order_no"] if wb_order else None,
        wb_client_name=wb_order["client_name"] if wb_order else None,
        wb_order_qty_kg=wb_order["quantity_kg"] if wb_order else None,
        wb_driver_id=wb_driver.id if wb_driver else None,
        wb_driver_name=wb_driver.name if wb_driver else None,
        loading_point=loading_point,
    )
    try:
        db.session.add(order)
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": "Failed to create order", "detail": str(e)}), 500

    if wb_order:
        # Take the order for this trip. If someone else took it a moment ago, undo the trip.
        from services import weighbridge_orders as wo
        try:
            wo.attach(wb_order["order_no"], order.id)
        except Exception as e:
            try:
                db.session.delete(order)
                db.session.commit()
            except Exception:
                db.session.rollback()
            code = getattr(e, "code", 500)
            return jsonify({"error": str(e) if code != 500 else "Could not take the order",
                            "detail": str(e)}), code

    truck_map, driver_map = _enrich_truck_maps({order.truck_id})
    return jsonify(_order_dict(order, truck_map, driver_map)), 201


@truck_entry_bp.route("/orders/<int:order_id>/first", methods=["POST"])
def save_first_weight(order_id: int):
    data = request.get_json(force=True) or {}
    weight = data.get("weight")

    if weight is None:
        return jsonify({"error": "weight is required"}), 400
    try:
        weight_val = float(weight)
    except (TypeError, ValueError):
        return jsonify({"error": "weight must be a number"}), 400
    if weight_val <= 0:
        return jsonify({"error": "weight must be greater than 0"}), 400

    order = TruckWeighOrder.query.get(order_id)
    if not order:
        return jsonify({"error": "Order not found"}), 404
    if order.status != "awaiting_first":
        return jsonify({"error": f"Order status is '{order.status}', expected 'awaiting_first'"}), 409

    order.first_weight_kg = weight_val
    order.first_ts = _utcnow()
    order.status = "awaiting_second"

    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": "Failed to save first weight", "detail": str(e)}), 500

    truck_map, driver_map = _enrich_truck_maps({order.truck_id})
    return jsonify(_order_dict(order, truck_map, driver_map)), 200


@truck_entry_bp.route("/orders/<int:order_id>/second", methods=["POST"])
def save_second_weight(order_id: int):
    data = request.get_json(force=True) or {}
    weight = data.get("weight")

    if weight is None:
        return jsonify({"error": "weight is required"}), 400
    try:
        weight_val = float(weight)
    except (TypeError, ValueError):
        return jsonify({"error": "weight must be a number"}), 400
    if weight_val <= 0:
        return jsonify({"error": "weight must be greater than 0"}), 400

    order = TruckWeighOrder.query.get(order_id)
    if not order:
        return jsonify({"error": "Order not found"}), 404
    if order.status != "awaiting_second":
        return jsonify({"error": f"Order status is '{order.status}', expected 'awaiting_second'"}), 409
    if order.first_weight_kg is None:
        return jsonify({"error": "First weight must be recorded before second weight"}), 409

    memo_error = _apply_memo_details(order, data)
    if memo_error:
        return jsonify({"error": memo_error}), 400

    order.second_weight_kg = weight_val
    order.second_ts = _utcnow()
    order.net_kg = order.compute_net()
    order.status = "completed"

    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": "Failed to save second weight", "detail": str(e)}), 500

    # The truck has exited: its weighbridge order (if any) is closed. Never fails the trip.
    if order.wb_order_no is not None:
        try:
            from services import weighbridge_orders as wo
            wo.close(order.id)
        except Exception:
            pass

    # Trip is committed. Silo stock is best effort and must never fail the trip.
    if order.silo_no is not None and order.stock_status != "applied":
        _run_stock_update(order)

    truck_map, driver_map = _enrich_truck_maps({order.truck_id})
    return jsonify(_order_dict(order, truck_map, driver_map)), 200


@truck_entry_bp.route("/orders/<int:order_id>/memo", methods=["PUT"])
def save_memo_details(order_id: int):
    """Correct the memo details of a trip (bags, notes, scale operator) before a reprint."""
    data = request.get_json(force=True) or {}
    order = TruckWeighOrder.query.get(order_id)
    if not order:
        return jsonify({"error": "Order not found"}), 404
    memo_error = _apply_memo_details(order, data)
    if memo_error:
        return jsonify({"error": memo_error}), 400
    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": "Failed to save memo details", "detail": str(e)}), 500
    truck_map, driver_map = _enrich_truck_maps({order.truck_id})
    return jsonify(_order_dict(order, truck_map, driver_map)), 200


def _memo_trip(order_id: int):
    order = TruckWeighOrder.query.get(order_id)
    if not order:
        return None
    truck_map, driver_map = _enrich_truck_maps({order.truck_id})
    return _order_dict(order, truck_map, driver_map)


@truck_entry_bp.route("/orders/<int:order_id>/memo.html", methods=["GET"])
def memo_html(order_id: int):
    """The filled Dispatch and Receive Memo as a page (what the browser prints)."""
    from flask import Response
    from services import dispatch_memo

    trip = _memo_trip(order_id)
    if trip is None:
        return jsonify({"error": "Order not found"}), 404
    return Response(dispatch_memo.build_memo_html(trip), mimetype="text/html; charset=utf-8")


@truck_entry_bp.route("/orders/<int:order_id>/memo.pdf", methods=["GET"])
def memo_pdf(order_id: int):
    """The same memo as a PDF file. 503 when this machine cannot make a PDF."""
    from flask import Response
    from services import dispatch_memo

    trip = _memo_trip(order_id)
    if trip is None:
        return jsonify({"error": "Order not found"}), 404
    try:
        data = dispatch_memo.html_to_pdf(dispatch_memo.build_memo_html(trip))
    except dispatch_memo.MemoPdfError as e:
        return jsonify({"error": "The PDF could not be made on the Hercules server", "detail": str(e)}), 503
    name = dispatch_memo.memo_file_name(trip)
    return Response(data, mimetype="application/pdf", headers={
        "Content-Disposition": f'attachment; filename="{name}"',
        "Cache-Control": "no-store",
    })


@truck_entry_bp.route("/memo-pdf/status", methods=["GET"])
def memo_pdf_status():
    """Can this machine make the memo PDF? ?refresh=1 tries again now."""
    from services import dispatch_memo

    return jsonify(dispatch_memo.pdf_status(force=request.args.get("refresh") == "1")), 200


@truck_entry_bp.route("/orders/open", methods=["GET"])
def list_open_orders():
    orders = (
        TruckWeighOrder.query.filter(TruckWeighOrder.status.in_(list(OPEN_STATUSES)))
        .order_by(TruckWeighOrder.created_at.desc())
        .all()
    )
    truck_ids = {o.truck_id for o in orders}
    truck_map, driver_map = _enrich_truck_maps(truck_ids)
    return jsonify({
        "orders": [_order_dict(o, truck_map, driver_map) for o in orders],
        "count": len(orders),
    }), 200


@truck_entry_bp.route("/orders/today", methods=["GET"])
def list_completed_today():
    date_str = request.args.get("date")

    # Business day is based on completion (OUT) time, not order creation time.
    # We resolve the local day to a half-open [start, end) range of absolute
    # timestamps and compare the bare column against it. The previous version
    # wrapped the column (`date(timezone(tz, second_ts)) == day`), which makes
    # the predicate non-sargable — Postgres cannot use an index on second_ts and
    # has to compute the expression for every row.
    if date_str:
        day = _parse_date_yyyy_mm_dd(date_str)
        if not day:
            return jsonify({"error": "date must be YYYY-MM-DD"}), 400
    else:
        day = datetime.now(BUSINESS_TZ).date()

    day_label = day.isoformat()
    start_local = datetime(day.year, day.month, day.day, tzinfo=BUSINESS_TZ)
    end_local = start_local + timedelta(days=1)

    orders = (
        TruckWeighOrder.query.filter(
            TruckWeighOrder.status == "completed",
            TruckWeighOrder.second_ts.isnot(None),
            TruckWeighOrder.second_ts >= start_local,
            TruckWeighOrder.second_ts < end_local,
        )
        .order_by(TruckWeighOrder.second_ts.desc().nullslast(), TruckWeighOrder.id.desc())
        .all()
    )

    truck_ids = {o.truck_id for o in orders}
    truck_map, driver_map = _enrich_truck_maps(truck_ids)
    rows = [_order_dict(o, truck_map, driver_map) for o in orders]

    return jsonify({"date": day_label, "rows": rows, "count": len(rows)}), 200


@truck_entry_bp.route("/orders/<int:order_id>", methods=["GET"])
def get_order(order_id: int):
    order = TruckWeighOrder.query.get(order_id)
    if not order:
        return jsonify({"error": "Order not found"}), 404
    truck_map, driver_map = _enrich_truck_maps({order.truck_id})
    return jsonify(_order_dict(order, truck_map, driver_map)), 200


@truck_entry_bp.route("/orders/<int:order_id>", methods=["DELETE"])
def delete_order(order_id: int):
    """Cancel/remove an open weigh trip so the truck can be used again.

    Only open trips can be cancelled and stock moves only on exit weight, so
    cancelling never reverses (and never needs to reverse) stock.
    """
    order = TruckWeighOrder.query.get(order_id)
    if not order:
        return jsonify({"error": "Order not found"}), 404
    if order.status not in OPEN_STATUSES:
        return jsonify({
            "error": f"Only open trips can be deleted (status is '{order.status}')",
        }), 409

    order.status = "cancelled"
    try:
        db.session.commit()
    except Exception as e:
        db.session.rollback()
        return jsonify({"error": "Failed to delete order", "detail": str(e)}), 500

    # A cancelled trip gives its weighbridge order back: it is open again.
    if order.wb_order_no is not None:
        try:
            from services import weighbridge_orders as wo
            wo.release(order.id)
        except Exception:
            pass

    truck_map, driver_map = _enrich_truck_maps({order.truck_id})
    return jsonify(_order_dict(order, truck_map, driver_map)), 200


@truck_entry_bp.route("/status/by-truck", methods=["GET"])
def status_by_truck():
    """Map truck_id -> open order summary (for Truck Management)."""
    orders = TruckWeighOrder.query.filter(
        TruckWeighOrder.status.in_(list(OPEN_STATUSES))
    ).all()
    truck_ids = {o.truck_id for o in orders}
    truck_map, driver_map = _enrich_truck_maps(truck_ids)

    by_truck = {}
    for o in orders:
        by_truck[str(o.truck_id)] = _order_dict(o, truck_map, driver_map)

    return jsonify({"by_truck": by_truck, "count": len(by_truck)}), 200
