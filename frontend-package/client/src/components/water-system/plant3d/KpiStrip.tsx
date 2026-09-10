/**
 * The full-width KPI row above the canvas+list grid: Bins, Capacity, Stored,
 * Utilisation, Alarms, Freshness. One glance at the whole plant before an
 * operator has picked a zone or a bin.
 *
 * EXTRACTED from `SiloList`'s own KPI section (Phase 4 workstream F), not
 * rewritten from it: the six numbers here are the same numbers that section
 * already computed, moved up out of the list pane so they show once, above
 * the split view, instead of scrolling away with the bin rows and vanishing
 * entirely on the bottom-sheet layout where the sheet opens collapsed.
 * `SiloList` keeps a `showKpi` escape hatch (default `false`) for exactly the
 * one layout that might still want its own copy — see that file.
 *
 * Same prop shape SiloList's KPI section already took (`summary`,
 * `plantWroteAt`, `fetchedAt`, `loading`, `error`, `onRefresh`, `onGoTo`), so
 * wiring this in at the page level is a house-move, not a rewrite.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Lock, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SILOS, formatCapacity } from '@/lib/plant3d/silos';
import { formatPercent } from '@/lib/plant3d/siloData';
import { Chip, DIVIDER, MiniBar, ago, freshness, type PlantSummary } from './PlantHud';

/** Bins the plant monitors — read off the model, same denominator every
    other count on this screen uses, rather than a magic 131. */
const TOTAL_BINS = SILOS.filter((s) => s.group.monitored).length;

/**
 * Site capacity, tonnes, over every MONITORED and METERED bin.
 *
 * `metered`, not just `monitored`: the 400 series is monitored (the plant
 * reports material, HL and LOCK for it) but has no quantity tag in DB5 at
 * all (PRODUCT.md rule 1), so it contributes nothing to a number that means
 * "tonnes this view could ever draw a fill for". Summed over `SILOS` — one
 * entry per physical bin — rather than over `SILO_GROUPS`, since a group's
 * own `capacityKg` is already the PER-BIN figure (`formatCapacity` reads it
 * the same way for a single bin's own detail panel).
 */
const METERED_CAPACITY_KG = SILOS.filter((s) => s.group.monitored && s.group.metered).reduce(
  (sum, s) => sum + s.group.capacityKg,
  0,
);

function Cell({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span className="flex shrink-0 items-baseline gap-1.5" title={title}>
      <span className="text-[10px] font-medium uppercase tracking-wide text-slate-500 light:text-gray-500">
        {label}
      </span>
      {children}
    </span>
  );
}

export interface KpiStripProps {
  summary: PlantSummary;
  plantWroteAt: Date | null;
  fetchedAt: Date | null;
  loading: boolean;
  error: Error | null;
  onRefresh: () => void;
  /** go to the next bin in a named set; used by the alarm chips */
  onGoTo: (which: 'high' | 'locked') => void;
  /**
   * Wraps to two rows instead of holding a fixed 44px, and drops the
   * "not live" sentence's absolute clock to its title only. Follows
   * `Plant3D.tsx`'s own <1100px `narrow` — the same threshold `SiloList`'s
   * bottom-sheet layout appears under, since that is the layout this strip
   * is most likely to sit above.
   */
  compact?: boolean;
}

export function KpiStrip({
  summary,
  plantWroteAt,
  fetchedAt,
  loading,
  error,
  onRefresh,
  onGoTo,
  compact,
}: KpiStripProps) {
  /* Same reasoning as StatusBar: age has to keep moving between polls, or a
     screen left open overnight sits on a green dot from the last render. */
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 10_000);
    return () => window.clearInterval(t);
  }, []);

  const fresh = freshness(plantWroteAt, fetchedAt, error);
  const notLive = fresh.tone === 'bg-red-500';
  const capacityFraction = METERED_CAPACITY_KG ? (summary.tonnes * 1000) / METERED_CAPACITY_KG : null;
  const alarms = summary.highLevel + summary.locked;

  return (
    <div
      data-plant3d-kpi
      className={cn(
        'shrink-0 border-b border-slate-800 bg-slate-950/95 px-3 text-xs light:border-gray-200 light:bg-white/95',
        compact
          ? 'flex flex-wrap items-center gap-x-4 gap-y-1.5 py-1.5'
          : 'flex h-11 items-center gap-x-4 overflow-x-auto',
      )}
    >
      {/* ---- Bins ---------------------------------------------------- */}
      <Cell label="Bins" title="Bins holding stock, of every bin in the plant">
        <span className="font-mono tabular-nums text-slate-200 light:text-gray-800">
          {summary.withStock}
          <span className="text-slate-600 light:text-gray-500">/{TOTAL_BINS}</span>
        </span>
      </Cell>

      <span className={DIVIDER} />

      {/* ---- Capacity -------------------------------------------------- */}
      <Cell label="Capacity">
        <span className="font-mono tabular-nums text-slate-200 light:text-gray-800">
          {formatCapacity(METERED_CAPACITY_KG)}
        </span>
      </Cell>

      <span className={DIVIDER} />

      {/* ---- Stored — the one 22px number in this strip ---------------- */}
      <Cell label="Stored">
        <span className="flex items-baseline gap-1">
          <span className="font-mono text-[22px] font-semibold leading-none tabular-nums text-white light:text-gray-900">
            {Math.round(summary.tonnes).toLocaleString('en-GB')}
          </span>
          <span className="text-[10px] leading-none text-slate-500 light:text-gray-500">t</span>
        </span>
      </Cell>

      <span className={DIVIDER} />

      {/* ---- Utilisation ------------------------------------------------ */}
      <Cell label="Utilisation">
        <span className="flex items-center gap-1.5">
          <span className="font-mono tabular-nums text-slate-200 light:text-gray-800">
            {formatPercent(capacityFraction)}
          </span>
          {capacityFraction !== null && (
            <MiniBar
              fraction={capacityFraction}
              title={`${formatPercent(capacityFraction)} of metered capacity held`}
            />
          )}
        </span>
      </Cell>

      <span className={DIVIDER} />

      {/* ---- Alarms ------------------------------------------------------ */}
      <Cell label="Alarms">
        <span className="flex items-center gap-1">
          {summary.highLevel > 0 && (
            <Chip
              tone="amber"
              title={`${summary.highLevel} bin(s) reporting high level — press to go to them`}
              onClick={() => onGoTo('high')}
            >
              <AlertTriangle className="h-3 w-3" />
              {summary.highLevel}
            </Chip>
          )}
          {summary.locked > 0 && (
            <Chip
              tone="red"
              title={`${summary.locked} bin(s) locked — press to go to them`}
              onClick={() => onGoTo('locked')}
            >
              <Lock className="h-3 w-3" />
              {summary.locked}
            </Chip>
          )}
          {alarms === 0 && !error && (
            <Chip tone="green" title="No bin is reporting a high level or a lock">
              <CheckCircle2 className="h-3 w-3" />
              <span className="sr-only">All normal</span>
            </Chip>
          )}
        </span>
      </Cell>

      <span className={DIVIDER} />

      {/* ---- Freshness ---------------------------------------------------- */}
      <Cell label="Freshness">
        <span className="flex items-center gap-1.5">
          <span
            className={cn('h-2.5 w-2.5 shrink-0 rounded-full', fresh.tone, loading && 'animate-pulse')}
            title={fresh.label}
            aria-hidden="true"
          />
          {plantWroteAt ? (
            <time
              dateTime={plantWroteAt.toISOString()}
              title={plantWroteAt.toISOString()}
              className={cn(
                'truncate tabular-nums',
                notLive ? 'font-semibold text-red-400 light:text-red-600' : 'text-slate-400 light:text-gray-600',
              )}
            >
              {notLive ? 'Not live — ' : ''}
              {ago((Date.now() - plantWroteAt.getTime()) / 1000)}
            </time>
          ) : (
            <span className="text-slate-500 light:text-gray-500">waiting for data</span>
          )}
          {error && (
            <button
              type="button"
              onClick={onRefresh}
              className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            >
              <span className="inline-flex min-h-[20px] items-center gap-1 rounded-full bg-red-500/20 px-1.5 text-[10px] font-semibold text-red-300 light:bg-red-100 light:text-red-600">
                <RefreshCw className="h-2.5 w-2.5" />
                Retry
              </span>
            </button>
          )}
        </span>
      </Cell>
    </div>
  );
}
