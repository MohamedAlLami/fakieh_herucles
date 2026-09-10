/**
 * The list pane beside the 3D stage — the "schedule" next to the model.
 *
 * First version (DESIGN.md, Phase 1 workstream A). Phase 4 (workstream F)
 * refines the row grammar, status-colour mode, the sort header and the
 * loading/error/empty states this file now carries.
 *
 * Sits inside `WaterSystemLayout`'s immersive stage, in the
 * `clamp(280px, 28%, 360px)` list pane on a wide viewport, or inside the
 * bottom sheet below 1100px container width (`Plant3D.tsx` decides which).
 * Either way this component does not know or care which — it always renders
 * the same KPI strip, finder and rows, sized to whatever height its parent
 * gives it.
 *
 * A plain, ungrouped `.map()` over up to 131 rows, deliberately not
 * virtualised: DESIGN.md allows "virtualised-or-cheap", and 131 simple flex
 * rows is comfortably cheap for React — no windowing dependency exists in
 * this package, and adding one for a bin count this small would be the kind
 * of mechanism this project's own history warns against building before it
 * is needed.
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Lock, RefreshCw, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SILOS, type SiloPlacement } from '@/lib/plant3d/silos';

/* Every bin in the model. Since the 500-series tanks were retired
   (2026-09-10) every group is monitored, so this and the KPI strip's
   denominator are the same number by construction. */
const TOTAL_BINS = SILOS.length;
import {
  OUT_OF_SERVICE,
  materialColorIn,
  materialLabel,
  formatPercent,
  siloLevel,
  type SiloReadings,
} from '@/lib/plant3d/siloData';
import {
  Chip,
  HATCH_PATTERN,
  MiniBar,
  SiloDetailPanel,
  STALE_AFTER_MS,
  STATUS_COLORS,
  ago,
  freshness,
  isStale,
  statusCategoryFor,
  type ColorMode,
  type PlantSummary,
} from './PlantHud';

export interface SiloListProps {
  /** the bins visible in the current zone — same set the scene draws, so the
      list and the model never disagree about what "this zone" means. */
  placements: SiloPlacement[];
  readings: SiloReadings;
  summary: PlantSummary;
  selected: number | null;
  hovered: number | null;
  onHover: (n: number | null) => void;
  /** jump to a bin by number — the existing `findSilo`: selects it, frames
      the camera on it, and returns false when no such bin exists. Used by
      both a row click and the finder's Enter/submit. */
  onFind: (siloNo: number) => boolean;
  onGoToAlarm: (which: 'high' | 'locked') => void;
  /** clears the selection — closes the expanded row. */
  onDeselect: () => void;
  /**
   * Whether a row's swatch and fill bar draw the material colour or the
   * fill-status colour (plan workstream F item 2). Optional and defaulted so
   * a caller mid-wiring this in still compiles against last week's contract.
   */
  colorMode?: ColorMode;
  /**
   * Draws this list's own copy of the KPI strip (bins/stored/alarms/
   * freshness) above the finder. Defaults to `false`: that strip moved out
   * to its own component, `KpiStrip.tsx`, which sits above the canvas+list
   * grid so it shows once rather than scrolling away with the rows — see
   * that file. Kept here, off by default rather than deleted, because the
   * narrow-viewport bottom sheet is a real DOM sibling of `KpiStrip`, not a
   * descendant of it (`Plant3D.tsx`'s sheet overlays the whole stage), so a
   * caller that wants the sheet to carry its own numbers when collapsed
   * still can without this file being rewritten a second time.
   */
  showKpi?: boolean;
}

/**
 * A one-line, right-aligned relative time for the row's own "updated"
 * column — "8 d", "19 h", "2 min", "45s" — never "8 days ago". The exported
 * `ago()` from PlantHud.tsx is the right format for a sentence (the KPI
 * strip's "plant wrote 2 min ago"), and the wrong one for a fixed-width
 * table column: at the laptop's own width that column measured too narrow
 * for "8 days ago" and the words wrapped onto a second line, which grew
 * every stale row taller than every fresh one and pushed the rest of the
 * list down with it.
 */
function agoShort(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}

/** A clock time as "HH:MM", for the error banner's "showing last data from
    HH:MM" — the absolute time belongs there, not a relative one, since the
    whole point of that line is that the relative time has stopped moving
    the operator can trust. */
function hhmm(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** 6px fill bar; material colour in material mode, status colour in status
    mode; a diagonal hatch on the empty track when the bin has no level to
    show at all (400 series, or no reading yet). Inline style rather
    than a Tailwind class: this app's `light:` set is a fixed, hand-written
    list (scripts/verify-plant3d.mjs scans for exactly that), and a one-off
    gradient or per-row hex has no business claiming a slot in it. */
function FillBar({ fill, color }: { fill: number | null; color: string }) {
  return (
    <span
      className="block h-1.5 w-full shrink-0 overflow-hidden rounded-sm bg-slate-800 light:bg-gray-200"
      style={fill === null ? { backgroundImage: HATCH_PATTERN } : undefined}
    >
      {fill !== null && fill > 0 && (
        <span
          className="block h-full rounded-sm"
          style={{ width: `${Math.max(1.5, Math.min(100, fill * 100))}%`, backgroundColor: color }}
        />
      )}
    </span>
  );
}

/** The row's own small colour key — a solid square in material mode, the
    same hatch `FillBar` uses when there is nothing to colour by. */
function Swatch({ color, hatched }: { color: string; hatched?: boolean }) {
  return (
    <span
      className="h-2.5 w-2.5 shrink-0 rounded-sm ring-1 ring-black/20"
      style={hatched ? { backgroundImage: HATCH_PATTERN } : { backgroundColor: color }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Sort header                                                         */
/* ------------------------------------------------------------------ */

type SortColumn = 'no' | 'material' | 'fill' | 'updated';
interface SortState {
  column: SortColumn;
  dir: 'asc' | 'desc';
}

const SORT_STORAGE_KEY = 'plant3d.sort.v1';
const DEFAULT_SORT: SortState = { column: 'no', dir: 'asc' };

function loadSort(): SortState {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw) return DEFAULT_SORT;
    const parsed = JSON.parse(raw) as Partial<SortState>;
    const columns: SortColumn[] = ['no', 'material', 'fill', 'updated'];
    if (
      parsed &&
      columns.includes(parsed.column as SortColumn) &&
      (parsed.dir === 'asc' || parsed.dir === 'desc')
    ) {
      return { column: parsed.column as SortColumn, dir: parsed.dir };
    }
  } catch {
    /* Storage unavailable or the saved value is not what this reads —
       either way the default sort is a perfectly good fallback. */
  }
  return DEFAULT_SORT;
}

/**
 * No · Material · Fill · Updated — click toggles ascending/descending on
 * that column. Alarms still pin first regardless of the column chosen (see
 * the `rows` memo below); this header is about the order WITHIN that, not a
 * way to see an alarmed bin sorted out of first place.
 *
 * Column widths and the `gap-2` container match the row below it exactly,
 * so a header label sits directly over the column it sorts.
 */
function SortHeader({ sort, onSort }: { sort: SortState; onSort: (column: SortColumn) => void }) {
  const button = (
    column: SortColumn,
    label: string,
    widthClass: string,
    align: 'left' | 'right',
    title?: string,
  ) => {
    const active = sort.column === column;
    return (
      <button
        type="button"
        onClick={() => onSort(column)}
        title={title}
        aria-label={title}
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={cn(
          'touch-target-44 flex shrink-0 items-center gap-0.5 whitespace-nowrap py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400',
          widthClass,
          align === 'right' && 'justify-end',
        )}
      >
        <span
          className={cn(
            'text-[10px] font-semibold uppercase tracking-wide',
            active
              ? 'text-slate-200 light:text-gray-800'
              : 'text-slate-500 light:text-gray-500',
          )}
        >
          {label}
        </span>
        {active &&
          (sort.dir === 'asc' ? (
            <ChevronUp className="h-2.5 w-2.5 shrink-0 text-slate-300 light:text-gray-600" />
          ) : (
            <ChevronDown className="h-2.5 w-2.5 shrink-0 text-slate-300 light:text-gray-600" />
          ))}
      </button>
    );
  };

  return (
    <div
      className="flex shrink-0 items-center gap-2 overflow-hidden border-b border-slate-800/60 px-3 light:border-gray-200"
      title="Alarmed bins are always listed first, whatever the sort"
    >
      {button('no', 'No', 'w-9', 'left')}
      <span className="w-2.5 shrink-0" aria-hidden="true" />
      {button('material', 'Material', 'min-w-0 flex-1', 'left')}
      {button('fill', 'Fill', 'w-[80px]', 'right')}
      {/*
        "Upd" rather than "Updated": the DATA column below this is a narrow
        32px ("8 d", "19 h"), and the full word at this row's own 10px/
        tracking-wide styling does not fit it — it overflowed past the "Fill"
        column and rendered the two labels on top of each other. Abbreviated
        here, spelled out in the title for anyone who taps or hovers it.
      */}
      {button('updated', 'Upd', 'w-8', 'right', 'Updated')}
      <span className="w-9 shrink-0" aria-hidden="true" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Loading skeleton                                                    */
/* ------------------------------------------------------------------ */

/** A moving highlight over placeholder shapes, not a spinner — a spinner
    claims indeterminate work is happening somewhere the operator cannot
    see, and this is a 15s poll whose shape is already known. `.plant3d-
    skeleton` (index.css) respects `prefers-reduced-motion` on its own. */
function SkeletonRow() {
  return (
    <div className="flex items-center gap-2 px-3 py-2" aria-hidden="true">
      <span className="plant3d-skeleton h-3 w-6 shrink-0 rounded" />
      <span className="plant3d-skeleton h-2.5 w-2.5 shrink-0 rounded-sm" />
      <span className="plant3d-skeleton h-3 min-w-0 flex-1 rounded" />
      <span className="plant3d-skeleton h-1.5 w-10 shrink-0 rounded-sm" />
      <span className="plant3d-skeleton h-3 w-8 shrink-0 rounded" />
    </div>
  );
}

function SiloListSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-slate-800 p-3 light:border-gray-200">
        <span className="plant3d-skeleton h-2.5 w-44 rounded" aria-hidden="true" />
        <div className="flex items-center gap-2" aria-hidden="true">
          <span className="plant3d-skeleton h-2.5 w-2.5 shrink-0 rounded-full" />
          <span className="plant3d-skeleton h-2.5 w-28 rounded" />
        </div>
        <div className="flex items-center gap-3" aria-hidden="true">
          <span className="plant3d-skeleton h-[22px] w-20 rounded" />
          <span className="plant3d-skeleton h-3 w-16 rounded" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {Array.from({ length: 8 }).map((_, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <SkeletonRow key={i} />
        ))}
      </div>
      <span className="sr-only" role="status">
        Loading silo data…
      </span>
    </div>
  );
}

export function SiloList({
  placements,
  readings,
  summary,
  selected,
  hovered,
  onHover,
  onFind,
  onGoToAlarm,
  onDeselect,
  colorMode = 'material',
  showKpi = false,
}: SiloListProps) {
  const [query, setQuery] = useState('');
  const [missing, setMissing] = useState(false);
  const [sort, setSort] = useState<SortState>(loadSort);

  useEffect(() => {
    try {
      localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort));
    } catch {
      /* Not durable this session — the sort still works, it just resets on
         the next visit. Not worth surfacing to the operator. */
    }
  }, [sort]);

  const onSort = (column: SortColumn) => {
    setSort((prev) =>
      prev.column === column ? { column, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { column, dir: 'asc' },
    );
  };

  const fresh = freshness(readings.plantWroteAt, readings.fetchedAt, readings.error);
  const notLive = fresh.tone === 'bg-red-500';
  const capacityFraction = summary.capacityKg ? (summary.tonnes * 1000) / summary.capacityKg : null;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const withInfo = placements.map((p) => {
      const reading = readings.byNo.get(p.siloNo);
      const level = siloLevel(p, reading);
      const material = materialLabel(reading);
      const materialColor = materialColorIn(readings.palette, reading?.materialCode);
      /* Same guard as Plant3D.tsx's own `known` calc: materialCode is typed
         string | null and the API sends numbers, so a bare `.trim()` on it
         is the exact crash that once blanked this whole page. */
      const code = String(reading?.materialCode ?? '').trim();
      const untagged = code === '' || code === OUT_OF_SERVICE;
      const stale = isStale(reading?.updatedAt);
      const displayMaterial = material;
      const alarmed = Boolean(reading?.hlActive || reading?.lockActive);
      const category = statusCategoryFor(level.fraction, alarmed);
      /* The colour actually drawn for this row's swatch and fill bar, given
         the current mode — computed once here rather than in render, since
         both the swatch and the bar need it. */
      const color =
        colorMode === 'status'
          ? (category ? STATUS_COLORS[category] : materialColor)
          : materialColor;
      const hatched = colorMode === 'status' && category === null;
      return {
        p,
        reading,
        level,
        material,
        displayMaterial,
        color,
        hatched,
        untagged,
        stale,
        alarmed,
      };
    });
    const filtered = q
      ? withInfo.filter(
          (r) => String(r.p.siloNo).startsWith(q) || r.displayMaterial.toLowerCase().includes(q),
        )
      : withInfo;

    const dir = sort.dir === 'asc' ? 1 : -1;
    const byColumn = [...filtered].sort((a, b) => {
      switch (sort.column) {
        case 'material':
          return dir * a.displayMaterial.localeCompare(b.displayMaterial);
        case 'fill': {
          const af = a.level.fraction ?? -1;
          const bf = b.level.fraction ?? -1;
          return dir * (af - bf);
        }
        case 'updated': {
          const at = a.reading?.updatedAt ? Date.parse(a.reading.updatedAt) : -1;
          const bt = b.reading?.updatedAt ? Date.parse(b.reading.updatedAt) : -1;
          return dir * (at - bt);
        }
        default:
          return dir * (a.p.siloNo - b.p.siloNo);
      }
    });

    /* Alarms always pinned first, whatever column is sorted — a stable
       partition of an already-sorted array, so the order WITHIN "alarmed"
       and WITHIN "not alarmed" still follows the chosen column. */
    const alarmedRows = byColumn.filter((r) => r.alarmed);
    const restRows = byColumn.filter((r) => !r.alarmed);
    const sorted = [...alarmedRows, ...restRows];

    /* The selected row stays pinned to the very top of the list while
       selected, regardless of alarm state or the sort column. */
    if (selected !== null) {
      const at = sorted.findIndex((r) => r.p.siloNo === selected);
      if (at > 0) {
        const [row] = sorted.splice(at, 1);
        sorted.unshift(row);
      }
    }
    return sorted;
  }, [placements, readings.byNo, readings.palette, query, selected, sort, colorMode]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    if (trimmed === '') return;
    const n = Number(trimmed);
    if (!Number.isInteger(n)) {
      /* Not a number — if the live filter above already narrowed it to one
         bin, Enter goes to that one rather than doing nothing. */
      if (rows.length === 1) {
        onFind(rows[0].p.siloNo);
        setMissing(false);
        setQuery('');
      }
      return;
    }
    if (!onFind(n)) {
      setMissing(true);
      return;
    }
    setMissing(false);
    setQuery('');
  };

  if (readings.isLoading) return <SiloListSkeleton />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ---- KPI strip --------------------------------------------------
        Off by default — see `showKpi` on `SiloListProps`. `KpiStrip.tsx`
        carries this same information above the canvas+list grid now. */}
      {showKpi && (
      <div className="flex shrink-0 flex-col gap-2 border-b border-slate-800 p-3 light:border-gray-200">
        {/*
          The list's own header line. Every bin in the model is monitored
          since the 500-series tanks were retired (2026-09-10), so this row
          and the "n/131" chip two rows down are now over the same 131 bins
          and cannot disagree.
        */}
        <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500 light:text-gray-500">
          {summary.bins} of {TOTAL_BINS} bins holding stock
        </p>
        {/* Freshness dot and the plant's own clock, on one line
            (DESIGN.md's KPI strip spec). */}
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'h-2.5 w-2.5 shrink-0 rounded-full',
              fresh.tone,
              readings.isLoading && 'animate-pulse',
            )}
            title={fresh.label}
            aria-hidden="true"
          />
          {readings.plantWroteAt ? (
            <time
              dateTime={readings.plantWroteAt.toISOString()}
              title={readings.plantWroteAt.toISOString()}
              className="truncate text-[11px] text-slate-400 light:text-gray-600"
            >
              plant wrote {ago((Date.now() - readings.plantWroteAt.getTime()) / 1000)}
            </time>
          ) : (
            <span className="truncate text-[11px] text-slate-500 light:text-gray-500">
              waiting for data
            </span>
          )}
        </div>

        {/*
          Persistent, not a chip that can scroll off. Two different lines
          for two different failures: a live fetch failure says so with the
          last good clock time and a way to try again; a merely STALE feed
          (>15 min, no fetch error) keeps the generic freshness sentence —
          there is nothing to retry, the plant itself has stopped writing.
        */}
        {readings.error ? (
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-[11px] font-semibold text-red-400 light:text-red-600" role="status">
              Live feed lost —{' '}
              {readings.plantWroteAt ? (
                <>
                  showing last data from{' '}
                  <time
                    dateTime={readings.plantWroteAt.toISOString()}
                    title={readings.plantWroteAt.toISOString()}
                  >
                    {hhmm(readings.plantWroteAt)}
                  </time>
                </>
              ) : (
                'no data received yet'
              )}
            </p>
            <button
              type="button"
              onClick={() => readings.refetch()}
              className="touch-target-44 shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            >
              <span className="inline-flex min-h-[24px] items-center gap-1 rounded-full bg-red-500/20 px-2 text-[11px] font-semibold text-red-300 light:bg-red-100 light:text-red-600">
                <RefreshCw className="h-3 w-3" />
                Retry
              </span>
            </button>
          </div>
        ) : (
          notLive && (
            <p className="text-[11px] font-semibold text-red-400 light:text-red-600" role="status">
              {fresh.label}
            </p>
          )
        )}

        {/* The one large number in this strip — everything else here is
            12px or smaller (DESIGN.md's KPI strip spec, workstream F item
            8). */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="flex items-baseline gap-1.5">
            <span className="font-mono text-[22px] font-semibold leading-none tabular-nums text-white light:text-gray-900">
              {Math.round(summary.tonnes).toLocaleString('en-GB')}
            </span>
            <span className="text-[10px] leading-none text-slate-500 light:text-gray-500">
              t on site
            </span>
            {capacityFraction !== null && (
              <MiniBar
                fraction={capacityFraction}
                title={`${formatPercent(capacityFraction)} of site capacity held`}
              />
            )}
          </span>

          <span className="flex items-center gap-1.5">
            <span className="flex items-baseline gap-0.5 font-mono text-xs leading-none tabular-nums text-slate-300 light:text-gray-700">
              {summary.withStock}
              <span className="text-slate-600 light:text-gray-500">/{summary.bins}</span>
            </span>
            <MiniBar
              fraction={summary.bins ? summary.withStock / summary.bins : 0}
              title={`${summary.withStock} of ${summary.bins} monitored bins hold stock`}
            />
          </span>

          {summary.highLevel > 0 && (
            <Chip
              tone="amber"
              title={`${summary.highLevel} bin(s) reporting high level — press to go to them`}
              onClick={() => onGoToAlarm('high')}
            >
              <AlertTriangle className="h-3 w-3" />
              {summary.highLevel}
            </Chip>
          )}
          {summary.locked > 0 && (
            <Chip
              tone="red"
              title={`${summary.locked} bin(s) locked — press to go to them`}
              onClick={() => onGoToAlarm('locked')}
            >
              <Lock className="h-3 w-3" />
              {summary.locked}
            </Chip>
          )}
        </div>
      </div>
      )}

      {/* ---- finder ------------------------------------------------------ */}
      <form
        onSubmit={submit}
        className={cn(
          'flex shrink-0 items-center gap-1.5 border-b border-slate-800 px-3 light:border-gray-200',
          'focus-within:bg-slate-900/40',
        )}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-slate-500 light:text-gray-500" />
        <label htmlFor="silo-list-finder" className="sr-only">
          Find a bin by number or material
        </label>
        <input
          id="silo-list-finder"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setMissing(false);
          }}
          placeholder="Find a bin or material"
          className={cn(
            'touch-target-44 min-h-[32px] w-full bg-transparent text-xs text-slate-200 outline-none',
            'placeholder:text-slate-500 light:text-gray-800',
          )}
          aria-invalid={missing}
        />
        {missing && (
          <span className="shrink-0 text-[10px] text-red-400" role="status">
            no such bin
          </span>
        )}
      </form>

      {/* ---- sort header --------------------------------------------------- */}
      {rows.length > 0 && <SortHeader sort={sort} onSort={onSort} />}

      {/* ---- rows --------------------------------------------------------- */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && (
          <div className="flex flex-col items-start gap-1.5 p-3 text-[11px] text-slate-500 light:text-gray-500">
            <p>{query.trim() ? `No bin or material matches “${query}”.` : 'No bins match.'}</p>
            {query.trim() && (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setMissing(false);
                }}
                className="touch-target-44 rounded text-cyan-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 light:text-cyan-700"
              >
                Clear filter
              </button>
            )}
          </div>
        )}
        {rows.map(
          ({ p, reading, level, displayMaterial, color, hatched, untagged, stale }) => {
            const isSelected = selected === p.siloNo;
            const isHovered = hovered === p.siloNo;
            return (
              <div
                key={p.siloNo}
                className={cn(
                  'border-b border-slate-800/60 light:border-gray-200',
                  isSelected && 'bg-slate-900/60 light:bg-gray-50',
                )}
              >
                <button
                  type="button"
                  onMouseEnter={() => onHover(p.siloNo)}
                  onMouseLeave={() => onHover(null)}
                  onFocus={() => onHover(p.siloNo)}
                  onBlur={() => onHover(null)}
                  onClick={() => onFind(p.siloNo)}
                  aria-pressed={isSelected}
                  className={cn(
                    'touch-target-44 flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                    'hover:bg-slate-900/40 light:hover:bg-gray-50',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400',
                    isHovered && !isSelected && 'bg-slate-900/30 light:bg-gray-50',
                  )}
                >
                  <span className="w-9 shrink-0 font-mono text-xs tabular-nums text-slate-300 light:text-gray-700">
                    {p.siloNo}
                  </span>
                  <Swatch color={color} hatched={hatched} />
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-300 light:text-gray-700">
                    {displayMaterial}
                  </span>
                  <span className="w-10 shrink-0">
                    <FillBar fill={level.fill} color={color} />
                  </span>
                  <span className="w-8 shrink-0 whitespace-nowrap text-right font-mono text-[11px] tabular-nums text-slate-400 light:text-gray-600">
                    {formatPercent(level.fraction)}
                  </span>
                  <span
                    className={cn(
                      'w-8 shrink-0 whitespace-nowrap text-right font-mono text-[10px] tabular-nums',
                      stale ? 'text-red-400 light:text-red-600' : 'text-slate-500 light:text-gray-500',
                    )}
                    title={
                      stale
                        ? `Stale — the plant has not written this value in over ${Math.round(STALE_AFTER_MS / 60000)} minutes (${reading?.updatedAt ? new Date(reading.updatedAt).toLocaleString() : 'unknown'})`
                        : reading?.updatedAt
                          ? new Date(reading.updatedAt).toLocaleString()
                          : undefined
                    }
                  >
                    {reading?.updatedAt
                      ? agoShort((Date.now() - Date.parse(reading.updatedAt)) / 1000)
                      : '—'}
                  </span>
                  <span className="flex w-9 shrink-0 items-center justify-end gap-1">
                    {reading?.hlActive && (
                      <AlertTriangle
                        className="h-3 w-3 shrink-0 text-amber-400"
                        aria-label="High level"
                      />
                    )}
                    {reading?.lockActive && (
                      <Lock className="h-3 w-3 shrink-0 text-red-400" aria-label="Locked" />
                    )}
                    {level.outOfRange && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                        title="Out of range"
                        aria-label="Out of range"
                      />
                    )}
                    {untagged && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-500"
                        title="Untagged bin"
                        aria-label="Untagged"
                      />
                    )}
                  </span>
                </button>

                {isSelected && (
                  /* Capped rather than free to grow: an expanded row that ran
                     past the list's own visible height would push every other
                     row out of reach with no way back to them short of
                     collapsing this one first. `max-h-[60vh]` with its own
                     scroll keeps the rest of the list one scroll away instead. */
                  <div className="max-h-[60vh] overflow-y-auto border-t border-slate-800/60 bg-slate-950/40 px-3 py-3 light:border-gray-200 light:bg-gray-50">
                    <SiloDetailPanel
                      placement={p}
                      reading={reading}
                      group={p.group}
                      palette={readings.palette}
                      onClose={onDeselect}
                      embedded
                    />
                  </div>
                )}
              </div>
            );
          },
        )}
      </div>
    </div>
  );
}
