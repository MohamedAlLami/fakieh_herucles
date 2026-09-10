/**
 * Fakieh Feed Factory (Old), Jeddah — site model for the 3D plant view.
 *
 * Every dimension here is in METRES, in a plant-local coordinate system:
 *
 *    +X  runs along the plant's long axis, north-west -> south-east
 *        (raw material at -X, finished feed at +X — i.e. X follows the material)
 *    +Z  runs across the plant, towards the truck yard
 *    +Y  is up
 *
 * The site sits on a diagonal in reality. The scene is authored and RENDERED
 * plant-aligned — nothing rotates it — because a view lined up with the process
 * reads far better than a north-up one. SITE_BEARING_DEG exists so that
 * `localToEastNorth` and `latLonToLocal` can put these metres back on the map,
 * which is how the footprints were checked against aerial imagery in the first
 * place. It is a survey tool, not a scene transform.
 *
 * Footprints were traced from georeferenced aerial imagery (Esri World Imagery
 * and Bing Aerial, both at 0.278 m/px, stitched and overlaid with a 10 m grid),
 * so these are real metres rather than eyeballed proportions. They are still
 * TRACED, not surveyed — treat them as accurate to a few metres, not centimetres.
 */

/** Plant marker, from the Google Maps place entry for the site. */
export const SITE_ORIGIN = { lat: 21.4347372, lon: 39.2231524 } as const;

/**
 * Bearing of the plant's long axis, degrees clockwise from geographic north.
 * Measured off the aerial: the spine runs roughly ESE.
 */
export const SITE_BEARING_DEG = 130;

/** Metres per degree at this latitude, for placing anything given as lat/lon. */
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos((SITE_ORIGIN.lat * Math.PI) / 180);

/*
 * Plant frame <-> geographic frame.
 *
 * Bearing is measured clockwise from north, so the unit vector along +X is
 * (sin B, cos B) in (east, north) — note the NEGATIVE north component for a
 * south-easterly bearing. +Z is 90 degrees clockwise from +X.
 *
 *     +X -> east sin(B),      north cos(B)
 *     +Z -> east sin(B+90),   north cos(B+90)
 */
const B = (SITE_BEARING_DEG * Math.PI) / 180;
const AXIS_X: readonly [number, number] = [Math.sin(B), Math.cos(B)];
const AXIS_Z: readonly [number, number] = [Math.sin(B + Math.PI / 2), Math.cos(B + Math.PI / 2)];

/** Plant-local metres -> metres east/north of the site origin. */
export function localToEastNorth(x: number, z: number): [number, number] {
  return [x * AXIS_X[0] + z * AXIS_Z[0], x * AXIS_X[1] + z * AXIS_Z[1]];
}

/** Convert a lat/lon to plant-local metres. Inverse of localToEastNorth. */
export function latLonToLocal(lat: number, lon: number): [number, number] {
  const east = (lon - SITE_ORIGIN.lon) * M_PER_DEG_LON;
  const north = (lat - SITE_ORIGIN.lat) * M_PER_DEG_LAT;
  // The axis pair is orthonormal, so the inverse is the transpose: project the
  // geographic offset onto each plant axis.
  return [east * AXIS_X[0] + north * AXIS_X[1], east * AXIS_Z[0] + north * AXIS_Z[1]];
}

/** A rectangular volume on the site, positioned by its centre. */
export interface SiteBuilding {
  id: string;
  label: string;
  /** centre of the footprint, plant-local metres */
  x: number;
  z: number;
  /** footprint size along X and Z, metres */
  length: number;
  width: number;
  /** eaves height, metres */
  height: number;
  /** additional ridge height for a pitched roof; 0 = flat */
  roofRise?: number;
  /** which silo zone this building encloses, if any */
  zone?: ZoneId;
  /** hint for the shell material */
  kind: 'store' | 'process' | 'office' | 'shed';
}

export type ZoneId = 'outside' | 'raw' | 'dosing' | 'buffer' | 'finished';

export interface Zone {
  id: ZoneId;
  label: string;
  short: string;
  description: string;
  /** which silo series live in this zone */
  series: number[];
  /**
   * Direction the camera sits in, relative to what it is looking at.
   *
   * A direction rather than a position: the distance is computed at runtime from
   * the zone's real bounding box and the live aspect ratio, so a zone is framed
   * correctly on a 1280x720 laptop and on a 4K monitor without anyone tuning a
   * number per screen. Normalised on use.
   */
  dir: [number, number, number];
}

/**
 * The five working areas, in material-flow order.
 *
 * The view is zoned because capacity spans 1600 t down to 100 kg - a 16,000:1
 * range that cannot share one true scale in a single frame. Each zone gets its
 * own framing, so a micro hopper is seen from ten metres and a bulk silo from a
 * hundred.
 *
 * Framing alone was not enough, and this comment used to claim otherwise.
 * Every bin on the site — indoor and outdoor alike — is drawn on a
 * capacity-keyed compressed size scale, and every height is stretched — see
 * SIZE_COMPRESSION and VERTICAL_EXAGGERATION in `silos.ts`, both disclosed in
 * the UI. Only the plant's single largest capacity (the 1,600 t 100 and 200
 * series) is drawn at true size; every smaller group is drawn
 * bigger than life like every other group.
 */
export const ZONES: Zone[] = [
  {
    id: 'outside',
    label: 'Outside Yard',
    short: 'Yard',
    description: 'Bulk raw material and flat storage, all outside the plant building',
    series: [100, 200],
    /* Swung toward +X now that the 100 and 200 banks run ACROSS the flow.
       Aimed down the columns they read as a receding line and everything past
       the third bin is small; from here the two columns present broadside.
       Checked against the day sun: 69 degrees off the view axis with a
       positive dot, so it stays behind the camera and off to one side — the
       rule that keeps one flank lit and the other falling away. */
    dir: [0.62, 0.44, 0.65],
  },
  {
    id: 'raw',
    label: 'Raw Material',
    short: 'Raw',
    description: 'The raw material battery feeding the mill',
    series: [300],
    dir: [0.26, 0.46, 0.85],
  },
  {
    id: 'dosing',
    label: 'Minerals & Micro',
    short: 'Dosing',
    description: 'Mineral bins and micro-ingredient hoppers on the dosing floor',
    series: [400, 900],
    dir: [0.16, 0.44, 0.88],
  },
  {
    id: 'buffer',
    label: 'Press Buffer',
    short: 'Buffer',
    description: 'Buffer bins between raw material and the press',
    series: [600],
    dir: [0.20, 0.44, 0.87],
  },
  {
    id: 'finished',
    label: 'Finished Feed',
    short: 'Finished',
    description: 'Finished feed bins feeding packing and bulk outloading',
    series: [800],
    dir: [0.16, 0.46, 0.87],
  },
];

/**
 * Framing for the "Whole site" view.
 *
 * A little higher than the zone views so the layout reads, but not so high that
 * it becomes a floor plan — from directly above, a 30 m silo and a 15 m one look
 * identical, and the height of the bins is half of what makes this worth
 * rendering in 3D at all.
 */
export const SITE_VIEW = {
  /*
   * Broadside, with enough turn to give the bank some depth.
   *
   * The plant is 280 m long and 70 m deep, so its length maps almost entirely
   * onto the width of the frame — broadside is the efficient view here. Turning
   * fully down the spine was tried and is worse: the bounding box's diagonal
   * then drives the fit and pushes the camera far enough back that the plant
   * becomes a model on a table.
   *
   * This comment used to say the canvas was "close to 3:1". It is not, and the
   * number was repeated into several later decisions before anyone measured it:
   * the real canvas is 1284 x 830 at the reference window, an aspect of 1.55.
   *
   * It also used to say vertical was the binding constraint. That was true when
   * it was written and is no longer: the drawn site bounds now fill 89.3% of the
   * frame WIDTH and only 48.1% of its height, so width binds. That is why the
   * top and bottom reservations, and the pad on the bounds, buy so little — the
   * axis they act on is not the one that is full.
   *
   * The consequence is worth stating plainly, because it ends a long argument.
   * A sweep of every lever the camera fit exposes — pad, insets, field of view —
   * moves a 10 m silo from 60.1 px to at best 61.0 px. **No camera setting can
   * make a bin readable in this view.** A 10 m silo is a twenty-eighth of the
   * drawn span and a 2.4 m bin is a hundred-and-fifteenth; that is the plant's
   * own proportions, not a tuning gap. This view is a locator map, and the page
   * opens on a zone instead.
   */
  dir: [0.36, 0.34, 0.87] as [number, number, number],
};

export const SITE = {
  /** ground plane drawn beyond the compound */
  ground: { length: 340, width: 190 },
  /** the open truck yard, south-west of the process spine */
  yard: { x: 14, z: 48, length: 148, width: 52 },
  /**
   * Perimeter LINE. Approximate: the compound edge is clear enough on the
   * aerial to place, not to measure. It is here because without a boundary
   * the plant reads as a handful of objects on an infinite plane rather than
   * as a site.
   *
   * `height`/`thickness` are inherited from the stage-1 slab wall and are no
   * longer drawn as a slab (workstream 4.E.3 replaces that with the fence
   * below) — kept so nothing that still reads them breaks, and because they
   * still describe a plausible compound boundary if a wall is ever wanted
   * again. `x`/`z`/`length`/`width` are the number this file promises not to
   * move: they are the fence LINE now.
   */
  /* z 26/168 -> 20/178 (2026-09-02): the widened 100 bank's far row now
     reaches z -67; the fence line moves north so it stays inside. */
  wall: { x: -10, z: 20, length: 320, width: 178, height: 3, thickness: 0.6 },
  /**
   * The perimeter fence (workstream 4.E.3, `structures.tsx`'s `<Perimeter>`).
   * Runs along the exact same rectangle as `wall` above — posts every
   * `postPitch` metres around the perimeter, `height` metres tall, plus a
   * translucent panel strip `panelHeight` metres tall at `panelAlpha` opacity.
   * Reads as a compound boundary without the stage-1 slab's "walled fortress"
   * silhouette.
   */
  fence: {
    postPitch: 4,
    height: 2.2,
    postSize: 0.1,
    panelHeight: 2,
    panelAlpha: 0.08,
  },
} as const;

/**
 * Road kerb geometry (workstream 4.E.2). A kerb strip runs along both sides
 * of every entry in `ROADS`, `offset` metres outside that road's own paved
 * half-width — additive only, `ROADS` itself is untouched.
 */
export const KERB = {
  width: 0.3,
  height: 0.15,
  offset: 0.15,
} as const;

/**
 * Building envelope detail (workstream 4.E.4): cladding stripe pitch,
 * parapet, roof vents, roller door. Additive — no `BUILDINGS` entry's
 * position, footprint or height changes here; this only adds the numbers
 * `structures.tsx`'s `<Buildings>` needs to dress the same boxes.
 */
export const BUILDING_DETAIL = {
  /** height of the parapet box wrapping the eaves */
  parapetHeight: 0.6,
  parapetThickness: 0.25,
  /** the box along the roof ridge */
  ridgeCapSize: 0.25,
  ventSize: 0.8,
  ventsPerBuilding: 4,
  rollerDoorWidth: 4,
  rollerDoorHeight: 5,
  /** metres between cladding ribs, sampled off world X — see structures.tsx */
  claddingStripePitch: 0.9,
  /** +/- luminance swing of the rib band, as a fraction of 1.0 */
  claddingStripeLuminance: 0.06,
} as const;

/**
 * Gallery truss member sizing (workstream 4.E.6). `GALLERIES` itself is
 * untouched — every `from`/`to`/`y`/`width` stays exactly as traced.
 */
export const TRUSS = {
  /** cross-section of every chord, vertical and diagonal box */
  memberSize: 0.2,
  /** spacing between vertical members along the span */
  verticalSpacing: 3,
  deckThickness: 0.05,
} as const;

/**
 * Building shells.
 *
 * Only the process spine is a building. The 100 and 200 series are outdoor
 * storage and are drawn as what they are - free-standing vessels on open ground -
 * rather than hidden under a shed. The two placeholder shells that stood over
 * them in stage 1 were traced from roof outlines before the silo counts and
 * capacities were known; 15 silos of 1600 t cannot fit under a 50 x 38 m roof at
 * any plausible height, so those shells were the guess and the silos are the fact.
 *
 * Shells render ghosted on demand, which is the honest way to show that most of
 * these bins are indoors.
 */
/*
 * The process spine is about twice as deep as it was drawn.
 *
 * Section 8d of the design plan carried this as an open question for three
 * stages: the four process buildings looked like one continuous structure
 * sitting well further from the yard than modelled, but the analysis could not
 * separate "the site has a kink in it" from "the building is much wider", so
 * nothing was adopted. A wrong fact is worse than an admitted gap.
 *
 * It has now been measured rather than eyeballed. The aerial's burned-in grid
 * resolves to exactly 72 px per 10 m cell and the origin cross-hair sits at
 * pixel (1872.5, 1871.5), which calibrates the image against this file's own
 * axis maths. Sampling roof colour at five positions along the spine — x = -15,
 * 15, 40, 69 and 107.6 — the uniform roof tone that begins at the modelled
 * NORTH wall runs unbroken to z ≈ +38 to +40, where the model stopped at +7 to
 * +13. The north wall itself lands within 3 m of where it was already drawn,
 * which is what cross-validates the calibration.
 *
 * That resolves the question in favour of ONE WIDER BUILDING. A kink would show
 * as a break in the roof's tone partway across; there is no break at any of the
 * five sample points.
 *
 * Confidence is about ±5 m — traced, not surveyed — and the widths below are
 * rounded accordingly. NO SILO MOVES: this is the shell drawn around them, and
 * the client has confirmed the bin positions are right.
 */
export const BUILDINGS: SiteBuilding[] = [
  {
    id: 'mill-a',
    label: 'Mill building — raw material',
    /* 2026-09-02: grown WEST from 55 to 61.5 m (x -46..15.5) to hold the
       widened 300 battery on the client's instruction. Past the aerial's
       ±5 m tolerance by ~1.5 m; the east wall stays at the dosing floor. */
    x: -15.25,
    z: 9,
    length: 61.5,
    width: 60,
    height: 26,
    roofRise: 2,
    zone: 'raw',
    kind: 'process',
  },
  {
    id: 'mill-b',
    label: 'Mill building — dosing',
    /* 2026-09-02: x 16..60 (was 13.85..58.35) — shifted east to stay
       contiguous with the grown mill-a; the dosing floor moved with it. */
    x: 38,
    z: 9,
    length: 44,
    width: 58,
    height: 24,
    roofRise: 2,
    zone: 'dosing',
    kind: 'process',
  },
  {
    id: 'press-house',
    label: 'Press house',
    /* 2026-09-02: x 60.5..78.5 (was 58.2..80.2) — 4 m shorter so the
       finished store could grow west around the widened 800 bins. */
    x: 69.5,
    z: 11,
    length: 18,
    width: 56,
    height: 24.5,
    roofRise: 2,
    zone: 'buffer',
    kind: 'process',
  },
  {
    id: 'finished-store',
    label: 'Finished feed store',
    /* 2026-09-02: x 79..138 (was 79.85..135.35), grown east for the
       widened 800 series; the west wall is pinned by the press house. */
    x: 108.5,
    z: 12,
    length: 59,
    width: 64,
    height: 22.5,
    roofRise: 3,
    zone: 'finished',
    kind: 'store',
  },
  {
    /*
     * 2026-09-02, from the calibrated overlay (7.2 px/m, origin (1872.5, 1871.5)
     * on site_esri_z19_site_grid10m.png): a single ridged-roof warehouse about
     * 290 m long runs along the whole south-west side of the truck yard, inside
     * this compound's fence line, from beyond the bulk bank to past the finished
     * store. The 34 x 12 m "Offices" box that stood here was a guess drawn on
     * top of it. Whether it is the plant's own bagged-feed store or a
     * neighbour's is not known; it is drawn because it is there, unzoned, and
     * never ghosted.
     */
    id: 'south-warehouse',
    label: 'Warehouse along the yard',
    x: 10,
    z: 90,
    length: 290,
    width: 26,
    height: 9,
    roofRise: 2,
    kind: 'store',
  },
];

/**
 * Yard lighting masts.
 *
 * Positions are plausible rather than surveyed — a working plant this size is
 * lit, and without lights the night view is a black rectangle. They exist for
 * the look and are not presented as plant data.
 */
export const LIGHT_MASTS: { x: number; z: number; height: number }[] = [
  { x: -132, z: 14, height: 20 },
  { x: -66, z: 16, height: 20 },
  { x: 2, z: 20, height: 18 },
  { x: 66, z: 18, height: 18 },
  { x: 118, z: 16, height: 18 },
  { x: -104, z: -34, height: 20 },
  { x: 8, z: -30, height: 18 },
  { x: 104, z: -28, height: 18 },
];

/**
 * Elevated conveyor galleries.
 *
 * Clearly visible on the satellite imagery as a raised diagonal structure on
 * truss supports running from the outdoor storage shed to the main building, and
 * previously missing from the model entirely. It is also the thing that makes
 * the plant read as a plant rather than as a row of unrelated sheds: the bins
 * exist to feed each other, and the galleries are how.
 *
 * The run from the outdoor bank is traced. The short links along the process
 * spine are inferred from the process, not from imagery — bins on a line have to
 * be connected somehow — and are drawn thinner to say so.
 */
export interface Gallery {
  /** both ends, plant-local metres */
  from: [number, number];
  to: [number, number];
  /** height of the underside of the deck */
  y: number;
  width: number;
  /** true where imagery shows it, false where the process implies it */
  observed: boolean;
}

export const GALLERIES: Gallery[] = [
  /* outdoor bank -> mill. The one that is actually visible from above. */
  { from: [-56, -12], to: [-46, -8], y: 26, width: 3.2, observed: true },
  /* along the spine, bay to bay */
  { from: [10, -8], to: [16, -10], y: 21, width: 2.2, observed: false },
  { from: [56, -10], to: [60, -9], y: 19, width: 2.2, observed: false },
  { from: [80, -8], to: [86, -6], y: 18, width: 2.2, observed: false },
];

/** Simple road strips, drawn as flat quads on the ground. */
/* Re-placed 2026-09-02 against the calibrated overlay: the south street runs
   beyond the long warehouse (z ~112-128), the west street just outside the
   fence (x ~-186..-170). Both were inside the compound before. */
export const ROADS = [
  { x: 0, z: 120, length: 380, width: 16 },
  { x: -178, z: 20, length: 16, width: 220 },
] as const;

/**
 * Outside-world dressing (client request 2026-09-02: "play with the outside
 * world a bit… look at the satellite images and see what we can add, to make
 * the world filled but not take from the GPU").
 *
 * `siteDressing.tsx` reads all of the below. Every entry here comes from
 * READING the aerial imagery, not from a survey — same standing as
 * `LIGHT_MASTS` ("plausible rather than surveyed") and `GALLERIES`' inferred
 * links, one step further removed again: these are the plant's NEIGHBOURS,
 * imagery the client was never asked to ground-truth for us. Treat every
 * number below as "traced by eye from `esri_wide_800m.png` /
 * `model_overlay_v2.png` / `site_esri_z19_site_grid10m.png`, accurate to
 * roughly a building-width, not a metre" — good enough to fill the world in
 * believably, never presented as plant data. This whole file's worth of
 * numbers must stay OUTSIDE `SITE.wall` (the plant's own fence) and outside
 * every `BUILDINGS` footprint; `scripts/verify-structures.mjs` enforces both
 * against `siteDressing.tsx`'s expanded instances, not just these specs.
 */

/** One neighbouring warehouse block, traced from the aerial's roof outlines. */
export interface NeighbourBuilding {
  id: string;
  /** footprint centre, plant-local metres */
  x: number;
  z: number;
  /** footprint size along X and Z, metres */
  length: number;
  width: number;
  /** eaves height, metres */
  height: number;
  roof: 'flat' | 'ridged';
}

/**
 * ~14 neighbouring warehouse footprints. The aerial shows this as a dense
 * industrial estate on a rectangular street grid whose blocks run PARALLEL
 * to the plant's own axes (that alignment is exactly why the plant-local
 * frame reads so well against the imagery) — so every footprint below is
 * axis-aligned, no rotation needed. Covers: the long ridged-roof warehouse
 * directly south of the yard (`neighbour-south-long`), the blocks across the
 * street to the north-west and north-east of the compound, and further
 * blocks west, east and south so the estate reads as continuous rather than
 * an island.
 */
export const NEIGHBOURS: NeighbourBuilding[] = [
  { id: 'neighbour-nw-1', x: -70, z: -105, length: 90, width: 40, height: 10, roof: 'flat' },
  { id: 'neighbour-ne-1', x: 55, z: -100, length: 80, width: 38, height: 11, roof: 'ridged' },
  { id: 'neighbour-ne-2', x: 140, z: -95, length: 60, width: 32, height: 9, roof: 'flat' },
  { id: 'neighbour-west-1', x: -235, z: -30, length: 90, width: 42, height: 10, roof: 'flat' },
  { id: 'neighbour-west-2', x: -235, z: 40, length: 100, width: 40, height: 9, roof: 'ridged' },
  { id: 'neighbour-west-3', x: -238, z: 100, length: 70, width: 35, height: 8, roof: 'flat' },
  { id: 'neighbour-south-1', x: 0, z: 150, length: 80, width: 34, height: 10, roof: 'ridged' },
  { id: 'neighbour-south-2', x: -95, z: 155, length: 70, width: 36, height: 9, roof: 'flat' },
  { id: 'neighbour-south-3', x: 105, z: 155, length: 65, width: 34, height: 10, roof: 'flat' },
  { id: 'neighbour-east-1', x: 210, z: 0, length: 75, width: 38, height: 9, roof: 'flat' },
  { id: 'neighbour-east-2', x: 215, z: 70, length: 70, width: 36, height: 10, roof: 'ridged' },
  { id: 'neighbour-far-ne', x: 205, z: -145, length: 55, width: 30, height: 8, roof: 'flat' },
  { id: 'neighbour-far-nw', x: -255, z: -95, length: 50, width: 30, height: 9, roof: 'flat' },
];

/** One estate street, drawn as flat instanced slabs + kerb strips (never the
 *  ground shader's own `ROADS` — see `siteDressing.tsx`'s header). */
export interface Street {
  id: string;
  /** centre, plant-local metres */
  x: number;
  z: number;
  /** length along its own `axis`, and width across it, metres */
  length: number;
  width: number;
  /** which plant-local axis the street's long dimension runs along */
  axis: 'x' | 'z';
}

/**
 * The two streets that box the compound in (north, running the long way
 * like `ROADS[0]`; west, like `ROADS[1]`) plus two more that close the
 * estate's grid around the plant on its other two sides, matching the
 * rectangular block pattern visible on the aerial.
 */
export const STREETS: Street[] = [
  /* The north-east street measured at z ~-93 on the calibrated overlay; the
     south and west streets are ROADS (ground shader + kerbs), not drawn here. */
  { id: 'street-north', x: 0, z: -92, length: 380, width: 16, axis: 'x' },
  { id: 'street-east', x: 190, z: 20, length: 220, width: 14, axis: 'z' },
];

/** A row of trees along one street edge — the builder walks `from` -> `to`
 *  at `spacing` and drops one X-billboard tree at every step. */
export interface TreeLine {
  from: [number, number];
  to: [number, number];
  spacing: number;
}

/** One line per street, on the side away from the compound (the only side
 *  with clearance between the fence and the paved slab). ~76 trees total. */
export const TREE_LINES: TreeLine[] = [
  { from: [-100, -103], to: [100, -103], spacing: 10 },
  { from: [-100, 131], to: [100, 131], spacing: 10 },
  { from: [-190, -40], to: [-190, 120], spacing: 10 },
  { from: [196, -40], to: [196, 120], spacing: 10 },
];

/** A row of parked vehicles — the builder walks `from` -> `to` at `spacing`,
 *  each vehicle facing along the row. STATIC: no motion, per the client's
 *  "purposeful motion only" rule (`PRODUCT.md`). */
export interface VehicleRow {
  from: [number, number];
  to: [number, number];
  kind: 'truck' | 'car';
  spacing: number;
}

/**
 * Trucks along the plant's east side (between the fence and `street-east`,
 * matching the aerial) and cars along three of the estate streets.
 * ~9 trucks, ~34 cars.
 */
export const PARKED_VEHICLES: VehicleRow[] = [
  { from: [165, -20], to: [165, 95], kind: 'truck', spacing: 14 },
  { from: [-140, -85], to: [10, -85], kind: 'car', spacing: 11 },
  { from: [-183, -25], to: [-183, 85], kind: 'car', spacing: 11 },
  { from: [183, -15], to: [183, 85], kind: 'car', spacing: 12 },
];

/** One low sand/aggregate cone, from the light-toned dirt lot on the
 *  aerial's north-east edge. */
export interface Stockpile {
  x: number;
  z: number;
  diameter: number;
  height: number;
}

/* Moved 2026-09-02: the calibrated overlay puts the brown aggregate lot
   NORTH-WEST of the plant across the north street (x -205..-135,
   z -125..-85), where a neighbour block had been drawn by eye. */
export const STOCKPILES: Stockpile[] = [
  { x: -195, z: -112, diameter: 16, height: 3 },
  { x: -172, z: -98, diameter: 18, height: 3 },
  { x: -150, z: -115, diameter: 14, height: 3 },
  { x: -185, z: -88, diameter: 12, height: 2.5 },
];

/**
 * A container/truck depot's bays, from the rows of orange containers
 * south-east of the compound. `rows` x `perRow` boxes, laid end to end along
 * `+X` (spacing `itemSpacing`) with each row offset `rowSpacing` along Z from
 * `(originX, originZ)`.
 */
export interface ContainerRowSpec {
  id: string;
  originX: number;
  originZ: number;
  rows: number;
  perRow: number;
  rowSpacing: number;
  itemSpacing: number;
}

export const CONTAINER_ROWS: ContainerRowSpec[] = [
  { id: 'container-depot', originX: 162, originZ: 100, rows: 3, perRow: 8, rowSpacing: 4, itemSpacing: 13 },
];

/** One tank in the liquid-tank farm south-west of the compound (round white
 *  tanks visible on the aerial near the raw-material end). */
export interface DressingTank {
  x: number;
  z: number;
  diameter: number;
  height: number;
}

/* Re-placed 2026-09-02 against the calibrated overlay: the white tanks sit
   south-west of the long warehouse beyond the south street, centred near
   (-96, 204), with a smaller cluster near (30, 172). The first placement was
   ~80 m west of them, on a street. */
export const TANK_FARM: DressingTank[] = [
  { x: -112, z: 199, diameter: 8, height: 6 },
  { x: -101, z: 199, diameter: 8, height: 6 },
  { x: -90, z: 199, diameter: 8, height: 6 },
  { x: -79, z: 199, diameter: 8, height: 6 },
  { x: -112, z: 210, diameter: 8, height: 6 },
  { x: -101, z: 210, diameter: 8, height: 6 },
  { x: -90, z: 210, diameter: 8, height: 6 },
  { x: -79, z: 210, diameter: 8, height: 6 },
  { x: 22, z: 172, diameter: 7, height: 5 },
  { x: 31, z: 172, diameter: 7, height: 5 },
  { x: 40, z: 172, diameter: 7, height: 5 },
];
