# Frontend map (frontend-package/, excluding Plant 3D)

Paths relative to `frontend-package/` unless noted. Plant3D.tsx and components/water-system/plant3d/ are covered elsewhere.
Read-only survey; node_modules is NOT installed (nothing was run).

## 1. Stack and build
- Vite 5 SPA, React 18.3, TypeScript 5.6 strict, **wouter 3** router, **TanStack Query 5** (barely used), axios + raw fetch, shadcn/Radix UI (`client/src/components/ui/`, 48 files), Tailwind **3.4** (`tailwind.config.ts`, darkMode:class), chart.js/react-chartjs-2 (dashboards), recharts (ui/chart.tsx), framer-motion, react-grid-layout + @dnd-kit (dashboard editor), three/@react-three (Plant3D), exceljs (lib/reportExcelExport.ts).
- `package.json` is a leftover Replit "rest-express" template: lists express, passport, drizzle, connect-pg-simple, @neondatabase, ws, memorystore: none used by the client. `@tailwindcss/vite` v4 is in devDeps but Tailwind 3 + postcss is what runs (`postcss.config.js`).
- Scripts: `npm run dev` / `start-frontend` = `vite`; `build` = `vite build` (out: `dist/public`); `preview`; `check` = `tsc` (noEmit); `verify:plant3d|shaders|picture|structures` = node scripts in `scripts/` (Plant3D concern). No test runner, no lint.
- Build/run: `npm ci && npm run dev` (Vite, host:true, allowedHosts:true). Backend target: `FAKIEH_API_TARGET=http://127.0.0.1:5001 npm run dev`, else default `http://192.168.0.60:5000` (vite.config.ts:41-44). Prod build: `npm run build`, then serve `dist/public` statically.
- vite.config.ts: root=`client/`; aliases `@`->client/src, `@shared`->shared, `@assets`->`attached_assets` (**dir does not exist**). Loads `@replit/vite-plugin-runtime-error-modal` always (a devDep). tsconfig includes `server/**/*` (does not exist).
- Entry: `client/index.html` (Google Fonts via CDN: Inter, JetBrains Mono, Noto Arabic/Devanagari/Nastaliq; inline script sets theme class from localStorage `fakieh-theme` before paint, :9-22; Replit banner script tag at bottom) -> `client/src/main.tsx` -> `App.tsx`.

## 2. App shell (client/src/App.tsx)
Provider order (App.tsx:~170-200): QueryClientProvider > ThemeProvider > NavLayoutProvider > SiloProvider > TooltipProvider > Toaster > Suspense > RoutedErrorBoundary > Router. All pages `React.lazy`. `Router` blocks rendering until `useTheme().isInitialized` (50 ms timeout). `ROUTE_NAMES` names the ErrorBoundary fallback; boundary resets on location change.
**No auth anywhere** (no login, token, or route guard). `credentials:"include"` in lib/queryClient.ts only.
Layout: every page wraps itself in `components/water-system/WaterSystemLayout.tsx` (props title/subtitle/showPageTitle/immersive; `immersive` is Plant3D-only). It renders `Sidebar.tsx` or `WaterTopNav.tsx` depending on `NavLayoutContext` (localStorage `fakieh-nav-layout`: sidebar|topbar), a header with theme toggle, `PartnerLogosStrip`. Nav items live in `components/water-system/navConfig.ts` (sidebar groups first ~150 lines, topnav list after). Settings link in sidebar goes to `/fakieh/admin` (Sidebar.tsx:100). Nav is defined twice (sidebar + topnav lists), edit both.

## 3. Route table (App.tsx:~84-129)
| Path | Target |
|---|---|
| `/`, any unknown | redirect `/fakieh/fakieh-dashboard` |
| `/fakieh`, `/fakieh/dashboard` | pages/water-system/Dashboard.tsx (mock charts) |
| `/fakieh/fakieh-dashboard` | FakiehDashboard.tsx (home) |
| `/fakieh/material` | Material.tsx |
| `/fakieh/storage` | Storage.tsx |
| `/fakieh/plant-3d` | Plant3D.tsx (other agent) |
| `/fakieh/production` | Production.tsx |
| `/fakieh/orders` | redirect `/fakieh/live_orders` |
| `/fakieh/live_orders` | Orders.tsx |
| `/fakieh/order-history` | OrderHistory.tsx |
| `/fakieh/weighbridge` | Weighbridge.tsx (read-only log) |
| `/fakieh/truck-entry` | TruckEntry.tsx |
| `/fakieh/management/{rfid,trucks,drivers,clients}` | Management.tsx (tab host: RFID.tsx, TruckManagement.tsx, ClientInformation.tsx) |
| `/fakieh/management`, `/rfid`, `/truck-management`, `/client-information` | redirects into management/* |
| `/fakieh/alarms` | Alarms.tsx (static) |
| `/fakieh/admin` | Admin.tsx (SMTP settings + local-state PLC form) |
| `/fakieh/distribution` | Distribution.tsx (+DistributionRuleCard/Editor) |
| `/fakieh/ai-assistant` | AiAssistant.tsx |
| `/fakieh/engineering` | **PlcConfiguration.tsx** (not Engineering.tsx) |
| `/fakieh/plc-reports` | PLCReports.tsx (mock data) |
| `/fakieh/batch-calendar` | BatchCalendarPage.tsx |
| `/fakieh/batch-historical-reports` | BatchHistoricalReports.tsx |
| `/fakieh/batch-raw-data` | BatchRawDataPage.tsx |
| `/fakieh/pallet-report` | PalletReport.tsx |
Routed but not in navConfig (URL only): dashboard, material, production, alarms, engineering, plc-reports.

## 4. Theming
- Class-based: `<html class="light|dark">`. ThemeContext.tsx sets class + localStorage `fakieh-theme`; the index.html pre-paint script mirrors it. Default = OS preference.
- Design is **dark-first**: components are written with dark slate Tailwind classes and a pseudo-variant `light:` (e.g. `light:bg-white`). **`light:` is NOT a Tailwind variant** (tailwind.config.ts:93 has only animate + typography plugins); index.css hand-defines each one as `:root.light .light\:bg-white {...}` (index.css:40-86; 752 `root.light` selectors total). A new `light:xxx` class does nothing until a matching rule is added to index.css.
- index.css (4825 lines, 960 `!important`) is layered overrides: transitions (1-37), light utility shims (39-86), Weighbridge `wb-*` console (88-352), alarm severity (357), many "force / nuclear / ultra-specific" light-mode button/tab overrides (389-900), light component overrides (900-1110+), sidebar shell (982-1085), then per-page blocks. Only the `wb-*` block uses CSS variables (`--wb-text`). tailwind.config.ts references shadcn tokens (`--background`, `--primary`, ...); verify they are defined before relying on them. A global `* {transition...}` (index.css:5) animates everything.
- Docs: `DESIGN.md`, `PRODUCT.md` in frontend-package (design intent). AiAssistant has its own 1744-line `AiAssistant.css`.

## 5. API client layer
No single client. Three mechanisms are mixed:
1. `config/api.ts`: `API_BASE_URL` = `/api` in dev else **hard-coded `http://192.168.199.160:5000/api`** (:9); `PLC_BASE_URL` likewise (:10); `API_ENDPOINTS` constants (many unused). The prod IP (192.168.199.160) differs from the Vite dev proxy default (192.168.0.60, vite.config.ts:44).
2. Raw `fetch('/api/...')` with relative URLs (FakiehDashboard, Material, Production, PlcConfiguration, ProductionPerformanceCard, AdminSettingsModal). In a production build these hit the **serving origin**, not 192.168.199.160, so they only work if the static host proxies /api.
3. axios (no shared instance, no interceptors) in Orders, OrderHistory, Batch*, RFID, Storage, TruckManagement, ClientInformation, AiAssistant, distributionApi.ts, SiloContext, kpiFetchAll.
- `lib/queryClient.ts`: staleTime Infinity, no refetch, default `queryFn` = fetch(queryKey[0]); `apiRequest()` helper. Used by PlcConfiguration, AdminSettingsModal (dead), dashboard editor (dead).
- `api/truckEntry.ts`: typed fetch wrappers for `/api/truck-entry/*`.
- `hooks/usePolling.ts`: non-overlapping poller with AbortSignal (Orders 5s, PalletReport live, AiAssistant live state, SiloContext). Other pages use raw `setInterval`.
- `contexts/SiloContext.tsx`: global silo store, `GET {PLC_BASE_URL}/silos` (:87); `useSilosPolling(15000)` opt-in in Orders.tsx:220 and Storage.tsx:95.
- Env vars: only `import.meta.env.DEV` and Vite-side `FAKIEH_API_TARGET`. No `.env` files.

## 6. Page -> endpoint table (backend paths under `/api`)
| Page (file) | Endpoints (file:line) | Polling / notes |
|---|---|---|
| FakiehDashboard (1226 lines) | `/sqlserver/batch-materials` :642, `/batch-materials/count` :662, `/batch-weekly-count` :675, `/batch-hourly-count?mode=today` :691, `/orders/{intake1,intake2,outload1,outload2,outload3,bulk,pt}?page=1&per_page=1` + `/plc/plant/orders` :747-754, `/trucks` :782 (fallback `/trucks/entries` :793). Child ProductionPerformanceCard: `/sqlserver/production-kpi` :227 | setInterval 60s hourly+weekly (:732); card refresh 60s (ProductionPerformanceCard:70,265); other counts once on idle |
| Dashboard (/fakieh/dashboard) | none; mock chart data (:21), localStorage `fakieh-dashboard-charts` (:568) | static |
| Orders (2579) | GET `/bin-materials` :475, `/rfid/config` :484, `/plc/orders/queue` :497, `/trucks/` :547, `/clients/` :557, `/websocket/status` :569, `/plc/plant/orders` :580; POST `/plc/orders/queue/{id}/cancel` and `/start[?force=true]` :507-529, `/plc/orders/enqueue` :760, **`http://localhost:5000/api/plc/orders/create` :878**, helper POST :130 | usePolling 5s (:712) of orders+queue+broadcast status; silos 15s |
| OrderHistory | GET `/orders/history` :116, DELETE `/orders/{id}` :89 | none |
| Storage | POST `/plc/silos/sync` :109, silos via SiloContext | silos 15s |
| Material | GET/POST/PUT `/materials` :55,95,115 | relative URLs |
| Production | **`http://localhost:5000/api/production` :56**; POST/PUT/DELETE `/production[/{id}]` :79-110 | mixed absolute/relative |
| Weighbridge | `/truck-entry/orders/today`, `/orders/open` via api/truckEntry | read-only log |
| TruckEntry (1072) | `/trucks/` :210; truckEntry.ts: POST `/truck-entry/orders`, `/orders/{id}/first` and `/second`, GET `/orders/open`, `/orders/today`, `/orders/{id}`, DELETE `{id}`, `/scales/{id}/live` | |
| Management > TruckManagement | `/trucks/`, `/trucks/drivers`, `/maintenance/`, `/weights/today?unit=kg`, CRUD trucks/drivers (:138-293) | |
| Management > ClientInformation | `/clients/` CRUD (:74-145) | |
| Management > RFID | `/rfid/config` GET/POST/PUT/DELETE (:94-192, relative); RfidAssignModal POST `/plc/rfid/assign` :100 | |
| Distribution | distributionApi.ts: `/distribution/rules` CRUD, `/rules/{id}/run`, `/report-catalog`, `/browse-folders`, `/settings/smtp-config`, `/settings/smtp-test` | |
| Admin | settingsApi smtp-config/smtp-test (:85,106); PLC IP form is local state only (:54) | |
| AiAssistant (1517) | `/ai/health` :761, `/ai/live/state` :788 (usePolling), POST `/ai/ask` :821, `/ai/ml/predict` + `/ai/ml/severity/predict` :858-859, POST `/ai/live/control` :868 | live poll; drift/retrain popups |
| PLCConfiguration (route /engineering) | useQuery `/api/plc/readings/simulate/{db}` :210 (refetch 5s :214), `/api/plc/datablocks`, `/api/plc/addresses` :336-341 | only real TanStack Query page |
| PLCReports | **none**: hard-coded `mockPLCData` (:833); live component :1324-1682. Lines 1-787 are a fully commented-out earlier copy | CSV export is client-side |
| BatchCalendarPage | `/kpi_calendar` :58, `/kpi_calendar/details` :85 | |
| BatchHistoricalReports (2764) | `/filter-options` :324, `/kpi` :363, `/kpi_calendar` :541,709, `/kpi_calendar/details` :563, `/reports` :628, `/kpi_calendar/product-summary` :696; Excel via lib/reportExcelExport.ts; logo fetch :1781 | |
| BatchRawDataPage | `/filter-options` :188, `/kpi/csv-format-report` :219,268 | CSV export |
| PalletReport | `/pallet-report/history` :204, `/summary` :205, `/live` :414 | usePolling on LivePanel |
| Alarms | none, static | |
| Reports.tsx (dead) | `http://localhost:5000/api/reports/{daily,weekly,monthly,detailed,material,export}` :1038+ | not routed |

Helpers: `utils/kpiFetchAll.ts` (paged KPI fetch), `utils/batchFilterOptions.ts`, `utils/outloadingSilos.ts`, `constants/materialCodes.ts`, `utils/timezone.ts` (277 lines of date helpers). `components/batch-material/{DetailsPopup,PieChart}.tsx` used by BatchCalendarPage and FakiehDashboard.

## 7. shared/ and dashboard editor
- `shared/schema.ts`: leftover Drizzle pgTable/zod schemas for a generic water-facility template (facilities, metrics, alerts, dashboard widgets, AdminConfig). Imported for TYPES only by dead components (AdminSettingsModal, ChartWidget, chartUtils, lib/mockData). The real backend contract is NOT typed here.
- `shared/mock-data.ts`: `mockDatabaseValues` catalogue + `generateTimeSeriesData`/`getCurrentValue` random generators, consumed by components/dashboard/{DashboardWidgets,DataSelector,ValueSelector}.
- `components/dashboard/InteractiveDashboardEditor.tsx` (1312 lines): react-grid-layout widget canvas, SketchPicker colours, config dialogs; persists to localStorage `hercules-dashboard-widgets` (:749,764), JSON export (:937); mock data only. Imported only by ProfessionalDashboardEditor <- pages/DashboardEditorPage.tsx, which has **no route**: the whole editor cluster (components/dashboard/*, ~4.5k lines) is unreachable.

## 8. Editing hazards
- Giant files: index.css 4825; BatchHistoricalReports 2764; Orders 2579; PLCReports 1690 (about 45% dead comment); Reports 1671 (dead); AiAssistant 1517 + .css 1744; InteractiveDashboardEditor 1312; FakiehDashboard 1226; TruckEntry 1072; Dashboard 1070.
- Dead / unreachable: `pages/water-system/Engineering.tsx` (613 lines, nearly all commented, not imported), `Reports.tsx` (not imported), `pages/DashboardEditorPage.tsx` + `components/dashboard/*` editors, `components/{AppLayout,AdminSettingsModal,Advanced3DGauges,AdvancedAnalyticsPanels,AnalyticsPanel,CenterMetricsPanel,ChartWidget}.tsx` (no importers), `lib/mockData.ts`, `lib/chartUtils.ts`, most of `shared/schema.ts`, the commented first half of PLCReports, unused `API_ENDPOINTS` keys, server-side npm deps. Dashboard.tsx and Alarms.tsx are routed but static/mock and not nav-linked.
- Hard-coded URLs: `config/api.ts:9-10` (192.168.199.160:5000), `vite.config.ts:44` (192.168.0.60:5000), `Orders.tsx:878`, `Production.tsx:56`, `Reports.tsx:1038` (all localhost:5000), `Admin.tsx:54` (192.168.1.100 default). Relative `/api/...` in a prod build resolves against the page origin while `API_BASE_URL` points at an absolute IP, so the two styles hit different hosts; localhost:5000 calls break on any machine that is not the backend.
- Duplicated logic: three request styles (section 5); per-page setInterval vs usePolling; 8 order-count fetches in FakiehDashboard; KPI/calendar param building repeated across Batch pages; trucks/clients lists fetched separately in Orders, TruckEntry, TruckManagement; `API_BASE_URL` defined twice (config/api.ts, Reports.tsx:1038); nav defined twice (navConfig sidebar and topnav lists).
- Theme traps: new `light:*` classes need a hand-written rule in index.css (section 4); appended `!important` override layers (index.css:~406-900) mean a button style fix is often defeated by a later "ultra-specific" rule, so grep the class in index.css before editing. The global `* { transition }` can cause flicker/perf cost.
- Other: no auth; no tests; `tsc` includes nonexistent `server/`; vite config imports a Replit plugin unconditionally; `Management.tsx` imports TruckManagement once and routes trucks/drivers via URL (check its tab logic before touching).
