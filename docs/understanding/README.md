# Fakieh Hercules — how the code is put together

Snapshot of `Imroz-hercules/fakieh_herucles` `main` at `5ae828b` (2026-09-11), mapped 2026-11-11.
Area maps, with file:line references:

- [backend.md](backend.md) — Flask app, routes, database, PLC/weighbridge, background jobs
- [frontend.md](frontend.md) — Vite/React app, routes, page → endpoint table, theming
- [plant3d.md](plant3d.md) — the 3D plant view and its verify scripts
- [engine-ai-deploy-history.md](engine-ai-deploy-history.md) — distribution engine, AI assistant, deployment, git history

## The system in one paragraph

A Flask backend (`Backend/app.py`, port 5000) talks to a Siemens PLC over snap7, to two Baykon
weighbridges over HTTP, to a Postgres app database and to a read-only SQL Server batch-report
database. A 0.5 s thread reads the PLC and pushes over SocketIO; APScheduler jobs dispatch queued
orders to the PLC, track pallets and send distribution reports by email. The React frontend
(`frontend-package/`, Vite, wouter, Tailwind/shadcn) serves about 25 pages under `/fakieh/*`,
including a procedural three.js plant view that polls `/api/silos`.

## How production runs

- Pushing to `main` on `Imroz-hercules/fakieh_herucles` triggers `.github/workflows/deploy.yml` on a
  self-hosted runner: `git pull`, `pip install`, a truck-weigh migration, `npm install`, then
  restart of the NSSM services `Fakieh_backend` and `Fakieh_frontend`, then a health curl.
- **A merge to `main` is a production deploy within minutes.** Work goes on branches.
- There is no frontend build step in the deploy; the frontend service runs whatever its NSSM
  command is (check on the server before changing build or env assumptions).
- Background workers only start when `app.py` runs as `__main__`.

## Rules for editing safely

1. **Never run the backend against the plant network without `DEMO_MODE=true`.** PLC write routes
   have no auth, the 2 s queue dispatcher writes on RFID scan, and `ALLOW_FORCE_WRITES` defaults on.
   How DEMO_MODE protects (checked 2026-11-11): every write route returns 503 under DEMO_MODE, and
   `read_db_bytes` returns zeros, so the dispatcher never sees status 1 (Idle) and never calls
   `_dispatch_next` (`plc_routes.py:1489`). The low-level `_db_write` (`plc_routes.py:608`) and
   `ensure_client` have no DEMO_MODE check of their own, so any new write path must add one.
2. Edit `Backend/distribution_engine.py`, not `Distribution/` (a different product's copy, not imported).
3. `plc_routes.py` holds module-level shared state that other modules import by private name;
   change its globals only after grepping every importer.
4. Schema changes have no migration tool: add to the `ensure_*` startup ALTERs and to
   `Backend/migrations/` as SQL. `silo_status` and the `plc` mapping tables are not defined in the repo.
5. Frontend API hosts are inconsistent: `config/api.ts` hard-codes one LAN IP, many pages use
   relative `/api`, and `Orders.tsx`, `Production.tsx` hard-code `localhost:5000`.
6. Light theme is hand-written `:root.light` overrides in `index.css` (about 960 `!important`);
   check both themes on any visual change.
7. Dead pages (no route): `Engineering.tsx`, `Reports.tsx`, `DashboardEditorPage` and the
   `components/dashboard` editor. `/fakieh/engineering` renders `PlcConfiguration.tsx`.
   Mock data in routed pages: `PLCReports`, `Dashboard`, `Alarms`.

## Checks that exist

| Check | Command | Covers |
|---|---|---|
| Backend tests | `cd Backend && python -m pytest tests` | pallet logic only (25 tests, pass) |
| Type check | `cd frontend-package && npm run check` | whole frontend (`tsc`) |
| 3D model checks | `npm run verify-plant3d` | scene model, no browser |
| 3D picture checks | `npm run verify-picture` | real Chrome, needs dev server on 5199 |

No frontend tests, no lint, nothing covering PLC routes, the queue, orders or distribution.

## Known facts worth not rediscovering

- No SAP integration code exists despite a commit message naming it.
- AI chat calls Gemini → DeepSeek → Claude with keys from `Backend/.env` (external APIs).
- All remote branches, including the fork's, are already in `main` (checked with `git cherry`).
- Contributors: husam-hammami (49 commits), Mohammed Al Lami (23), Imroz-hercules (13).
