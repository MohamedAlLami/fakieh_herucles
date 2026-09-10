/**
 * Live silo readings for the 3D plant view.
 *
 * WHY THIS DOES NOT USE `SiloContext`
 * -----------------------------------
 * `contexts/SiloContext.tsx` filters its results to `dbNo` 1, 2 and 3. Against
 * the live API that drops 65 of the plant's 131 bins — the ones the backend
 * returns with `dbNo` 0. Which series those are is a property of the data, not
 * of the series numbering, so it is not worth naming here; what matters is that
 * half the plant goes missing. That is correct for the Storage screen the
 * context was written for and wrong for a view of the whole plant, so this
 * fetches `/api/silos` directly and keeps every row.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SILO_BY_NO, heightFractionForVolume, type SiloPlacement } from './silos';
import { rosterName, rosterSlot } from './materials';

/** One row of `GET /api/silos`, exactly as the backend serialises it. */
export interface SiloReading {
  siloNo: number;
  dbNo: number;
  binName: string | null;
  materialCode: string | null;
  materialName: string | null;
  quantityKg: number | null;
  hlActive: boolean;
  lockActive: boolean;
  updatedAt: string | null;
}

export interface SiloReadings {
  byNo: Map<number, SiloReading>;
  rows: SiloReading[];
  /** material code -> colour, derived from the rows actually present */
  palette: MaterialPalette;
  isLoading: boolean;
  /** the fetch failed — the view must say so rather than show stale zeros */
  error: Error | null;
  /** when this browser last received a response */
  fetchedAt: Date | null;
  /**
   * The newest `updatedAt` across all rows — when the PLANT last wrote a value.
   *
   * This, not the fetch time, is what "live" means here. A request that
   * succeeded a second ago can still be returning numbers the plant last touched
   * days earlier, and a screen that calls that "live" because the HTTP call was
   * quick is telling an operator something untrue about their stock.
   */
  plantWroteAt: Date | null;
  refetch: () => void;
}

/** Poll interval. The plant's own poll worker runs on a similar cadence. */
const POLL_MS = 15_000;

export function useSiloReadings(enabled = true): SiloReadings {
  const q = useQuery<SiloReading[]>({
    queryKey: ['/api/silos'],
    refetchInterval: enabled ? POLL_MS : false,
    refetchOnWindowFocus: true,
    staleTime: 0,
    enabled,
    retry: 1,
  });

  const rows = useMemo(() => q.data ?? [], [q.data]);

  /*
   * Memoised together, because every consumer of `byNo` keys a memo on it. A
   * fresh Map on each render made the scene rewrite all 131 instance colours,
   * fills and surface matrices on every pointer move.
   */
  const { byNo, newest, palette } = useMemo(() => {
    /*
     * Only METERED bins count toward "when did the plant last write".
     *
     * This scanned every row, including the 400-series — the one series this
     * file spends a paragraph explaining is never a real reading, because the
     * PLC has no quantity tag for it. Something upstream stamps those rows with
     * a current timestamp anyway. So the freshness dot was being held up, in
     * part, by bins whose numbers the app refuses to draw.
     *
     * Today that merely understates how stale the plant is. The failure it sets
     * up is the worst one available on this screen: if the real feed stops while
     * whatever touches the untagged rows keeps ticking, the dot goes green and
     * the view says it is live over a plant that is entirely stale.
     */
    let latest = 0;
    for (const r of rows) {
      if (!r.updatedAt) continue;
      if (!SILO_BY_NO.get(r.siloNo)?.group.metered) continue;
      const t = Date.parse(r.updatedAt);
      if (Number.isFinite(t) && t > latest) latest = t;
    }
    return {
      byNo: new Map(rows.map((r) => [r.siloNo, r])),
      newest: latest,
      palette: buildMaterialPalette(rows.map((r) => r.materialCode)),
    };
  }, [rows]);

  return {
    rows,
    byNo,
    palette,
    isLoading: q.isLoading,
    error: (q.error as Error) ?? null,
    fetchedAt: q.dataUpdatedAt ? new Date(q.dataUpdatedAt) : null,
    plantWroteAt: newest ? new Date(newest) : null,
    refetch: q.refetch,
  };
}

/* ------------------------------------------------------------------ */
/* Level                                                               */
/* ------------------------------------------------------------------ */

/** Why a bin has no level to draw. `null` reason means it does have one. */
export type NoLevelReason = 'no-tag' | 'no-reading';

export interface SiloLevel {
  /** height fraction 0..1 to shade, or null when nothing may be drawn */
  fill: number | null;
  /** capacity fraction, unclamped — can exceed 1 or go negative */
  fraction: number | null;
  /** the raw reported number, shown even when it is nonsense */
  quantityKg: number | null;
  reason: NoLevelReason | null;
  /** the reported value is outside 0..capacity */
  outOfRange: boolean;
}

/**
 * Resolve what may be drawn for one bin.
 *
 * The rules this enforces, none of which are negotiable:
 *
 *  - The 400-series has NO quantity tag in DB5 (`QTY_MAP_DB5` has no 401-408
 *    entry). The API still returns a `quantityKg` for those bins, but nothing
 *    ever writes it, so it is stale at best and a dosing figure at worst. It is
 *    never a level and must never be shaded.
 *  - Negative quantities are real on this plant (-152.78 and -477.31 have been
 *    seen on the SCADA). The shading clamps at zero; the number does not.
 *  - A quantity above capacity is shown as over-full rather than silently
 *    clipped to look normal.
 */
export function siloLevel(p: SiloPlacement, r: SiloReading | undefined): SiloLevel {
  const qty = r?.quantityKg ?? null;
  const base: SiloLevel = {
    fill: null,
    fraction: null,
    quantityKg: qty,
    reason: null,
    outOfRange: false,
  };

  if (!p.group.metered) return { ...base, reason: 'no-tag' };
  if (!r) return { ...base, reason: 'no-reading' };
  if (qty === null || !Number.isFinite(qty)) return { ...base, reason: 'no-reading' };

  const fraction = qty / p.group.capacityKg;
  return {
    fill: heightFractionForVolume(p.dims, fraction),
    fraction,
    quantityKg: qty,
    reason: null,
    outOfRange: fraction < 0 || fraction > 1,
  };
}

/* ------------------------------------------------------------------ */
/* Material colour                                                     */
/* ------------------------------------------------------------------ */

/**
 * Out of service, per the plant's own SCADA convention.
 * `999` in the material code field means the bin is out of service.
 */
export const OUT_OF_SERVICE = '999';

/** Empty or unrecognised material, again following the SCADA screens. */
function isBlankCode(code: string | null | undefined): boolean {
  /* String(), not just a null guard.
     `materialCode` is TYPED as string|null and the type is a promise the JSON
     cannot keep: one row arriving with a numeric code — entirely ordinary for a
     driver that does not cast an integer column — throws "trim is not a
     function" out of a render, and with no ErrorBoundary anywhere in this app
     the WHOLE page goes blank and stays blank through every later poll. A
     silent white screen from one malformed field is far worse than a wrong
     number, so every code that reaches a string method is coerced first. */
  const c = String(code ?? '').trim();
  return c === '' || c === '0' || c === '0000';
}

const UNKNOWN_COLOR = '#6b7280';
const OOS_COLOR = '#4b5563';

/**
 * Material colours.
 *
 * Searched rather than picked: candidates were generated on a CIELCh grid and
 * selected by greedy maximin on CIEDE2000, subject to staying clear of the cyan
 * selection accent, of alarm red, and of the four silo shell greys, and to
 * remaining legible on both a dark and a light card.
 *
 * Ordered so the best-separated subset comes first, because this plant runs six
 * or seven materials at a time and almost never fourteen. Measured on the first
 * seven: minimum separation 22.8 dE00 for normal vision, 13.2 under protanopia
 * and 12.7 under deuteranopia — a colour-blind operator can still tell them
 * apart, which a hue ramp would not have given.
 *
 * The gold at index 9 sits close to alarm amber, so it is deliberately held back
 * out of the first seven rather than dropped.
 */
const MATERIAL_PALETTE = [
  '#347914',
  '#ff78a6',
  '#0170a9',
  '#a55504',
  '#8d50b1',
  '#906265',
  '#2f756e',
  '#70af79',
  '#756c00',
  '#c68e28',
  '#c54588',
  '#5e67a0',
  '#617455',
  '#ba8aac',
];

function hashCode(c: string): number {
  /* FNV-1a with a murmur3 finalizer. Material codes are short, near-consecutive
     numeric strings (100, 105, 112, 113), and a plain h*31+ch hash maps those to
     adjacent slots; the avalanche step is what separates them. */
  let h = 2166136261;
  for (let i = 0; i < c.length; i += 1) {
    h ^= c.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/*
 * Which material has which colour.
 *
 * Codes are sorted and assigned from the front of the palette, so a plant
 * running six materials gets the six best-separated colours rather than six
 * drawn at random from all fourteen. A hash-to-slot scheme was tried first and
 * rejected: it scattered this plant's six materials across slots 3 to 13,
 * throwing away exactly the separation the palette was searched for.
 *
 * Sorting by code also makes the common change harmless. New materials at this
 * plant get higher codes, and appending a higher code leaves every existing
 * assignment untouched.
 *
 * This returns a value rather than mutating a module-level map. It used to do
 * the latter, from inside a `useMemo` during render — which React's rendering
 * contract does not permit: an abandoned or competing render could swap the
 * mapping out from under the committed scene, and the legend, the hover card and
 * the detail panel could then disagree about what colour maize is.
 */
export type MaterialPalette = ReadonlyMap<string, string>;

export function buildMaterialPalette(codes: readonly (string | null | undefined)[]): MaterialPalette {
  const unique = Array.from(
    new Set(
      codes
        .map((c) => String(c ?? '').trim())
        .filter((c) => !isBlankCode(c) && c !== OUT_OF_SERVICE),
    ),
  );
  unique.sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    /* Numeric where both are numbers, so 99 sorts before 100 rather than after. */
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  /*
   * Colour comes from the plant's fixed material roster, not from position
   * among whatever happens to be loaded right now.
   *
   * This assigned `paletteEntry(i)` by index into the sorted PRESENT codes, so
   * a material's colour depended on its neighbours. Load code 8 into any bin
   * and it sorts to the front, takes the first colour, and every other material
   * shifts one along — maize would be a different colour between one shift and
   * the next. The check that guards this only ever tested adding a HIGHER code,
   * which is the direction that happens to be safe.
   *
   * Anchoring to the roster makes the mapping stable for every code the plant
   * is known to use. Codes the roster has never heard of still get a colour,
   * appended after it in sorted order, so nothing ever renders uncoloured.
   */
  const out = new Map<string, string>();
  const taken = new Set<number>();
  for (const code of unique) {
    const slot = rosterSlot(code);
    if (slot !== null) taken.add(slot);
  }
  /*
   * A code the roster has never heard of takes the lowest slot the roster is
   * not using RIGHT NOW, rather than queueing after the whole roster.
   *
   * Starting strangers at ROSTER_SIZE was the obvious thing and it overflowed:
   * the roster reserves 38 slots whether or not those materials are loaded, so
   * a handful of unknown codes pushed past the palette's distinct capacity and
   * two materials came out the same colour. Widening the palette to cover it
   * would have meant lightness steps so fine that the check passed while the
   * colours were indistinguishable to a person — a check passing about a thing
   * that is still broken.
   *
   * The trade is explicit: a stranger's colour is NOT stable across sessions,
   * because it depends on which roster materials happen to be loaded. It cannot
   * be — the plant has never named it. Every material the plant HAS named keeps
   * its fixed slot, which is the property that actually matters.
   */
  let next = 0;
  for (const code of unique) {
    const slot = rosterSlot(code);
    if (slot !== null) {
      out.set(code, paletteEntry(slot));
      continue;
    }
    while (taken.has(next)) next += 1;
    taken.add(next);
    out.set(code, paletteEntry(next));
  }
  return out;
}

/**
 * The nth distinct colour.
 *
 * Past the end of the searched palette, entries repeat at a shifted lightness
 * rather than simply wrapping — a plain `i % 14` means the fifteenth material on
 * a screen is drawn in the same colour as the first, which is the one thing this
 * palette exists to prevent. Three tiers give 42 before anything repeats. The
 * shifted tiers are less separated than the searched fourteen, which is the
 * honest trade: this plant runs six or seven materials, and a 15th is an
 * exception worth handling without pretending it is as legible.
 */
/*
 * Lightness tiers past the searched base palette.
 *
 * Three tiers gave 42 distinct colours, which was exactly enough while slots
 * were handed out densely from zero. Anchoring colour to the plant's fixed
 * material roster spends slots more sparsely — the roster reserves 25 whether
 * or not those materials are loaded today — so the ceiling had to rise with it.
 * Five tiers give 70.
 *
 * The trade is honest and worth stating: the extra tiers sit at half the
 * lightness separation of the original two, so they are closer together than
 * anything the base palette was searched for. They are overflow — reached only
 * by materials the plant's own batch records have never mentioned — and a
 * slightly tighter colour for an unknown material is a better failure than a
 * repeated one, which would say two different materials are the same.
 */
const LIGHTNESS_TIERS = [0, -0.26, 0.26, -0.13, 0.13];

function paletteEntry(i: number): string {
  const n = MATERIAL_PALETTE.length;
  const base = MATERIAL_PALETTE[i % n];
  const shift = LIGHTNESS_TIERS[Math.floor(i / n) % LIGHTNESS_TIERS.length];
  return shift === 0 ? base : shiftLightness(base, shift);
}

/** Move a hex colour toward black or white by a fixed fraction. */
function shiftLightness(hex: string, amount: number): string {
  const v = parseInt(hex.slice(1), 16);
  const ch = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => {
    const shifted = amount < 0 ? c * (1 + amount) : c + (255 - c) * amount;
    return Math.max(0, Math.min(255, Math.round(shifted)));
  });
  return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** Resolves a material code to its colour against a given palette. */
export function materialColorIn(
  palette: MaterialPalette,
  code: string | null | undefined,
): string {
  if (isBlankCode(code)) return UNKNOWN_COLOR;
  const c = String(code).trim();
  if (c === OUT_OF_SERVICE) return OOS_COLOR;
  return (
    palette.get(c) ??
    /* Not in the palette: a code that arrived after it was built. The hash keeps
       it from flickering through several colours before the next rebuild. */
    MATERIAL_PALETTE[hashCode(c) % MATERIAL_PALETTE.length]
  );
}

export function materialLabel(r: SiloReading | undefined): string {
  if (!r) return 'No data';
  const code = String(r.materialCode ?? '').trim();
  if (code === OUT_OF_SERVICE) return 'Out of service';
  if (isBlankCode(code)) {
    /* "Empty" was wrong: a bin can report a real quantity with no material code
       against it, and calling that empty contradicts the level drawn beside it.
       What is missing is the assignment, not the contents. */
    return (r.quantityKg ?? 0) > 0 ? 'No material assigned' : 'Empty / unassigned';
  }
  /* The feed's own name first — it is generally the better one ("Yellow Maize"
     against the batch export's "Maize"). The plant's batch records are the
     fallback, so a coded bin never has to show a bare number at an operator. */
  return r.materialName?.trim() || rosterName(code) || `Code ${code}`;
}

/** Distinct materials present, for the legend. Sorted by bin count, descending. */
export function materialsPresent(
  rows: SiloReading[],
  palette: MaterialPalette,
): { code: string; name: string; color: string; count: number }[] {
  const seen = new Map<string, { code: string; name: string; color: string; count: number }>();
  for (const r of rows) {
    const code = String(r.materialCode ?? '').trim();
    if (isBlankCode(code)) continue;
    const key = code;
    const prev = seen.get(key);
    if (prev) prev.count += 1;
    else
      seen.set(key, {
        code,
        name: materialLabel(r),
        color: materialColorIn(palette, code),
        count: 1,
      });
  }
  return Array.from(seen.values()).sort((a, b) => b.count - a.count);
}

/** "12,000 kg", "-152.8 kg", "—" */
export function formatKg(kg: number | null): string {
  if (kg === null || !Number.isFinite(kg)) return '—';
  const abs = Math.abs(kg);
  const dp = abs > 0 && abs < 100 ? 1 : 0;
  return `${kg.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp })} kg`;
}

export function formatPercent(fraction: number | null): string {
  if (fraction === null || !Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(fraction < 0.1 && fraction > -0.1 ? 1 : 0)}%`;
}
