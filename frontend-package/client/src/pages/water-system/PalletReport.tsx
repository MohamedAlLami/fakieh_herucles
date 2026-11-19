import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileSpreadsheet,
  Gauge,
  MapPin,
  PackageCheck,
  PackageSearch,
  PlayCircle,
  Printer,
  RefreshCw,
  Search,
  Timer,
} from 'lucide-react'

import { WaterSystemLayout } from '@/components/water-system/WaterSystemLayout'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { API_ENDPOINTS } from '@/config/api'
import { usePolling } from '@/hooks/usePolling'
import { useRowSelection } from '@/hooks/useRowSelection'
import { exportTableToExcel, type ExportColumn } from '@/utils/exportTable'
import { printTable } from '@/utils/printTable'
import {
  formatSaudiTime,
  getDefaultProductionDayRange,
  saudiDatetimeLocalToUtcIso,
} from '@/utils/timezone'

type LineName = 'P1' | 'P2' | 'P3' | 'P4'
type OrderStatus = 'RUNNING' | 'COMPLETED'

interface Movement {
  id: number
  source1: number | null
  source2: number | null
  destination1: number | null
  destination2: number | null
  quantity: number | null
  selection: number | null
  observed_at: string
}

interface PalletOrder {
  id: number
  line: LineName
  order_sequence: number
  order_description: string
  source1: number | null
  source2: number | null
  destination1: number | null
  destination2: number | null
  production_name: string | null
  material: string | null
  start_qty: number | null
  latest_qty: number | null
  final_qty: number | null
  product_kg: number | null
  running: boolean
  status: OrderStatus
  selection: number | null
  actual_start_time: string
  actual_end_time: string | null
  duration_seconds: number | null
  /** From the start of the order to its end, pauses included (PLC FullRun). */
  full_run_seconds?: number | null
  /** Only the time the line was really running (PLC Running). */
  actual_run_seconds?: number | null
  paused?: boolean
  movements: Movement[]
}

interface HistoryResponse {
  success: boolean
  items: PalletOrder[]
  pagination: { page: number; page_size: number; total: number; pages: number }
  error?: string
}

interface SummaryResponse {
  success: boolean
  total_orders: number
  running_orders: number
  completed_orders: number
  total_product_kg: number
  per_line: Record<LineName, number>
  error?: string
}

interface CurrentOrder {
  id: number
  order_sequence: number
  order_description: string
  actual_start_time: string
  elapsed_seconds: number
  full_run_seconds?: number
  actual_run_seconds?: number
}

interface PalletLine {
  line: LineName
  source1: number | null
  source2: number | null
  destination1: number | null
  destination2: number | null
  quantity: number
  running: boolean
  selection?: number
  selected?: boolean
  /** PLC FullRun bit; null when the PLC does not have it. */
  full_run?: boolean | null
  /** The order is open but the line is not running right now. */
  paused?: boolean
  production_name: string | null
  material: string | null
  current_order: CurrentOrder | null
}

interface LiveResponse {
  success: boolean
  timestamp: string
  lines: Record<LineName, PalletLine>
  error?: string
}

const formatTimestamp = (value?: string | null) => value ? formatSaudiTime(value, true) : '—'

const formatQuantity = (value?: number | null) => {
  if (value == null) return '—'
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

const formatDuration = (seconds?: number | null) => {
  if (seconds == null) return '—'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  return [hours ? `${hours}h` : '', minutes || hours ? `${minutes}m` : '', `${secs}s`]
    .filter(Boolean)
    .join(' ')
}

const validCode = (value?: number | null) => value != null && value !== 0

const uniqueValues = (values: Array<number | null | undefined>) =>
  Array.from(new Set(values.filter(validCode) as number[]))

const displayTrail = (values: number[]) => values.length ? values.join(' → ') : '—'

const orderSources = (order: PalletOrder) =>
  uniqueValues(order.movements.flatMap((movement) => [movement.source1, movement.source2]))

const orderDestinations = (order: PalletOrder) => {
  const bin1 = uniqueValues(order.movements.map((movement) => movement.destination1))
  const bin2 = uniqueValues(order.movements.map((movement) => movement.destination2))
  return { bin1, bin2 }
}

/** Both destination bins in one cell: "Bin 1: 848 → 847 | Bin 2: 849". */
const destinationText = (order: PalletOrder) => {
  const { bin1, bin2 } = orderDestinations(order)
  const parts: string[] = []
  if (bin1.length) parts.push(`Bin 1: ${displayTrail(bin1)}`)
  if (bin2.length) parts.push(`Bin 2: ${displayTrail(bin2)}`)
  return parts.join(' | ')
}

const orderStatusText = (order: PalletOrder) =>
  order.status === 'RUNNING' ? (order.paused ? 'Paused' : 'Running') : 'Completed'

const fullRunSeconds = (order: PalletOrder) => order.full_run_seconds ?? order.duration_seconds
const actualRunSeconds = (order: PalletOrder) => order.actual_run_seconds ?? fullRunSeconds(order)

/** h:mm:ss, for print and Excel where columns must line up. */
const clockDuration = (seconds?: number | null) => {
  if (seconds == null) return ''
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

const HISTORY_HEADINGS = [
  'Line', 'Status', 'Actual Start', 'Ended', 'Destination Bins', 'Full Run', 'Actual Run',
  'Batch ID', 'Sources', 'Recipe', 'Product Name', 'Product KG',
]

const selectionMeaning = (selection?: number | null) => {
  if (selection === 3) return 'P3'
  if (selection === 4) return 'P4'
  if (selection === 5) return 'P5'
  return '—'
}

function KpiCard({ label, value, icon: Icon, accent }: {
  label: string
  value: string
  icon: typeof Activity
  accent: string
}) {
  return (
    <Card className="pallet-report-kpi border-border bg-card text-card-foreground">
      <CardContent className="flex items-center justify-between p-4">
        <div>
          <p className="pallet-report-kpi-label text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className="pallet-report-kpi-value mt-1 text-2xl font-bold text-foreground">{value}</p>
        </div>
        <div className={`pallet-report-kpi-icon rounded-xl p-2.5 ${accent}`}><Icon className="h-5 w-5" /></div>
      </CardContent>
    </Card>
  )
}

function HistoryPanel() {
  const [defaults] = useState(getDefaultProductionDayRange)
  const [items, setItems] = useState<PalletOrder[]>([])
  const [summary, setSummary] = useState<SummaryResponse | null>(null)
  const [pagination, setPagination] = useState({ page: 1, page_size: 50, total: 0, pages: 0 })
  const [line, setLine] = useState('ALL')
  const [status, setStatus] = useState('ALL')
  const [startDate, setStartDate] = useState(defaults.startDate)
  const [endDate, setEndDate] = useState(defaults.endDate)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [exporting, setExporting] = useState(false)
  const rowKey = (order: PalletOrder) => `${order.line}-${order.id}`
  const selection = useRowSelection(items.map(rowKey))

  const requestParams = useCallback((includePagination: boolean) => {
    const params = new URLSearchParams({ line, status })
    if (includePagination) {
      params.set('page', String(pagination.page))
      params.set('page_size', String(pagination.page_size))
    }
    if (startDate) params.set('start_date', saudiDatetimeLocalToUtcIso(startDate))
    if (endDate) params.set('end_date', saudiDatetimeLocalToUtcIso(endDate))
    if (search.trim()) params.set('search', search.trim())
    return params
  }, [line, status, pagination.page, pagination.page_size, startDate, endDate, search])

  const loadHistory = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError(null)
    try {
      const [historyResponse, summaryResponse] = await Promise.all([
        fetch(`${API_ENDPOINTS.PALLET_REPORT.HISTORY}?${requestParams(true)}`, { signal }),
        fetch(`${API_ENDPOINTS.PALLET_REPORT.SUMMARY}?${requestParams(false)}`, { signal }),
      ])
      const historyBody = (await historyResponse.json()) as HistoryResponse
      const summaryBody = (await summaryResponse.json()) as SummaryResponse
      if (!historyResponse.ok || !historyBody.success) {
        throw new Error(historyBody.error || 'Unable to load stored pallet history')
      }
      if (!summaryResponse.ok || !summaryBody.success) {
        throw new Error(summaryBody.error || 'Unable to load pallet summary')
      }
      setItems(historyBody.items)
      setPagination(historyBody.pagination)
      setSummary(summaryBody)
    } catch (cause) {
      if ((cause as { name?: string }).name !== 'AbortError') {
        setError(cause instanceof Error ? cause.message : 'Unable to load stored pallet history')
      }
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [requestParams, refreshKey])

  useEffect(() => {
    const controller = new AbortController()
    void loadHistory(controller.signal)
    return () => controller.abort()
  }, [loadHistory])

  // What gets printed or exported: the ticked runs, or every run that matches the
  // filters (all pages, not only the page on screen) when none is ticked.
  const reportRows = async (): Promise<PalletOrder[]> => {
    if (selection.count > 0) return items.filter((order) => selection.selected.has(rowKey(order)))
    if (pagination.pages <= 1) return items
    const all: PalletOrder[] = []
    for (let page = 1; page <= 500; page += 1) {
      const params = requestParams(false)
      params.set('page', String(page))
      params.set('page_size', '100')
      const response = await fetch(`${API_ENDPOINTS.PALLET_REPORT.HISTORY}?${params}`)
      const body = (await response.json()) as HistoryResponse
      if (!response.ok || !body.success) throw new Error(body.error || 'Unable to load stored pallet history')
      all.push(...body.items)
      if (page >= body.pagination.pages) break
    }
    return all
  }

  const reportTable = (rows: PalletOrder[]) => {
    const columns: ExportColumn<PalletOrder>[] = [
      { header: 'Line', cell: (order) => order.line },
      { header: 'Status', cell: orderStatusText },
      { header: 'Actual Start', cell: (order) => formatTimestamp(order.actual_start_time) },
      { header: 'Ended', cell: (order) => (order.status === 'RUNNING' ? 'Live' : formatTimestamp(order.actual_end_time)) },
      { header: 'Destination Bins', cell: destinationText },
      { header: 'Full Run', cell: (order) => clockDuration(fullRunSeconds(order)) },
      { header: 'Actual Run', cell: (order) => clockDuration(actualRunSeconds(order)) },
      { header: 'Batch ID', cell: (order) => order.id },
      { header: 'Sources', cell: (order) => orderSources(order).join(' → ') },
      { header: 'Recipe', cell: (order) => order.material },
      { header: 'Product Name', cell: (order) => order.production_name },
      {
        header: 'Product KG',
        cell: (order) => (order.product_kg == null ? '' : formatQuantity(order.product_kg)),
        excel: (order) => order.product_kg,
        numeric: true,
      },
    ]
    const subtitles: string[] = []
    const period = [startDate && `from ${startDate.replace('T', ' ')}`, endDate && `to ${endDate.replace('T', ' ')}`]
      .filter(Boolean)
      .join(' ')
    if (period) subtitles.push(`Period: ${period}`)
    const active: string[] = []
    if (line !== 'ALL') active.push(`Line: ${line}`)
    if (status !== 'ALL') active.push(`Status: ${status === 'RUNNING' ? 'Running' : 'Completed'}`)
    if (search.trim()) active.push(`Search: ${search.trim()}`)
    if (active.length) subtitles.push(`Filters: ${active.join(' | ')}`)
    if (selection.count > 0) subtitles.push(`${rows.length} of ${pagination.total} production runs selected`)
    const totalKg = rows.reduce((sum, order) => sum + (order.product_kg ?? 0), 0)
    const fullTotal = rows.reduce((sum, order) => sum + (fullRunSeconds(order) ?? 0), 0)
    const actualTotal = rows.reduce((sum, order) => sum + (actualRunSeconds(order) ?? 0), 0)
    const label = `Total: ${rows.length} run${rows.length === 1 ? '' : 's'}`
    const footer = (kg: string | number): Array<string | number> => [
      label, '', '', '', '', clockDuration(fullTotal), clockDuration(actualTotal), '', '', '', '', kg,
    ]
    return { columns, subtitles, totalKg, footer }
  }

  const runExport = async (kind: 'print' | 'excel') => {
    setExporting(true)
    setError(null)
    try {
      const rows = await reportRows()
      const table = reportTable(rows)
      const problem = kind === 'print'
        ? await printTable({
            title: 'Pallet Report',
            subtitles: table.subtitles,
            columns: table.columns,
            rows,
            landscape: true,
            footer: table.footer(formatQuantity(table.totalKg)).map(String),
          })
        : await exportTableToExcel({
            title: 'Pallet Report',
            subtitles: table.subtitles,
            columns: table.columns,
            rows,
            footer: table.footer(Math.round(table.totalKg * 100) / 100),
            filename: 'pallet-report',
            sheetName: 'Pallet Report',
          })
      if (problem) setError(problem)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to prepare the pallet report')
    } finally {
      setExporting(false)
    }
  }

  const updateFilter = (setter: (value: string) => void, value: string) => {
    setter(value)
    setPagination((current) => ({ ...current, page: 1 }))
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Total orders" value={(summary?.total_orders ?? 0).toLocaleString()} icon={PackageCheck} accent="bg-cyan-500/10 text-cyan-400" />
        <KpiCard label="Running" value={(summary?.running_orders ?? 0).toLocaleString()} icon={PlayCircle} accent="bg-emerald-500/10 text-emerald-400" />
        <KpiCard label="Completed" value={(summary?.completed_orders ?? 0).toLocaleString()} icon={CheckCircle2} accent="bg-blue-500/10 text-blue-400" />
        <KpiCard label="Total production" value={`${formatQuantity(summary?.total_product_kg ?? 0)} KG`} icon={Gauge} accent="bg-amber-500/10 text-amber-400" />
      </div>

      <Card className="border-border bg-card text-card-foreground">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-36 space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Line</label>
            <Select value={line} onValueChange={(value) => updateFilter(setLine, value)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{['ALL', 'P1', 'P2', 'P3', 'P4'].map((value) => <SelectItem key={value} value={value}>{value === 'ALL' ? 'All lines' : value}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="min-w-36 space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</label>
            <Select value={status} onValueChange={(value) => updateFilter(setStatus, value)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                <SelectItem value="RUNNING">Running</SelectItem>
                <SelectItem value="COMPLETED">Completed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Start date & time</label>
            <Input type="datetime-local" step="60" value={startDate} onChange={(event) => updateFilter(setStartDate, event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">End date & time</label>
            <Input type="datetime-local" step="60" value={endDate} min={startDate || undefined} onChange={(event) => updateFilter(setEndDate, event.target.value)} />
          </div>
          <div className="min-w-52 flex-1 space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Search</label>
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input className="pl-9" placeholder="Order, source, destination…" value={search} onChange={(event) => updateFilter(setSearch, event.target.value)} />
            </div>
          </div>
          <Button variant="outline" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
          <Button variant="outline" onClick={() => void runExport('print')} disabled={loading || exporting || items.length === 0} data-testid="pallet-print">
            <Printer className="mr-2 h-4 w-4" /> {selection.count > 0 ? `Print selected (${selection.count})` : 'Print'}
          </Button>
          <Button variant="outline" onClick={() => void runExport('excel')} disabled={loading || exporting || items.length === 0} data-testid="pallet-excel">
            <FileSpreadsheet className="mr-2 h-4 w-4" /> {selection.count > 0 ? `Export selected (${selection.count})` : 'Export Excel'}
          </Button>
        </CardContent>
      </Card>

      {error && <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{error}</AlertDescription></Alert>}

      <Card className="overflow-hidden border-border bg-card text-card-foreground">
        <div className="border-b border-border px-4 py-3 text-lg font-bold">Production information</div>
        <div className="max-h-[56vh] overflow-auto">
          <Table className="pallet-report-table min-w-[1100px] border-collapse">
            <TableHeader className="pallet-report-table-head sticky top-0 z-10">
              <TableRow>
                <TableHead className="w-10 border px-3 py-3">
                  <input
                    type="checkbox"
                    aria-label="Select all shown production runs"
                    className="h-4 w-4 cursor-pointer accent-cyan-500"
                    checked={selection.allSelected}
                    onChange={selection.toggleAll}
                    disabled={items.length === 0}
                  />
                </TableHead>
                {HISTORY_HEADINGS.map((heading) => (
                  <TableHead key={heading} className="whitespace-nowrap border px-3 py-3 font-semibold">{heading}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? Array.from({ length: 4 }).map((_, index) => (
                <TableRow key={index}>{Array.from({ length: HISTORY_HEADINGS.length + 1 }).map((__, cell) => <TableCell key={cell} className="border py-4"><Skeleton className="h-5 w-20" /></TableCell>)}</TableRow>
              )) : items.length ? items.map((order) => {
                const sources = orderSources(order)
                const { bin1, bin2 } = orderDestinations(order)
                const running = order.status === 'RUNNING'
                const statusText = orderStatusText(order)
                return (
                  <TableRow key={rowKey(order)} className="align-top transition-colors" data-testid="pallet-row">
                    <TableCell className="border p-3">
                      <input
                        type="checkbox"
                        aria-label={`Select ${order.line} run ${order.id}`}
                        className="h-4 w-4 cursor-pointer accent-cyan-500"
                        checked={selection.selected.has(rowKey(order))}
                        onChange={() => selection.toggle(rowKey(order))}
                      />
                    </TableCell>
                    <TableCell className="border p-3 text-base font-bold">{order.line}</TableCell>
                    <TableCell className="whitespace-nowrap border p-3">
                      <Badge className={`border-transparent text-white ${statusText === 'Running' ? 'bg-emerald-600 hover:bg-emerald-600' : statusText === 'Paused' ? 'bg-amber-600 hover:bg-amber-600' : 'bg-blue-600 hover:bg-blue-600'}`} data-status={statusText}>{statusText}</Badge>
                    </TableCell>
                    <TableCell className="w-28 border p-3 text-sm">{formatTimestamp(order.actual_start_time)}</TableCell>
                    <TableCell className="w-28 border p-3 text-sm">{running ? 'Live' : formatTimestamp(order.actual_end_time)}</TableCell>
                    <TableCell className="whitespace-nowrap border p-3 text-sm leading-6">
                      <div><span className="text-muted-foreground">Bin 1:</span> <span className="font-medium">{displayTrail(bin1)}</span></div>
                      <div><span className="text-muted-foreground">Bin 2:</span> <span className="font-medium">{displayTrail(bin2)}</span></div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap border p-3 font-medium">{formatDuration(fullRunSeconds(order))}</TableCell>
                    <TableCell className="whitespace-nowrap border p-3 font-medium">{formatDuration(actualRunSeconds(order))}</TableCell>
                    <TableCell className="border p-3 text-sm">{order.id}</TableCell>
                    <TableCell className="whitespace-nowrap border p-3 font-medium">{displayTrail(sources)}</TableCell>
                    <TableCell className="border p-3">{order.material || '—'}</TableCell>
                    <TableCell className="border p-3">{order.production_name || '—'}</TableCell>
                    <TableCell className="whitespace-nowrap border p-3 text-base font-bold">{formatQuantity(order.product_kg)} KG</TableCell>
                  </TableRow>
                )
              }) : <TableRow><TableCell colSpan={HISTORY_HEADINGS.length + 1} className="h-36 border text-center text-muted-foreground">No production runs match these filters.</TableCell></TableRow>}
            </TableBody>
            {!loading && items.length > 0 && (
              <TableFooter className="pallet-report-total-row">
                <TableRow>
                  <TableCell colSpan={HISTORY_HEADINGS.length} className="border px-3 py-3 font-bold">Total</TableCell>
                  <TableCell className="whitespace-nowrap border px-3 py-3 text-base font-bold">{formatQuantity(summary?.total_product_kg ?? 0)} KG</TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4">
          <div className="flex items-center gap-3">
            <Select value={String(pagination.page_size)} onValueChange={(value) => setPagination((current) => ({ ...current, page: 1, page_size: Number(value) }))}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>{[25, 50, 100].map((size) => <SelectItem key={size} value={String(size)}>{size} per page</SelectItem>)}</SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">{pagination.total.toLocaleString()} production runs</span>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" disabled={loading || pagination.page <= 1} onClick={() => setPagination((current) => ({ ...current, page: current.page - 1 }))}><ChevronLeft className="mr-1 h-4 w-4" /> Previous</Button>
            <span className="text-sm text-foreground">Page {pagination.page} of {Math.max(1, pagination.pages)}</span>
            <Button variant="outline" size="sm" disabled={loading || pagination.page >= pagination.pages} onClick={() => setPagination((current) => ({ ...current, page: current.page + 1 }))}>Next <ChevronRight className="ml-1 h-4 w-4" /></Button>
          </div>
        </div>
      </Card>
    </div>
  )
}

function LiveCard({ line, item, timestamp }: { line: LineName; item?: PalletLine; timestamp?: string }) {
  const sources = item ? uniqueValues([item.source1, item.source2]) : []
  const destinations = item ? uniqueValues([item.destination1, item.destination2]) : []
  const sourceLabel = sources.length ? sources.join(' / ') : '—'
  const destinationLabel = destinations.length ? destinations.join(' / ') : '—'
  const running = Boolean(item?.running)
  const paused = Boolean(item?.paused)
  const stateLabel = running ? 'Running' : paused ? 'Paused' : 'Stopped'
  return (
    <Card className="pallet-live-card relative overflow-hidden border-slate-700/50 bg-slate-900/80">
      <div className={`pallet-live-status-bar absolute inset-x-0 top-0 h-1 ${running ? 'bg-emerald-500' : paused ? 'bg-amber-500' : 'bg-slate-600'}`} />
      <CardHeader className="pb-3 pt-5">
        <div className="flex items-center justify-between">
          <CardTitle className="pallet-live-card-title flex items-center gap-2 text-xl"><PackageSearch className="pallet-live-accent h-5 w-5 text-cyan-400" />{line}</CardTitle>
          {item ? <Badge data-running={running} data-paused={paused} className={`pallet-live-status-badge ${running ? 'bg-emerald-600 hover:bg-emerald-600' : paused ? 'bg-amber-600 hover:bg-amber-600' : 'bg-slate-600 hover:bg-slate-600'}`}><span className={`pallet-live-status-dot mr-1.5 h-2 w-2 rounded-full ${running ? 'bg-emerald-200 animate-pulse' : paused ? 'bg-amber-200' : 'bg-slate-300'}`} />{stateLabel}</Badge> : <Skeleton className="h-6 w-20" />}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="pallet-live-order-panel grid grid-cols-2 gap-3 rounded-lg border border-slate-700/50 bg-slate-950/35 p-3">
          <div><p className="pallet-live-label text-[10px] font-semibold uppercase tracking-wider text-slate-500">Current order</p><p className="pallet-live-order-value mt-1 text-xl font-bold text-cyan-400">{item?.current_order?.order_description || '—'}</p></div>
          <div className="text-right"><p className="pallet-live-label text-[10px] font-semibold uppercase tracking-wider text-slate-500">Quantity</p><p className="pallet-live-quantity mt-1 text-xl font-bold text-amber-400">{formatQuantity(item?.quantity)} <span className="text-xs">KG</span></p></div>
        </div>

        <div className="pallet-live-route flex items-center justify-between gap-2 rounded-lg bg-slate-800/55 px-3 py-2.5 text-sm">
          <span className="pallet-live-source max-w-[35%] truncate font-semibold text-cyan-300">{sourceLabel}</span>
          <ArrowRight className="pallet-live-arrow h-4 w-4 shrink-0 text-slate-500" />
          <Badge variant="outline" className="pallet-live-line-badge shrink-0">{line}</Badge>
          <ArrowRight className="pallet-live-arrow h-4 w-4 shrink-0 text-slate-500" />
          <span className="pallet-live-destination max-w-[35%] truncate text-right font-semibold text-blue-300">{destinationLabel}</span>
        </div>

        <div className="grid grid-cols-2 gap-x-5 gap-y-3 text-sm">
          <div><p className="pallet-live-label flex items-center gap-1 text-xs text-slate-500"><MapPin className="h-3 w-3" /> Source</p><p className="pallet-live-detail-value mt-0.5 font-medium text-slate-200">{sourceLabel}</p></div>
          <div><p className="pallet-live-label flex items-center gap-1 text-xs text-slate-500"><MapPin className="h-3 w-3" /> Destination</p><p className="pallet-live-detail-value mt-0.5 font-medium text-slate-200">{destinationLabel}</p></div>
          <div><p className="pallet-live-label flex items-center gap-1 text-xs text-slate-500"><Clock3 className="h-3 w-3" /> Started</p><p className="pallet-live-detail-value mt-0.5 font-medium text-slate-200">{formatTimestamp(item?.current_order?.actual_start_time)}</p></div>
          <div><p className="pallet-live-label flex items-center gap-1 text-xs text-slate-500"><Timer className="h-3 w-3" /> Full run</p><p className="pallet-live-detail-value mt-0.5 font-medium text-slate-200" data-testid={`pallet-live-full-${line}`}>{item?.current_order ? formatDuration(item.current_order.full_run_seconds ?? item.current_order.elapsed_seconds) : '—'}</p></div>
          <div><p className="pallet-live-label flex items-center gap-1 text-xs text-slate-500"><Activity className="h-3 w-3" /> Actual run</p><p className="pallet-live-detail-value mt-0.5 font-medium text-slate-200" data-testid={`pallet-live-actual-${line}`}>{item?.current_order ? formatDuration(item.current_order.actual_run_seconds ?? item.current_order.elapsed_seconds) : '—'}</p></div>
          <div><p className="pallet-live-label text-xs text-slate-500">Production</p><p className="pallet-live-muted-value mt-0.5 font-medium text-slate-400">{item?.production_name || 'Not mapped'}</p></div>
          {(line === 'P3' || line === 'P4') && <div><p className="pallet-live-label text-xs text-slate-500">Selection</p><p className="pallet-live-selection mt-0.5 font-medium text-violet-300">{item?.selection ?? '—'} · {selectionMeaning(item?.selection)}</p></div>}
        </div>
        <div className="pallet-live-footer border-t border-slate-700/50 pt-3 text-xs text-slate-500">Last updated: {formatTimestamp(timestamp)}</div>
      </CardContent>
    </Card>
  )
}

function LivePanel({ active }: { active: boolean }) {
  const [data, setData] = useState<LiveResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  usePolling(async (signal) => {
    try {
      const response = await fetch(API_ENDPOINTS.PALLET_REPORT.LIVE, { signal })
      const body = (await response.json()) as LiveResponse
      if (!response.ok || !body.success) throw new Error(body.error || 'Unable to retrieve live pallet data')
      setData(body)
      setError(null)
    } catch (cause) {
      if ((cause as { name?: string }).name !== 'AbortError') {
        setData(null)
        setError(cause instanceof Error ? cause.message : 'Unable to retrieve live pallet data')
      }
    }
  }, 3000, active)

  const runningCount = useMemo(() => data ? Object.values(data.lines).filter((line) => line.running).length : 0, [data])
  return (
    <div className="pallet-live-page space-y-4">
      <div className="pallet-live-monitor flex items-center justify-between rounded-lg border border-slate-700/50 bg-slate-900/60 px-4 py-3">
        <div className="flex items-center gap-2"><Activity className="pallet-live-accent h-4 w-4 text-cyan-400" /><span className="pallet-live-monitor-title text-sm font-medium">Live DB7 line monitor</span></div>
        <span className="pallet-live-monitor-summary text-sm text-slate-400"><strong className="pallet-live-running-count text-emerald-400">{runningCount}</strong> of 4 lines running</span>
      </div>
      {error && <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>PLC Offline — {error}. No placeholder values are being shown.</AlertDescription></Alert>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {(['P1', 'P2', 'P3', 'P4'] as LineName[]).map((line) => <LiveCard key={line} line={line} item={data?.lines[line]} timestamp={data?.timestamp} />)}
      </div>
    </div>
  )
}

export function PalletReport() {
  const [activeTab, setActiveTab] = useState('history')
  return (
    <WaterSystemLayout title="Pallet Report" subtitle="Live pallet movement and completed production orders">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-5">
        <div className="flex justify-center">
          <TabsList className="grid h-11 w-full max-w-md grid-cols-2 rounded-xl border border-slate-700/60 bg-slate-900/80 p-1 light:border-slate-200 light:bg-slate-100">
            <TabsTrigger value="history" className="rounded-lg data-[state=active]:bg-cyan-600 data-[state=active]:text-white">Pallet History</TabsTrigger>
            <TabsTrigger value="live" className="rounded-lg data-[state=active]:bg-cyan-600 data-[state=active]:text-white">Pallet Live</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="history" className="mt-0"><HistoryPanel /></TabsContent>
        <TabsContent value="live" className="mt-0"><LivePanel active={activeTab === 'live'} /></TabsContent>
      </Tabs>
    </WaterSystemLayout>
  )
}
