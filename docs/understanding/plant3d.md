# Plant 3D view - map (read-only survey, 2026-11-11)

Route `/fakieh/plant-3d` (App.tsx:69 lazy import, :104 Route; nav in navConfig.ts:148,231). Paths relative to `frontend-package/` unless noted.

## Stack (package.json)
three ^0.170.0, @react-three/fiber ^8.18.0, @react-three/drei ^9.122.0, @react-three/postprocessing ^2.19.1, postprocessing ^6.39.4, react ^18.3.1, vite ^5.4.19, @tanstack/react-query, framer-motion. No model files: everything is procedural geometry (Plant3D.tsx:8-11). Route is lazy so three.js stays out of the initial chunk (verify-plant3d check "initial chunk keeps three.js out", ~:1142). `scripts/preflight.mjs` (predev/prebuild) installs missing deps. DEV-only handles: `window.__plant3d`, `__plant3dSetColorMode`, `__plant3dSetSolidShells` (Plant3D.tsx ~1530; stripped in prod).

## Files
- `client/src/pages/water-system/Plant3D.tsx` 2583 lines: page, Scene, camera rig, overlays, stage state.
- `client/src/components/water-system/plant3d/`: PlantHud.tsx 1689 (ZoneSwitch :342, LookBar :425, DiagnosticsBar :605, SiloFinder :670, freshness :859, StatusBar :880, statusCategoryFor :1069, LegendDock :1128, STALE_AFTER_MS 900_000 :1428, SiloDetailPanel :1486), SiloList 748, KpiStrip 237, ControlBar 193 (`ViewMode='3d'|'2d'` :28), DataChip 172, Hint, Breadcrumb, StatusModeSwitch.
- `client/src/lib/plant3d/` (8271 lines, the engine): silos.ts (SILO_GROUPS :441, SILOS :938, MONITORED_COUNT :967), site.ts (zones outside/raw/dosing/buffer/finished :123-161; buildings from :333), siloData.ts (data hook), siloMesh.tsx (InstancedMesh solid/pick/shell :138-140), siloShader.ts (728, spliced part-based shader; setColorMode/setSolidShells uniforms), siloGeometry.ts, siloParts.ts, siloSelection.tsx (proxy mesh), siloBeacons.tsx (HL alarm beacons), siloStructures.tsx, structures.tsx (fence, kerbs, trusses, buildings, platforms, masts), siteDressing.tsx, ground.tsx, SkyDome.tsx, look.ts (LOOKS day/dusk/night :201), PostFx.tsx, lut.ts, materials.ts, textures.ts (data-URI only).

## Scene composition (Scene at Plant3D.tsx:1016)
- Background + fog from look (:1075); SiteEnvironment (drei Environment + lightformers, :870); hemisphereLight + one directional sun (shadow map 2048, or 512 in lowPower; frustum re-fitted by ShadowFollow :657 to the visible zone); SkyDome; SiteGround; SiteDressing; structures; one SiloGroupMesh per group via BUCKETS (:902); selection proxy; beacons.
- 131 bins, 5 zones plus Whole site. Series 100/200 concrete bulk silos, 300/400/600/800/900 steel. The 500-series liquid tanks were retired (commit 4488122); every group is now monitored.
- Canvas (:2154): `shadows`, `dpr={lowPower?1:[1,2]}`, camera [-40,150,240] fov 42 near 0.5 far 2400, `antialias=!lowPower`, powerPreference high-performance, `key` remount on quality change, ACESFilmic set in onCreated (:2182) but exposure driven each render by ExposureDrive (:775; POST_CHAIN_EXPOSURE_GAIN=0.5 :793), PCFSoftShadowMap. Context-lost banner with canvas-identity guard (:2207-2235).
- Camera: OrbitControls (damping 0.08, maxPolar PI/2.06, distance 6..560, rotation off in 2D), CameraRig :539 fly-to, ZoomDriver :527. The 2D plan is the same canvas looking straight down (dir [0.02,1,0.02], :1932-1934) with rotate disabled (:2288), not a separate renderer.
- Post chain (PostFx.tsx, rendered outside Scene :2280, skipped in lowPower): N8AO -> SMAA -> TiltShift (opacity by camera distance, fades by ~120 m) -> ToneMapping -> LUT (runtime LookupTexture, deliberately last). Bloom, Vignette and Outline were removed.
- Silo grammar (DESIGN.md): acrylic fresnel shell, matte contents in material colour, bright level ring, hatched 0.35-alpha shell with no data, selection = cyan #22d3ee proxy mesh. Two colour modes: material vs fill-status (thresholds 0.1/0.9, PlantHud :1055-1057).

## Live data binding
- One endpoint: `GET /api/silos` via react-query `useSiloReadings(enabled)` (lib/plant3d/siloData.ts:57), `refetchInterval` 15 s (`POLL_MS` :55), refetchOnWindowFocus; disabled when no WebGL (Plant3D.tsx:1633). Backend: `Backend/routes/plc_routes.py:2523` (`api_bp /silos`), fed by PLC sync.
- Row `SiloReading` {siloNo, dbNo, binName, materialCode, materialName, quantityKg, hlActive, lockActive, updatedAt} (siloData.ts:19). `siloLevel()` :148 gives fraction vs group capacity; NoLevelReason 'no-tag'|'no-reading'; 400 series never gets a level; negatives clamp; over-capacity reads full. OUT_OF_SERVICE code '999' (:180). Palette derived from rows present (buildMaterialPalette :270). Material codes coerced to string before .trim() (blank-page guard :189).
- Freshness: plantWroteAt (max updatedAt) vs fetchedAt separates stale PLC poll from failed fetch (PlantHud :859); on error the view says so instead of showing zeros.
- Read-only "shadow twin": nothing writes back (Plant3D.tsx:5-7).

## HUD / layout
- Immersive shell (DESIGN.md Page grammar): stage div (:2099); KpiStrip full width (bins, capacity, stored, utilisation, alarms, freshness; hidden in fullscreen); split view = canvas minmax(0,1fr) + SiloList clamp(280px,28%,360px); under 1100 px the list is a bottom sheet overlay (SHEET_PEEK 320 :173) so the canvas never resizes. Fullscreen (`expanded` :1490) is fixed inset-0 with the list as overlay drawer.
- Overlays: silo-number pills via one SiloNumberProjector :175 (MIN_BIN_PX 13, MAX_LABELS 70, collision culling), DataChip labels (labelMode 'data'), HoverChip :326, LegendDock, SiloDetailPanel, Hint, Breadcrumb. The bottom-left ControlBar was removed (0e9110e); ControlBar.tsx still supplies the ViewMode type.
- Looks: day (default, client choice), dusk, night.

## Performance
- drei PerformanceMonitor -> postTier 0..3 (Plant3D.tsx:2243): tier1 drops TiltShift, 2 drops N8AO, 3 drops SMAA; LUT and ToneMapping never dropped. Skipped under `?fx=on`.
- isSoftwareRenderer (:1390) -> lowPower under quality 'auto'; quality low/auto/full; DEV `?fx=on|off` (:1623). lowPower = dpr 1, no AA, no post, 512 shadow map.
- Instanced silos per group, shared shader uniforms, shadow camera follows framing, StatsProbe :806.
- Budget (DESIGN.md:56): <=350k tris whole site, <=420k per zone, <=120 draw calls, >=40 fps static / >=35 orbiting on Iris Xe, dpr 1.5, no runtime network fetches. Geometry part enforced by verify-plant3d "triangle and draw-call budget" (:1731).

## Verification tooling (scripts/; node + esbuild + raw CDP, no test framework)
Exit codes everywhere: 0 pass, 1 fail, 2 could-not-run. npm scripts (package.json:12-15): verify:plant3d, verify:shaders, verify:picture, verify:structures. Not wired to npm: verify-lut, verify-hud-components, shoot-*.
- verify-plant3d.mjs (1820 lines, ~42 check() calls, no browser): model asserts, 131 bins, group counts, contiguous numbers, no overlaps, indoor groups fit buildings, capacity vs drawn volume, fill inversion, API edge cases, palette uniqueness, shader splice points once, no reversed smoothstep, sun geometry, copy wording (no in-service bin called idle), error boundary present, page wrapper cannot trap position:fixed, reference screenshots name their zone, tri/draw budget.
- verify-picture.mjs (1359): real Chrome/Edge over CDP against a dev server (default http://127.0.0.1:5199, arg 2 overrides; env PICTURE_VIEWS, PICTURE_SKIP_DUSK=1). Measures the image: silo MASK-pass coverage and bbox per view (VIEWS :894-908, e.g. whole site >=10% / 240 px), mid-tone floors, material separability via CIEDE2000 (lib/picture-metrics.mjs; functions serialised with fn.toString()).
- verify-shaders.mjs (414): compiles real silo and ground shaders on a real GL driver (past bug: fragment used a vertex-only uniform, silos rendered black while static checks passed).
- verify-structures.mjs (546): calls the pure builders of structures.tsx and checks footprints, no Canvas.
- verify-lut.mjs (340): neutral LUT in chain position is a pixel no-op and the real grade is not (proves the check can fail); needs browser + dev server.
- verify-hud-components.mjs (373): renderToStaticMarkup of KpiStrip/ControlBar/DataChip, react kept external.
- shoot-plant3d.mjs [outDir default shots/] [baseUrl default :5199], shoot-hud/looks/shader/shell/archetypes.mjs, aerial-overlay.py: screenshot harnesses. Use `?fx=on` (headless raster is CPU).
- Run: start vite on port 5199 (`npm run dev -- --port 5199`; vite default is 5173), then `node scripts/verify-picture.mjs`; model/shader checks via `npm run verify:*`.

## Docs and decisions
- `DESIGN.md` (frontend-package root): "clean daylight scale model" world, palette table, client decisions 2026-09-01/02 (day default, vertical stretch 1.25x, base diameters), cyan only means selection, motion 150-250 ms with reduced-motion, touch targets, perf envelope. `PRODUCT.md` holds product rules.
- Repo `docs/` has NO 3D overhaul plan; docs/superpowers/plans only has `2026-08-24-frontend-load-performance.md`. The plan cited in code comments (section 4.D, 6a Codex audit) is not in the repo.
- Open: TODO(Phase 4, HUD worker) Plant3D.tsx ~1506/1530: colorMode and solidShells have no HUD control, only DEV console hooks. Provisional tokens in DESIGN.md. Stale comments: verify-plant3d header says 36 checks (now ~42); verify-hud-components says components not mounted (they are).
- Pitfalls in comments: blank canvas under ancestor transforms (resize offsetSize + nudge ~:2170); hidden Chrome tab suspends rAF; remounted canvas fires webglcontextlost on the old canvas; Plant3D.tsx is a single 2583-line file holding stage state, edit carefully.

## Git history (Plant3D.tsx, plant3d/, lib/plant3d, scripts)
- 65655d9 2026-09-01 live 3D view of the plant and its 131 silos
- ec71dd5 install missing deps before dev/build (preflight)
- dd07b3e 2026-09-02 wip overhaul snapshot: immersive shell, split view, archetypes, part shader, structures, picture checks
- 24cac94 2026-09-02 visual overhaul: lighting, structures, dressing, KPI strip, data labels, 2D plan, control bar
- 0e9110e 2026-09-03 remove bottom-left control bar
- f318b69 2026-09-03 halve exposure on post-processing path
- 4488122 2026-09-10 retire 500-series liquid tanks; d9c8ee1 docs trace cleanup
Last 3D change 2026-09-10.
