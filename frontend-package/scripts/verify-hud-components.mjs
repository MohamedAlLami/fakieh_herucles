/**
 * Unit-render the four new Plant 3D HUD components with no browser at all.
 *
 *   node scripts/verify-hud-components.mjs
 *
 * WHY THIS EXISTS
 * ----------------
 * `KpiStrip`, `ControlBar` and `DataChip` are not mounted anywhere yet — the
 * page wiring that puts them on screen is a different worker's change, still
 * landing. `shoot-hud.mjs` drives a real browser against the running page and
 * so cannot see them until that wiring exists. This script does not need the
 * page at all: it bundles each component with esbuild (the same technique
 * `verify-plant3d.mjs` already uses for the non-React modules) and calls
 * `react-dom/server`'s `renderToStaticMarkup` directly, so it can prove the
 * component itself is right — the correct numbers, the correct classes, the
 * correct aria-labels — before any wiring lands.
 *
 * ONE REACT, NOT TWO
 * -------------------
 * `react`, `react-dom` and `react/jsx-runtime` are esbuild EXTERNALS here,
 * the opposite of `verify-plant3d.mjs`'s "bundle everything" rule for the
 * same reason that rule exists, reversed: that script bundles react-free
 * modules into a directory outside the project, where Node cannot resolve
 * bare specifiers back to node_modules. This script renders REACT COMPONENTS
 * with hooks, and two separately bundled copies of react are not
 * hook-compatible with each other — a component's hooks talk to a dispatcher
 * that lives on ITS copy of the react module, and calling it from a
 * different copy is the "Invalid hook call" class of failure. So the output
 * here lands inside the project tree (`scripts/.verify-hud-tmp`, not the OS
 * tmpdir), where Node's normal upward module resolution finds the project's
 * own `node_modules/react` for the externals — the same one this script
 * itself imports to call `renderToStaticMarkup` — while everything else
 * (lucide-react, clsx, tailwind-merge, this app's own `@/lib/*` modules)
 * still bundles in, so nothing needs a second `node_modules` to resolve from.
 *
 * Exit codes match `verify-plant3d.mjs`: 0 all passed, 1 a check failed, 2
 * the harness itself could not run (bundling failed, a component threw).
 */
import { build } from 'esbuild';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const COMPONENTS = join(ROOT, 'client', 'src', 'components', 'water-system', 'plant3d');
const LIB = join(ROOT, 'client', 'src', 'lib', 'plant3d');

let ran = 0;
let failed = 0;

function check(name, fn) {
  ran += 1;
  try {
    const problem = fn();
    if (problem) {
      failed += 1;
      console.log(`FAIL  ${name}\n      ${String(problem).replace(/\n/g, '\n      ')}`);
    } else {
      console.log(`ok    ${name}`);
    }
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}\n      threw: ${err && err.stack ? err.stack : err}`);
  }
}

/** `html` contains every one of `needles`, each reported by name if missing. */
function containsAll(html, needles) {
  const missing = Object.entries(needles).filter(([, text]) => !html.includes(text));
  if (!missing.length) return null;
  return missing.map(([label, text]) => `missing ${label} (${JSON.stringify(text)})`).join('; ');
}

async function bundleInto(dir, entries) {
  await build({
    entryPoints: entries,
    outdir: dir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    logLevel: 'error',
    alias: { '@': join(ROOT, 'client', 'src') },
    /* Without this, `platform: 'node'` resolves `lucide-react` (no `exports`
       map, only legacy `main`/`module` fields, so `conditions` cannot steer
       it) to its CJS build, which `require()`s the external `react` at its
       own top level — and a `format: 'esm'` bundle has no `require()` to
       give it. Preferring `module` over `main` picks lucide-react's ESM
       build instead, whose `import "react"` a plain external passthrough
       handles the normal way. */
    mainFields: ['module', 'main'],
    /* See the file header: react itself must NOT be bundled, so every
       component here shares the exact react module instance this script's
       own `renderToStaticMarkup` uses. */
    external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  });
}

async function main() {
  const dir = await mkdtemp(join(ROOT, 'scripts', '.verify-hud-tmp-'));
  let PlantHud;
  let KpiStripMod;
  let ControlBarMod;
  let DataChipMod;
  let silos;
  let site;

  try {
    try {
      await bundleInto(dir, [
        join(COMPONENTS, 'PlantHud.tsx'),
        join(COMPONENTS, 'KpiStrip.tsx'),
        join(COMPONENTS, 'ControlBar.tsx'),
        join(COMPONENTS, 'DataChip.tsx'),
        join(LIB, 'silos.ts'),
        join(LIB, 'site.ts'),
      ]);
      /* esbuild nests multi-entry-point output under each entry's path
         relative to the lowest common ancestor of every entry point given
         to this one `build()` call (its auto-computed `outbase`) — here
         that ancestor is `client/src`, so the components land under
         `components/water-system/plant3d/*.js` and the lib modules under
         `lib/plant3d/*.js`, not flat in `dir`. */
      const out = (rel) => pathToFileURL(join(dir, rel)).href;
      PlantHud = await import(out(join('components', 'water-system', 'plant3d', 'PlantHud.js')));
      KpiStripMod = await import(out(join('components', 'water-system', 'plant3d', 'KpiStrip.js')));
      ControlBarMod = await import(out(join('components', 'water-system', 'plant3d', 'ControlBar.js')));
      DataChipMod = await import(out(join('components', 'water-system', 'plant3d', 'DataChip.js')));
      silos = await import(out(join('lib', 'plant3d', 'silos.js')));
      site = await import(out(join('lib', 'plant3d', 'site.js')));
    } catch (err) {
      /* Not `process.exit()` here — that would terminate before the outer
         `finally` below removes `dir`, leaving a stray build behind on
         every run that fails this early. Throwing lets the outer `finally`
         run first; `main().catch()` at the bottom turns it into exit 2. */
      throw new Error(`could not bundle or import the HUD components: ${err && err.stack ? err.stack : err}`);
    }

    /* ================================================================ *
     * KpiStrip                                                          *
     * ================================================================ */
    {
      const expectedTotalBins = silos.SILOS.filter((s) => s.group.monitored).length;
      const expectedCapacityKg = silos.SILOS.filter((s) => s.group.monitored && s.group.metered).reduce(
        (sum, s) => sum + s.group.capacityKg,
        0,
      );
      const expectedCapacityText = silos.formatCapacity(expectedCapacityKg);

      const summary = {
        bins: expectedTotalBins,
        tonnes: 12345.6,
        withStock: 87,
        highLevel: 3,
        locked: 2,
        noLevel: 4,
        capacityKg: expectedCapacityKg,
      };
      const plantWroteAt = new Date(Date.now() - 3 * 60_000); // 3 min ago — live
      const fetchedAt = new Date();

      const html = renderToStaticMarkup(
        h(KpiStripMod.KpiStrip, {
          summary,
          plantWroteAt,
          fetchedAt,
          loading: false,
          error: null,
          onRefresh: () => {},
          onGoTo: () => {},
        }),
      );

      check('KpiStrip renders all six cells with the right numbers', () =>
        containsAll(html, {
          'Bins label': '>Bins<',
          'withStock/total': `${summary.withStock}<`,
          'total bins': `/${expectedTotalBins}`,
          'Capacity label': '>Capacity<',
          'capacity figure': expectedCapacityText,
          'Stored label': '>Stored<',
          'stored tonnage': Math.round(summary.tonnes).toLocaleString('en-GB'),
          'Utilisation label': '>Utilisation<',
          'Alarms label': '>Alarms<',
          'high-level chip title': `${summary.highLevel} bin(s) reporting high level`,
          'locked chip title': `${summary.locked} bin(s) locked`,
          'Freshness label': '>Freshness<',
        }),
      );

      /* A bin count the strip did not compute itself — proves the assertion
         above is actually reading the rendered HTML rather than trivially
         passing. `withStock` is a prop the component only ever reads
         literally, so asserting a WRONG value must fail. */
      check('KpiStrip fixture sanity: a wrong withStock value is rejected', () => {
        const bad = containsAll(html, { 'wrong withStock': `>${summary.withStock + 1}<` });
        /* `containsAll` reports MISSING needles as a problem; here the
           "problem" it finds (the wrong number is indeed absent) is the
           PASS for this check, so invert it. */
        return bad ? null : 'the wrong withStock value was found in the markup';
      });

      const staleHtml = renderToStaticMarkup(
        h(KpiStripMod.KpiStrip, {
          summary,
          plantWroteAt: new Date(Date.now() - 20 * 60_000), // 20 min — past the 15 min floor
          fetchedAt,
          loading: false,
          error: null,
          onRefresh: () => {},
          onGoTo: () => {},
        }),
      );
      check('KpiStrip reads "Not live" in red past 15 minutes', () =>
        containsAll(staleHtml, { 'not live text': 'Not live', 'red text class': 'text-red-400' }),
      );
    }

    /* ================================================================ *
     * DataChip                                                          *
     * ================================================================ */
    {
      const dataHtml = renderToStaticMarkup(
        h(DataChipMod.DataChip, { siloNo: 312, percent: 0.62, tonnes: 310, status: 'normal', mode: 'data' }),
      );
      check('DataChip (data mode) renders the three parts', () =>
        containsAll(dataHtml, { number: '>312<', percent: '>62%<', tonnes: '>310 t<' }),
      );

      const statuses = ['low', 'normal', 'high', 'alarm', 'locked', 'no-data'];
      const rendered = Object.fromEntries(
        statuses.map((status) => [
          status,
          renderToStaticMarkup(
            h(DataChipMod.DataChip, { siloNo: 405, percent: 0.5, tonnes: 20, status, mode: 'data' }),
          ),
        ]),
      );

      check('DataChip gives every status a distinct background colour', () => {
        const colors = statuses
          .filter((s) => s !== 'no-data')
          .map((s) => DataChipMod.chipColor(s));
        const unique = new Set(colors);
        if (unique.size !== colors.length) return `colours collide: ${colors.join(', ')}`;
        /* And the colour actually reached the markup as a style, not just
           computed and discarded. */
        return containsAll(rendered.normal, { 'normal colour': DataChipMod.chipColor('normal') })
          || containsAll(rendered.alarm, { 'alarm colour': DataChipMod.chipColor('alarm') });
      });

      check('DataChip draws a padlock on a locked bin and not on a normal one', () => {
        if (!rendered.locked.includes('lucide-lock')) return 'no lock glyph in the locked chip';
        if (rendered.normal.includes('lucide-lock')) return 'a normal chip drew a lock glyph anyway';
        return null;
      });

      check('DataChip shows "***" for no-data rather than a percent or tonnage', () => {
        if (!rendered['no-data'].includes('***')) return 'no "***" in the no-data chip';
        if (rendered['no-data'].includes('50%')) return 'the no-data chip printed a fraction anyway';
        if (!dataChipClassHasDashedBorder(DataChipMod)) return 'dataChipClass has no dashed rim for no-data';
        return null;
      });

      const numberHtml = renderToStaticMarkup(
        h(DataChipMod.DataChip, { siloNo: 807, percent: 0.9, tonnes: 40, status: 'high', mode: 'number' }),
      );
      check('DataChip (number mode) is the plain number pill, not the data chip', () => {
        if (!numberHtml.includes('>807<')) return 'the silo number is missing';
        if (numberHtml.includes('%') || numberHtml.includes(' t<')) {
          return 'number mode leaked percent/tonnage content';
        }
        return null;
      });

      check('NUMBER_CHIP_W / DATA_CHIP_W are the documented formulas', () => {
        if (DataChipMod.NUMBER_CHIP_W(3) !== 11 + 7 * 3) return 'NUMBER_CHIP_W(3) is not 11 + 7*3';
        if (DataChipMod.DATA_CHIP_W(3) <= DataChipMod.NUMBER_CHIP_W(3)) {
          return 'the three-part chip must estimate wider than the bare number';
        }
        return null;
      });
    }

    /* ================================================================ *
     * ControlBar                                                        *
     * ================================================================ */
    {
      const html = renderToStaticMarkup(
        h(ControlBarMod.ControlBar, {
          viewMode: '3d',
          onViewMode: () => {},
          xray: false,
          onXray: () => {},
          onReset: () => {},
          onFit: () => {},
          labels: 'off',
          onLabels: () => {},
          onZoom: () => {},
        }),
      );
      const expectedLabels = [
        '3D view',
        '2D plan view',
        'See inside the silos',
        'Reset view',
        'Fit all',
        'Bin labels',
        'Zoom in',
        'Zoom out',
      ];
      check('ControlBar renders every control with its aria-label', () => {
        const missing = expectedLabels.filter((label) => !html.includes(`aria-label="${label}"`));
        return missing.length ? `missing aria-label(s): ${missing.join(', ')}` : null;
      });
      check('ControlBar reflects aria-pressed on the toggles', () => {
        /* 3D is the active view mode in this fixture; 2D and X-ray are not. */
        const activeCount = (html.match(/aria-pressed="true"/g) ?? []).length;
        const inactiveCount = (html.match(/aria-pressed="false"/g) ?? []).length;
        if (activeCount < 1) return 'nothing rendered aria-pressed="true" with an active view mode';
        if (inactiveCount < 1) return 'nothing rendered aria-pressed="false"';
        return null;
      });
    }

    /* ================================================================ *
     * ZoneSwitch (lives in PlantHud.tsx)                                *
     * ================================================================ */
    {
      const counts = Object.fromEntries(site.ZONES.map((z) => [z.id, 1]));
      const wideHtml = renderToStaticMarkup(
        h(PlantHud.ZoneSwitch, { zones: site.ZONES, zone: 'all', counts, onSelect: () => {}, narrow: false }),
      );
      check('ZoneSwitch prints every zone\'s silo range', () =>
        containsAll(wideHtml, {
          'Yard (outside)': '101–115 · 201–203',
          'Raw': '301–322',
          'Dosing': '401–408 · 901–930',
          'Buffer': '601–605',
          'Finished': '801–848',
        }),
      );

      const narrowHtml = renderToStaticMarkup(
        h(PlantHud.ZoneSwitch, { zones: site.ZONES, zone: 'all', counts, onSelect: () => {}, narrow: true }),
      );
      check('ZoneSwitch hides the ranges when narrow', () => {
        if (narrowHtml.includes('301–322')) return 'a range printed even though narrow=true';
        return null;
      });
    }

    console.log(`\n${ran} checks, ${failed} failed.`);
    process.exit(failed ? 1 : 0);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** `dataChipClass('no-data')` must include Tailwind's `border-dashed` — read
    directly from the exported function rather than re-deriving the class
    string here, so this check breaks the moment that function's contract
    changes instead of silently going stale. */
function dataChipClassHasDashedBorder(mod) {
  return mod.dataChipClass('no-data').includes('border-dashed');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(2);
});
