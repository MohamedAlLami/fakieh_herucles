/**
 * Silo geometry — archetypes built from `siloParts.ts` primitives, plus the
 * revolved profile that the capacity/volume maths still reasons about.
 *
 * Split out of `siloMesh.tsx` so that file exports nothing but its component.
 * A module that exports both a React component and plain values cannot be hot
 * reloaded: Vite refuses the Fast Refresh boundary and falls back to a full page
 * reload, which in this view means losing the camera, the selection and the
 * whole WebGL context on every keystroke.
 *
 * TWO GEOMETRIES PER BIN, TWO DIFFERENT JOBS
 * -------------------------------------------
 * `siloProfile`/`fillRange`/`storageVolume` (in `silos.ts`) are the PHYSICS: a
 * simple revolved profile whose volume the capacity checks integrate exactly.
 * They are unchanged by this file's archetype work on purpose — the checks
 * that prove a bin holds the tonnage written on it read `siloProfile` and
 * `fillRange` directly, and changing their shape would mean re-deriving the
 * hopper/roof maths against a lathe that no longer exists.
 *
 * `buildBaseGeometry`/`buildDetailGeometry` are the PICTURE: a merged,
 * multi-part `BufferGeometry` per group (`aPart`-tagged, see `siloParts.ts`)
 * that dresses the same footprint in an archetype's structure — legs, rings,
 * hatches, rails. It follows the profile's silhouette closely enough that the
 * capacity checks and the archetype checks are describing the same object,
 * but it is built from primitives, not a lathe, because a lathe cannot carry
 * per-vertex part tags cleanly and cannot merge with boxes and torii.
 */
import * as THREE from 'three';
import {
  HOPPER_OUTLET_RATIO,
  SILO_GROUPS,
  deriveDims,
  type SiloDims,
  type SiloGroupSpec,
} from './silos';
import {
  PART,
  boxPart,
  beamPart,
  cylinderPart,
  domeCapPart,
  horizontalCylinderPart,
  mergeParts,
  ringPart,
  triCount,
} from './siloParts';

/**
 * Radial segments, from bin diameter.
 *
 * The new roof rings, rails and legs make a low facet count obvious in a way
 * a bare lathe never was, so the plant-wide tiers are coarser at the low end
 * than before (10-28) and step at fixed diameters rather than a linear ramp:
 * 32 from 8 m up (the 100/200 series), 24 from 2 m (300/600/800), 16
 * below (400/900 — thirty of the plant's bins are under 2 m across, and even
 * at 16 sides they read as round once the structure is added around them).
 */
export function segmentsFor(diameter: number): number {
  if (diameter >= 8) return 32;
  if (diameter >= 2) return 24;
  return 16;
}

/**
 * How much wider than the barrel the roof eave stands, as a multiple of `r`.
 *
 * A bare cone springing straight out of the wall is the one silhouette
 * feature every bin on this site was missing, hopper-bottomed or flat: real
 * bolted-steel roofs oversail the top ring by a small lip before the cone
 * rises, and that lip is what reads as a roof meeting a wall rather than a
 * cylinder growing a point.
 *
 * Held to 2% — smaller than it would be on a free-standing bin — because it
 * has to clear TWO different tight spots at once, both measured against the
 * true drawn radius via `profileMaxRadius`:
 *
 *   - the 300-series raw-material battery sits 0.57 m clear of the mill wall
 *     at true size, the tightest indoor building clearance on the plant (see
 *     `SIZE_COMPRESSION`'s own note that 0.85 was chosen to clear every
 *     building "with margin to spare" — this eats directly into that
 *     margin). 2% leaves 0.53 m, comfortably over the 0.5 m floor the
 *     building-clearance check enforces; 3% drops it to 0.50 m — genuinely on
 *     the line, not spare room; 4% fails the check outright at 0.48 m.
 *   - the 800-series finished-feed bank packs three rows on a 2.55 m pitch
 *     over a 2.4 m shell, the tightest bin-to-bin spacing on the plant. 2%
 *     leaves it about 13 cm clear — the 300-series building wall binds first.
 *
 * Both proofs are recorded against `verify-plant3d.mjs`'s checks below.
 */
const EAVE_RATIO = 1.02;

/**
 * How much wider than the barrel the flat-bottomed foundation skirt stands.
 *
 * Only `hopperRatio: 0` groups use this — the 100/200 series, the two
 * largest-diameter groups on the plant and the only ones with real headroom
 * in their packing (their own pitch clears a 10% skirt with room to spare;
 * see the proof). A hopper-bottomed bin already gets a visible base from its
 * discharge cone and foot; a flat-bottomed one had nothing before this but a
 * shell running straight into the ground.
 */
const SKIRT_RATIO = 1.07;

/**
 * The silo profile, in real metres, revolved about Y — the PHYSICS shape.
 *
 * Duplicated points a hair apart give LatheGeometry a hard crease where the
 * hopper meets the barrel and where the barrel meets the roof; without them the
 * shared normals smooth the joint and a cylinder reads as a lumpy cone.
 *
 * Unchanged by the archetype work — see the file header. Every capacity check
 * in `verify-plant3d.mjs` integrates this profile directly, so its shape has
 * to keep being the one the volume maths was derived against.
 */
export function siloProfile(d: SiloDims): THREE.Vector2[] {
  const r = d.diameter / 2;
  const eps = Math.max(0.004, d.diameter * 0.003);
  const hasHopper = d.hopper > 0;
  const yStore = d.elevation;
  const yBarrel = yStore + d.hopper;
  const yTop = yBarrel + d.barrel;
  const p: THREE.Vector2[] = [new THREE.Vector2(0.001, 0)];

  if (hasHopper) {
    const outlet = r * HOPPER_OUTLET_RATIO;
    const foot = Math.max(outlet * 1.6, r * 0.3);
    const footH = Math.min(0.35, yStore * 0.25);
    const collar = Math.min(yStore - eps, footH + Math.max(0.2, yStore * 0.3));
    p.push(new THREE.Vector2(foot, 0));
    p.push(new THREE.Vector2(foot, footH));
    p.push(new THREE.Vector2(outlet, collar));
    p.push(new THREE.Vector2(outlet, yStore));
    p.push(new THREE.Vector2(r, yBarrel));
  } else {
    const skirt = r * SKIRT_RATIO;
    const skirtH = Math.min(0.9, yStore * 0.3);
    p.push(new THREE.Vector2(skirt, 0));
    p.push(new THREE.Vector2(skirt, skirtH));
    p.push(new THREE.Vector2(r, skirtH + eps));
    p.push(new THREE.Vector2(r, yStore));
  }

  p.push(new THREE.Vector2(r, yBarrel + eps));
  p.push(new THREE.Vector2(r, yTop));
  p.push(new THREE.Vector2(r, yTop + eps));
  const eaveR = r * EAVE_RATIO;
  const eaveRise = Math.max(eps * 3, (eaveR - r) * 0.6);
  p.push(new THREE.Vector2(eaveR, yTop + eps + eaveRise));
  p.push(new THREE.Vector2(0.001, yTop + d.roof));
  return p;
}

/** Local Y range over which the contents are shaded. Unchanged — see the file header. */
export function fillRange(d: SiloDims): [number, number] {
  return [d.elevation, d.elevation + d.hopper + d.barrel];
}

/* ------------------------------------------------------------------ */
/* Archetype geometry — the PICTURE                                    */
/* ------------------------------------------------------------------ */

interface Layout {
  r: number;
  outlet: number;
  hasHopper: boolean;
  yStore: number;
  yBarrelBase: number;
  yTop: number;
  yApex: number;
  skirtH: number;
  skirtR: number;
  segs: number;
}

function layoutOf(g: SiloGroupSpec, d: SiloDims): Layout {
  const r = d.diameter / 2;
  const hasHopper = d.hopper > 0;
  const yStore = d.elevation;
  const yBarrelBase = yStore + d.hopper;
  const yTop = yBarrelBase + d.barrel;
  const yApex = yTop + d.roof;
  const skirtH = hasHopper ? 0 : Math.min(0.9, yStore * 0.3);
  const skirtR = r * SKIRT_RATIO;
  return {
    r,
    outlet: r * HOPPER_OUTLET_RATIO,
    hasHopper,
    yStore,
    yBarrelBase,
    yTop,
    yApex,
    skirtH,
    skirtR,
    segs: segmentsFor(d.diameter),
  };
}

/** Even angles around a circle, in radians, starting at 45 degrees so a
    4-legged bin's legs land at the classic 45/135/225/315 positions. */
function legAngles(count: number, startDeg = 45): number[] {
  return Array.from({ length: count }, (_, i) => ((startDeg + (360 / count) * i) * Math.PI) / 180);
}

/** Legs + an optional square/polygon cross-brace ring, from the floor to
    `topY` (just under the hopper/barrel seam), at radius `legR`. */
function legsAndBrace(
  legR: number,
  topY: number,
  count: number,
  cross: number,
  brace: boolean,
): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const angles = legAngles(count);
  const pts = angles.map((a) => [Math.cos(a) * legR, Math.sin(a) * legR] as const);
  for (const [x, z] of pts) {
    out.push(boxPart(cross, topY, cross, x, topY / 2, z, 0, PART.STRUCTURE));
  }
  if (brace) {
    const braceY = topY * 0.5;
    for (let i = 0; i < pts.length; i += 1) {
      const [x0, z0] = pts[i];
      const [x1, z1] = pts[(i + 1) % pts.length];
      const mx = (x0 + x1) / 2;
      const mz = (z0 + z1) / 2;
      const len = Math.hypot(x1 - x0, z1 - z0);
      const rot = Math.atan2(z1 - z0, x1 - x0);
      out.push(beamPart(len, cross * 0.8, cross * 0.8, mx, braceY, mz, -rot, PART.STRUCTURE));
    }
  }
  return out;
}

/** The 12-post + top-rail railing ring that sits on the roof base of every
    bulk silo and tank, at `r * 1.03`. */
function railRing(r: number, y: number): THREE.BufferGeometry[] {
  const radius = r * 1.03;
  const postH = 1.1;
  const out: THREE.BufferGeometry[] = [];
  for (const a of legAngles(12, 0)) {
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius;
    out.push(boxPart(0.06, postH, 0.06, x, y + postH / 2, z, a, PART.RING));
  }
  out.push(ringPart(radius, 0.03, 24, 4, y + postH, PART.RING));
  return out;
}

/** Wall + roof + (optionally) hopper, shared by every archetype — the part
    of the merged geometry that follows `siloProfile`'s silhouette. */
function shellParts(d: SiloDims, L: Layout, roofRadiusRatio = 1): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const wallBase = L.hasHopper ? L.yBarrelBase : L.skirtH;
  out.push(cylinderPart(L.r, L.r, L.yTop - wallBase, L.segs, (wallBase + L.yTop) / 2, PART.WALL, true));
  if (L.hasHopper) {
    out.push(
      cylinderPart(L.r, L.outlet, d.hopper, L.segs, (L.yStore + L.yBarrelBase) / 2, PART.HOPPER, true),
    );
    /* the 0.5 m outlet spool the hopper discharges through */
    const spoolH = 0.3;
    out.push(cylinderPart(L.outlet, L.outlet, spoolH, Math.max(8, L.segs / 2), L.yStore - spoolH / 2, PART.HOPPER));
  } else {
    out.push(cylinderPart(L.skirtR, L.skirtR, L.skirtH, L.segs, L.skirtH / 2, PART.STRUCTURE));
  }
  out.push(
    cylinderPart(0.001, L.r * roofRadiusRatio, d.roof, L.segs, (L.yTop + L.yApex) / 2, PART.ROOF, true),
  );
  return out;
}

function hatch(r: number, y: number, diameter = 1.2, height = 0.5): THREE.BufferGeometry[] {
  const hr = diameter / 2;
  return [
    cylinderPart(hr, hr, height, 12, y + height / 2, PART.ACCENT),
    ringPart(hr, 0.02, 16, 4, y, PART.ACCENT),
  ];
}

function ladderDetail(L: Layout, side = -1): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const x = side * (L.r + 0.08);
  const zOff = 0.2;
  const railBottom = L.skirtH > 0 ? L.skirtH : 0.1;
  const railHeight = L.yTop - railBottom;
  const railY = railBottom + railHeight / 2;
  out.push(boxPart(0.05, railHeight, 0.05, x, railY, -zOff, 0, PART.STRUCTURE));
  out.push(boxPart(0.05, railHeight, 0.05, x, railY, zOff, 0, PART.STRUCTURE));
  const rungCount = Math.max(1, Math.floor(railHeight / 0.3));
  for (let i = 0; i <= rungCount; i += 1) {
    const y = railBottom + i * 0.3;
    if (y > L.yTop) break;
    out.push(boxPart(0.05, 0.04, zOff * 2 + 0.05, x, y, 0, 0, PART.STRUCTURE));
  }
  /* safety cage hoops every 1.5 m above 2.5 m, half-rings open toward the wall */
  for (let y = 2.5; y <= L.yTop; y += 1.5) {
    out.push(ringPart(0.35, 0.02, 12, 4, y, PART.STRUCTURE, Math.PI, side > 0 ? 0 : Math.PI));
  }
  return out;
}

/**
 * The base, always-visible geometry for one group: wall/roof/hopper plus
 * whatever structure the archetype calls for. One merged `BufferGeometry`
 * per group, `aPart`-tagged throughout — see the file header.
 */
export function buildBaseGeometry(g: SiloGroupSpec, d: SiloDims): THREE.BufferGeometry {
  const L = layoutOf(g, d);
  const st = g.structure ?? {};
  const parts: THREE.BufferGeometry[] = [];

  switch (g.archetype) {
    case 'bulk': {
      parts.push(...shellParts(d, L));
      parts.push(...hatch(L.r, L.yApex - 0.1));
      parts.push(...railRing(L.r, L.yTop));
      break;
    }
    case 'tank': {
      /* flat roof: a thin disc, then a shallow dome (rise 0.15r) on top */
      parts.push(cylinderPart(L.r, L.r, L.yTop - L.skirtH, L.segs, (L.skirtH + L.yTop) / 2, PART.WALL, true));
      parts.push(cylinderPart(L.r, L.r, 0.08, L.segs, L.yTop + 0.04, PART.ROOF, true));
      parts.push(cylinderPart(L.skirtR, L.skirtR, L.skirtH, L.segs, L.skirtH / 2, PART.STRUCTURE));
      parts.push(domeCapPart(L.r, L.r * 0.15, L.segs, L.yTop + 0.08, PART.ROOF));
      parts.push(...railRing(L.r, L.yTop));
      if (st.stair) {
        /* six stacked short boxes suggesting a spiral stair up the side */
        const stepCount = 6;
        const stepH = 0.4;
        const stepY0 = L.skirtH + 0.3;
        for (let i = 0; i < stepCount; i += 1) {
          const a = ((i * 55) * Math.PI) / 180;
          const y = stepY0 + i * ((L.yTop - stepY0 - stepH) / (stepCount - 1));
          parts.push(boxPart(0.7, stepH, 0.28, Math.cos(a) * L.r * 1.02, y, Math.sin(a) * L.r * 1.02, a, PART.STRUCTURE));
        }
      }
      break;
    }
    case 'hopperBin': {
      /* the 800 series packs 2.55 m pitch over a 2.4 m shell; a 1.03 rail
         ring or a full 1.025 stiffener would collide with the next bin, so
         those groups thin their rings to 1.012 — see the collision proof in
         verify-plant3d.mjs and the note on EAVE_RATIO above. */
      const ringRatio = st.ringRadiusRatio ?? 1.025;
      parts.push(...shellParts(d, L));
      parts.push(...hatch(L.r, L.yApex - 0.08, Math.min(0.6, L.r * 0.5), 0.3));
      const legCount = st.legs ?? 4;
      const legR = L.outlet + (L.r - L.outlet) * 0.55;
      const cross = Math.max(0.08, Math.min(0.14, L.r * 0.06));
      parts.push(...legsAndBrace(legR, L.yBarrelBase, legCount, cross, true));
      const ringCount = st.rings ?? 0;
      if (ringCount > 0) {
        const span = L.yTop - L.yBarrelBase;
        for (let i = 1; i <= ringCount; i += 1) {
          const y = L.yBarrelBase + (span * i) / (ringCount + 1);
          parts.push(ringPart(L.r * ringRatio, 0.02, 24, 4, y, PART.RING));
        }
      }
      break;
    }
    case 'mineralBin': {
      parts.push(...shellParts(d, L));
      const legCount = st.legs ?? 4;
      const legR = L.outlet + (L.r - L.outlet) * 0.55;
      const cross = Math.max(0.06, Math.min(0.1, L.r * 0.08));
      parts.push(...legsAndBrace(legR, L.yBarrelBase, legCount, cross, false));
      break;
    }
    case 'microHopper': {
      parts.push(...shellParts(d, L));
      const legCount = st.legs ?? 3;
      const legR = L.outlet + (L.r - L.outlet) * 0.6;
      const cross = Math.max(0.05, L.r * 0.1);
      parts.push(...legsAndBrace(legR, L.yBarrelBase, legCount, cross, false));
      if (st.screwFeeder) {
        /*
         * The plan specifies a 0.25 m diameter x 0.6 m stub at TRUE (real
         * metre) scale — sized for a free-standing micro hopper, not for one
         * packed ten-to-a-ring on a 1 m TRUE pitch (s900a), let alone three
         * separate 900-series groups only 10.5 m apart centre-to-centre
         * before size compression widens everything.
         *
         * Capped two ways, and the tighter one wins:
         *  - against this group's OWN pitch (a stub reaching past half the
         *    row spacing collides with its own row-mate), same reasoning as
         *    the 800-series ring thinning below;
         *  - against the barrel radius itself, because the overlap check in
         *    verify-plant3d.mjs treats `profileMaxRadius` as a CIRCLE — a
         *    directional feature pointing only -Z still inflates the assumed
         *    exclusion radius in every direction, including toward a
         *    neighbouring group offset in X, not Z. Measured: at the pitch
         *    cap alone (reach ~0.45 m on s900a) the check found bins 904 and
         *    911 — s900a and s900b, offset almost entirely in X — 0.72 m
         *    apart when they should have been clear, purely because the
         *    circular approximation charged the whole stub length against
         *    every direction. Tying the reach to the barrel radius instead
         *    keeps the stub roughly circularly consistent with the legs
         *    already sitting at a similar radius, and the real overlap check
         *    (not just this file's own arithmetic) is what confirmed it.
         */
        const margin = 0.05;
        const pitchCap = Math.max(L.outlet + 0.1, g.pitchZ / 2 - margin);
        const barrelCap = L.r * 1.15;
        const maxReach = Math.min(pitchCap, barrelCap);
        const stubLen = Math.max(0.08, Math.min(0.6, maxReach - L.outlet));
        const stubR = Math.min(0.125, L.r * 0.4);
        parts.push(
          horizontalCylinderPart(stubR, stubLen, 10, 0, L.yStore - 0.15, -(L.outlet + stubLen / 2), PART.STRUCTURE, 'z'),
        );
      }
      break;
    }
    default:
      parts.push(...shellParts(d, L));
  }

  return mergeParts(parts);
}

/**
 * The detail LOD geometry for one group — ladder-with-cage on the bulk/tank/
 * hopperBin archetypes, plus a catwalk grating strip per bin for the 800
 * series. Hidden beyond `LOD_DETAIL_DISTANCE`; `null` for archetypes with no
 * detail parts (mineral bins, micro hoppers).
 */
export function buildDetailGeometry(g: SiloGroupSpec, d: SiloDims): THREE.BufferGeometry | null {
  if (g.archetype !== 'bulk' && g.archetype !== 'tank' && g.archetype !== 'hopperBin') return null;
  const L = layoutOf(g, d);
  const side = g.structure?.ladderSide ?? -1;
  const parts = ladderDetail(L, side);
  if (g.series === 800) {
    parts.push(boxPart(0.6, 0.05, 1.0, 0, L.yTop + 0.05, 0, 0, PART.STRUCTURE));
  }
  if (!parts.length) return null;
  return mergeParts(parts);
}

/* ------------------------------------------------------------------ */
/* profileMaxRadius                                                    */
/* ------------------------------------------------------------------ */

const radiusCache = new Map<string, number>();

/**
 * Find the group a `SiloDims` belongs to, without relying on object identity.
 *
 * `verify-plant3d.mjs` bundles `silos.ts` and `siloGeometry.ts` as SEPARATE
 * esbuild entry points, so `silos.js`'s `SILOS` array and the `SILO_GROUPS`
 * this module imports are two different bundles' copies of the same source —
 * `===` on their `dims` objects will never be true. `deriveDims` is a pure
 * function of `(capacityKg, diameter, hopperRatio, elevation)`, so re-running
 * it here against every group and comparing the derived FIELDS (not object
 * identity) finds the same group deterministically: identical floating-point
 * inputs through identical arithmetic produce bit-identical floats, in any
 * module instance.
 */
function specForDims(d: SiloDims): SiloGroupSpec | null {
  for (const g of SILO_GROUPS) {
    const gd = deriveDims(g.capacityKg, g.diameter, g.hopperRatio, g.elevation);
    if (
      gd.diameter === d.diameter &&
      gd.barrel === d.barrel &&
      gd.hopper === d.hopper &&
      gd.roof === d.roof &&
      gd.elevation === d.elevation
    ) {
      return g;
    }
  }
  return null;
}

/**
 * The true drawn radius of a bin's silhouette, in real metres — the widest a
 * bin's MERGED BASE geometry actually reaches (rings, rails and legs
 * included; the ladder is excluded, since it is LOD and only ever visible up
 * close, never at the range these checks care about), not `diameter / 2` and
 * no longer just the lathe profile either.
 *
 * `spec` is optional so the existing overlap/building-fit checks in
 * `verify-plant3d.mjs` — which this file does not own and call
 * `profileMaxRadius(dims)` with one argument — keep working unmodified: when
 * it is omitted this resolves the owning group itself via `specForDims`. Pass
 * it explicitly (as `siloMesh.tsx` does) to skip that search.
 *
 * Cached per group id: building the merged geometry is not free, and this is
 * called from an O(n^2) overlap sweep over 131 bins.
 */
export function profileMaxRadius(d: SiloDims, spec?: SiloGroupSpec): number {
  const g = spec ?? specForDims(d);
  if (!g) {
    /* No archetype known for this exact dims (should not happen against the
       real plant model) — fall back to the physics profile's own widest
       point, still correct, just blind to structure this file cannot find. */
    let max = 0;
    for (const pt of siloProfile(d)) if (pt.x > max) max = pt.x;
    return max;
  }
  const cached = radiusCache.get(g.id);
  if (cached !== undefined) return cached;
  const geo = buildBaseGeometry(g, d);
  geo.computeBoundingBox();
  const box = geo.boundingBox!;
  const r = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z));
  geo.dispose();
  radiusCache.set(g.id, r);
  return r;
}

export { PART } from './siloParts';
export { triCount } from './siloParts';
