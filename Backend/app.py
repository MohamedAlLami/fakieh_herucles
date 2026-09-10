import sys
import os
# Add the Backend directory to sys.path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from flask import Flask, jsonify, request
from sqlalchemy import text
from flask_cors import CORS
from datetime import datetime, timezone
from models import db
# from routes.storage_routes import storage_bp
from routes.weighbridge import weighbridge_bp
from routes.orders import orders_bp
from routes.rfid_routes import rfid_bp
from routes.truck_routes import truck_bp
from routes.reports import reports_bp
from routes.material_routes import material_bp
import config
from routes.production_routes import production_bp
from utils.error_handler import handle_api_error, APIError
from routes.process_routes import process_bp
from routes.weigh_simple import wb_form
from routes.plant_flow import plant_bp
from routes.plc_routes import plc_bp , api_bp
from routes.orders_history_routes import orders_history_bp
from routes.data_ingestion import ingestion_bp
from routes.websocket_routes import websocket_bp, init_socketio
from routes.sqlserver_routes import sqlserver_bp
from routes.production_kpi import production_kpi_bp
from routes.kpi_material_routes import kpi_material_bp
from routes.kpi_calendar_routes import kpi_calendar_bp
from routes.distribution_routes import distribution_bp
from routes.settings_routes import settings_bp
from routes.client_routes import client_bp
from routes.truck_entry_routes import truck_entry_bp
from routes.ai_routes import ai_bp
from routes.live_routes import live_bp
from routes.pallet_report_routes import pallet_report_bp
# Import models so db.create_all() picks up the new tables (PostgreSQL).
from models.distribution import DistributionRule, SystemSetting
from models.client import Client
from models.truck_weigh_order import TruckWeighOrder
from models.order_queue import OrderQueue
from models.pallet_report import PalletReport
from models.pallet_order import PalletOrder, PalletOrderMovement, PalletOrderSequence
from background_sync import start_silo_sync

app = Flask(__name__)
app.config.from_object(config)

# Initialize the database
db.init_app(app)

# Initialize SocketIO for WebSocket support
socketio = init_socketio(app)

# Configure CORS properly - allow both localhost and network IPs
CORS(app, origins=[
    "http://localhost:5173",
    "http://192.168.199.160:5173",
    "http://192.168.1.60:5173", 
    "http://192.168.199.60:5173",
    "http://192.168.0.60:5173"
], supports_credentials=True)

# Health check endpoint
@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({
        'status': 'Server is running',
        'sqlserver_database': config.SQLSERVER_DATABASE,
        'batch_materials_table': config.SQLSERVER_BATCH_MATERIALS_TABLE,
    })

# Test endpoint to verify database connection
@app.route('/api/test', methods=['GET'])
def test_db():
    try:
        # Test database connection (SQLAlchemy 2.0 requires text() for raw SQL)
        db.session.execute(text('SELECT 1'))
        return jsonify({'status': 'Database connection successful'})
    except Exception as e:
        return jsonify({'error': f'Database connection failed: {str(e)}'}), 500

# Plant orders endpoint (redirects to PLC routes)
@app.route('/api/plant/orders', methods=['GET'])
def plant_orders_main():
    """Redirect to PLC plant orders endpoint"""
    from routes.plc_routes import plant_orders
    return plant_orders()

# Register error handlers
@app.errorhandler(APIError)
def handle_api_exception(error):
    return handle_api_error(error)

@app.errorhandler(404)
def not_found(error):
    return jsonify({
        'error': True,
        'message': 'Resource not found',
        'status_code': 404,
        'error_code': 'NOT_FOUND',
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'path': request.path,
        'method': request.method
    }), 404

@app.errorhandler(500)
def internal_error(error):
    return jsonify({
        'error': True,
        'message': 'Internal server error',
        'status_code': 500,
        'error_code': 'INTERNAL_ERROR',
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'path': request.path,
        'method': request.method
    }), 500

# Register your blueprints
# app.register_blueprint(storage_bp)
app.register_blueprint(weighbridge_bp)
app.register_blueprint(orders_bp)
app.register_blueprint(rfid_bp)
app.register_blueprint(truck_bp)
app.register_blueprint(reports_bp)
app.register_blueprint(production_bp)
app.register_blueprint(material_bp)
app.register_blueprint(process_bp)
app.register_blueprint(wb_form)
app.register_blueprint(plant_bp)
app.register_blueprint(plc_bp)
app.register_blueprint(orders_history_bp)
app.register_blueprint(ingestion_bp)
app.register_blueprint(websocket_bp)
app.register_blueprint(api_bp)
app.register_blueprint(sqlserver_bp)
app.register_blueprint(production_kpi_bp)
app.register_blueprint(kpi_material_bp, url_prefix='/api')
app.register_blueprint(kpi_calendar_bp, url_prefix='/api')
app.register_blueprint(distribution_bp)
app.register_blueprint(settings_bp)
app.register_blueprint(client_bp)
app.register_blueprint(truck_entry_bp)
app.register_blueprint(ai_bp)
app.register_blueprint(live_bp)
app.register_blueprint(pallet_report_bp)

# Boot the Hercules AI live monitor (CSV replay by default; SQL via AI_LIVE_SOURCE).
try:
    from ai_assistant.live.engine import get_engine
    get_engine()
except Exception as _ai_err:
    print(f"Hercules AI live monitor skipped: {_ai_err}")

if __name__ == '__main__':
    with app.app_context():
        # Only create tables on the default (PostgreSQL) bind. KPIMaterial is
        # mapped to the read-only SQL Server reporting DB (__bind_key__ =
        # "sqlserver"); including it here meant an unreachable reporting server
        # aborted startup even for Postgres-only features.
        try:
            db.create_all(bind_key=None)
        except Exception as _db_err:
            import sys
            print(
                "FATAL: cannot initialize the application database "
                f"({app.config.get('SQLALCHEMY_DATABASE_URI')}): {_db_err}",
                file=sys.stderr,
            )
            sys.exit(1)

        # Add distribution window columns on pre-existing installs
        try:
            from models.distribution import ensure_distribution_columns
            ensure_distribution_columns()
        except Exception as _mig_err:
            print(f"Distribution column migration skipped: {_mig_err}")

        try:
            from models.client import ensure_clients_index
            ensure_clients_index()
        except Exception as _client_idx_err:
            print(f"Clients index migration skipped: {_client_idx_err}")

        try:
            from models.truck_weigh_order import ensure_truck_weigh_orders_table
            ensure_truck_weigh_orders_table()
        except Exception as _truck_weigh_err:
            print(f"Truck weigh orders migration skipped: {_truck_weigh_err}")

        try:
            from models.order_queue import ensure_order_queue_table
            ensure_order_queue_table()
        except Exception as _order_queue_err:
            print(f"Order queue migration skipped: {_order_queue_err}")

        try:
            from models.orders import ensure_order_truck_client_columns
            ensure_order_truck_client_columns()
        except Exception as _order_cols_err:
            print(f"Order truck/client column migration skipped: {_order_cols_err}")
        
        # Start background silo sync task (in-process; avoids HTTP self-call)
        start_silo_sync(app)

        # Start the report-distribution scheduler (APScheduler cron jobs)
        try:
            from scheduler import start_scheduler
            start_scheduler(app)
        except Exception as _sched_err:
            print(f"Distribution scheduler not started: {_sched_err}")

        # Always-on order-queue dispatcher: auto-starts waiting orders regardless
        # of the websocket broadcast / UI state, and survives restarts.
        try:
            from scheduler import start_queue_dispatcher
            start_queue_dispatcher(app)
        except Exception as _queue_disp_err:
            print(f"Queue dispatcher not started: {_queue_disp_err}")

        # DB7 event monitor: translates running/selection changes into
        # restart-safe pallet orders without writing periodic sample rows.
        try:
            from scheduler import start_pallet_order_monitor
            start_pallet_order_monitor(app)
        except Exception as _pallet_sched_err:
            print(f"Pallet order monitor not started: {_pallet_sched_err}")

        # Always-on PLC broadcast: live plant orders + silo snapshot for the UI.
        # Operators no longer Start/Stop this from Live Orders.
        try:
            from routes.websocket_routes import ensure_broadcast_running
            ensure_broadcast_running(app)
        except Exception as _broadcast_err:
            print(f"PLC broadcast not started: {_broadcast_err}")

    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, debug=False, host='0.0.0.0', port=port, allow_unsafe_werkzeug=True)
