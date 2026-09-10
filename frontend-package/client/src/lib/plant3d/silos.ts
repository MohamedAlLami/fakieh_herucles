/**
 * Fakieh Feed Factory — silo master model.
 *
 * The single place where the plant's 131 monitored bins are described. Positions,
 * capacities, groupings and derived dimensions all live here; the 3D scene reads
 * this and draws it. Correcting the plant layout means editing this file, never
 * the rendering code.
 *
 * WHAT IS MEASURED AND WHAT IS NOT
 * --------------------------------
 * MEASURED (plant visit, cross-checked against the `silo_status` table — every
 *   count matches exactly): silo numbers, counts per series, capacity per series,
 *   which series sit inside and which outside, and the arrangement of each group.
 * DERIVED: every height and diameter. No measured dimensions exist for this site
 *   and Street View has no coverage. Volume comes from capacity / bulk density; a
 *   plausible diameter is assumed and the height follows from it. These are
 *   labelled DERIVED in the UI and must not be presented as surveyed fact.
 * ASSUMED: where each group sits on the site, and the order silo numbers run in
 *   within a group.
 *
 * Coordinates are plant-local metres, matching `site.ts`:
 *   +X follows the material (raw at -X, finished feed at +X)
 *   +Z runs across the plant toward the truck yard
 *   +Y is up
 */
import type { ZoneId } from './site';

/**
 * Bulk density used for every capacity -> volume conversion, t/m3.
 * Typical for maize and compounded feed meal. One constant applied uniformly, so
 * the relative sizes across series are at least internally consistent.
 */
export const BULK_DENSITY_T_PER_M3 = 0.75;

/**
 * Vertical exaggeration.
 *
 * The plant is 280 m long and its tallest silo is 30 m, so at a framing that
 * fits the site the bins are a tenth of the frame and read as studs. Stretching
 * everything vertically — silos, buildings, platforms, the wall — is the
 * standard fix for exactly this shape of site, and it costs nothing that matters
 * here: every height is exaggerated by the same factor, so relative heights stay
 * true, and a level is a FRACTION of its own bin, so every percentage on screen
 * is unaffected.
 *
 * It is applied as a scale on the scene, not baked into the model. `dims` stays
 * the honest derived size, the capacity checks keep testing real geometry, and
 * the UI says the heights are exaggerated.
 */
/*
 * 1.55 -> 1.25 on 2026-09-02, on the client's decision after the proportions
 * were measured: with 1.55 the drawn height-to-diameter ratio was 8.5 for the
 * 300 series and 10.0 for the 800 series — straws, where a real hopper bin sits
 * near 3. The two biggest banks cannot get WIDER (11 bins per row already span
 * 53.9 m of a 55 m traced building; 16 per row span 48.6 m of 55.5 m), so the
 * stretch is the one lever that makes every bin stockier at once while keeping
 * relative heights true. The immersive page's canvas is ~40% taller than the
 * one 1.55 was tuned for, which is what pays for the lost height at site range.
 */
export const VERTICAL_EXAGGERATION = 1.25;

/**
 * Size compression, applied to every group on the site — indoor and outdoor
 * alike, keyed to CAPACITY rather than to the assumed diameter.
 *
 * Capacity here spans 16,000:1 (100 kg to 1,600 t), which at true scale means
 * a micro hopper is a speck beside the bulk silos — you cannot see it, let
 * alone read a level off it. A power law keeps every group in the right
 * ORDER of size while pulling the small ones up toward the large:
 *
 *     drawn scale  = (capacity / CAP_REF) ^ ((SIZE_COMPRESSION - 1) / 3)
 *     drawn volume = true volume * drawn scale ^ 3
 *                  = CAP_REF/density * (capacity / CAP_REF) ^ SIZE_COMPRESSION
 *
 * CAP_REF is the plant's own largest capacity (see SIZE_REFERENCE_CAPACITY_KG
 * below), so drawn volume reduces to a power of capacity ALONE — every
 * group's assumed diameter and shape cancel out of the ratio. That algebra is
 * what makes both guarantees below hold for any diameter this file happens to
 * assume, not just the ones in it today:
 *
 *   - two groups of equal capacity draw the exact same volume, whether one
 *     sits in a building and the other stands in the open
 *   - drawn volume is STRICTLY increasing in capacity (SIZE_COMPRESSION > 0),
 *     so a bigger bin can never draw smaller than a smaller one
 *
 * THIS USED TO BE KEYED TO ZONE, NOT CAPACITY, AND IT WAS WRONG. The 100, 200
 * series returned scale 1 unconditionally; every other group ran a
 * curve keyed to its own assumed DIAMETER. That treated "which zone is this"
 * and "how big is this" as the same question, and on this plant they are not:
 * two groups can share a capacity and be given different assumed diameters
 * (this plant had exactly that — 160 t in both the 300 and the since-retired
 * 500 series, 4 m
 * assumed for one, 5 m for the other), and a diameter-keyed curve has no way
 * to know they are supposed to match. Measured on the layout this replaced:
 * the 300 series (indoor, 160 t) drew at 266 m3 and the 500 series (outdoor,
 * the SAME 160 t) drew at 213 m3 — a 24% mismatch for one number on the
 * label — and separately the 50 t press-buffer silo drew SMALLER (117 m3)
 * than the 45 t finished-feed bin (138 m3), a straight capacity-order
 * inversion, because the two were never on the same curve to begin with. That
 * second one is not a rounding error: it is a bigger bin reading as the
 * smaller one on screen, which is precisely the "it feels so off" this exists
 * to fix.
 *
 * At 0.85 the plant's capacity range (16,000:1) compresses to a drawn-volume
 * range of about 664:1 (2,133 m3 down to 3.2 m3) and a drawn-diameter range
 * of about 7.7:1 (10 m down to the 1.3 m floor). The 100 and 200 series,
 * already the biggest bins on site, are UNCHANGED — see CAP_REF.
 *
 * Swept downward against `every indoor group fits inside its building` and
 * `no two bins occupy the same space`, both measured on DRAWN size: at 0.84
 * the 300 series (mill-a's raw-material battery) is left 0.36 m clear of the
 * mill wall in X, under the 0.5 m this file requires; at 0.85 that margin is
 * 0.57 m. Fixed group centres are what bites here, not the building: the 300
 * series is two rows of eleven on a 4.4 m true pitch, and this file may not
 * widen that pitch beyond what SIZE_COMPRESSION itself opens it to. 0.85 is the
 * smallest exponent — the most compression, and so the most legibility for
 * the small bins — that still clears every building and every neighbour
 * with margin to spare.
 */
export const SIZE_COMPRESSION = 0.85;

/**
 * Smallest a compressed bin may be drawn, in metres.
 *
 * The power law above has no floor, so the further a bin falls below the
 * reference the smaller it keeps getting: silo 901 is 0.45 m across, and
 * projecting the current camera code shows why a floor is needed at all —
 * uncompressed it is smaller on screen than every other bin in the plant,
 * zone view included. That is the client's "the small silos are too small",
 * and no amount of camera work fixes it, because the bin next to it is fifty
 * times the volume.
 *
 * 1.3 m rather than a rounder number because the neighbours do not move: the
 * 900a and 900b group centres are a fixed 10.5 m apart, and a search against
 * the real layout puts first contact between their drawn silhouettes at
 * 1.3755 m. 1.3 m keeps a working margin, and only the three 900-series
 * groups are ever close enough to this floor to be touched by it — every
 * other group's capacity-driven curve already clears 1.3 m on its own. It is
 * set by fixed group spacing on the dosing floor, which is a layout fact, not
 * a drawing choice, and this file does not move group centres.
 */
export const SIZE_FLOOR_DIAMETER = 1.3;

/**
 * How much bigger than life a group is drawn.
 *
 * A pure function of capacity and this group's own assumed diameter — no
 * zone in sight. `refCapacityKg` is passed in rather than read from a module
 * constant so this stays testable on its own; `buildPlacements` below is the
 * only caller, and it passes SIZE_REFERENCE_CAPACITY_KG.
 */
export function sizeScale(g: { capacityKg: number; diameter: number }, refCapacityKg: number): number {
  const curve = (g.capacityKg / refCapacityKg) ** ((SIZE_COMPRESSION - 1) / 3);
  return Math.max(curve, SIZE_FLOOR_DIAMETER / g.diameter);
}

export type SeriesId = 100 | 200 | 300 | 400 | 600 | 800 | 900;

/** Derived physical dimensions of a single bin, all metres. */
export interface SiloDims {
  diameter: number;
  /** straight cylindrical section */
  barrel: number;
  /** depth of the discharge cone below the barrel; 0 = flat bottom */
  hopper: number;
  /** rise of the conical roof above the barrel */
  roof: number;
  /** underside of the hopper (or of a flat bottom) above its own floor */
  elevation: number;
  /** elevation + hopper + barrel + roof */
  total: number;
  /** capacity / density, m3 */
  volume: number;
}

/**
 * Radius of the hopper outlet, as a fraction of the barrel radius.
 *
 * This single number is shared by the geometry and by every volume calculation.
 * It has to be: an earlier version drew the hopper as a frustum bottoming at
 * 0.72 x radius while the maths assumed a cone tapering to a point, which drew
 * all eight hopper-bottomed groups 5-15% larger than the capacity written on
 * them and put the fill line up to twelve percentage points wrong. Geometry and
 * arithmetic now read the same constant, so they cannot drift apart again.
 */
export const HOPPER_OUTLET_RATIO = 0.18;

/** Cross-section radius of the storage space, h metres above its own bottom. */
export function storageRadiusAt(d: SiloDims, h: number): number {
  const R = d.diameter / 2;
  if (d.hopper <= 0 || h >= d.hopper) return R;
  const a = R * HOPPER_OUTLET_RATIO;
  return a + (R - a) * (Math.max(h, 0) / d.hopper);
}

/** Volume of contents held from the bottom of the storage space up to h. */
export function storageVolumeUpTo(d: SiloDims, h: number): number {
  const R = d.diameter / 2;
  const area = Math.PI * R * R;
  const capped = Math.min(Math.max(h, 0), d.hopper + d.barrel);
  if (d.hopper <= 0) return area * capped;
  const a = R * HOPPER_OUTLET_RATIO;
  const inCone = Math.min(capped, d.hopper);
  const rTop = storageRadiusAt(d, inCone);
  const cone = (Math.PI / 3) * inCone * (a * a + a * rTop + rTop * rTop);
  const barrel = capped > d.hopper ? area * (capped - d.hopper) : 0;
  return cone + barrel;
}

/** Everything the bin can hold, m3. Equals capacity / density by construction. */
export function storageVolume(d: SiloDims): number {
  return storageVolumeUpTo(d, d.hopper + d.barrel);
}

/**
 * Height fraction that holds a given fraction of the capacity.
 *
 * A hopper holds far less near its outlet than the barrel does per metre, so
 * shading a bin linearly by height would put the surface in the wrong place on
 * every hopper-bottomed bin in the plant. This inverts the real volume instead.
 *
 * Bisection rather than algebra: the frustum volume is a cubic in height, and a
 * closed form would have to be kept in step with `storageVolumeUpTo` by hand.
 * Forty halvings resolve to a part in 10^12 of the bin height. The scene, the
 * plant totals and the per-zone totals each walk every bin, so this runs on the
 * order of 370 times per refresh — still nothing, but three times what a glance
 * at the call site suggests.
 */
export function heightFractionForVolume(d: SiloDims, volumeFraction: number): number {
  const total = d.hopper + d.barrel;
  if (!(total > 0) || Number.isNaN(volumeFraction)) return 0;
  /* Clamp before use: Infinity must read as full, not fall through as garbage. */
  const f = Math.min(Math.max(volumeFraction, 0), 1);
  /* Bisection on a strict `<` can never move `lo` off 0 or `hi` onto `total`, so
     an empty bin would settle at 2^-41 of its height and a full one 2^-41 short.
     Physically nothing, but the empty and full cases are exactly the two the
     shader guards on, so make them exact. */
  if (f <= 0) return 0;
  if (f >= 1) return 1;
  const want = f * storageVolume(d);
  let lo = 0;
  let hi = total;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (storageVolumeUpTo(d, mid) < want) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2 / total;
}

/**
 * Height from capacity.
 *
 * volume = capacity / density, split between the discharge cone and the straight
 * section, so a bin with a deep hopper comes out correctly shorter than one
 * without. The diameter is the assumed input; everything else follows from it.
 *
 * The hopper is a frustum, not a cone — it discharges through a real outlet —
 * so its volume uses the same outlet ratio the geometry is drawn with.
 */
export function deriveDims(
  capacityKg: number,
  diameter: number,
  hopperRatio: number,
  elevation: number,
): SiloDims {
  const volume = capacityKg / 1000 / BULK_DENSITY_T_PER_M3;
  const R = diameter / 2;
  const area = Math.PI * R * R;
  const hopper = diameter * hopperRatio;
  const k = HOPPER_OUTLET_RATIO;
  const hopperVolume = hopper > 0 ? (area * hopper * (k * k + k + 1)) / 3 : 0;
  const barrel = Math.max(0.3, (volume - hopperVolume) / area);
  const roof = diameter * 0.18;
  return {
    diameter,
    barrel,
    hopper,
    roof,
    elevation,
    total: elevation + hopper + barrel + roof,
    volume,
  };
}

/**
 * Lay a group out from an ASCII mask, so the arrangement in the code is the
 * arrangement on the plant floor and the two cannot quietly drift apart.
 *
 *   ['XXX',      the 3-2-3 of the mineral bins:
 *    'X X',      two on the sides, centre open
 *    'XXX']
 *
 * Columns run along +X, rows along +Z, and positions come out left to right, row
 * by row — which is the order silo numbers are assigned in.
 */
export function maskPositions(
  mask: readonly string[],
  pitchX: number,
  pitchZ: number,
  cx: number,
  cz: number,
): [number, number][] {
  const cols = Math.max(...mask.map((r) => r.length));
  const x0 = cx - ((cols - 1) * pitchX) / 2;
  const z0 = cz - ((mask.length - 1) * pitchZ) / 2;
  const out: [number, number][] = [];
  mask.forEach((row, r) => {
    for (let c = 0; c < row.length; c += 1) {
      if (row[c] !== ' ') out.push([x0 + c * pitchX, z0 + r * pitchZ]);
    }
  });
  return out;
}

/** What a group's shell is made of, which is also what colour it reads as. */
export type ShellKind = 'concrete' | 'galvanised' | 'painted' | 'tank';

/*
 * Four shell colours, pulled apart on purpose.
 *
 * Most bins in this plant have no material assigned, so most of the time the
 * shell colour IS the colour of the plant — and four near-identical greys made
 * the whole site one flat wash. Warm concrete outside against cool steel inside
 * gives the eye something to separate the zones by even when there is no stock
 * anywhere.
 */
const SHELL: Record<ShellKind, string> = {
  /* Big outdoor storage reads as poured concrete on the aerial imagery: warm,
     sandy, sun-bleached. */
  concrete: '#d6c9ae',
  /* Indoor mill bins: mill-finish galvanised steel, cool and slightly blue. */
  galvanised: '#9fb1c2',
  /* Dosing-floor bins, painted a pale industrial green-grey. */
  painted: '#9fb8ad',
  /* Liquid tanks. The coldest and darkest of the four, so the unreported
     liquid tanks read as inert rather than as working plant. */
  tank: '#77878f',
};

/**
 * The shape each group is drawn in — see `siloGeometry.ts`'s
 * `buildBaseGeometry` for what each one assembles. Diameters and heights are
 * unchanged by this; it only dresses the same derived dims in structure.
 */
export type SiloArchetype = 'bulk' | 'tank' | 'hopperBin' | 'mineralBin' | 'microHopper';

/** Per-group structure knobs the archetype builder reads. Every field is
    optional and archetype-specific; see `buildBaseGeometry`. */
export interface SiloStructureParams {
  /** leg count (hopperBin/mineralBin/microHopper) */
  legs?: number;
  /** stiffener ring count on the barrel (hopperBin) */
  rings?: number;
  /** which side the ladder detail mesh stands on; -1 = -X (the default) */
  ladderSide?: 1 | -1;
  /** override for the stiffener/rail ring radius ratio, when the nominal
      value would collide with a neighbour — see the 800-series note in
      `siloGeometry.ts`'s `buildBaseGeometry` */
  ringRadiusRatio?: number;
  /** the six-box spiral-stair suggestion (tank) */
  stair?: boolean;
  /** the horizontal screw-feeder stub off the outlet (microHopper) */
  screwFeeder?: boolean;
  /** this group gets the shared conveyor structure (hopperBin, 800 series) */
  conveyors?: boolean;
}

export interface SiloGroupSpec {
  id: string;
  series: SeriesId;
  label: string;
  /** the shape this group is drawn in — see `SiloArchetype` */
  archetype: SiloArchetype;
  /** structure knobs the archetype builder reads; all optional */
  structure?: SiloStructureParams;
  /**
   * Which tab this group is grouped under — a statement about what the bins
   * ARE, not about where they stand.
   */
  zone: ZoneId;
  /**
   * The building this group physically stands in, when that is not simply the
   * building belonging to its zone.
   *
   * These were one field until the 400 series had to move. `zone` was doing two
   * unrelated jobs: deciding which tab a group appears under, and deciding
   * which building it must fit inside. That worked only while every group
   * happened to stand in the building named after its own zone.
   *
   * The 400 series broke it. The plant's own documentation calls 401-408
   * "DB3 mineral", and the zone they sit in is labelled "Minerals & Micro", so
   * mineral is what they are. But they were asked to stand in front of the 300
   * battery, which is inside mill-a — the RAW building. With one field the only
   * way to place them there was to call them raw material, which put mineral
   * bins under a tab reading "Raw Material". That is a false statement about
   * the plant made in order to satisfy a geometry check, which is exactly
   * backwards: the check exists to protect the drawing's honesty.
   *
   * So a group can now say where it stands without lying about what it holds.
   */
  building?: string;
  /** first silo number in the group; numbers run in mask order */
  first: number;
  capacityKg: number;
  /**
   * Does the plant report a quantity for these bins?
   *
   * The 400-series has no quantity tag in DB5 at all, so it may never be
   * drawn with a fill level — doing so would be animating a signal that does
   * not exist.
   */
  metered: boolean;
  /** present in the application database at all */
  monitored: boolean;
  shell: ShellKind;
  /** ASSUMED diameter, metres — the one free input to the derivation */
  diameter: number;
  /** discharge cone depth as a multiple of diameter; 0 = flat bottom */
  hopperRatio: number;
  /** underside height above this group's own floor, metres */
  elevation: number;
  /** floor the group stands on: 0 = ground, >0 = mezzanine slab */
  floor: number;
  mask: readonly string[];
  pitchX: number;
  pitchZ: number;
  /** centre of the group, plant-local metres */
  cx: number;
  cz: number;
  arrangement: string;
  note?: string;
}

/**
 * The eleven groups that make up the plant.
 *
 * A "group" is a set of bins sharing a capacity, a shape and an arrangement —
 * which is also exactly the unit that becomes one instanced draw call.
 */
export const SILO_GROUPS: SiloGroupSpec[] = [
  /* ------------------------------------------------------------------ *
   * OUTSIDE — bulk raw material and liquids                            *
   * ------------------------------------------------------------------ */
  {
    id: 's100',
    series: 100,
    label: 'Bulk raw material',
    archetype: 'bulk',
    zone: 'outside',
    first: 101,
    capacityKg: 1_600_000,
    metered: true,
    monitored: true,
    shell: 'concrete',
    /* Widened 2026-09-02 on the client's instruction ("bigger, like a real silo shape", buildings may grow past the aerial); see the proportions table in the design log 8l. */
    diameter: 11,
    hopperRatio: 0,
    elevation: 1.2,
    floor: 0,
    /* Turned across the flow on the client's instruction: two COLUMNS running
       away from the spine, rather than two rows along it. Mask characters step
       in X and mask rows step in Z, so this is simply the transpose of what was
       here — the count and the grouping are untouched, only the axis. */
    mask: ['XX', 'XX', 'XX', 'XX', 'XX', 'XX', 'XX', 'X '],
    pitchX: 12,
    pitchZ: 13,
    cx: -95.5,
    cz: -16,
    arrangement: 'Two columns: eight, then seven',
  },
  {
    id: 's200',
    series: 200,
    label: 'Flat storage',
    archetype: 'bulk',
    zone: 'outside',
    first: 201,
    capacityKg: 1_600_000,
    metered: true,
    monitored: true,
    shell: 'concrete',
    /* Widened 2026-09-02 on the client's instruction ("bigger, like a real silo shape", buildings may grow past the aerial); see the proportions table in the design log 8l. */
    diameter: 11,
    hopperRatio: 0,
    elevation: 1.2,
    floor: 0,
    /* A column of three, across the flow, and placed FIRST — upstream of the
       100 series rather than beside it. Client instruction. `cz` puts its top
       on the same line as the 100 series so the two banks start together. */
    mask: ['X', 'X', 'X'],
    pitchX: 14,
    pitchZ: 14,
    cx: -118,
    cz: -44,
    arrangement: 'Column of three',
    note: 'Flat storage in reality. Drawn as cylinders on instruction, so this group is representational rather than literal.',
  },

  /* ------------------------------------------------------------------ *
   * INSIDE — raw material battery                                      *
   * ------------------------------------------------------------------ */
  {
    id: 's300',
    series: 300,
    label: 'Raw material',
    archetype: 'hopperBin',
    /*
     * ringRadiusRatio thinned to 1.012, same reasoning as the 800 series.
     *
     * The three stiffener rings the hopperBin archetype adds widen the true
     * drawn silhouette past what the bare roof eave alone did — `EAVE_RATIO`
     * (1.02) was tuned to leave this group 0.57 m clear of the mill-a wall
     * with NO rings on it. At the hopperBin default ring ratio (1.025) the
     * true `profileMaxRadius` (which now measures the rings' own torus tube,
     * not just their centreline) shrinks that to 0.487 m — under the 0.5 m
     * the building-fit check requires. 1.012 restores clearance comfortably;
     * see the proof in the Phase 2B report.
     */
    structure: { legs: 4, rings: 3, ringRadiusRatio: 1.012 },
    zone: 'raw',
    first: 301,
    capacityKg: 160_000,
    metered: true,
    monitored: true,
    shell: 'galvanised',
    /* 4 -> 4.45 m, pitch 4.4 -> 4.8 (2026-09-02, client's instruction to go
       bigger). 4.45 is the most the row can take: eleven bins on the client's
       arrangement must sit inside mill-a, whose EAST wall cannot pass the
       dosing floor's west edge at x 15.6, so the building could only grow
       west and the bins are centred at x -15. mill-a is now 61.5 m long. */
    diameter: 4.45,
    hopperRatio: 0.7,
    elevation: 2.5,
    floor: 0,
    mask: ['XXXXXXXXXXX', 'XXXXXXXXXXX'],
    pitchX: 4.8,
    pitchZ: 8.4,
    cx: -15,
    cz: -6,
    arrangement: 'Two rows of eleven',
  },

  /* ------------------------------------------------------------------ *
   * INSIDE — dosing floor: minerals and micro-ingredients              *
   * ------------------------------------------------------------------ */
  {
    id: 's400',
    series: 400,
    label: 'Mineral bins',
    archetype: 'mineralBin',
    structure: { legs: 4 },
    /* Minerals, per the plant's own docs ("401-408 ... DB3 mineral"), so they
       stay in the Minerals & Micro group — but they stand in mill-a, in front
       of the 300 battery, on the client's instruction. */
    zone: 'dosing',
    building: 'mill-a',
    first: 401,
    capacityKg: 5_000,
    metered: false,
    monitored: true,
    shell: 'painted',
    /* 1.5 -> 2.0 m (2026-09-02, client's proportions decision): a 5 t mineral
       bin at 1.5 m drew 5.4:1; 2.0 m is a real small hopper bin's shape. The
       2.4 m pitch opens with the same draw scale, so the pair on the sides
       stays clear. */
    /* 2.7 m (2026-09-02, second widening on the client's "bigger, the ones
       you can"): the most the 3-2-3 block can take at cz 8 while staying
       1.6 m clear of the 300 battery's back row; drawn volume still equals
       the 5 t capacity, so the bin is shorter for being wider. */
    diameter: 2.7,
    hopperRatio: 0.7,
    elevation: 0.6,
    floor: 10,
    mask: ['XXX', 'X X', 'XXX'],
    pitchX: 2.9,
    pitchZ: 2.9,
    cx: -15,
    cz: 8,
    arrangement: 'Square, three-two-three, the pair on the sides',
    note: 'No quantity tag exists in DB5 for the 400 series. Material, HL and LOCK only — never a level.',
  },
  {
    id: 's900a',
    series: 900,
    label: 'Micro — 5 kg scale',
    archetype: 'microHopper',
    structure: { legs: 3, screwFeeder: true },
    zone: 'dosing',
    first: 901,
    capacityKg: 100,
    metered: true,
    monitored: true,
    shell: 'painted',
    diameter: 0.45,
    hopperRatio: 0.7,
    elevation: 0.5,
    floor: 10,
    mask: ['XXXX', 'X  X', 'XXXX'],
    pitchX: 1,
    pitchZ: 1,
    cx: 32.0,
    cz: -12,
    arrangement: 'Ring of ten, four-two-four, open centre',
  },
  {
    id: 's900b',
    series: 900,
    label: 'Micro — 20 kg scale',
    archetype: 'microHopper',
    structure: { legs: 3, screwFeeder: true },
    zone: 'dosing',
    first: 911,
    capacityKg: 150,
    metered: true,
    monitored: true,
    shell: 'painted',
    diameter: 0.5,
    hopperRatio: 0.7,
    elevation: 0.5,
    floor: 10,
    mask: ['XXXX', 'XXXX', 'XXXX'],
    pitchX: 1.1,
    pitchZ: 1.1,
    cx: 42.5,
    cz: -12,
    arrangement: 'Three rows of four',
  },
  {
    id: 's900c',
    series: 900,
    label: 'Micro — 50 kg scale',
    archetype: 'microHopper',
    structure: { legs: 3, screwFeeder: true },
    zone: 'dosing',
    first: 923,
    capacityKg: 300,
    metered: true,
    monitored: true,
    shell: 'painted',
    diameter: 0.6,
    hopperRatio: 0.7,
    elevation: 0.5,
    floor: 10,
    mask: ['XXX', 'X X', 'XXX'],
    pitchX: 1.3,
    pitchZ: 1.3,
    cx: 52.3,
    cz: -12,
    arrangement: 'Square, three-two-three',
  },

  /* ------------------------------------------------------------------ *
   * INSIDE — press buffer                                              *
   * ------------------------------------------------------------------ */
  {
    id: 's600s',
    series: 600,
    label: 'Press buffer',
    archetype: 'hopperBin',
    structure: { legs: 4, rings: 2 },
    zone: 'buffer',
    first: 601,
    capacityKg: 5_000,
    metered: true,
    monitored: true,
    shell: 'galvanised',
    /* 1.5 -> 2.0 m (2026-09-02, client's proportions decision), same reasoning
       as the 400 series; the 5 x 6 m pitch has room to spare. */
    /* 2.7 m, z pitch 7 (2026-09-02, second widening). 3.2 m was tried and the
       capacity check refused it: a 5 t bin's 60-degree hopper alone holds
       9.7 m3 at that width against a 6.7 m3 label. 2.7 m is the widest a 5 t
       bin can be drawn while its volume still equals its capacity. 0.9 m
       clear of the
       press house's west wall, 1.2 m clear of its north wall. */
    diameter: 2.7,
    hopperRatio: 0.7,
    elevation: 0.6,
    floor: 8,
    mask: ['XX', 'XX'],
    pitchX: 5,
    pitchZ: 7,
    cx: 66.5,
    cz: -9,
    arrangement: 'Two pairs: 601-602 and 603-604',
    note: 'The 600 SCADA screen shows 18.00 for bins that look full, against a 5 t capacity. The units are unconfirmed, so treat any level here as unverified.',
  },
  {
    id: 's600l',
    series: 600,
    label: 'Press buffer — large',
    archetype: 'hopperBin',
    structure: { legs: 4, rings: 2 },
    zone: 'buffer',
    first: 605,
    capacityKg: 50_000,
    metered: true,
    monitored: true,
    shell: 'galvanised',
    /* 3 -> 3.5 m (2026-09-02, client's proportions decision): the 50 t buffer
       silo drew 6:1 tall; 3.5 m brings it under 5:1 at the new stretch. It
       stands alone, so nothing binds. */
    /* 4.5 m (2026-09-02, second widening): 0.8 m clear of the press house's
       east wall, which is what pins the finished store's west wall. */
    diameter: 4.5,
    hopperRatio: 0.7,
    elevation: 0.6,
    floor: 8,
    mask: ['X'],
    pitchX: 1,
    pitchZ: 1,
    cx: 75.0,
    cz: -9,
    arrangement: 'Stands alone',
  },

  /* ------------------------------------------------------------------ *
   * INSIDE — finished feed                                             *
   * ------------------------------------------------------------------ */
  {
    id: 's800',
    series: 800,
    label: 'Finished feed',
    archetype: 'hopperBin',
    /*
     * ringRadiusRatio thinned from the hopperBin default (1.025) to 1.012.
     *
     * Measured against the true drawn silhouette (`profileMaxRadius`, which
     * now includes the torus tube of the stiffener rings, not just their
     * centreline): at 1.025 the three rings leave only about 4.7 cm clear on
     * the tight 2.55 m row pitch over the 2.4 m shell (drawScale ~1.195) —
     * technically inside the 13 cm the bare eave lip already left, but
     * uncomfortably close to the overlap check's own tolerance. 1.012 widens
     * that to about 8.5 cm, which is the plan's own instruction for exactly
     * this series. See the proof recorded in the Phase 2B report.
     */
    structure: { legs: 4, rings: 3, conveyors: true, ringRadiusRatio: 1.012 },
    zone: 'finished',
    first: 801,
    capacityKg: 45_000,
    metered: true,
    monitored: true,
    shell: 'galvanised',
    /* 2.4 -> 2.65 m, pitch 2.55 -> 2.94 (2026-09-02, client's instruction to
       go bigger). 2.65 is the most the row can take: sixteen bins on the
       client's arrangement, centred at x 107.6, must clear the press house,
       whose east wall cannot come west of the large buffer silo at x 75
       (+2.4 m radius). The store grew EAST to 59 m instead. */
    diameter: 2.65,
    hopperRatio: 0.7,
    elevation: 0.8,
    floor: 0,
    mask: ['XXXXXXXXXXXXXXXX', 'XXXXXXXXXXXXXXXX', 'XXXXXXXXXXXXXXXX'],
    pitchX: 2.94,
    pitchZ: 3,
    cx: 107.6,
    cz: -4,
    arrangement: 'Three rows of sixteen, one per outloading conveyor',
    note: 'The three rows correspond to conveyors CC121.1, .2 and .3. The +24 pairing in the order code is a destination-selection relationship, not a physical stack.',
  },
];

/**
 * Reference capacity the compression curve bends around, kg.
 *
 * The plant's own largest capacity — 1,600 t, held by both the 100 and 200
 * series — so those two groups draw at scale 1, true size, and nothing on
 * site is ever drawn BIGGER than the biggest bins actually are. Every other
 * group, indoor or outdoor, draws bigger than life by some amount; nothing
 * draws smaller than life. Derived from SILO_GROUPS rather than hand-typed,
 * so a future group bigger than 1,600 t could never silently leave this
 * pointed at the wrong bin.
 */
const SIZE_REFERENCE_CAPACITY_KG = Math.max(...SILO_GROUPS.map((g) => g.capacityKg));

/** One bin, fully resolved: where it is, how big it is, what it belongs to. */
export interface SiloPlacement {
  siloNo: number;
  group: SiloGroupSpec;
  /** index within the group — also its instance index in the InstancedMesh */
  index: number;
  x: number;
  z: number;
  /** height of the floor this bin stands on */
  floor: number;
  dims: SiloDims;
  /**
   * Uniform scale the bin is DRAWN at. 1 only for the plant's largest
   * capacity (the 100 and 200 series); every other group, indoor or
   * outdoor, is greater than 1 — see SIZE_COMPRESSION.
   */
  drawScale: number;
  /** top of the drawn roof above ground, for labels and camera aim */
  topY: number;
}

/** Mezzanine slabs the elevated groups stand on. */
export interface Platform {
  id: string;
  label: string;
  zone: ZoneId;
  /**
   * The building the slab stands in when that is not the building of its own
   * zone — the same split `SiloGroupSpec.zone`/`building` makes. The mineral
   * dosing floor holds dosing-zone bins but stands in mill-a, the raw
   * building, so the Raw Material view must draw it or the 400 series hangs
   * in the air there. `platformInZone` below is the one rule.
   */
  building?: string;
  x: number;
  z: number;
  length: number;
  width: number;
  /** top surface height above ground */
  y: number;
}

export const PLATFORMS: Platform[] = [
  {
    /*
     * The 400 series stands at floor 10 in mill-a, in front of the 300
     * battery, on the client's instruction — and until 2026-09-02 nothing was
     * drawn under it: the only dosing slab was the one in mill-b. The client
     * saw eight bins hanging in the air. This is the mezzanine they stand on,
     * sized to the group's drawn footprint plus a walkway.
     */
    id: 'mineral-floor',
    label: 'Mineral dosing floor',
    zone: 'dosing',
    building: 'mill-a',
    x: -15,
    z: 8,
    length: 13,
    width: 13,
    y: 10,
  },
  {
    id: 'dosing-floor',
    label: 'Dosing floor',
    zone: 'dosing',
    /* 36.1 -> 36.6: mill-b's west wall moved to x 16 when mill-a grew (2026-09-02). */
    x: 36.6,
    z: -12,
    length: 41,
    width: 11,
    y: 10,
  },
  {
    id: 'buffer-floor',
    label: 'Buffer floor',
    zone: 'buffer',
    x: 69.2,
    z: -9,
    length: 17,
    width: 13,
    y: 8,
  },
];

/**
 * Is this platform part of the picture when `zone` is selected?
 *
 * The same two-way rule the page applies to silo groups (`groupInZone`): a
 * slab belongs to the zone it serves, and to the zone whose building it
 * physically stands in. Takes the building list as an argument so this module
 * stays free of a value import from `site.ts`.
 */
export function platformInZone(
  p: Platform,
  zone: ZoneId | 'all',
  buildings: readonly { id: string; zone?: ZoneId }[],
): boolean {
  if (zone === 'all') return true;
  if (p.zone === zone) return true;
  if (!p.building) return false;
  return buildings.some((b) => b.id === p.building && b.zone === zone);
}

function buildPlacements(): SiloPlacement[] {
  const out: SiloPlacement[] = [];
  for (const g of SILO_GROUPS) {
    /* `dims` stays the TRUE derived size — the capacity checks test real
       geometry. The compression is a draw-time scale on top of it, and the
       spacing opens up by the same factor so nothing collides. */
    const dims = deriveDims(g.capacityKg, g.diameter, g.hopperRatio, g.elevation);
    const scale = sizeScale(g, SIZE_REFERENCE_CAPACITY_KG);
    /*
     * The pitch opens by the same factor the bins grow by — which does move
     * individual bins, and that deserves an argument rather than a shrug,
     * because the client's instruction is that no silo moves.
     *
     * It has to open: growing a bin without growing its spacing makes it
     * overlap its own neighbour, which the overlap check would catch and which
     * would look worse than any drift. So the question is only how far anything
     * actually moves. Measured, worst bin per group, against its group centre:
     *
     *   s100  1600 t  scale 1.000  drift 0.00 m      s500  160 t  1.122  1.95 m
     *   s200  1600 t  scale 1.000  drift 0.00 m      s300  160 t  1.122  2.73 m
     *   s800    45 t  scale 1.195  drift 3.78 m      s900a 0.1 t  2.889  3.41 m
     *
     * The two groups with real outside evidence behind them — the satellite-
     * traced 100 and 200 series — do not move AT ALL, because they hold the
     * plant's largest capacity and the curve is anchored there, so their scale
     * is exactly 1. That is not a coincidence to rely on quietly: it falls out
     * of `SIZE_REFERENCE_CAPACITY_KG` being the maximum, and it is the reason
     * this mapping is safe to apply outdoors as well as in.
     *
     * The one evidence-backed group that does move is the 500 series, by
     * 1.95 m. Weigh that against what is actually known about where it is: the
     * georeferencing pass could not pin the outdoor bank's position to better
     * than about 20 m, because its sawtooth roof alternates between shadow and
     * sunlit ridge and is photometrically indistinguishable from the loading
     * apron in front of it. A 1.95 m drift sits an order of magnitude inside
     * the uncertainty that was already there and openly recorded.
     *
     * Every other group's position was ASSUMED to begin with, and this file
     * says so at the top.
     */
    const pts = maskPositions(g.mask, g.pitchX * scale, g.pitchZ * scale, g.cx, g.cz);
    pts.forEach(([x, z], i) => {
      out.push({
        siloNo: g.first + i,
        group: g,
        index: i,
        x,
        z,
        floor: g.floor,
        dims,
        drawScale: scale,
        topY: g.floor + dims.total * scale,
      });
    });
  }
  return out;
}

/** Every bin on the site, in silo-number order within each group. */
export const SILOS: SiloPlacement[] = buildPlacements();

/** Fast lookup by silo number. */
export const SILO_BY_NO = new Map<number, SiloPlacement>(SILOS.map((s) => [s.siloNo, s]));

/**
 * Counts asserted against the plant database, which is the source of truth.
 *
 * A typo in a mask would otherwise change a silo count silently, and every
 * number downstream would still look perfectly plausible. `assertSiloModel`
 * turns that into a loud failure instead.
 */
export const EXPECTED_COUNTS: Readonly<Record<string, number>> = {
  s100: 15,
  s200: 3,
  s300: 22,
  s400: 8,
  s900a: 10,
  s900b: 12,
  s900c: 8,
  s600s: 4,
  s600l: 1,
  s800: 48,
};

/** Bins the plant monitors: 131 — which is now every bin in the model. The
    500-series liquid tanks were removed on the client's instruction
    (2026-09-10); they were the only unmonitored group, so this count and
    SILOS.length agree by construction rather than by coincidence. */
export const MONITORED_COUNT = SILOS.filter((s) => s.group.monitored).length;

/**
 * Check the model against the counts taken from the plant database.
 *
 * Returns the list of problems; empty means the model matches. Called by the 3D
 * page on mount so a layout mistake surfaces on screen rather than being
 * discovered by someone counting cylinders.
 */
export function assertSiloModel(): string[] {
  const problems: string[] = [];
  const seen = new Set<number>();

  for (const g of SILO_GROUPS) {
    const n = SILOS.filter((s) => s.group.id === g.id).length;
    const want = EXPECTED_COUNTS[g.id];
    if (want === undefined) {
      problems.push(`group ${g.id} has no expected count`);
    } else if (n !== want) {
      problems.push(`group ${g.id}: ${n} bins placed, plant has ${want}`);
    }
  }

  for (const s of SILOS) {
    if (seen.has(s.siloNo)) problems.push(`silo ${s.siloNo} placed more than once`);
    seen.add(s.siloNo);
    if (!s.group.metered && s.group.monitored && s.group.series !== 400) {
      /* only the 400s are legitimately monitored-but-unmetered */
      problems.push(`silo ${s.siloNo} is monitored but unmetered outside the 400 series`);
    }
  }

  /* The drawn shape must hold the capacity written on it. This is the check
     that would have caught the cone-versus-frustum mismatch immediately. */
  for (const g of SILO_GROUPS) {
    const d = deriveDims(g.capacityKg, g.diameter, g.hopperRatio, g.elevation);
    const want = g.capacityKg / 1000 / BULK_DENSITY_T_PER_M3;
    const got = storageVolume(d);
    if (Math.abs(got - want) / want > 0.005) {
      problems.push(
        `group ${g.id} is drawn to hold ${got.toFixed(1)} m3 but is labelled ${want.toFixed(1)} m3`,
      );
    }
  }

  if (MONITORED_COUNT !== 131) {
    problems.push(`${MONITORED_COUNT} monitored bins, plant database has 131`);
  }
  return problems;
}

/** Where a zone's label hangs in 3D: over the middle of its bins, above the tallest. */
export interface ZoneAnchor {
  zone: ZoneId;
  x: number;
  z: number;
  top: number;
  bins: number;
  siloNos: number[];
}

export const ZONE_ANCHORS: ZoneAnchor[] = (() => {
  const byZone = new Map<ZoneId, SiloPlacement[]>();
  for (const s of SILOS) {
    const list = byZone.get(s.group.zone);
    if (list) list.push(s);
    else byZone.set(s.group.zone, [s]);
  }
  const out: ZoneAnchor[] = [];
  byZone.forEach((ps, zone) => {
    out.push({
      zone,
      x: ps.reduce((a, p) => a + p.x, 0) / ps.length,
      z: ps.reduce((a, p) => a + p.z, 0) / ps.length,
      top: Math.max(...ps.map((p) => p.topY)),
      bins: ps.filter((p) => p.group.monitored).length,
      siloNos: ps.filter((p) => p.group.monitored).map((p) => p.siloNo),
    });
  });
  return out;
})();

/** An axis-aligned box in plant-local metres. */
export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

function boundsOf(ps: SiloPlacement[], pad = 4, floorMargin?: number): Bounds {
  const r = (p: SiloPlacement) => (p.dims.diameter * p.drawScale) / 2 + pad;
  /*
   * True ground, unless the caller wants to frame from the group's own floor.
   *
   * Every zone box used to start at y = 0, including the two zones that live on
   * a mezzanine. Dosing sits on a floor 10 m up, so its box carried 10 m of
   * empty air below the lowest hopper — 48% of its total height describing
   * nothing at all. Height is the binding axis for every zone view here, so
   * that dead space was pushing the camera back and shrinking the bins for no
   * return: framing dosing from its own floor brings the camera from 72.7 m to
   * 55.7 m and takes the bins from 34.5% of the frame width to 46.2%.
   *
   * `Math.max(0, ...)` makes this a no-op for the three ground-level zones, so
   * one constant covers both cases without a special case.
   */
  const groundY =
    floorMargin === undefined ? 0 : Math.max(0, Math.min(...ps.map((p) => p.floor)) - floorMargin);
  return {
    min: [
      Math.min(...ps.map((p) => p.x - r(p))),
      groundY,
      Math.min(...ps.map((p) => p.z - r(p))),
    ],
    max: [
      Math.max(...ps.map((p) => p.x + r(p))),
      Math.max(...ps.map((p) => p.topY)) + pad,
      Math.max(...ps.map((p) => p.z + r(p))),
    ],
  };
}

/** What each zone occupies, so the camera can frame it rather than guess at it. */
export const ZONE_BOUNDS: Record<string, Bounds> = (() => {
  const out: Record<string, Bounds> = {};
  for (const a of ZONE_ANCHORS) {
    out[a.zone] = boundsOf(
      SILOS.filter((s) => s.group.zone === a.zone),
      a.zone === 'dosing' ? 3 : 6,
      /* 2 m below the deck — enough to keep the slab edge and the tops of the
         columns in shot for context, without the whole drop to the ground. */
      2,
    );
  }
  return out;
})();

/** Everything the plant occupies. */
/* Pad 0.5 rather than 2. Worth doing and not worth claiming: measured, it
   takes a 10 m silo from 60.1 px to 61.0 px, because the drawn bounds already
   fill 89.3% of the frame width and there is only 10.7% left to win. */
export const SITE_BOUNDS: Bounds = boundsOf(SILOS, 0.5);

/** Bounds as they appear on screen, with the vertical exaggeration applied. */
export function drawnBounds(b: Bounds): Bounds {
  return {
    min: [b.min[0], b.min[1] * VERTICAL_EXAGGERATION, b.min[2]],
    max: [b.max[0], b.max[1] * VERTICAL_EXAGGERATION, b.max[2]],
  };
}

export function shellColor(kind: ShellKind): string {
  return SHELL[kind];
}

/** Human-readable capacity: "1,600 t", "45 t", "300 kg". */
export function formatCapacity(kg: number): string {
  if (kg >= 1000) return `${(kg / 1000).toLocaleString('en-GB')} t`;
  return `${kg.toLocaleString('en-GB')} kg`;
}

/** Metres, to one decimal, for the derived-dimensions readout. */
export function m(v: number): string {
  return `${v.toFixed(1)} m`;
}
