/**
 * Plant 3D model checks.
 *
 *   node scripts/verify-plant3d.mjs
 *
 * Exit codes are deliberately distinct, because "found nothing wrong" and
 * "could not look" are different results and must never share one:
 *
 *   0  every check ran and passed
 *   1  at least one check failed
 *   2  the checks could not run at all (build failed, module missing)
 *
 * The number of checks executed is printed. A run that quietly executed nothing
 * would otherwise report success.
 *
 * These are the checks that caught real defects while this view was being built:
 * a hopper drawn 5-15% larger than the capacity written on it, a Tailwind
 * opacity class that silently produced no background, and the standing risk that
 * a typo in a layout mask changes a silo count without changing anything that
 * looks wrong.
 */
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'client', 'src', 'lib', 'plant3d');

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

function approx(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance;
}

async function bundle(dir, entries) {
  await build({
    entryPoints: entries.map((e) => join(SRC, e)),
    outdir: dir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'error',
    /* Bundle everything rather than externalising: the output lands in a temp
       directory outside the project, where Node cannot resolve bare specifiers
       back to node_modules. `@react-three/fiber` is only ever a type import in
       these files, so it disappears at compile time and never reaches Node. */
    external: [],
  });
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'plant3d-verify-'));
  let silos;
  let data;
  let geom;
  let shaderMod;
  let mesh;
  let look;
  let groundMod;
  let site;
  try {
    await bundle(dir, ['silos.ts', 'siloData.ts', 'siloGeometry.ts', 'siloShader.ts', 'siloMesh.tsx', 'site.ts', 'look.ts', 'ground.tsx']);
    silos = await import(pathToFileURL(join(dir, 'silos.js')).href);
    data = await import(pathToFileURL(join(dir, 'siloData.js')).href);
    geom = await import(pathToFileURL(join(dir, 'siloGeometry.js')).href);
    shaderMod = await import(pathToFileURL(join(dir, 'siloShader.js')).href);
    mesh = await import(pathToFileURL(join(dir, 'siloMesh.js')).href);
    site = await import(pathToFileURL(join(dir, 'site.js')).href);
    look = await import(pathToFileURL(join(dir, 'look.js')).href);
    groundMod = await import(pathToFileURL(join(dir, 'ground.js')).href);
  } catch (err) {
    console.error('COULD NOT RUN — the modules failed to build or import.');
    console.error(err && err.stack ? err.stack : err);
    await rm(dir, { recursive: true, force: true });
    process.exit(2);
  }

  const { SILOS, SILO_GROUPS, EXPECTED_COUNTS, MONITORED_COUNT } = silos;

  /*
   * Two files are scanned as TEXT rather than imported: `PlantHud.tsx` pulls in
   * React and lucide icons, and neither the disclosure text nor the wording
   * rules are exported values. Read once, up front, so a read failure is a
   * COULD-NOT-RUN rather than three checks quietly passing on `null`.
   */
  let hudSource = null;
  let dataSource = null;
  try {
    hudSource = await readFile(
      join(ROOT, 'client', 'src', 'components', 'water-system', 'plant3d', 'PlantHud.tsx'),
      'utf8',
    );
    dataSource = await readFile(join(ROOT, 'client', 'src', 'lib', 'plant3d', 'siloData.ts'), 'utf8');
  } catch (err) {
    console.error('COULD NOT RUN — could not read the sources to scan.');
    console.error(err && err.stack ? err.stack : err);
    await rm(dir, { recursive: true, force: true });
    process.exit(2);
  }

  /* ---- the model matches the plant ---------------------------------- */

  check('model asserts clean', () => {
    const problems = silos.assertSiloModel();
    return problems.length ? problems.join('; ') : null;
  });

  check('131 monitored bins', () =>
    MONITORED_COUNT === 131 ? null : `got ${MONITORED_COUNT}`);

  check('every group has the count the plant has', () => {
    const bad = [];
    for (const g of SILO_GROUPS) {
      const n = SILOS.filter((s) => s.group.id === g.id).length;
      if (n !== EXPECTED_COUNTS[g.id]) bad.push(`${g.id}: ${n} vs ${EXPECTED_COUNTS[g.id]}`);
    }
    return bad.length ? bad.join(', ') : null;
  });

  check('silo numbers contiguous and in the plant ranges', () => {
    const RANGES = {
      100: [101, 115], 200: [201, 203], 300: [301, 322], 400: [401, 408],
      600: [601, 605], 800: [801, 848], 900: [901, 930],
    };
    const bad = [];
    for (const [series, [lo, hi]] of Object.entries(RANGES)) {
      const nums = SILOS.filter((s) => s.group.series === Number(series))
        .map((s) => s.siloNo)
        .sort((a, b) => a - b);
      if (nums[0] !== lo || nums[nums.length - 1] !== hi) {
        bad.push(`${series}: ${nums[0]}-${nums[nums.length - 1]} vs ${lo}-${hi}`);
        continue;
      }
      if (nums.some((v, i) => i > 0 && v !== nums[i - 1] + 1)) bad.push(`${series}: not contiguous`);
    }
    return bad.length ? bad.join(', ') : null;
  });

  check('no two bins occupy the same space', () => {
    /*
     * Bins on different floors were skipped outright, which meant a ground silo
     * standing directly under the dosing mezzanine could grow tall enough to
     * push through the slab and nothing would say so. Overlap is now a genuine
     * 3D test: footprints must be clear, OR their vertical extents must be.
     */
    const bad = [];
    for (let i = 0; i < SILOS.length; i += 1) {
      for (let j = i + 1; j < SILOS.length; j += 1) {
        const a = SILOS[i];
        const b = SILOS[j];
        /*
         * DRAWN size, not true size — and not `diameter` either.
         *
         * This measured `dims.diameter` — the real vessel — while the screen
         * shows `dims.diameter * drawScale`, and indoor bins are drawn LARGER
         * than life so that a 0.45 m micro hopper is visible next to a 10 m
         * silo. So the check was testing a smaller object than the one on
         * screen, and two bins could overlap in plain sight while it passed.
         *
         * That is the entire size-compression feature, unguarded, for as long
         * as it has existed — and it is the feature the client has asked about
         * twice. An overlap check that measures the wrong object is worse than
         * none, because it is quoted as evidence.
         *
         * `diameter` itself stopped being the drawn width the day the profile
         * grew a roof eave and a foundation skirt wider than the shell —
         * `geom.profileMaxRadius` is the actual outer edge of what
         * `siloProfile` draws, whatever shape that happens to be this week.
         * Measuring `diameter / 2` here again the next time someone widens
         * the silhouette would be exactly the bug this comment already
         * describes once, just moved one level down.
         */
        const dOf = (p) => 2 * geom.profileMaxRadius(p.dims) * p.drawScale;
        const gap = Math.hypot(a.x - b.x, a.z - b.z) - (dOf(a) + dOf(b)) / 2;
        if (gap >= -1e-6) continue;

        const aLo = a.floor;
        const aHi = a.topY;
        const bLo = b.floor;
        const bHi = b.topY;
        const vertical = Math.min(aHi, bHi) - Math.max(aLo, bLo);
        if (vertical <= 1e-6) continue;

        if (bad.length < 5) {
          bad.push(
            `${a.siloNo}/${b.siloNo} overlap ${(-gap).toFixed(2)}m across and ${vertical.toFixed(2)}m up`,
          );
        }
      }
    }
    return bad.length ? bad.join(', ') : null;
  });

  check('every indoor group fits inside its building', () => {
    /*
     * Silo-versus-silo overlap says nothing about a bin poking through a wall or
     * a roof. This was checked by hand while the layout was being built and then
     * left out of the suite, which means nothing would have caught someone
     * nudging a group two metres and pushing it through the mill.
     */
    const buildings = site.BUILDINGS;
    if (!buildings || !buildings.length) return 'no buildings in the site model';
    const byZone = new Map();
    const byId = new Map();
    for (const b of buildings) {
      if (b.zone) byZone.set(b.zone, b);
      byId.set(b.id, b);
    }

    const bad = [];
    for (const g of SILO_GROUPS) {
      /*
       * An explicit `building` wins over the zone lookup. A group's zone says
       * what its bins ARE; the building says where they stand, and the two are
       * only usually the same. Naming a building that does not exist is a
       * mistake worth catching rather than silently skipping, so that case
       * fails instead of falling through to "outdoor group".
       */
      const b = g.building ? byId.get(g.building) : byZone.get(g.zone);
      if (g.building && !b) {
        bad.push(`${g.id} names building "${g.building}", which is not in the site model`);
        continue;
      }
      if (!b) continue; /* outdoor group */
      const ss = SILOS.filter((s) => s.group.id === g.id);
      /* Drawn, not true — same reason as the overlap check above, and the same
         `profileMaxRadius` fix: a group can poke through a wall on screen
         while its real vessels, or even its nominal `diameter`, would have
         fitted with room to spare. */
      const r = geom.profileMaxRadius(ss[0].dims) * ss[0].drawScale;
      const marginX = Math.min(
        Math.min(...ss.map((s) => s.x)) - r - (b.x - b.length / 2),
        b.x + b.length / 2 - (Math.max(...ss.map((s) => s.x)) + r),
      );
      const marginZ = Math.min(
        Math.min(...ss.map((s) => s.z)) - r - (b.z - b.width / 2),
        b.z + b.width / 2 - (Math.max(...ss.map((s) => s.z)) + r),
      );
      const head = b.height + (b.roofRise ?? 0) - Math.max(...ss.map((s) => s.topY));
      if (marginX < 0.5 || marginZ < 0.5 || head < 0.5) {
        bad.push(
          `${g.id} in ${b.id}: margins X ${marginX.toFixed(1)}m Z ${marginZ.toFixed(1)}m head ${head.toFixed(1)}m`,
        );
      }
    }
    return bad.length ? bad.join(', ') : null;
  });

  check('no outdoor group stands inside a building', () => {
    /*
     * The hole the building-fit check leaves, and it was not theoretical.
     *
     * That check walks the groups, looks up a building by the group's ZONE, and
     * does `if (!b) continue;` for anything with no matching building —
     * commented "outdoor group". So every outdoor group is excused from the
     * only check that knows where the walls are. An outdoor group standing in
     * the middle of an indoor building satisfies it perfectly.
     *
     * The 500 series was doing exactly that: five liquid tanks declared
     * `zone: 'outside'`, drawn at x -56..-20, z 14, inside mill-a at x -43..13,
     * z -21..39. Three of the five stood in the raw material building. It
     * survived every one of the 36 checks and was found by the client drawing
     * a red circle round it on a screenshot.
     *
     * Footprint only, deliberately: a bin genuinely tucked under an elevated
     * deck would be a legitimate thing to draw, but no group here does that,
     * and treating a plan-view intersection as the fault keeps the rule simple
     * enough to be obviously right.
     */
    const buildings = site.BUILDINGS;
    if (!buildings || !buildings.length) return 'no buildings in the site model';
    const outdoor = SILO_GROUPS.filter((g) => !buildings.some((b) => b.zone === g.zone));
    /* If every group turned out to be indoors this check would pass while
       examining nothing at all — the empty-loop trap. */
    if (outdoor.length === 0) return 'found no outdoor groups to check — the zone lookup is broken';

    const bad = [];
    for (const g of outdoor) {
      for (const p of SILOS.filter((s2) => s2.group.id === g.id)) {
        const r = geom.profileMaxRadius(p.dims) * p.drawScale;
        for (const b of buildings) {
          const insideX = p.x + r > b.x - b.length / 2 && p.x - r < b.x + b.length / 2;
          const insideZ = p.z + r > b.z - b.width / 2 && p.z - r < b.z + b.width / 2;
          if (insideX && insideZ && bad.length < 6) {
            bad.push(`silo ${p.siloNo} (${g.id}, zone ${g.zone}) stands in ${b.id}`);
          }
        }
      }
    }
    return bad.length ? bad.join('; ') : null;
  });

  /* ---- the drawn shape holds the stated capacity --------------------- */

  check('every group holds the capacity written on it', () => {
    const bad = [];
    for (const g of SILO_GROUPS) {
      const d = silos.deriveDims(g.capacityKg, g.diameter, g.hopperRatio, g.elevation);
      const want = g.capacityKg / 1000 / silos.BULK_DENSITY_T_PER_M3;
      const got = silos.storageVolume(d);
      /* `NaN > 0.001` is false, so without this a NaN volume passes as correct. */
      if (!Number.isFinite(got) || !Number.isFinite(want)) {
        bad.push(`${g.id}: non-finite volume (${got} vs ${want})`);
        continue;
      }
      const err = Math.abs(got - want) / want;
      if (err > 0.001) bad.push(`${g.id}: ${(err * 100).toFixed(2)}% out`);
    }
    return bad.length ? bad.join(', ') : null;
  });

  check('the drawn profile encloses exactly that volume', () => {
    /* Integrate the revolved profile between the storage bounds and compare with
       the arithmetic. This is the check that catches geometry and maths drifting
       apart, which is precisely how the hopper came to be 15% too big. */
    const bad = [];
    for (const g of SILO_GROUPS) {
      const d = silos.deriveDims(g.capacityKg, g.diameter, g.hopperRatio, g.elevation);
      const [y0, y1] = geom.fillRange(d);
      const pts = geom.siloProfile(d);
      let volume = 0;
      for (let i = 1; i < pts.length; i += 1) {
        const lo = pts[i - 1];
        const hi = pts[i];
        const a = Math.max(lo.y, y0);
        const b = Math.min(hi.y, y1);
        if (b <= a || hi.y === lo.y) continue;
        const rAt = (y) => lo.x + ((hi.x - lo.x) * (y - lo.y)) / (hi.y - lo.y);
        const r1 = rAt(a);
        const r2 = rAt(b);
        volume += (Math.PI / 3) * (b - a) * (r1 * r1 + r1 * r2 + r2 * r2);
      }
      const want = silos.storageVolume(d);
      if (!Number.isFinite(volume) || !Number.isFinite(want)) {
        bad.push(`${g.id}: non-finite profile volume (${volume} vs ${want})`);
        continue;
      }
      const err = Math.abs(volume - want) / want;
      if (err > 0.001) bad.push(`${g.id}: profile ${volume.toFixed(3)} vs maths ${want.toFixed(3)}`);
    }
    return bad.length ? bad.join(', ') : null;
  });

  check('the profile has no degenerate segment', () => {
    /* A zero-length lathe segment yields NaN normals and a bin that renders
       black. The creases are deliberately a few millimetres apart. */
    const bad = [];
    let shortest = Infinity;
    for (const g of SILO_GROUPS) {
      const d = silos.deriveDims(g.capacityKg, g.diameter, g.hopperRatio, g.elevation);
      const pts = geom.siloProfile(d);
      for (let i = 1; i < pts.length; i += 1) {
        const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        /* Every comparison below is false for NaN, so it has to be rejected
           explicitly or a profile full of NaN sails through as valid. */
        if (!Number.isFinite(len) || !Number.isFinite(pts[i].x) || !Number.isFinite(pts[i].y)) {
          bad.push(`${g.id} segment ${i} is not finite`);
          continue;
        }
        shortest = Math.min(shortest, len);
        if (len <= 0) bad.push(`${g.id} segment ${i}`);
        if (pts[i].y < pts[i - 1].y) bad.push(`${g.id} segment ${i} goes back down`);
        if (pts[i].x < 0) bad.push(`${g.id} segment ${i} negative radius`);
      }
    }
    if (bad.length) return bad.join(', ');
    console.log(`      shortest profile segment ${shortest.toFixed(4)} m`);
    return null;
  });

  /* ---- the level maths inverts the volume ---------------------------- */

  check('fill height inverts the volume exactly', () => {
    let worst = 0;
    let where = '';
    for (const g of SILO_GROUPS) {
      const d = silos.deriveDims(g.capacityKg, g.diameter, g.hopperRatio, g.elevation);
      const total = silos.storageVolume(d);
      for (const f of [0, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
        const h = silos.heightFractionForVolume(d, f) * (d.hopper + d.barrel);
        const back = silos.storageVolumeUpTo(d, h) / total;
        if (!Number.isFinite(back) || !Number.isFinite(h)) {
          return `non-finite inverse for ${g.id} at f=${f}`;
        }
        if (Math.abs(back - f) > worst) {
          worst = Math.abs(back - f);
          where = `${g.id} f=${f}`;
        }
      }
    }
    return worst > 0.005 ? `worst error ${worst.toExponential(2)} at ${where}` : null;
  });

  check('fill height stays inside 0..1 for any input', () => {
    const d = silos.deriveDims(160000, 4, 0.7, 2.5);
    const bad = [];
    for (const f of [-5, -0.3, 0, 1, 1.4, 99, NaN, Infinity, -Infinity]) {
      const v = silos.heightFractionForVolume(d, f);
      if (!Number.isFinite(v) || v < 0 || v > 1) bad.push(`${f} -> ${v}`);
    }
    if (!approx(silos.heightFractionForVolume(d, 0), 0, 0)) bad.push('f=0 is not exactly 0');
    if (!approx(silos.heightFractionForVolume(d, 1), 1, 0)) bad.push('f=1 is not exactly 1');
    return bad.length ? bad.join(', ') : null;
  });

  /* ---- the rules about what may not be drawn ------------------------- */

  check('the 400 series never gets a level, even when the API sends one', () => {
    const bad = [];
    for (const p of SILOS.filter((s) => s.group.series === 400)) {
      /* A deliberately non-zero quantity: the API really does return these. */
      const level = data.siloLevel(p, {
        siloNo: p.siloNo, dbNo: 3, binName: '', materialCode: '113',
        materialName: 'Limestone', quantityKg: 3400, hlActive: false,
        lockActive: false, updatedAt: new Date().toISOString(),
      });
      if (level.fill !== null || level.reason !== 'no-tag') {
        bad.push(`${p.siloNo}: fill=${level.fill} reason=${level.reason}`);
      }
    }
    return bad.length ? bad.join(', ') : null;
  });

  /*
   * This used to assert that the one unmonitored group -- the 500-series
   * liquid tanks -- never drew a level. The client retired those tanks on
   * 2026-09-10 and every remaining group is monitored, so the check is
   * inverted: it now guards the assumption the UI was simplified on.
   *
   * It matters because a good deal of code was deleted on the strength of
   * "no group is unmonitored": the 'not-monitored' level reason, the muted
   * shader input in Plant3D, the "not in the feed" tooltips. Re-adding an
   * unmonitored group without restoring those would silently draw it as an
   * ordinary bin with no data, which is the mislabelling all of this exists
   * to prevent.
   */
  check('every group in the model is monitored', () => {
    const bad = SILOS.filter((s) => !s.group.monitored).map((s) => s.siloNo);
    return bad.length
      ? `unmonitored bins ${bad.join(', ')} — the UI no longer has a way to show them; see this check`
      : null;
  });

  check('a negative quantity clamps the fill but keeps the number', () => {
    const p = SILOS.find((s) => s.group.series === 300);
    const level = data.siloLevel(p, {
      siloNo: p.siloNo, dbNo: 1, binName: '', materialCode: '100',
      materialName: 'Maize', quantityKg: -152.78, hlActive: false,
      lockActive: false, updatedAt: new Date().toISOString(),
    });
    if (level.fill !== 0) return `fill should be exactly 0, got ${level.fill}`;
    if (level.quantityKg !== -152.78) return `quantity mangled to ${level.quantityKg}`;
    if (!level.outOfRange) return 'not flagged out of range';
    return null;
  });

  check('an over-capacity quantity reads full and out of range', () => {
    const p = SILOS.find((s) => s.group.series === 800);
    const level = data.siloLevel(p, {
      siloNo: p.siloNo, dbNo: 2, binName: '', materialCode: '100',
      materialName: 'Maize', quantityKg: p.group.capacityKg * 1.5, hlActive: false,
      lockActive: false, updatedAt: new Date().toISOString(),
    });
    if (level.fill !== 1) return `fill should be exactly 1, got ${level.fill}`;
    return level.outOfRange ? null : 'not flagged out of range';
  });

  /* ---- material colours ---------------------------------------------- */

  check('no two materials share a colour, well past the palette length', () => {
    /* Seven codes never reached the point where the palette wraps. Forty-two is
       three full tiers — the first repeat is at 43, and that is stated rather
       than discovered by someone looking at two identical silos. */
    for (const n of [7, 14, 15, 28, 42]) {
      const codes = Array.from({ length: n }, (_, i) => String(100 + i * 3));
      const palette = data.buildMaterialPalette(codes);
      const unique = new Set(codes.map((c) => data.materialColorIn(palette, c)));
      if (unique.size !== n) return `${n} materials produced only ${unique.size} colours`;
    }
    return null;
  });

  check('material codes are matched with whitespace trimmed', () => {
    /* A padded PLC code used to miss its palette entry and silently fall back
       to the hash, giving the same material two colours on one screen. */
    const palette = data.buildMaterialPalette(['100', '105']);
    return data.materialColorIn(palette, ' 100 ') === data.materialColorIn(palette, '100')
      ? null
      : 'a padded code resolves to a different colour';
  });

  check('a material keeps its colour whatever else the plant is holding', () => {
    /*
     * This only ever added a HIGHER code — the one direction that happened to be
     * safe under the old sorted-index assignment, so it passed while the real
     * failure sat next to it untested. Colours came from position among the
     * codes PRESENT, so loading material 8 into any bin sorted it to the front,
     * took the first colour, and shifted every other material along. Maize
     * changed colour between one shift and the next.
     *
     * An operator learns these colours. They have to survive the plant's stock
     * changing, which is the only thing about a plant that is guaranteed.
     */
    const codes = ['100', '105', '112', '113', '202', '210'];
    const before = data.buildMaterialPalette(codes);
    const cases = [
      ['a higher code appears', [...codes, '900']],
      ['a LOWER code appears', [...codes, '8']],
      ['a code in the middle appears', [...codes, '111']],
      ['several codes appear at once', [...codes, '8', '12', '33', '900']],
      ['half of them go away', ['100', '113', '210']],
      ['the order they arrive in changes', [...codes].reverse()],
    ];
    const bad = [];
    for (const [what, after] of cases) {
      const p = data.buildMaterialPalette(after);
      for (const c of codes) {
        /* Only codes still present can be compared — one that has gone away has
           no colour to keep. */
        if (!after.includes(c)) continue;
        if (data.materialColorIn(before, c) !== data.materialColorIn(p, c)) {
          bad.push(`${c} changed colour when ${what}`);
        }
      }
    }
    return bad.length ? bad.join(', ') : null;
  });

  check('the palette is a value, not shared module state', () => {
    /* Building one palette used to overwrite a module-level map that every
       caller read from. Checking a single colour was too weak: a map that
       ACCUMULATED entries would have passed. Compare whole snapshots and
       identities. */
    const a = data.buildMaterialPalette(['100', '105']);
    const snapshot = JSON.stringify([...a.entries()].sort());
    const b = data.buildMaterialPalette(['700', '800', '900']);
    if (a === b) return 'two calls returned the same map instance';
    if (JSON.stringify([...a.entries()].sort()) !== snapshot) {
      return 'building a second palette mutated the first';
    }
    if (a.has('700')) return 'the first palette gained an entry from the second';
    return null;
  });

  check('a bin holding stock is never labelled empty', () => {
    const withStock = data.materialLabel({
      siloNo: 1, dbNo: 1, binName: '', materialCode: null, materialName: null,
      quantityKg: 4200, hlActive: false, lockActive: false, updatedAt: null,
    });
    const empty = data.materialLabel({
      siloNo: 1, dbNo: 1, binName: '', materialCode: null, materialName: null,
      quantityKg: 0, hlActive: false, lockActive: false, updatedAt: null,
    });
    if (/empty/i.test(withStock)) return `a bin holding 4200 kg is labelled "${withStock}"`;
    return /empty/i.test(empty) ? null : `an empty bin is labelled "${empty}"`;
  });

  /* ---- the shader actually gets patched ------------------------------ */

  const THREE = await import('three');

  check('every shader splice point exists exactly once', () => {
    /* `String.replace` matches nothing quietly. If three renames a chunk, the
       injection silently vanishes and the page still renders — just with no
       level shading and an opaque shell. Nothing would throw. */
    const lib = THREE.ShaderLib.physical;
    const markers = shaderMod.SILO_SHADER_MARKERS;
    /* A loop over an empty array passes trivially. Emptying both lists made this
       report ok while asserting nothing whatsoever — the same shape as the
       Tailwind check that once passed while matching zero classes. */
    if (!markers.vertex.length || !markers.fragment.length) {
      return `no markers declared (${markers.vertex.length} vertex, ${markers.fragment.length} fragment) — checked nothing`;
    }
    const bad = [];
    for (const marker of markers.vertex) {
      const n = lib.vertexShader.split(marker).length - 1;
      if (n !== 1) bad.push(`vertex "${marker}" appears ${n} times`);
    }
    for (const marker of markers.fragment) {
      const n = lib.fragmentShader.split(marker).length - 1;
      if (n !== 1) bad.push(`fragment "${marker}" appears ${n} times`);
    }
    return bad.length ? bad.join(', ') : null;
  });

  /*
   * The mesh module is bundled and imported for its own sake.
   *
   * Nothing else in this file uses it: the geometry and shader assertions moved
   * to `siloGeometry.ts` and `siloShader.ts` when `siloMesh.tsx` was split so it
   * would export only its component. Dropping it from the bundle would have
   * been the obvious tidy-up and would have quietly removed the only thing
   * standing between a broken component and a clean run of these checks —
   * `npx tsc` would still catch it, but this script is what gets run.
   *
   * Named as a check rather than left implicit in the import list, so that
   * anyone removing it has to remove a check to do it.
   */
  /*
   * The sun must be off to one side and BEHIND the camera, in every look.
   *
   * This rule was learned three times over and each time it cost hours of
   * tuning colours that were never the problem:
   *
   *   ~0 degrees   the sun is over the camera's shoulder. Every visible face is
   *                lit, no shadow falls anywhere the viewer can see, and the
   *                whole site reads as flat cardboard.
   *   ~180 degrees the sun is in front. The bins go to silhouette AND the sun
   *                enters the frame, where drei's Sky shader paints a scattering
   *                hot-spot that blows out the upper half of the picture.
   *
   * The failure is silent in both directions: the page renders, nothing errors,
   * and the image is just quietly wrong. Night had drifted to 128 degrees with a
   * NEGATIVE dot product — in front of the camera — which is why "night" was not
   * dark. A comment saying "keep the sun off-axis" did not catch that. This
   * does, and it will catch the same drift in SITE_VIEW.dir.
   */
  check('a non-string material code cannot blank the page', () => {
    /*
     * `materialCode` is typed `string | null`, and the type is a promise the
     * JSON cannot keep. One row arriving with a NUMBER — ordinary for a driver
     * that does not cast an integer column — used to throw "trim is not a
     * function" out of a render. There is no ErrorBoundary anywhere in this
     * app, so the entire page went white and STAYED white through every
     * subsequent poll. A silent blank screen from one malformed field is worse
     * than any wrong number this view could show.
     */
    const bad = [];
    const numeric = 105;
    const attempts = [
      ['materialLabel', () => data.materialLabel({ materialCode: numeric, quantityKg: 1 })],
      ['buildMaterialPalette', () => data.buildMaterialPalette(['100', numeric, '112'])],
      ['materialsPresent', () => data.materialsPresent([{ materialCode: numeric, quantityKg: 1 }], new Map())],
      ['materialColorIn', () => data.materialColorIn(data.buildMaterialPalette(['100']), numeric)],
    ];
    for (const [name, run] of attempts) {
      try {
        run();
      } catch (err) {
        bad.push(`${name}: ${err.message}`);
      }
    }
    return bad.length ? bad.join('; ') : null;
  });

  check('nothing shown on screen calls an in-service bin unused or idle', () => {
    /*
     * The 500-series IS in service — the plant's own SCADA shows 501-504 as soya
     * oil and 505 as the Term IN-8 line, with live pumps and valves. They are
     * absent from THIS app's feed, which is a gap in what the view can see.
     * Calling them idle tells the client something false about their own plant,
     * and the detail panel once asserted both readings in the same panel: a
     * tooltip saying "these tanks are unused" directly above a note saying "not
     * an idle tank farm".
     *
     * Scanned as RENDERED TEXT, not as source. A first pass at this grepped the
     * whole file and failed on the comment explaining the rule — a check that
     * fires on a sentence stating the opposite of the thing it forbids is a
     * check someone deletes. What matters is what reaches a screen.
     */
    if (hudSource === null) return 'COULD NOT READ PlantHud.tsx';
    const shown = [];

    /*
     * Match to the closing `};` at the start of a line, NOT to the first
     * semicolon. `const NO_LEVEL: Record<string, { chip: string; detail: string }>`
     * carries semicolons inside its own TYPE ANNOTATION, so the `[^;]+` this was
     * first written with captured the declaration header and nothing else. It
     * then scanned zero strings and reported ok — in a check whose entire
     * purpose is catching exactly that. Found only by breaking the target on
     * purpose and watching the check pass anyway.
     */
    const noLevel = hudSource.match(/const NO_LEVEL[\s\S]*?\n\};/);
    if (!noLevel) return 'no NO_LEVEL block found at all';
    for (const [, s] of noLevel[0].matchAll(/'([^']{12,})'/g)) shown.push(['NO_LEVEL', s]);
    /* Counted per source, not pooled: the group notes below would otherwise
       carry the total past any threshold while NO_LEVEL contributed nothing. */
    if (shown.length < 3) return `NO_LEVEL yielded only ${shown.length} strings`;

    /* The group notes render straight into the detail panel. */
    const notes = SILO_GROUPS.filter((g) => g.note);
    if (notes.length < 3) return `only ${notes.length} group notes to scan`;
    for (const g of notes) shown.push([g.id, g.note]);

    const bad = shown
      .filter(([, s]) => /\b(unused|idle)\b/i.test(s) && !/\bnot\b[^.]{0,16}\b(unused|idle)\b/i.test(s))
      .map(([where]) => where);
    return bad.length ? `asserted in: ${[...new Set(bad)].join(', ')}` : null;
  });

  check('the disclosure names every distortion the drawing applies', () => {
    /*
     * Three separate distortions are applied to make the plant legible, and the
     * legend is the only place a viewer is ever told. If a constant changes and
     * this text does not, the view is quietly lying about its own geometry.
     */
    if (hudSource === null) return 'COULD NOT READ PlantHud.tsx';
    const block = hudSource.match(/const PROVENANCE = \[([\s\S]*?)\]\.join/);
    if (!block) return 'no PROVENANCE block found at all';
    const text = block[1];
    const bad = [];
    /*
     * Compared against the EXPORTED constant, not against the literal 1.55.
     *
     * This used to test `/1\.55/` while the failure message right here already
     * interpolated `silos.VERTICAL_EXAGGERATION` — so the check knew the real
     * value and declined to use it. Change the exaggeration to 1.8 and the
     * disclosure keeps telling the operator 1.55, which is the precise thing
     * the comment above says this check exists to prevent: "if a constant
     * changes and this text does not, the view is quietly lying about its own
     * geometry." The check was pinned to the value the text happened to say.
     *
     * Accepts the LITERAL number OR a template-literal reference to the
     * constant itself (`${VERTICAL_EXAGGERATION}`) — the source is scanned as
     * TEXT here, not evaluated, so a `${VERTICAL_EXAGGERATION}x` in the
     * PROVENANCE string reads as the two literal characters `$`, `{`, the
     * identifier, `}`, `x` rather than as "1.25x". That interpolation is a
     * STRONGER guarantee against the exact drift this check exists to catch
     * — the text cannot say the wrong number once it is computed from the
     * constant at runtime — so it has to count as satisfying the rule, not
     * fail it for no longer spelling the digits out by hand.
     */
    const hasLiteral = new RegExp(String(silos.VERTICAL_EXAGGERATION).replace('.', '\.')).test(text);
    const hasInterpolation = /\$\{\s*VERTICAL_EXAGGERATION\s*\}/.test(text);
    if (!hasLiteral && !hasInterpolation) {
      bad.push(`the ${silos.VERTICAL_EXAGGERATION}x height stretch`);
    }
    if (!/compress/i.test(text)) bad.push('the indoor size compression');
    if (!new RegExp(String(silos.SIZE_FLOOR_DIAMETER)).test(text)) {
      bad.push(`the ${silos.SIZE_FLOOR_DIAMETER} m size floor`);
    }
    return bad.length ? `undisclosed: ${bad.join(', ')}` : null;
  });

  check('the sun is off-axis and behind the camera from every angle the view uses', () => {
    /*
     * Every camera direction, not just the site one.
     *
     * This asked `checkSunGeometry(LOOKS, SITE_VIEW.dir)` and stopped there —
     * three looks against ONE of the six directions this view actually points
     * the camera in. The whole-site framing was covered; every zone the
     * operator spends their time in was not. An audit found the consequence
     * sitting in the tree already, not hypothetically: a zone/look pair more
     * than 90 degrees off, i.e. the sun in front of the camera, flattening the
     * bins into cardboard — with the check reporting ok, because it never
     * looked at that direction.
     *
     * The angles here are the geometry the whole lighting design rests on, so
     * checking one seventh of them was close to checking none.
     */
    /*
     * Two rules, because one rule cannot honestly cover both cases.
     *
     * `checkSunGeometry`'s 45-80 degree band is a QUALITY preference: it is the
     * range where one flank is lit and the other falls away, and it is what the
     * primary framing is composed for. It cannot be required of every zone.
     * There is one sun and six camera directions pointing all over a 280 m
     * site; no single sun position sits 45-80 degrees off all of them, so a
     * flat rule would be unsatisfiable by construction, and an unsatisfiable
     * check gets relaxed until it passes, which is how checks die.
     *
     * What IS required everywhere is the physical rule the whole lighting
     * design rests on: the sun stays BEHIND the camera. Past 90 degrees it is
     * in front, the lit face is the one turned away, and the bins flatten into
     * cardboard — the exact "barely able to see them" complaint. That is a
     * defect at any zone, in any look.
     *
     * So: over 90 degrees fails anywhere. The 45-80 preference is enforced on
     * the site view, which is the default and the one that is composed, and
     * reported as advisory elsewhere rather than silently tolerated.
     */
    const dirs = [{ where: 'whole site', dir: site.SITE_VIEW.dir, composed: true }]
      .concat(site.ZONES.map((z) => ({ where: z.label, dir: z.dir, composed: false })));
    const bad = [];
    const advisory = [];
    let examined = 0;
    for (const { where, dir, composed } of dirs) {
      const results = look.checkSunGeometry(look.LOOKS, dir);
      examined += results.length;
      for (const r of results) {
        if (r.angleDeg >= 90) {
          bad.push(`${where} at ${r.time}: ${r.angleDeg.toFixed(1)} deg — the sun is IN FRONT of the camera`);
        } else if (!r.safe && composed) {
          bad.push(`${where} at ${r.time}: ${r.angleDeg.toFixed(1)} deg, outside the composed 45-80 band`);
        } else if (!r.safe) {
          advisory.push(`${where}/${r.time} ${r.angleDeg.toFixed(0)}deg`);
        }
      }
    }
    /* A direction list that came back empty would satisfy every assertion above
       without examining anything — the empty-loop trap this file has been
       bitten by before. */
    if (examined === 0) return 'examined no look/direction pairs at all';
    if (advisory.length) {
      console.log(`      advisory (outside 45-80 but still behind the camera): ${advisory.join(', ')}`);
    }
    return bad.length ? `${bad.length} of ${examined} pairs unsafe: ${bad.join('; ')}` : null;
  });

  check('every ground shader splice point exists exactly once', () => {
    /* Same silent failure as the silo shader: the ground patches three's stock
       material by string replacement, so a renamed chunk means the injected
       code never runs, the page still renders, and the yard is quietly a flat
       colour with no markings on it. */
    const lib = THREE.ShaderLib.physical;
    const markers = groundMod.GROUND_SHADER_MARKERS;
    if (!markers) return 'the ground module exports no splice markers';
    /* Same empty-array trap as the silo markers above. */
    if (!markers.vertex.length || !markers.fragment.length) {
      return `no markers declared (${markers.vertex.length} vertex, ${markers.fragment.length} fragment) — checked nothing`;
    }
    const bad = [];
    for (const marker of markers.vertex) {
      const n = lib.vertexShader.split(marker).length - 1;
      if (n !== 1) bad.push(`vertex "${marker}" appears ${n} times`);
    }
    for (const marker of markers.fragment) {
      const n = lib.fragmentShader.split(marker).length - 1;
      if (n !== 1) bad.push(`fragment "${marker}" appears ${n} times`);
    }
    if (bad.length) return bad.join(', ');

    /* And that the patch actually lands, rather than matching nothing. */
    const patched = { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
    groundMod.patchGroundShader(patched);
    if (patched.vertexShader.length <= lib.vertexShader.length) return 'the vertex patch added nothing';
    if (patched.fragmentShader.length <= lib.fragmentShader.length) return 'the fragment patch added nothing';
    return null;
  });

  check('the silo mesh module still builds and exports its component', () => {
    if (typeof mesh.SiloGroupMesh !== 'function') {
      return `SiloGroupMesh is ${typeof mesh.SiloGroupMesh}, not a component`;
    }
    /* The whole point of the split. A non-component export puts the file back
       outside Vite's Fast Refresh boundary and every edit reloads the page,
       losing the camera, the selection and the WebGL context with it. */
    const extra = Object.keys(mesh).filter((k) => k !== 'SiloGroupMesh');
    return extra.length ? `also exports ${extra.join(', ')} — breaks Fast Refresh` : null;
  });

  check('the patched shader declares everything it uses', () => {
    const lib = THREE.ShaderLib.physical;
    const shader = { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
    shaderMod.patchSiloShader(shader);

    /* Resolve three's #include directives so the check sees the real source the
       driver would see, not a file full of unexpanded directives. */
    const resolve = (src) => {
      let out = src;
      for (let pass = 0; pass < 6; pass += 1) {
        out = out.replace(/#include <(\w+)>/g, (whole, name) =>
          THREE.ShaderChunk[name] === undefined ? whole : THREE.ShaderChunk[name]);
      }
      return out;
    };
    const vert = resolve(shader.vertexShader);
    const frag = resolve(shader.fragmentShader);

    const bad = [];
    const declared = (src, decl) => (src.includes(decl) ? null : decl);

    /*
     * Derived from the source, not listed by hand.
     *
     * This used to be three literal arrays — `'attribute vec2 aFx'` and friends —
     * which made it a whitelist that could only fail on names somebody had
     * thought to write down. It missed `vY`, `vUpDir` and `vInstJit` entirely,
     * and it reported a FAILURE the day `aFx` legitimately became a vec3,
     * because the hardcoded type no longer matched. Wrong in both directions:
     * blind to real regressions, noisy on real changes.
     *
     * So: pull every `aXxx` / `vXxx` / `uXxx` this project declares out of the
     * patched shader itself, and assert each is declared in every stage that
     * uses it, with the SAME type on both sides of a varying. That is what the
     * name of this check has always claimed.
     */
    const OURS = /\b(?:attribute|varying|uniform)\s+(\w+)\s+([auv][A-Z]\w*)\s*;/g;
    const declsIn = (src) => {
      const out = new Map();
      for (const [, type, name] of src.matchAll(OURS)) out.set(name, type);
      return out;
    };
    const vertDecls = declsIn(vert);
    const fragDecls = declsIn(frag);
    if (vertDecls.size < 4 || fragDecls.size < 4) {
      return `found only ${vertDecls.size} vertex and ${fragDecls.size} fragment declarations — scanned nothing`;
    }

    /* Used, but stripped of comments first: a name that appears only inside a
       comment is not a use, and this file is heavily commented. */
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    const usedIn = (src) => new Set((strip(src).match(/\b[auv][A-Z]\w*\b/g) ?? []));
    for (const [stage, decls, src] of [
      ['vertex', vertDecls, vert],
      ['fragment', fragDecls, frag],
    ]) {
      for (const name of usedIn(src)) {
        /* Only our own names. three has plenty of its own aXxx/vXxx/uXxx and
           they are its problem, declared behind preprocessor conditionals we
           cannot evaluate here. */
        if (!vertDecls.has(name) && !fragDecls.has(name)) continue;
        if (!decls.has(name)) bad.push(`${stage} uses ${name} without declaring it`);
      }
    }
    for (const [name, type] of vertDecls) {
      const other = fragDecls.get(name);
      if (other && other !== type) {
        bad.push(`${name} is ${type} in the vertex stage and ${other} in the fragment stage`);
      }
    }

    /* Identifiers we borrow from three must be in scope where we use them.
       `vViewPosition` is the one at risk: it is declared conditionally. */
    if (!/varying vec3 vViewPosition/.test(frag)) {
      bad.push('vViewPosition is not declared in the fragment shader — FRAG_ALPHA would not compile');
    }
    if (!/vec3 normal = /.test(frag)) {
      bad.push('no `normal` in the fragment shader — FRAG_ALPHA would not compile');
    }
    /* The alpha block must land after the normal is computed, or `normal` is
       used before it exists. */
    const normalAt = frag.indexOf('vec3 normal = ');
    const alphaAt = frag.indexOf(shaderMod.SILO_ALPHA_SENTINEL);
    if (alphaAt === -1) bad.push('the shell alpha block did not get injected at all');
    else if (normalAt === -1 || alphaAt < normalAt) {
      bad.push('the shell alpha block is injected before `normal` is computed');
    }

    /*
     * Braces: compare against the UNPATCHED shader rather than expecting zero.
     * three's own fragment source resolves to 161 open and 160 close — a brace
     * inside a preprocessor conditional — so "balanced" is the wrong assertion
     * and would fail for a reason that has nothing to do with this patch. What
     * matters is that the patch leaves the balance exactly as it found it.
     */
    const balance = (src) => (src.match(/\{/g) || []).length - (src.match(/\}/g) || []).length;
    const baseVert = resolve(lib.vertexShader);
    const baseFrag = resolve(lib.fragmentShader);
    if (balance(vert) !== balance(baseVert)) {
      bad.push(`patch changed vertex brace balance by ${balance(vert) - balance(baseVert)}`);
    }
    if (balance(frag) !== balance(baseFrag)) {
      bad.push(`patch changed fragment brace balance by ${balance(frag) - balance(baseFrag)}`);
    }
    return bad.length ? bad.join('; ') : null;
  });

  check('no smoothstep with reversed edges', () => {
    /*
     * `smoothstep(edge0, edge1, x)` with edge0 >= edge1 is UNDEFINED in GLSL ES.
     * It behaves as an inverse ramp on most desktop drivers, which is exactly
     * why it survives review and then misbehaves on someone's integrated GPU.
     */
    const lib = THREE.ShaderLib.physical;
    const shader = { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
    shaderMod.patchSiloShader(shader);
    /* The ground was never scanned by this at all — it only ever patched the
       silo shader — so every marking on the yard, the thing every camera angle
       sees first, was outside the one check written to protect it. */
    const groundShader = { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
    groundMod.patchGroundShader(groundShader);
    const bad = [];
    /*
     * Arguments are found by walking the parentheses, not by a character class.
     *
     * This used `/smoothstep\(([^()]*)\)/`, which EXCLUDES parentheses from the
     * capture — so any call with a nested call in it was invisible to the check.
     * The one line the comment above is actually about,
     * `smoothstep( 0.0, 0.02, abs( vFrac - vFill ) )`, contains `abs(...)` and
     * was therefore never scanned at all: its edges could be reversed and this
     * reported ok. Two of three calls in the file were being seen.
     *
     * Splitting on top-level commas only, for the same reason.
     */
    const splitArgs = (src, open) => {
      let depth = 0;
      const args = [];
      let start = open + 1;
      for (let i = open; i < src.length; i += 1) {
        const c = src[i];
        if (c === '(') depth += 1;
        else if (c === ')') {
          depth -= 1;
          if (depth === 0) {
            args.push(src.slice(start, i));
            return { args: args.map((a) => a.trim()), end: i };
          }
        } else if (c === ',' && depth === 1) {
          args.push(src.slice(start, i));
          start = i + 1;
        }
      }
      return null; /* unbalanced — the brace-balance check will catch it */
    };
    const number = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
    let scanned = 0;
    const sources = [
      ['silo vertex', shader.vertexShader],
      ['silo fragment', shader.fragmentShader],
      ['ground vertex', groundShader.vertexShader],
      ['ground fragment', groundShader.fragmentShader],
    ];
    for (const [name, src] of sources) {
      for (let i = src.indexOf('smoothstep'); i !== -1; i = src.indexOf('smoothstep', i + 1)) {
        const open = src.indexOf('(', i);
        if (open === -1) continue;
        const parsed = splitArgs(src, open);
        if (!parsed || parsed.args.length < 2) continue;
        scanned += 1;
        const [e0, e1] = parsed.args;
        const whole = src.slice(i, parsed.end + 1);
        if (number.test(e0) && number.test(e1)) {
          if (Number(e0) >= Number(e1)) bad.push(`${name}: reversed edges in ${whole}`);
        } else if (number.test(e0) && Number(e0) === 0) {
          /* `smoothstep(0.0, &lt;expression&gt;, x)` is the canonical safe direction:
             it can only be reversed if the expression is <= 0, which is a
             different bug and one the author has to reason about anyway. Every
             other non-literal pair gets a human. */
        } else if (e0 !== e1) {
          /* Anything whose edges are not two plain numbers is reported for a
             human rather than waved through — this cannot reason about an
             expression, and must not pretend to. */
          bad.push(`${name}: non-literal smoothstep edges need a human: ${whole}`);
        }
      }
    }
    /* three's own chunks contain smoothstep calls, so a zero here means the
       scanner is broken rather than the shader being clean. */
    if (scanned === 0) return 'scanned zero smoothstep calls — the scanner found nothing to check';
    return bad.length ? bad.join(', ') : null;
  });

  /* ---- the bundle ---------------------------------------------------- */

  await checkInitialChunk();

  /* ---- the Tailwind traps -------------------------------------------- */

  await checkTailwind();
  await checkLightClasses();

  /* ---- guardrails that have already been removed once ----------------- */

  await checkErrorBoundary();
  await checkShotsNameTheirZone();
  await checkMaterialCodeCoercion();
  await checkFixedPositionTrap();
  await checkTriangleBudget();

  await rm(dir, { recursive: true, force: true });

  console.log(`\n${ran} checks run, ${failed} failed`);
  if (ran === 0) {
    console.error('no checks executed — treating as a failure to run');
    process.exit(2);
  }
  process.exit(failed ? 1 : 0);
}

/**
 * Classes that generate no CSS.
 *
 * Tailwind only emits opacity modifiers that are in its scale, so a class such
 * as `bg-slate-950/92` produces nothing at all — the element renders with no
 * background and nobody finds out until they look at the running page, which is
 * exactly what happened to the status card on this view.
 *
 * Where a built stylesheet exists, that is the authority: the class is looked up
 * in the CSS the browser will actually receive. Without one, fall back to
 * checking the opacity step against Tailwind's default scale, and SAY which of
 * the two ran — a weaker check reported as a stronger one is how a green tick
 * comes to mean nothing.
 */
/**
 * three.js must never reach a user who does not open this page.
 *
 * "The initial chunk stays at 307.85 kB" has been quoted as a rule in every
 * document this project has, and nothing enforced it. It held by the grace of a
 * single `lazy(() => import('./pages/water-system/Plant3D'))` in `App.tsx`; one
 * ordinary top-level `import` of anything in `lib/plant3d` anywhere in the eager
 * tree pulls the whole of three.js forward. Measured, not imagined: one such
 * import took the initial chunk from 307.85 kB to 1,005.77 kB, and every check
 * in this file still passed.
 *
 * The size ceiling is deliberately loose and the three.js test is exact. A
 * kilobyte of drift is nobody's problem; a renderer in the front door is.
 */
async function checkInitialChunk() {
  const dir = join(ROOT, 'dist', 'public');
  let html = null;
  try {
    html = await readFile(join(dir, 'index.html'), 'utf8');
  } catch {
    /* No build to inspect. Say so as a failure rather than passing: this check
       silently skipping is how the rule went unenforced in the first place. */
    check('the initial chunk keeps three.js out of the front door', () =>
      'no build to check — run `npm run build` first');
    return;
  }

  const eager = [...html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  const bad = [];
  let scanned = 0;
  for (const src of eager) {
    let js;
    try {
      js = await readFile(join(dir, src.replace(/^\//, '')), 'utf8');
    } catch {
      bad.push(`${src}: referenced by index.html but missing from the build`);
      continue;
    }
    scanned += 1;
    /* Names that only exist inside three's renderer, so a match means the whole
       library came along rather than a stray string. */
    if (/WebGLRenderer|ShaderChunk|WebGLProgram/.test(js)) {
      bad.push(`${src}: contains three.js — the 3D route is no longer lazy`);
    }
    if (js.length > 340_000) {
      bad.push(`${src}: ${(js.length / 1024).toFixed(1)} kB, past the 340 kB ceiling`);
    }
  }
  check('the initial chunk keeps three.js out of the front door', () => {
    if (scanned === 0) return 'index.html referenced no eager module scripts — checked nothing';
    return bad.length ? bad.join(', ') : null;
  });
}

async function checkTailwind() {
  /* Every multiple of five from 0 to 100 compiles in Tailwind 3.4; nothing else
     does. The set was previously typed out by hand and was missing 15, 35, 45,
     55, 65 and 85 — a legitimately-compiling class would have been reported as a
     failure. Only used when there is no build to check against. */
  const ALLOWED = new Set(Array.from({ length: 21 }, (_, i) => i * 5));
  const files = [
    'client/src/components/water-system/plant3d/PlantHud.tsx',
    'client/src/components/water-system/plant3d/SiloList.tsx',
    'client/src/components/water-system/plant3d/Breadcrumb.tsx',
    'client/src/components/water-system/plant3d/Hint.tsx',
    'client/src/components/water-system/plant3d/StatusModeSwitch.tsx',
    'client/src/components/water-system/plant3d/KpiStrip.tsx',
    'client/src/components/water-system/plant3d/ControlBar.tsx',
    'client/src/components/water-system/plant3d/DataChip.tsx',
    'client/src/pages/water-system/Plant3D.tsx',
    'client/src/lib/plant3d/siloMesh.tsx',
  ];
  const pattern =
    /\b((?:light:)?(?:hover:)?(?:focus-visible:)?(?:focus-within:)?(?:bg|text|border|ring|from|to|via|shadow|fill|stroke|divide|outline|placeholder)-[a-z]+(?:-\d{2,3})?)\/(\d{1,3})\b/g;

  /*
   * Prefer the real stylesheet if the project has been built.
   *
   * A stale build makes this check lie in the most confusing direction: a class
   * added since the last `npm run build` is reported as "does not exist", which
   * sends someone hunting a defect that is not there. Say the build is stale
   * instead, and say it as a failure — a check silently grading against
   * yesterday's output is worse than one that admits it cannot grade.
   */
  let css = null;
  let stale = null;
  try {
    const dir = join(ROOT, 'dist', 'public', 'assets');
    const { readdir, stat } = await import('node:fs/promises');
    const names = (await readdir(dir)).filter((n) => n.endsWith('.css'));
    if (names.length) {
      const stats = await Promise.all(names.map((n) => stat(join(dir, n))));
      const built = Math.max(...stats.map((st) => st.mtimeMs));
      /* Everything that can change the emitted CSS, not just the three files
         this check reads classes out of. Editing index.css or the Tailwind
         config after a build would otherwise be graded against stale output. */
      const inputs = [...files, 'client/src/index.css', 'tailwind.config.ts'];
      const sources = await Promise.all(
        inputs.map((f) => stat(join(ROOT, f)).catch(() => ({ mtimeMs: 0 }))),
      );
      const newest = Math.max(...sources.map((st) => st.mtimeMs));
      if (newest > built) {
        stale = `the built CSS is older than the source (run \`npm run build\` first)`;
      }
      css = (await Promise.all(names.map((n) => readFile(join(dir, n), 'utf8')))).join('\n');
    }
  } catch {
    css = null;
  }

  const bad = [];
  const seen = new Set();
  for (const rel of files) {
    let source;
    try {
      source = await readFile(join(ROOT, rel), 'utf8');
    } catch {
      bad.push(`${rel}: unreadable`);
      continue;
    }
    source.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(pattern)) {
        const cls = m[0];
        if (seen.has(cls + rel + i)) continue;
        seen.add(cls + rel + i);
        if (css) {
          /* Tailwind escapes `/` and `:` in selectors. */
          const escaped = cls.replace(/[:/]/g, (c) => '\\' + c);
          /*
           * A substring match is not enough: .bg-slate-950\/9 is a prefix of
           * .bg-slate-950\/90, so an invalid /9 opacity passed whenever a valid
           * /90 existed anywhere in the stylesheet -- and on this codebase one
           * always does. Tailwind's opacity scale is the exact place this check
           * earns its keep, since only multiples of 5 generate any CSS at all,
           * so the one mistake it most needs to catch was the one it could not
           * see. The lookahead makes it a whole-token match, not a prefix.
           */
          const asRegex = escaped.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
          if (!new RegExp(asRegex + '(?![A-Za-z0-9_-])').test(css)) {
            bad.push(`${rel}:${i + 1} ${cls} -- no such class in the built CSS`);
          }
        } else if (!ALLOWED.has(Number(m[2]))) {
          bad.push(`${rel}:${i + 1} ${cls} — opacity step not in Tailwind's default scale`);
        }
      }
    });
  }

  /*
   * PLANT3D_TRACE=1 prints how many classes were actually scanned.
   *
   * Worth keeping: this check once passed while matching nothing at all,
   * because a stray character had crept into the pattern. A check that scans
   * zero classes and reports "ok" is indistinguishable from one that works.
   */
  if (process.env.PLANT3D_TRACE) {
    console.log(
      `      [trace] css=${css ? css.length + ' chars' : 'none'} classes-scanned=${seen.size} problems=${bad.length}`,
    );
  }
  if (seen.size === 0) {
    /* Whether or not there is a build to grade against, a matcher that finds
       nothing is broken. This check once reported "ok" while scanning zero. */
    bad.push('scanned zero classes — the matcher is broken, not the code');
  }
  check(
    css
      ? 'every Tailwind opacity class exists in the built CSS'
      : 'every Tailwind opacity step is in the default scale (no build to check against)',
    () => {
      if (stale) return stale;
      return bad.length ? bad.join(', ') : null;
    },
  );
}

/**
 * `light:` is not a Tailwind variant in this app.
 *
 * It is a hand-written set of about ninety rules in `index.css`, and anything
 * outside that set generates no CSS whatsoever — the class sits in the markup
 * looking correct and does nothing. That is how this view came to have a
 * transparent badge on the active zone pill, a mini-silo diagram that kept its
 * dark colours on a white card, and a placeholder styled by a rule that was
 * never written.
 *
 * Tailwind's own linting cannot catch this, because as far as Tailwind is
 * concerned `light:` is an unknown variant it simply skips.
 */
async function checkLightClasses() {
  const BACKSLASH = String.fromCharCode(92);
  const files = [
    'client/src/components/water-system/plant3d/PlantHud.tsx',
    'client/src/components/water-system/plant3d/SiloList.tsx',
    'client/src/components/water-system/plant3d/Breadcrumb.tsx',
    'client/src/components/water-system/plant3d/Hint.tsx',
    'client/src/components/water-system/plant3d/StatusModeSwitch.tsx',
    'client/src/components/water-system/plant3d/KpiStrip.tsx',
    'client/src/components/water-system/plant3d/ControlBar.tsx',
    'client/src/components/water-system/plant3d/DataChip.tsx',
    'client/src/pages/water-system/Plant3D.tsx',
    'client/src/lib/plant3d/siloMesh.tsx',
  ];

  let available;
  try {
    const css = await readFile(join(ROOT, 'client', 'src', 'index.css'), 'utf8');
    available = new Set();
    for (const m of css.matchAll(/\.light\\:[^\s,{)]+/g)) {
      /* Selectors are escaped (`.light\:bg-white`) and may carry a trailing
         pseudo-class (`.light\:hover\:text-gray-900:hover`) that is not part of
         the class name. */
      const cls = m[0].slice(1).split(BACKSLASH).join('').replace(/:(hover|focus|active|visited)$/, '');
      available.add(cls);
    }
  } catch {
    available = null;
  }

  const bad = [];
  let scanned = 0;
  if (available) {
    for (const rel of files) {
      let source;
      try {
        source = await readFile(join(ROOT, rel), 'utf8');
      } catch {
        bad.push(`${rel}: unreadable`);
        continue;
      }
      source.split('\n').forEach((line, i) => {
        /* Only look inside className strings, and never inside a comment. These
           files explain the `light:` trap in prose that quotes the very classes
           it warns about, and a check that flags its own documentation is a
           check people learn to ignore. */
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
        /* Single quotes, double quotes and backticks. Template literals are how
           conditional class strings get written, and a scanner blind to them
           would miss exactly the classes most likely to be wrong. */
        for (const q of line.matchAll(
          /'([^']*light:[^']*)'|"([^"]*light:[^"]*)"|`([^`]*light:[^`]*)`/g,
        )) {
          const text = q[1] ?? q[2] ?? q[3] ?? '';
          for (const m of text.matchAll(/light:[a-z0-9:/[\].-]*[a-z0-9\]]/g)) {
            scanned += 1;
            if (!available.has(m[0])) bad.push(`${rel}:${i + 1} ${m[0]}`);
          }
        }
      });
    }
  }

  check(
    available
      ? `every light: class exists in index.css (${available.size} defined)`
      : 'light: classes could not be checked — index.css unreadable',
    () => {
      if (!available) return 'index.css could not be read';
      /* These files are full of light: classes. Finding none means the scanner
         stopped working, not that the code got clean. */
      if (scanned === 0) return 'scanned zero light: classes — the matcher is broken';
      return bad.length ? `${bad.length} class(es) generate no CSS: ${bad.join(', ')}` : null;
    },
  );
}

/**
 * The app still has an error boundary, and it is still wired to something.
 *
 * This exists because the absence was expensive: a `materialCode` that arrived
 * as a number instead of the `string | null` it is typed as threw out of a
 * render, and with nothing above it to catch, React unmounted the whole tree.
 * The page went blank and stayed blank until someone reloaded it by hand.
 *
 * The failure this guards against is not "someone deletes the boundary on
 * purpose" — it is the quiet one, where a refactor leaves the import in place
 * and stops rendering it, or wraps something that no longer contains the
 * routes. So the check is not a grep for the word: it requires the class to
 * still contain the static method that is the entire mechanism, and it
 * requires the element to actually have the router nested inside it.
 */
async function checkErrorBoundary() {
  const read = async (p) => {
    try {
      return await readFile(join(ROOT, 'client', 'src', p), 'utf8');
    } catch {
      return null;
    }
  };
  const boundary = await read(join('components', 'ErrorBoundary.tsx'));
  const app = await read('App.tsx');

  check('the error boundary still exists and can still catch', () => {
    if (boundary === null) return 'client/src/components/ErrorBoundary.tsx is missing';
    /*
     * `getDerivedStateFromError` is what makes React route an error here at
     * all. A class without it renders a fallback that never appears.
     *
     * Matched as a DECLARATION, not as a substring. The first version of this
     * asked `boundary.includes('getDerivedStateFromError')` and was proven
     * useless the moment it was tested: renaming the method to
     * `DISABLED_getDerivedStateFromError` leaves the class unable to catch
     * anything and leaves that substring sitting right there, so the check
     * passed on a boundary that no longer worked. That is the same shape as
     * the five dead checks this file has already had to fix, written fresh
     * into a check whose entire purpose was guarding against regressions.
     */
    if (!/(^|[^\w$])static\s+getDerivedStateFromError\s*\(/.test(boundary)) {
      return 'ErrorBoundary.tsx no longer declares static getDerivedStateFromError(), so it cannot catch';
    }
    /*
     * ...and it has to RETURN something, which the declaration test alone does
     * not establish. An audit produced the mutation that beat the first
     * version: keep the method, keep the name, and `return null` from it.
     * React then derives no state, the fallback never renders, the page blanks
     * exactly as before, and a check written to prevent precisely that prints
     * ok. So the body must be seen to return an object literal.
     */
    const body = boundary.slice(boundary.search(/static\s+getDerivedStateFromError/));
    if (!/getDerivedStateFromError[^{]*\{[\s\S]{0,400}?return\s*\{/.test(body)) {
      return 'ErrorBoundary.tsx declares getDerivedStateFromError but does not return state from it';
    }
    return null;
  });

  check('the error boundary is still wrapped around the routes', () => {
    if (app === null) return 'client/src/App.tsx could not be read';
    if (!/<ErrorBoundary[\s>]/.test(app)) return 'App.tsx never renders <ErrorBoundary>';
    /* Nesting, not adjacency: an <ErrorBoundary> rendered somewhere in the
       file while <Router /> sits outside it protects nothing. */
    /*
     * Comments stripped first. The mutation that beat the first version was to
     * leave `{/* <Router /> *\/}` inside the boundary and render the real
     * router outside it: a substring search finds the router, the routes are
     * unprotected, and the check passes. A commented-out router is not a
     * router.
     */
    const live = app.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
    const open = live.indexOf('<ErrorBoundary');
    const close = live.indexOf('</ErrorBoundary>', open);
    if (open === -1) return 'App.tsx never renders <ErrorBoundary> outside a comment';
    if (close === -1) return 'App.tsx has no closing </ErrorBoundary>';
    if (!live.slice(open, close).includes('<Router')) {
      return '<Router /> is not nested inside <ErrorBoundary> — the routes are unprotected';
    }
    return null;
  });
}

/**
 * Every reference screenshot names the zone it claims to show.
 *
 * The screenshot harness has now produced misleading evidence twice. First it
 * asked for a button labelled "Dosing" when the real label is "Minerals &
 * Micro", found nothing, silently did nothing, and wrote a picture of the
 * raw-material bank to `05-zone-dosing.png`. That was fixed by making a click
 * that matches nothing throw — which could not help with the second one,
 * because the second one never clicked at all: three shots named no zone and
 * simply inherited whatever the page defaulted to, so when the default view
 * changed from the whole site to a single zone, three files called "site"
 * became pictures of the Outside Yard. All three were reviewed as evidence.
 *
 * The harness now asserts the active zone at runtime. This is the static half:
 * it stops a shot from being added back without a zone in the first place.
 */
async function checkShotsNameTheirZone() {
  let src = null;
  try {
    src = await readFile(join(ROOT, 'scripts', 'shoot-plant3d.mjs'), 'utf8');
  } catch {
    /* handled below — a missing harness must not pass as "nothing wrong" */
  }

  check('every reference screenshot names the zone it claims to show', () => {
    if (src === null) return 'scripts/shoot-plant3d.mjs could not be read';
    const start = src.indexOf('const shots = [');
    if (start === -1) return 'could not find the shots array — this check has gone stale';
    const end = src.indexOf('];', start);
    if (end === -1) return 'the shots array is unterminated — this check has gone stale';

    const entries = src
      .slice(start, end)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{ name:'));

    /*
     * The trap this project has fallen into before, guarded explicitly: a loop
     * over an array that turns out to be empty passes every assertion inside
     * it and reports success. If the parse above stops matching, that is a
     * broken check, not a clean result.
     */
    if (entries.length === 0) return 'parsed zero shots — the matcher is broken, not the harness clean';

    /*
     * Same rule for the time of day. The shot list runs once per viewport and
     * the page is NOT reloaded between passes, so a shot that names no setup
     * photographs whatever the previous pass happened to leave switched on.
     * That is how a whole-site shot came out in daylight on the pass after the
     * default had been changed to dusk.
     */
    const undated = entries.filter((l) => !/\bsetup:\s*'/.test(l));
    if (undated.length) {
      return `${undated.length} shot(s) inherit the time of day from the shot before: ${undated.join(' ')}`;
    }

    const naked = entries.filter((l) => !/\bzone:/.test(l));
    if (naked.length) {
      return `${naked.length} shot(s) inherit whatever zone the page defaults to: ${naked.join(' ')}`;
    }

    /*
     * ...and the zone it names has to be the zone its FILENAME claims.
     *
     * Having a `zone:` field at all was the whole of the first version of this
     * check, and an audit produced the mutation that beats it in one line:
     * point `04-zone-raw` at 'Finished Feed'. The field is present, the runtime
     * readback agrees with the request, every assertion passes -- and the
     * harness confidently writes a picture of the finished-feed store to a file
     * called `04-zone-raw.png`. That is the identical defect this check exists
     * to prevent, wearing its third face.
     *
     * So name and zone are tied together here. `NN-zone-<x>` must ask for a
     * zone whose label contains <x>; an `NN-site-*` shot must ask for the site.
     */
    const NAME_ZONE = {
      raw: 'Raw', dosing: 'Dosing', finished: 'Finished',
      yard: 'Yard', press: 'Buffer', site: '(Whole site|All)',
    };
    const mismatched = [];
    for (const line of entries) {
      const name = /name:\s*'([^']+)'/.exec(line)?.[1] ?? '(unnamed)';
      const key = /-zone-(\w+)/.exec(name)?.[1] ?? (/-site-/.test(name) ? 'site' : null);
      if (!key) { mismatched.push(`${name}: the filename says nothing about its zone`); continue; }
      const want = NAME_ZONE[key];
      if (!want) { mismatched.push(`${name}: no expected zone is known for "${key}"`); continue; }
      /* Searches the whole entry, so a zone's long and short labels both count. */
      const asks = line.slice(line.indexOf('zone:'));
      if (!new RegExp(want).test(asks)) {
        mismatched.push(`${name} asks for ${asks.replace(/\s+/g, ' ').trim()} -- expected ${want}`);
      }
    }
    return mismatched.length
      ? `filename and zone disagree:\n${mismatched.join('\n')}`
      : null;
  });
}

/**
 * No `.trim()` reaches a material code that was not coerced to a string first.
 *
 * `materialCode` is typed `string | null` and the API does not keep that
 * promise: it sends numbers. `105.trim` is not a function, the throw comes out
 * of a render, and before there was an error boundary that blanked the entire
 * page until someone reloaded it by hand.
 *
 * There was already a check named for this bug. It passed while two live
 * instances sat in the tree, because it only ever called into `siloData.ts` —
 * the module where the bug had been FIXED — and never read the two files where
 * it had been rewritten from scratch: one in the visuals memo that feeds the
 * whole scene, firing the moment anyone clicks a material in the legend, and
 * one in the detail panel, firing the moment anyone selects a bin. A check
 * that only inspects the place you already fixed will report clean for ever.
 *
 * So this one reads source text across every file that touches the field, and
 * it is deliberately about the SHAPE of the guard rather than the behaviour of
 * one module. `?? ''` and `?.` both look like they handle this and neither
 * does: they replace null and undefined, not the wrong type.
 */
async function checkMaterialCodeCoercion() {
  const files = [
    join('pages', 'water-system', 'Plant3D.tsx'),
    join('components', 'water-system', 'plant3d', 'PlantHud.tsx'),
    join('components', 'water-system', 'plant3d', 'SiloList.tsx'),
    join('components', 'water-system', 'plant3d', 'Breadcrumb.tsx'),
    join('components', 'water-system', 'plant3d', 'Hint.tsx'),
    join('components', 'water-system', 'plant3d', 'StatusModeSwitch.tsx'),
    join('components', 'water-system', 'plant3d', 'KpiStrip.tsx'),
    join('components', 'water-system', 'plant3d', 'ControlBar.tsx'),
    join('components', 'water-system', 'plant3d', 'DataChip.tsx'),
    join('lib', 'plant3d', 'siloData.ts'),
    join('lib', 'plant3d', 'siloMesh.tsx'),
    join('lib', 'plant3d', 'materials.ts'),
  ];

  const bad = [];
  let scanned = 0;
  let read = 0;

  for (const rel of files) {
    let src;
    try {
      src = await readFile(join(ROOT, 'client', 'src', rel), 'utf8');
    } catch {
      bad.push(`${rel}: could not be read`);
      continue;
    }
    read += 1;
    src.split('\n').forEach((line, i) => {
      /* Comments describe this bug at length in several of these files; a
         mention inside one is not a call site. */
      const code = line.replace(/\/\*.*?\*\//g, '').replace(/^\s*(\/\/|\*).*$/, '');
      if (!/materialCode/.test(code) || !/\.trim\s*\(/.test(code)) return;
      scanned += 1;
      /*
       * The coercion has to WRAP the code, not merely share a line with it.
       * Asking whether `String(` appears anywhere on the line was the first
       * version, and the mutation that beats it is
       * `String(unrelated); const code = r!.materialCode!.trim()` -- both
       * tokens present, the crash entirely intact.
       */
      if (!/String\s*\([^()]*materialCode[^()]*\)[^;]*?\.trim\s*\(/.test(code)) {
        bad.push(`${rel}:${i + 1}  ${line.trim()}`);
      }
    });
  }

  check('every material code is coerced to a string before .trim()', () => {
    if (read === 0) return 'none of the files could be read — this check did not run';
    /*
     * The empty-loop trap, guarded explicitly. If a refactor renames the field
     * or moves these call sites, this scanner finds nothing and would report
     * success on a codebase it never examined. Finding zero call sites means
     * the matcher broke, not that the code got safe.
     */
    if (scanned === 0) {
      return 'found zero materialCode .trim() call sites — the matcher is broken, not the code clean';
    }
    return bad.length
      ? `${bad.length} unguarded call site(s):\n${bad.join('\n')}`
      : null;
  });
}

/**
 * Full screen must not be trapped by the page wrapper.
 *
 * Every page's content sits inside `.page-transition.page-transition-enter-active`
 * (WaterSystemLayout). A `transform`, `filter`, `perspective` or `contain`
 * on that wrapper makes it the containing block for every `position: fixed`
 * descendant — so the Plant 3D stage's `fixed inset-0` full-screen mode
 * resolved against the wrapper, not the viewport, and the canvas stayed at
 * 965x326. Found on the client's laptop by reading the canvas rect with the
 * fixed class applied; nothing here had ever measured it.
 *
 * Static because the rule is static: both classes are applied unconditionally
 * in the JSX, so whatever the stylesheet says for them is the permanent state.
 * The scanner reads the real stylesheet, so a rule that reappears in either
 * class fails the build; scanning zero rules is a broken matcher, not a pass.
 */
async function checkFixedPositionTrap() {
  const rel = 'client/src/index.css';
  let css;
  try {
    css = await readFile(join(ROOT, rel), 'utf8');
  } catch {
    check('the page wrapper cannot trap position: fixed', () => `${rel} could not be read`);
    return;
  }
  const TRAP = /^\s*(transform|filter|backdrop-filter|perspective|contain|will-change)\s*:\s*([^;]+);/gm;
  const blocks = [];
  const re = /\.page-transition(?:-enter-active|-enter)?\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    /* Strip comments before reading declarations — the fix is documented in a
       comment that names the exact value it replaced. */
    blocks.push({ selector: m[0].slice(0, m[0].indexOf('{')).trim(), body: m[1].replace(/\/\*[\s\S]*?\*\//g, '') });
  }
  check('the page wrapper cannot trap position: fixed', () => {
    if (blocks.length === 0) return 'found no .page-transition rules — the matcher is broken, not the CSS clean';
    const bad = [];
    for (const b of blocks) {
      /* `.page-transition-enter` is the pre-mount state; it is never applied on
         its own in this app, but a translate there is harmless only while that
         stays true, and the wrapper renders with `-enter-active` from the
         first paint. The active and base classes are what is on screen. */
      if (b.selector === '.page-transition-enter') continue;
      let d;
      while ((d = TRAP.exec(b.body)) !== null) {
        const value = d[2].trim();
        if (d[1] === 'will-change' ? /transform|filter|perspective/.test(value) : value !== 'none') {
          bad.push(`${b.selector} { ${d[1]}: ${value} }`);
        }
      }
      TRAP.lastIndex = 0;
    }
    return bad.length
      ? `these make the page wrapper a containing block for position: fixed — full screen will not fill the screen:\n${bad.join('\n')}`
      : null;
  });
}

/**
 * Triangle and draw-call budget — Phase 2B (silo archetypes).
 *
 * Bundles `silos.ts`, `siloGeometry.ts` and `siloStructures.tsx` as its OWN
 * isolated esbuild entry, deliberately separate from the shared bundle
 * `main()` builds at the top of this file: that shared bundle also includes
 * `ground.tsx` and `look.ts`, owned by other workstreams, and a break in
 * either of those aborts `main()` before a single `check()` call runs. This
 * check has nothing to do with the ground or the sky, so it does not
 * inherit their failure — it builds only the geometry files it actually
 * measures, and reports its own COULD-NOT-RUN if THAT build fails.
 *
 * It calls the real `buildBaseGeometry`/`buildDetailGeometry`/`triCount`
 * functions `siloMesh.tsx` calls at runtime — actual triangle counts off the
 * actual merged geometry, not an estimate — and the actual
 * `buildConveyors` the finished-feed zone's shared structure uses.
 */
async function checkTriangleBudget() {
  const dir = await mkdtemp(join(tmpdir(), 'plant3d-tris-'));
  let silos;
  let geom;
  let structures;
  try {
    await build({
      entryPoints: ['silos.ts', 'siloGeometry.ts', 'siloStructures.tsx'].map((e) => join(SRC, e)),
      outdir: dir,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'error',
      external: [],
    });
    silos = await import(pathToFileURL(join(dir, 'silos.js')).href);
    geom = await import(pathToFileURL(join(dir, 'siloGeometry.js')).href);
    structures = await import(pathToFileURL(join(dir, 'siloStructures.js')).href);
  } catch (err) {
    check(
      'triangle and draw-call budget',
      () => `could not build siloGeometry.ts/siloStructures.tsx: ${err && err.stack ? err.stack : err}`,
    );
    await rm(dir, { recursive: true, force: true });
    return;
  }

  check('triangle and draw-call budget', () => {
    const { SILO_GROUPS, SILOS, deriveDims } = silos;
    if (!SILO_GROUPS.length || !SILOS.length) {
      return 'no groups/placements to measure — the matcher is broken, not the geometry clean';
    }

    let baseTotal = 0;
    let drawCalls = 0;
    const rows = [];
    const byZone = new Map();

    for (const g of SILO_GROUPS) {
      const count = SILOS.filter((s) => s.group.id === g.id).length;
      const d = deriveDims(g.capacityKg, g.diameter, g.hopperRatio, g.elevation);
      const base = geom.buildBaseGeometry(g, d);
      const baseTris = geom.triCount(base);
      base.dispose();
      const detail = geom.buildDetailGeometry(g, d);
      const detailTris = detail ? geom.triCount(detail) : 0;
      if (detail) detail.dispose();

      baseTotal += baseTris * count;
      /* contents + surface + shell + pick per group, +1 draw if it carries a
         detail LOD mesh, +1 if it carries shared structure (conveyors). */
      drawCalls += 4 + (detailTris > 0 ? 1 : 0) + (g.structure?.conveyors ? 1 : 0);

      rows.push({ id: g.id, archetype: g.archetype, count, baseTris, detailTris, zone: g.zone });
      const list = byZone.get(g.zone) ?? [];
      list.push(g);
      byZone.set(g.zone, list);
    }
    /* the alarm-beacon InstancedMesh and the number-label projector add one
       more draw each, whole-scene rather than per-group. */
    drawCalls += SILO_GROUPS.length; /* one SiloBeacons instancedMesh per group */

    console.log('      per-group triangle table:');
    for (const r of rows) {
      console.log(
        `        ${r.id.padEnd(7)} ${r.archetype.padEnd(11)} x${String(r.count).padStart(3)}` +
          `  base=${String(r.baseTris).padStart(6)} tris/bin (${(r.baseTris * r.count).toLocaleString().padStart(9)} total)` +
          `  detail=${String(r.detailTris).padStart(5)} tris/bin`,
      );
    }

    /* Largest zone by monitored bin count — base + detail + shared structure,
       for that zone alone, per the plan's "48-bin finished zone" budget. */
    let largestZone = null;
    let largestCount = 0;
    for (const [zone, groups] of byZone) {
      const n = groups.reduce((a, g) => a + SILOS.filter((s) => s.group.id === g.id).length, 0);
      if (n > largestCount) {
        largestCount = n;
        largestZone = zone;
      }
    }
    let zoneTotal = 0;
    for (const g of byZone.get(largestZone) ?? []) {
      const row = rows.find((r) => r.id === g.id);
      zoneTotal += (row.baseTris + row.detailTris) * row.count;
      if (g.structure?.conveyors) {
        const placements = SILOS.filter((s) => s.group.id === g.id);
        const conv = structures.buildConveyors(placements);
        if (conv) {
          zoneTotal += geom.triCount(conv);
          conv.dispose();
        }
      }
    }
    console.log(
      `      largest zone: ${largestZone} (${largestCount} bins), base+detail+structure = ${zoneTotal.toLocaleString()} tris`,
    );
    console.log(`      whole-site base total: ${baseTotal.toLocaleString()} tris, ~${drawCalls} draw calls`);

    const bad = [];
    if (baseTotal > 350_000) bad.push(`base total ${baseTotal.toLocaleString()} tris > 350,000`);
    if (zoneTotal > 420_000) {
      bad.push(`${largestZone} zone base+detail+structure ${zoneTotal.toLocaleString()} tris > 420,000`);
    }
    if (drawCalls > 120) bad.push(`~${drawCalls} draw calls > 120`);
    return bad.length ? bad.join(', ') : null;
  });

  await rm(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('COULD NOT RUN');
  console.error(err && err.stack ? err.stack : err);
  process.exit(2);
});
