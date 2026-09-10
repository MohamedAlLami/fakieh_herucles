/**
 * 24-Hour Production Performance panel for the Fakieh Dashboard.
 *
 * Shows the four figures the plant asked for -- when the window's first batch
 * started, when its last batch ended, how fast the mill ran, and how much of
 * the 24 hours it ran at all -- over one shared 24-hour axis so the numbers and
 * the picture cannot disagree.
 *
 * All arithmetic lives in the backend (Backend/routes/production_kpi.py), which
 * is where the awkward parts of this data are handled: batches overlap because
 * their start is a release stamp, tonnage is the sum of dosed material rather
 * than the [Quantity] column, OutLoading is not production, and "Not Selected"
 * rows are placeholders. This component formats and draws; it does not decide
 * what anything means.
 *
 * Note on styling: `light:` here is not a Tailwind variant. It is a hand-written
 * allowlist of rules under `:root.light` in index.css, so only classes that
 * already exist there will do anything. Sticking to cyan/gray/green keeps the
 * panel inside that allowlist.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, Clock, Flag, Gauge, Zap } from 'lucide-react'
import { BUSINESS_TZ, parseUtcDate } from '@/utils/timezone'

export interface ProductionKpiResponse {
  success: boolean
  mode: 'rolling' | 'production_day' | 'custom'
  window: { start: string | null; end: string | null; hours: number; elapsed_hours: number }
  batches: number
  batches_running: number
  tons: number
  first_batch_start: string | null
  last_batch_end: string | null
  running_hours: number
  idle_hours: number
  availability_pct: number
  throughput_tph: number
  throughput_window_tph: number
  on_target_pct: number | null
  on_target_rows: number
  scored_rows: number
  dosing_tolerance_pct: number
  dosing_accuracy_pct: number | null
  concurrency: number | null
  timeline: Array<{ start: string | null; end: string | null }>
  by_hour: Array<{ hour_start: string | null; tons: number; batches: number }>
  non_production: { categories: string[]; batches: number; tons: number }
  error?: string
  message?: string
}

const REFRESH_MS = 60000

const timeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
})

const dayFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TZ,
  month: 'short',
  day: 'numeric',
})

const hourFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TZ,
  hour: '2-digit',
  hour12: false,
})

function formatClock(iso: string | null | undefined): string {
  const d = parseUtcDate(iso)
  return d ? timeFmt.format(d) : '--:--'
}

function formatDay(iso: string | null | undefined): string {
  const d = parseUtcDate(iso)
  return d ? dayFmt.format(d) : ''
}

function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '--'
  const whole = Math.floor(hours)
  const minutes = Math.round((hours - whole) * 60)
  if (minutes === 60) return `${whole + 1}h 00m`
  return `${whole}h ${String(minutes).padStart(2, '0')}m`
}

/** One of the four headline figures. Typography matches the KPI tiles above. */
function Stat({
  label,
  value,
  sub,
  icon,
  muted,
}: {
  label: string
  value: string
  sub?: string
  icon: React.ReactNode
  muted?: boolean
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-cyan-400 light:text-cyan-600 shrink-0">{icon}</span>
        <p className="text-sm font-medium text-slate-400 light:text-gray-600 truncate">{label}</p>
      </div>
      <p
        className={`text-2xl font-bold tabular-nums truncate ${
          muted ? 'text-slate-500 light:text-gray-500' : 'text-white light:text-gray-900'
        }`}
      >
        {value}
      </p>
      {sub ? (
        <p className="text-xs text-slate-400 light:text-gray-600 truncate mt-0.5">{sub}</p>
      ) : (
        <p className="text-xs text-transparent select-none mt-0.5">&nbsp;</p>
      )}
    </div>
  )
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 rounded-md bg-slate-900/50 light:bg-gray-100 border border-slate-700/50 light:border-gray-200 px-2.5 py-1">
      <span className="text-xs text-slate-400 light:text-gray-600">{label}</span>
      <span className="text-xs font-semibold text-white light:text-gray-900 tabular-nums">{value}</span>
    </span>
  )
}

export default function ProductionPerformanceCard() {
  const [kpi, setKpi] = useState<ProductionKpiResponse | null>(null)
  // Operators read this card, so the visible message stays plain; whatever the
  // browser or the server actually said is kept for the tooltip.
  const [error, setError] = useState<{ text: string; detail?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const abortRef = useRef<AbortController | null>(null)

  const fetchKpi = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await fetch('/api/sqlserver/production-kpi?hours=24', {
        signal: controller.signal,
      })
      let body: ProductionKpiResponse | null = null
      try {
        body = (await res.json()) as ProductionKpiResponse
      } catch {
        // A gateway error page, or nothing at all. res.status says more than
        // "Unexpected end of JSON input" ever would.
        body = null
      }
      if (!res.ok || !body?.success) {
        setError({
          text: 'The reporting service could not return production data.',
          detail: body?.message || body?.error || `HTTP ${res.status} ${res.statusText}`.trim(),
        })
        return
      }
      setKpi(body)
      setError(null)
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setError({
        text: 'Cannot reach the reporting service.',
        detail: (err as Error).message,
      })
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchKpi()
    const interval = setInterval(fetchKpi, REFRESH_MS)
    return () => {
      clearInterval(interval)
      abortRef.current?.abort()
    }
  }, [fetchKpi])

  const windowStart = parseUtcDate(kpi?.window?.start)
  const windowEnd = parseUtcDate(kpi?.window?.end)
  const windowMs =
    windowStart && windowEnd ? Math.max(windowEnd.getTime() - windowStart.getTime(), 1) : 1

  const pct = (d: Date) =>
    windowStart ? ((d.getTime() - windowStart.getTime()) / windowMs) * 100 : 0

  const runBlocks = (kpi?.timeline ?? [])
    .map((span) => {
      const s = parseUtcDate(span.start)
      const e = parseUtcDate(span.end)
      if (!s || !e) return null
      const left = Math.max(0, Math.min(100, pct(s)))
      const right = Math.max(0, Math.min(100, pct(e)))
      const width = Math.max(right - left, 0.35) // keep a short run visible
      return { left, width, s, e }
    })
    .filter(Boolean) as Array<{ left: number; width: number; s: Date; e: Date }>

  const byHour = kpi?.by_hour ?? []
  const peakHour = byHour.reduce((max, h) => Math.max(max, h.tons), 0)

  // Axis ticks every three hours, labelled in plant time.
  const ticks = windowStart
    ? Array.from({ length: 9 }, (_, i) => {
        const at = new Date(windowStart.getTime() + (windowMs * i) / 8)
        return { pct: (i / 8) * 100, label: `${hourFmt.format(at)}:00` }
      })
    : []

  const hasData = !!kpi && (kpi.batches > 0 || kpi.batches_running > 0)
  const availability = kpi?.availability_pct ?? 0

  return (
    <div className="bg-slate-800/50 light:bg-white border border-slate-700/50 light:border-gray-200 rounded-lg p-6 shadow-lg light:shadow-xl relative overflow-hidden">
      {/* Header — matches the chart cards' title + pulsing status badge idiom */}
      <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-white light:text-gray-900">
            24-Hour Production Performance
          </h3>
          <p className="text-xs text-slate-400 light:text-gray-600 mt-1">
            {windowStart && windowEnd
              ? `${formatDay(kpi?.window?.start)} ${formatClock(kpi?.window?.start)} → ${formatDay(
                  kpi?.window?.end,
                )} ${formatClock(kpi?.window?.end)} · plant time`
              : 'Rolling 24-hour window · plant time'}
          </p>
        </div>
        <div className="flex items-center space-x-2 shrink-0">
          <div
            className={`w-3 h-3 rounded-full ${
              error ? 'bg-slate-500' : 'bg-cyan-500 animate-pulse'
            }`}
          />
          <span className="text-xs text-cyan-400 light:text-cyan-600 font-medium">
            {error ? 'Unavailable' : 'Last 24 hours'}
          </span>
        </div>
      </div>

      {loading && !kpi ? (
        <div className="space-y-5" aria-busy="true">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="space-y-2">
                <div className="h-4 w-24 rounded bg-slate-700/50 light:bg-gray-200 animate-pulse" />
                <div className="h-7 w-20 rounded bg-slate-700/50 light:bg-gray-200 animate-pulse" />
              </div>
            ))}
          </div>
          <div className="h-24 rounded-md bg-slate-700/30 light:bg-gray-100 animate-pulse" />
        </div>
      ) : (
        <>
          {/* The four figures */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-cyan-400 light:text-cyan-600 shrink-0">
                  <Gauge className="h-4 w-4" />
                </span>
                <p className="text-sm font-medium text-slate-400 light:text-gray-600 truncate">
                  Efficiency
                </p>
              </div>
              <p
                className={`text-2xl font-bold tabular-nums ${
                  hasData ? 'text-white light:text-gray-900' : 'text-slate-500 light:text-gray-500'
                }`}
              >
                {hasData ? `${availability.toFixed(1)}%` : '--'}
              </p>
              <div className="h-1.5 rounded-full bg-slate-700/60 light:bg-gray-200 overflow-hidden mt-2 mb-1">
                <div
                  className="h-full bg-cyan-500 rounded-full transition-all duration-500"
                  style={{ width: `${Math.max(0, Math.min(100, availability))}%` }}
                />
              </div>
              <p className="text-xs text-slate-400 light:text-gray-600 truncate">
                {hasData
                  ? `Running ${formatHours(kpi?.running_hours)} of 24h`
                  : 'Running time ÷ 24 hours'}
              </p>
            </div>

            <Stat
              icon={<Zap className="h-4 w-4" />}
              label="Throughput"
              value={hasData ? `${(kpi?.throughput_tph ?? 0).toFixed(1)} t/h` : '--'}
              sub={
                hasData
                  ? `${(kpi?.throughput_window_tph ?? 0).toFixed(1)} t/h across the full 24h`
                  : 'Tonnage ÷ running time'
              }
              muted={!hasData}
            />

            <Stat
              icon={<Clock className="h-4 w-4" />}
              label="First batch start"
              value={hasData ? formatClock(kpi?.first_batch_start) : '--:--'}
              sub={hasData ? formatDay(kpi?.first_batch_start) : 'No batches yet'}
              muted={!hasData}
            />

            <Stat
              icon={<Flag className="h-4 w-4" />}
              label="Last batch end"
              value={
                kpi?.last_batch_end
                  ? formatClock(kpi.last_batch_end)
                  : kpi?.batches_running
                    ? 'Running'
                    : '--:--'
              }
              sub={
                kpi?.last_batch_end
                  ? formatDay(kpi.last_batch_end)
                  : kpi?.batches_running
                    ? `${kpi.batches_running} batch${kpi.batches_running === 1 ? '' : 'es'} in progress`
                    : 'No batches yet'
              }
              muted={!kpi?.last_batch_end}
            />
          </div>

          {/* One shared 24-hour axis: tonnage per hour above, running time below */}
          <div className="mt-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-slate-400 light:text-gray-600">
                Tonnage per hour
              </span>
              <span className="text-xs text-slate-500 light:text-gray-500 tabular-nums">
                {peakHour > 0 ? `peak ${peakHour.toFixed(1)} t` : ''}
              </span>
            </div>

            <div className="flex items-end gap-[2px] h-16" role="img" aria-label="Tonnage produced per hour over the last 24 hours">
              {(byHour.length ? byHour : Array.from({ length: 24 }, () => null)).map((h, i) => {
                const tons = h?.tons ?? 0
                const height = peakHour > 0 ? Math.max((tons / peakHour) * 100, tons > 0 ? 6 : 0) : 0
                return (
                  <div
                    key={i}
                    className="flex-1 h-full flex items-end bg-slate-900/40 light:bg-gray-100 rounded-sm overflow-hidden"
                    title={
                      h?.hour_start
                        ? `${formatClock(h.hour_start)} — ${tons.toFixed(2)} t, ${h.batches} batch${
                            h.batches === 1 ? '' : 'es'
                          }`
                        : 'No data'
                    }
                  >
                    <div
                      className="w-full bg-cyan-500/70 rounded-sm transition-all duration-500"
                      style={{ height: `${height}%` }}
                    />
                  </div>
                )
              })}
            </div>

            {/* Running/idle ribbon on the same axis */}
            <div className="relative h-2.5 mt-2 rounded-full bg-slate-900/60 light:bg-gray-200 overflow-hidden">
              {runBlocks.map((b, i) => (
                <div
                  key={i}
                  className="absolute inset-y-0 bg-cyan-500 rounded-full"
                  style={{ left: `${b.left}%`, width: `${b.width}%` }}
                  title={`Running ${formatClock(b.s.toISOString())} → ${formatClock(b.e.toISOString())}`}
                />
              ))}
            </div>

            <div className="relative h-4 mt-1">
              {ticks.map((t, i) => (
                <span
                  key={i}
                  className="absolute text-[10px] text-slate-500 light:text-gray-500 tabular-nums -translate-x-1/2"
                  style={{ left: `${t.pct}%` }}
                >
                  {t.label}
                </span>
              ))}
            </div>
          </div>

          {/* Supporting figures */}
          <div className="flex flex-wrap items-center gap-2 mt-5">
            <Chip label="Batches" value={hasData ? String(kpi?.batches ?? 0) : '--'} />
            <Chip label="Produced" value={hasData ? `${(kpi?.tons ?? 0).toFixed(1)} t` : '--'} />
            <Chip label="Idle" value={hasData ? formatHours(kpi?.idle_hours) : '--'} />
            <Chip
              label={`On target ±${kpi?.dosing_tolerance_pct ?? 2}%`}
              value={
                kpi?.on_target_pct !== null && kpi?.on_target_pct !== undefined
                  ? `${kpi.on_target_pct.toFixed(1)}%`
                  : '--'
              }
            />
            {kpi?.non_production?.tons ? (
              <Chip label="Outloaded (not counted)" value={`${kpi.non_production.tons.toFixed(1)} t`} />
            ) : null}
          </div>

          {error ? (
            <p
              className="flex items-center gap-2 text-xs text-slate-400 light:text-gray-600 mt-4"
              title={error.detail}
            >
              <Activity className="h-3.5 w-3.5" />
              {error.text} Showing no data until it responds.
            </p>
          ) : !hasData ? (
            <p className="flex items-center gap-2 text-xs text-slate-400 light:text-gray-600 mt-4">
              <Activity className="h-3.5 w-3.5" />
              No batches recorded in the last 24 hours.
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}
