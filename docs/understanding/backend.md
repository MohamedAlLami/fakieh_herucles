# Backend map (Flask core) - read before editing

Paths relative to repo root. Python 3.12 locally. Evidence: static reading + `pytest` run (see section 6). No SAP integration exists in the code (a grep for the word `sap` hits nothing).

## 1. Startup / config
- Entry: `Backend/app.py` (247 lines). `python Backend/app.py` (also `start.sh:17` runs `python3 Backend/app.py` next to `npx vite --port 8080` in `frontend-package`). No app factory; `app` is module-level, so importing `app` registers everything and **boots the AI live monitor as an import side-effect** (`app.py:150-155`, `ai_assistant.live.engine.get_engine()`).
- Port: env `PORT`, default 5000, host `0.0.0.0` (`app.py:246-247`). `socketio.run(..., async_mode='threading', allow_unsafe_werkzeug=True, debug=False)`. `eventlet` is in requirements but unused (`init_socketio` uses threading, `routes/websocket_routes.py:36`).
- Everything that starts workers lives under `if __name__ == '__main__':` (`app.py:157`). **Running under gunicorn / `flask run` / `import app` starts NO schedulers, no PLC broadcast, no silo sync, no table creation.**
- Startup order in `__main__` (app.py:157-246): `db.create_all(bind_key=None)` (fatal exit if the Postgres app DB fails) -> idempotent `ensure_*` helpers (distribution cols, clients index, truck_weigh_orders, order_queue, order truck/client cols; each in try/except, failures only printed) -> `start_silo_sync` -> `start_scheduler` -> `start_queue_dispatcher` -> `start_pallet_order_monitor` -> `start_pallet_historian` -> `ensure_broadcast_running`.
- Config: `Backend/config.py` (env-overridable; defaults hard-coded incl. dev passwords). Env vars: `DB_USERNAME DB_PASSWORD DB_HOST DB_PORT` (Postgres), `SQLSERVER_USER/PASSWORD/SERVER/DATABASE/BATCH_MATERIALS_TABLE`, `PLC_POLL_INTERVAL` (0.5s), `PLC_ORDERS_CACHE_TTL_SEC` (1.25), `SQLALCHEMY_POOL_*`. Secrets exist as plaintext **defaults in config.py:10-11, 19-20** (not copied here; override via env). Resend/SMTP secrets are stored in Postgres `system_settings` (`smtp_config.py`, `models/distribution.py:SystemSetting`). AI keys via env (`GEMINI_API_KEY GOOGLE_API_KEY ANTHROPIC_API_KEY DEEPSEEK_API_KEY`, `AI_*`).
- PLC config: `Backend/config.json` (ip/rack/slot/default_db/demo_mode) merged over `DEFAULT_CONFIG` in `routes/plc_routes.py:15-47`; env overrides `PLC_IP PLC_RACK PLC_SLOT PLC_DB READ_LEN DEMO_MODE CHECK_SILOS DB_ABSENT_COOLDOWN_SEC ALLOW_FORCE_WRITES(default true) QUEUE_STRICT_RFID(1) QUEUE_MULTIWORKER_LOCK(0) QUEUE_ADVISORY_LOCK_KEY QUEUE_DISPATCH_INTERVAL_SEC(2) PALLET_MONITOR_INTERVAL_SEC(2) PALLET_HISTORY_INTERVAL_SEC(60) BROADCAST_SILO_SYNC_MIN_SEC(15) WS_CONNECT_SILO_PERSIST_MIN_SEC(20) POLL_SEC ONLY_ON_CHANGES PLC_VERBOSE_LOGS`, list-limit vars `*_LIST_DEFAULT/MAX`, `KPI_*`.
- DBs (3 engines via Flask-SQLAlchemy binds, `config.py:15, 34-39`):
  - default bind: Postgres database `Faikeh` (psycopg2) - app data.
  - bind `plc`: Postgres database `plc` - PLC tag-mapping tables (read by `_pg_rows`, plc_routes.py:75; falls back to default engine).
  - bind `sqlserver`: MSSQL via pyodbc "ODBC Driver 17", server `DESKTOP-N8PGI9S\FAKIEH_REPORTING`, db `ASMBatchReports`, table `BatchMaterials_Shadow` (read-only reporting; `models/kpi_material.py`, `routes/sqlserver_routes.py`, `production_kpi.py`).
- CORS: hard-coded origin list `app.py:57-63` (localhost:5173 + 4 LAN IPs, all port 5173). SocketIO `cors_allowed_origins="*"`. A frontend on :8080 (start.sh) is NOT in the CORS list.
- Error handlers: `utils/error_handler.py` (`APIError`), 404/500 JSON in app.py:97-122.

## 2. HTTP routes
Handlers in `Backend/routes/` unless noted. Blueprint prefix in brackets.

| Method | Path | Handler (file:line) | Purpose |
|---|---|---|---|
| GET | /api/health | app.py:67 | status + SQL Server DB names |
| GET | /api/test | app.py:76 | SELECT 1 on app DB |
| GET | /api/plant/orders | app.py:86 | alias to plc_routes.plant_orders |
| | **PLC admin [/api/plc]** | plc_routes.py | |
| GET | /api/plc/info, /health | 1131, 1144 | snap7 loaded / PLC connect check |
| GET | /api/plc/db/<n>/probe, /health, /lines, /silos | 1164, 1181, 1197, 1205 | raw DB probing/decoding |
| GET | /api/plc/db/5/silos-qty | 1214 | DB5 silo quantities |
| GET | /api/plc/db/<n>/orders | 1225 | orders for DB n |
| GET | /api/plc/plant/orders | 1839 | live orders snapshot (TTL cache while broadcast on; `?nocache=1`) |
| POST | /api/plc/rfid/assign | 1931 | **PLC WRITE** push RFID/order to a line |
| POST | /api/plc/db/1/intake/line/<line>/write | 2023 | **PLC WRITE** DB1 intake |
| POST | /api/plc/db/3/mineral/line/<line>/write | 2104 | **PLC WRITE** DB3 mineral |
| POST | /api/plc/db/2/outloading/line/<line>/write | 2151 | **PLC WRITE** DB2 outloading |
| POST | /api/plc/db/4/bulk/write | 2235 | **PLC WRITE** DB4 bulk |
| POST | /api/plc/db/4/pit/write | 2317 | **PLC WRITE** DB4 pit |
| POST | /api/plc/silos/sync | 2446 | read PLC silos, upsert `silo_status` |
| GET | /api/plc/silos, /silos-plc | 2491, 2518 | silos from DB / direct PLC |
| GET | /api/plc/db-health, /lines, /orders, /test-simple | 2569-2580 | legacy aliases (default DB) |
| GET/POST | /api/plc/orders/mineral | 2658 | legacy mineral orders (POST = **PLC WRITE** via create_mineral_order 2611) |
| GET | /api/plc/orders/mineral/test, /debug/routes | 2666, 2678 | debug |
| POST | /api/plc/orders/clear-legacy-mineral, /clear-conflicts, /clear-mineral | 2695, 2723, 2761 | **PLC WRITE** clear tags |
| POST | /api/plc/orders/enqueue | 2777 | add to `order_queue` (waiting) |
| GET | /api/plc/orders/queue | 2887 | list queue |
| POST | /api/plc/orders/queue/<id>/start | 2913 | **PLC WRITE** dispatch queued order |
| POST | /api/plc/orders/queue/<id>/cancel | 2973 | cancel |
| POST | /api/plc/orders/create | 3000 | **PLC WRITE** create order (mineral/intake/outloading/bulk/pit) |
| GET | /api/silos, /api/bin-materials | 2523, 2546 | frontend silos (api_bp, prefix /api) |
| | **WebSocket [/api/websocket]** | websocket_routes.py | |
| POST | /api/websocket/start-broadcast, /stop-broadcast | 200, 212 | toggle PLC broadcast thread (auto-started anyway) |
| GET | /api/websocket/status | 222 | |
| WS | events connect/disconnect/join/leave/subscribe_plc/unsubscribe_plc; emits `plc_data`, `status`, `error` | 45-100 | |
| | **Orders [/api/orders]** | orders.py | DB CRUD of order tables |
| GET | /test, /intake1, /intake2, /mineral, /outload1-3, /bulk, /pt | 14-705 | list by line |
| GET/DELETE | /intake/<id>, /outloading/<id>, /bulk/<id>, /pt/<id> | 198-794 | |
| POST | /intake, /outloading, /bulk, /pt, /seed | 243, 488, 651, 819, 870 | create (DB only) / seed |
| GET | /api/orders/active, /completed, /history, /stats | orders_history_routes.py:65, 118, 210, 328 | |
| DELETE | /api/orders/<id> | orders_history_routes.py:416 | |
| | **Clients [/api/clients]** | client_routes.py | GET /, GET/PUT/DELETE /<id>, POST / (59-130) |
| | **Trucks [/api/trucks]** | truck_routes.py | GET/POST /, GET/PUT/DELETE /<id>, /drivers CRUD, /drivers/status/<s>, /drivers/truck/<id> (26-241) |
| | **RFID [/api/rfid]** | rfid_routes.py | GET /stream; POST /simulate/seed, /simulate/ping; /tags CRUD; /config CRUD; GET /available; POST /config/assign (33-241). `/config/release` commented out (289) |
| POST | /api/weighbridge/capture-by-rfid | weighbridge.py:859 | record weight by RFID (file is mostly commented old code; live Blueprint at 677) |
| | **Truck entry [/api/truck-entry]** | truck_entry_routes.py | GET /scales, /scales/<id>/live; POST /orders, /orders/<id>/first, /<id>/second; GET /orders/open, /today, /<id>; DELETE /orders/<id>; GET /status/by-truck (83-313). Scales read over HTTP via `utils/baykon_scales.py` |
| POST | /api/wb-form/create, /finish | weigh_simple.py:59, 117 | |
| | **Process [/api/process]** | process_routes.py | POST /link, /weigh/capture, /complete; GET /scale/live (37-204) |
| | **Plant flow [/api]** | plant_flow.py | GET /weights/today; POST /weigh/in, /rfid/log, /weigh/out, /dispatch (37-199) |
| | **Materials / production** | material_routes.py:19-158; production_routes.py:17-147 | CRUD /api/materials[/<id>], /api/production[/<id>] |
| | **Reports [/api/reports]** | reports.py:51-672 | daily/weekly/monthly/detailed/material list+get+post (+PUT/DELETE daily); /config/tabs, /config/columns[/<type>], /config/values[/<name>] CRUD; POST /bulk/daily; GET /stats/summary; GET /export/<type> |
| | **KPI (SQL Server) [/api]** | kpi_material_routes.py:150-618 | GET /kpi, /reports, /reports/product-summary, /kpi/csv-format-report, /filter-options, /kpi/dashboard-analytics |
| | | kpi_calendar_routes.py:26-122 | GET /api/kpi_calendar, /kpi_calendar/details, /kpi_calendar/product-summary |
| GET | /api/sqlserver/production-kpi | production_kpi.py:546 | |
| GET | /api/sqlserver/test-connection, /batch-materials, /batch-hourly-count, /batch-weekly-count, /batch-materials/count, /batch-materials/<guid> | sqlserver_routes.py:36-392 | |
| GET | /api/pallet-report/live, /orders, /history, /summary | pallet_report_routes.py:133-224 | DB7 pallet lines |
| | **Distribution [/api/distribution]** | distribution_routes.py:163-245 | GET /report-catalog, /rules, /browse-folders; POST /rules; PUT/DELETE /rules/<id>; POST /rules/<id>/run |
| | **Settings [/api/settings]** | settings_routes.py:18-47 | GET/POST /smtp-config; POST /smtp-test |
| | **Ingestion [/api/ingestion]** | data_ingestion.py:286-327 | POST /start, /stop, /ingest-now; GET /status |
| | **AI [/api/ai]** | ai_routes.py:20-131 | GET /health, /insights, /history, /ml/info, /ml/top-risks, /ml/severity/info; POST /ask, /ml/predict, /ml/severity/predict |
| | | live_routes.py:22, 27 | GET /api/ai/live/state; POST /api/ai/live/control |

Not registered (dead blueprint): `routes/local_batch_routes.py` (CSV-based clone of KPI routes at `/api/kpi`, `/api/kpi_calendar`...) - only imported by `Backend/run_ai_demo.py:26`. A `storage_bp` import is commented out (app.py:8). No `routes/__init__.py` (namespace package). Helper modules without routes: `orders_sink.py`, `silos_sink.py`, `silos_collect.py`, `silo_qty_map.py`.

## 3. Data model
- Plain SQLAlchemy models in `Backend/models/*.py`, one `db = SQLAlchemy()` (`models/__init__.py`). Postgres tables: `intake_orders outloading_orders bulk_line_orders pt_line_orders` (orders.py), `order_queue`, `truck_weigh_orders`, `weighbridge_records weigh_visits weights_log rfid_log`, `trucks drivers clients`, `rfid_tags rfid_config`, `materials silos bin_materials`, `production_batches`, `daily/weekly/monthly/detailed/material_consumption_reports`, `report_configurations column_configurations column_values`, `distribution_rules system_settings`, `pallet_report`, `pallet_orders pallet_order_movements pallet_order_sequences`.
- Tables NOT modelled but used via raw SQL: `public.silo_status`, `silo_status_history` (written by `routes/silos_sink.py` and `plc_routes.py:persist_silos_from_plc` ~2400; migration `migrations/add_silo_status_quantity_kg.sql` adds `quantity_kg`; base DDL not in repo). PLC mapping tables in database `plc` (columns tag_name, tag_type, byte_offset, bit_index, str_len, silo_no, category; plc_routes.py ~135-215); DDL not in repo.
- SQL Server: `KPIMaterial` (bind `sqlserver`, table `BatchMaterials_Shadow`). `Backend/fix_package/`, `nfm_clone_package/`, `batchdata/` hold SQL Server scripts (shadow table, triggers, DDL) - operational SQL, not run by the app.
- Migrations: **no Alembic.** (a) `db.create_all(bind_key=None)` at startup creates missing tables only; (b) idempotent `ensure_*()` functions run at startup (app.py:170-195) doing `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`/CREATE; (c) manual SQL in `Backend/migrations/*.sql` (clients client_number, order_queue, order truck/client, pallet_orders, pallet_report, silo quantity_kg, truck_weigh_orders), applied by hand (`scripts/run_truck_weigh_migration.py` runs one). Changing a model column does NOT alter existing tables - add an `ensure_*` or a SQL file.

## 4. PLC integration (python-snap7)
- Lib: `snap7` imported with graceful fallback (`plc_routes.py:57-66`); without it all write endpoints return 503 and reads return None. `DEMO_MODE` also blocks writes.
- Connection: single global `CLIENT` + `CLIENT_LOCK` (plc_routes.py:270-300); `ensure_client()` connects lazily to `PLC_IP` (192.168.0.100 default, rack 0 slot 3) and reconnects. Every reader/writer in the process shares it (HTTP, broadcast thread, APScheduler jobs, silo sync).
- Reads: `read_db_bytes(db, len)` (:360) with per-DB good-length cache and "absent" cooldown. Decoders `render_lines`, `render_silos`, `render_silo_qty`. Tag layouts come from the PG `plc` DB via `load_map_from_pg(db_no)` (:102) - **except DB3, which is hard-coded** (line tags + mineral silos 401-408, HL/lock bits at byte 444) at :104-~135.
- DB blocks: DB1 = intake lines 1/2 (+ legacy mineral); DB2 = outloading; DB3 = mineral intake line 3 + silo material/HL/LOCK; DB4 = bulk + pit lines; DB5 = silo quantities (`routes/silo_qty_map.py`, REAL tags bytes 0-488, silos 101-322, 601-605, 801-848, 901-930; doc `docs/silo_bin_tags.md`); DB7 = pallet lines P1-P4 (`services/pallet_report_service.py:13-40`, 42 bytes: P1 offsets 0-10, P2 14-24, shared P3/P4 28-34..). Status word codes: `STATUS_MAP` :561; status 8 = completion window.
- Writes (**production-touching**): `_db_write` :608 -> `_write_tags` :676 (INT >h / REAL >f / STRING[n]) called from the 5 `/db/*/write` routes, `/rfid/assign`, `/orders/create`, `/orders/queue/<id>/start`, `/orders/clear-*` (`_clear_plc_tags` :658), and the **queue dispatcher** `_dispatch_next` (:1400) which runs automatically every 2s. No auth on any of these routes. `ALLOW_FORCE_WRITES` defaults true: `force` in body/query/`X-Force-Write` bypasses the "status must be Idle (1)" check (:461, :1977). Silo safety check `_check_silos_allowed` (:643, gated by CHECK_SILOS).
- Data flow PLC -> DB -> API:
  1. `broadcast_worker` thread (`websocket_routes.py` ~130, name `plc-broadcast`, every `PLC_POLL_INTERVAL`=0.5s) calls `fetch_plant_orders_snapshot()` -> `_execute_plant_orders()` (plc_routes.py:1586): reads DB1/2/3/4, builds payload, runs `process_order_queue`, and per line calls `handle_order_status` (:739): timestamp buffers across status codes 2/6/8; on status 8 the completed order is inserted into the order tables (`_store_complete_order_with_lifecycle` :942, models.orders.*). Orders are persisted ONLY this way (`persist_orders` calls are commented out).
  2. Same thread every 15s: `collect_all_silos()` + `persist_silos()` upserts `silo_status`, history only on change.
  3. Result emitted via SocketIO `plc_data` to room `plc_data`; HTTP `/api/plc/plant/orders` serves a TTL cache of the same payload (`_ORDERS_SNAPSHOT_LOCK`).
  4. Frontend uses REST (DB tables) and WS (live).
- Pallet (DB7): scheduler `pallet_order_monitor` (2s) -> `monitor_pallet_orders()` state machine in `services/pallet_order_service.py` writing `pallet_orders`/`pallet_order_movements`; `pallet_history` (60s) -> `collect_pallet_history()` inserts `pallet_report` snapshots. Postgres advisory-lock keys 7_062_001 / 7_061_001 prevent duplicates across processes.
- Weighbridge: two Baykon BX23 scales over HTTP `status.cgi` (Scale 1 192.168.1.200 entry, Scale 2 192.168.1.220 exit, basic auth with default admin user), `utils/baykon_scales.py` (hard-coded IPs/MACs, creds ~line 28-29). Used by `truck_entry_routes.py` and `scripts/check_scales.py`. Weights can also be posted manually via `capture-by-rfid`.
- RFID: tags surface via PLC line tags; `rfid_routes`/`rfid_config` assign tags to trucks; queue dispatch matches the scanned RFID (`QUEUE_STRICT_RFID`).
- SAP: none present. SQL Server `ASMBatchReports` (batching system) is the only external system, read-only.

## 5. Background jobs / threads (all started only from `__main__`)
| Name | Where | Cadence | Does |
|---|---|---|---|
| plc-broadcast thread | websocket_routes.py `ensure_broadcast_running` (~l.178) | 0.5s | PLC poll, order lifecycle persist, WS emit, silo persist every 15s |
| SiloSyncTask thread | background_sync.py:15 (`start_silo_sync(app)`) | 30s | `persist_silos_from_plc` for DB1,2,3 (second silo writer next to broadcast) |
| APScheduler `queue_dispatch` | scheduler.py:112-123 | 2s | `run_queue_dispatch_cycle` -> may **write PLC** (advisory lock if `QUEUE_MULTIWORKER_LOCK`) |
| `pallet_order_monitor` | scheduler.py ~148 | 2s | DB7 -> pallet_orders |
| `pallet_history` | scheduler.py ~172 | 60s | DB7 -> pallet_report |
| `distribution_<id>` cron | scheduler.py `rebuild_scheduler_jobs` | per rule daily/weekly/monthly | `distribution_engine.execute_distribution_rule` builds reports and emails (SMTP or Resend); rebuilt by distribution_routes on rule CRUD |
| Ingestion thread | data_ingestion.py:296 | POLL_SEC 1s, only after POST /api/ingestion/start | writes snapshots into order tables (overlaps with handle_order_status path; do not enable casually) |
| AI live engine thread | ai_assistant/live/engine.py:119 (+ retrain thread :315) | AI_LIVE_TICK | CSV replay / SQL anomaly monitor; starts on import of app.py |
Note: three separate functions in scheduler.py lazily create the shared `BackgroundScheduler` global `_scheduler`.

## 6. Tests
- `Backend/tests/`: `test_pallet_order_service.py`, `test_pallet_report.py` - unittest-style with mocks, no DB/PLC needed.
- Ran from `Backend/`: `python -m pytest -q -p no:cacheprovider tests` -> `25 passed in 0.10s`. `--collect-only` -> `25 tests collected in 0.05s`.
- `Backend/scripts/test_production_kpi.py` and `test_truck_entry_phase1.py` are manual scripts needing live DBs/server (not in `tests/`). No tests for plc_routes, orders, queue, distribution, weighbridge. No CI config seen at root.

## 7. Hazards for editing
- `routes/plc_routes.py` (3385 lines) is a monolith: config, snap7 client, mapping, decoders, order lifecycle, queue dispatcher, writers, silo persistence and HTTP routes, with module-level mutable state (`CLIENT`, `_DB_CACHE`, timestamp buffers, `_LAST_ORDERS_PAYLOAD`). Other modules import names from it (`silos_collect`, `websocket_routes`, `data_ingestion`, `services/*`: `read_db_bytes`, `load_map_from_pg`, `render_silos`, `fetch_plant_orders_snapshot`, `DEMO_MODE`, `_snap7_loaded`). Renames break them. Many legacy duplicate routes (`/orders/mineral`, `/db-health`, `/lines`, `/orders`).
- **Production PLC writes, no auth** (section 4). Running locally against the live PLC (192.168.0.100) writes real tags; set `DEMO_MODE=true` (config.json `demo_mode` or env) before experimenting. The 2s dispatcher writes automatically when an RFID is scanned and a waiting queue row matches.
- DB3 tag map is hard-coded (plc_routes.py:104+) and bypasses the `plc` PG mapping; other DBs depend on `plc` DB contents not in the repo.
- Duplicates: `Backend/distribution_engine.py` (1321 lines) vs `Distribution/distribution_engine.py` (4068 lines); likewise `Distribution/{scheduler,smtp_config}.py` and `Distribution/distribution_bp.py` vs `Backend/routes/distribution_routes.py` - all differ. `Backend/` copies are what app.py imports; `Distribution/` is a reference bundle (also holds JSX + `Distribution_Module_Reference.md`). Confirm which is current before editing.
- Dead/stray: `routes/weighbridge.py` (~660 commented lines), `routes/local_batch_routes.py` (unregistered), `Backend/_ro_*.py` + `_*_out.txt` + `_watch_*` (one-off investigation probes and their outputs; may contain connection details), `run_ai_demo.py`, `delete_old_orders.py` (destructive standalone script; see `docs/README_delete_orders.md`), root `plc.py` / `plcdb3.py` (standalone snap7 read scripts, DB4/DB3 hard-coded, IP 192.168.0.100; not imported), root `sql.py` (CSV -> SQL Server loader, hard-coded server), `Backend/fix_package/` and `nfm_clone_package/` (SQL packages for the NFM server; repo policy: never push to the boss origin).
- Hard-coded hosts/IPs: PLC 192.168.0.100 (config.json, plc_routes.py:17, plc.py, plcdb3.py, scripts/read_plc_silo_qty.py:46); scales 192.168.1.200/.220 (utils/baykon_scales.py, scripts/check_scales.py); CORS LAN IPs (app.py:59-62); SQL Server `DESKTOP-N8PGI9S\FAKIEH_REPORTING` (config.py:20, sql.py:19); Postgres `localhost`; `background_sync.py` default `http://localhost:5000`; Resend sender `reports@herculesv2.app` (smtp_config.py:26).
- Plaintext default credentials in `config.py` and `utils/baykon_scales.py`; `.gitignore` ignores `*.env`.
- Silo state has multiple writers (broadcast thread, SiloSyncTask, WS connect handler, `/silos/sync`, ingestion): redundant PLC reads and races on the single shared snap7 client.
- Workers only start under `python app.py`; a WSGI deployment silently loses them. `debug=False`, so no reloader duplication.
- Schema drift: models change only via startup `ensure_*`; adding a model column without SQL breaks existing DBs.
- ML artefacts: `ai_assistant/ml/*.joblib` pickles tied to scikit-learn==1.9.0 (requirements.txt comment).
- Emoji in print() (`[QUEUE] ...`) can raise UnicodeEncodeError on Windows cp1252 consoles.
