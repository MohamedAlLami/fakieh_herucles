import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Gauge,
  MapPin,
  PackageCheck,
  PackageSearch,
  PlayCircle,
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { API_ENDPOINTS } from '@/config/api'
import { usePolling } from '@/hooks/usePolling'
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

const selectionMeaning = (selection?: number | null) => {
  if (selection === 3) return 'P3'
  if (selection === 4) return 'P4'
  if (selection === 5) return 'Both'
  return '—'
}

function ValueTrail({ values }: { values: number[] }) {
  if (!values.length) return <span className="text-slate-500">—</span>
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {values.map((value, index) => (
        <span key={value} className="contents">
          {index > 0 && <ArrowRight className="h-3 w-3 text-slate-500" />}
          <Badge variant="outline" className="border-cyan-500/30 bg-cyan-500/10 text-cyan-300 light:text-cyan-700">
            {value}
          </Badge>
        </span>
      ))}
    </div>
  )
}
function KpiCard({ label, value, icon: Icon, accent }: {
  label: string
  value: string
  icon: typeof Activity
  accent: string
}) {
  return (
    <Card className="border-slate-700/50 bg-slate-900/70 light:border-gray-200 light:bg-white">
      <CardContent className="flex items-center justify-between p-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
          <p className="mt-1 text-2xl font-bold text-slate-100 light:text-slate-900">{value}</p>
        </div>
        <div className={`rounded-xl p-2.5 ${accent}`}><Icon className="h-5 w-5" /></div>
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
      const [ordersResponse, summaryResponse] = await Promise.all([
        fetch(`${API_ENDPOINTS.PALLET_REPORT.HISTORY}?${requestParams(true)}`, { signal }),
        fetch(`${API_ENDPOINTS.PALLET_REPORT.SUMMARY}?${requestParams(false)}`, { signal }),
      ])
      const ordersBody = (await ordersResponse.json()) as HistoryResponse
      const summaryBody = (await summaryResponse.json()) as SummaryResponse
      if (!ordersResponse.ok || !ordersBody.success) {
        throw new Error(ordersBody.error || 'Unable to load pallet orders')
      }
      if (!summaryResponse.ok || !summaryBody.success) {
        throw new Error(summaryBody.error || 'Unable to load pallet summary')
      }
      setItems(ordersBody.items)
      setPagination(ordersBody.pagination)
      setSummary(summaryBody)
    } catch (cause) {
      if ((cause as { name?: string }).name !== 'AbortError') {
        setError(cause instanceof Error ? cause.message : 'Unable to load pallet orders')
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

      <Card className="border-slate-700/50 bg-slate-900/70 light:border-gray-200 light:bg-white">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-36 space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Line</label>
            <Select value={line} onValueChange={(value) => updateFilter(setLine, value)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{['ALL', 'P1', 'P2', 'P3', 'P4'].map((value) => <SelectItem key={value} value={value}>{value === 'ALL' ? 'All lines' : value}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="min-w-36 space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status</label>
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
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Start date & time</label>
            <Input type="datetime-local" step="60" value={startDate} onChange={(event) => updateFilter(setStartDate, event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">End date & time</label>
            <Input type="datetime-local" step="60" value={endDate} min={startDate || undefined} onChange={(event) => updateFilter(setEndDate, event.target.value)} />
          </div>
          <div className="min-w-52 flex-1 space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">Search</label>
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
              <Input className="pl-9" placeholder="Order, source, destination…" value={search} onChange={(event) => updateFilter(setSearch, event.target.value)} />
            </div>
          </div>
          <Button variant="outline" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </CardContent>
      </Card>

      {error && <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{error}</AlertDescription></Alert>}

      <Card className="overflow-hidden border-slate-700/50 bg-slate-900/70 light:border-gray-200 light:bg-white">
        <div className="max-h-[56vh] overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-slate-800 light:bg-slate-100">
              <TableRow>
                {['Batch Information', 'Order Description', 'Source', 'Production Name', 'Product KG', 'Selection'].map((heading) => <TableHead key={heading} className="whitespace-nowrap py-3">{heading}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? Array.from({ length: 4 }).map((_, index) => (
                <TableRow key={index}>{Array.from({ length: 6 }).map((__, cell) => <TableCell key={cell} className="py-5"><Skeleton className="h-12 w-28" /></TableCell>)}</TableRow>
              )) : items.length ? items.map((order) => {
                const movements = order.movements.length ? order.movements : [{ ...order, id: order.id, quantity: order.product_kg, observed_at: order.actual_start_time }]
                const sources = uniqueValues(movements.flatMap((movement) => [movement.source1, movement.source2]))
                const destination1 = uniqueValues(movements.map((movement) => movement.destination1))
                const destination2 = uniqueValues(movements.map((movement) => movement.destination2))
                const running = order.status === 'RUNNING'
                return (
                  <TableRow key={order.id} className="align-top transition-colors hover:bg-slate-800/40 light:hover:bg-slate-50">
                    <TableCell className="min-w-[290px] py-4">
                      <div className="space-y-3 rounded-lg border border-slate-700/50 bg-slate-950/35 p-3 light:border-slate-200 light:bg-slate-50">
                        <div className="flex items-center gap-2">
                          <Badge className="bg-cyan-600 hover:bg-cyan-600">{order.line}</Badge>
                          <Badge className={running ? 'bg-emerald-600 hover:bg-emerald-600' : 'bg-slate-600 hover:bg-slate-600'}>{running ? 'Running' : 'Completed'}</Badge>
                        </div>
                        <div className="grid grid-cols-2 gap-x-5 gap-y-2 text-xs">
                          <div><span className="block text-slate-500">Actual start</span><span className="text-slate-200 light:text-slate-800">{formatTimestamp(order.actual_start_time)}</span></div>
                          <div><span className="block text-slate-500">Actual end</span><span className="text-slate-200 light:text-slate-800">{running ? 'Live' : formatTimestamp(order.actual_end_time)}</span></div>
                          <div><span className="block text-slate-500">Destination 1</span><ValueTrail values={destination1} /></div>
                          <div><span className="block text-slate-500">Destination 2</span><ValueTrail values={destination2} /></div>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-slate-400"><Timer className="h-3.5 w-3.5" /> Duration: <span className="font-medium text-slate-200 light:text-slate-800">{running ? 'Live · ' : ''}{formatDuration(order.duration_seconds)}</span></div>
                      </div>
                    </TableCell>
                    <TableCell className="min-w-36 py-5"><div className="text-2xl font-bold text-cyan-400">{order.order_description}</div><div className="mt-1 text-xs text-slate-500">{order.line} Order #{order.order_sequence}</div></TableCell>
                    <TableCell className="min-w-36 py-5"><ValueTrail values={sources} /></TableCell>
                    <TableCell className="min-w-36 py-5"><span className="text-slate-500">{order.production_name || 'Not mapped'}</span><div className="mt-1 text-xs text-slate-500">Material: {order.material || '—'}</div></TableCell>
                    <TableCell className="min-w-36 py-5"><div className="text-xl font-bold text-amber-400 light:text-amber-700">{formatQuantity(order.product_kg)}</div><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">KG</div></TableCell>
                    <TableCell className="min-w-28 py-5">
                      {order.line === 'P1' || order.line === 'P2' || order.selection == null ? <span className="text-slate-500">—</span> : <><Badge variant="outline" className="border-violet-500/40 text-violet-300 light:text-violet-700">{order.selection}</Badge><div className="mt-1 text-xs text-slate-500">{selectionMeaning(order.selection)}</div></>}
                    </TableCell>
                  </TableRow>
                )
              }) : <TableRow><TableCell colSpan={6} className="h-36 text-center text-slate-400">No pallet orders match these filters.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-700/50 p-4 light:border-gray-200">
          <div className="flex items-center gap-3">
            <Select value={String(pagination.page_size)} onValueChange={(value) => setPagination((current) => ({ ...current, page: 1, page_size: Number(value) }))}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>{[25, 50, 100].map((size) => <SelectItem key={size} value={String(size)}>{size} per page</SelectItem>)}</SelectContent>
            </Select>
            <span className="text-sm text-slate-500">{pagination.total.toLocaleString()} orders</span>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" disabled={loading || pagination.page <= 1} onClick={() => setPagination((current) => ({ ...current, page: current.page - 1 }))}><ChevronLeft className="mr-1 h-4 w-4" /> Previous</Button>
            <span className="text-sm text-slate-300 light:text-gray-700">Page {pagination.page} of {Math.max(1, pagination.pages)}</span>
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
  return (
    <Card className="relative overflow-hidden border-slate-700/50 bg-slate-900/80 light:border-gray-200 light:bg-white">
      <div className={`absolute inset-x-0 top-0 h-1 ${running ? 'bg-emerald-500' : 'bg-slate-600'}`} />
      <CardHeader className="pb-3 pt-5">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-xl"><PackageSearch className="h-5 w-5 text-cyan-400" />{line}</CardTitle>
          {item ? <Badge className={running ? 'bg-emerald-600 hover:bg-emerald-600' : 'bg-slate-600 hover:bg-slate-600'}><span className={`mr-1.5 h-2 w-2 rounded-full ${running ? 'bg-emerald-200 animate-pulse' : 'bg-slate-300'}`} />{running ? 'Running' : 'Stopped'}</Badge> : <Skeleton className="h-6 w-20" />}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-700/50 bg-slate-950/35 p-3 light:border-slate-200 light:bg-slate-50">
          <div><p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Current order</p><p className="mt-1 text-xl font-bold text-cyan-400">{item?.current_order?.order_description || '—'}</p></div>
          <div className="text-right"><p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Quantity</p><p className="mt-1 text-xl font-bold text-amber-400 light:text-amber-700">{formatQuantity(item?.quantity)} <span className="text-xs">KG</span></p></div>
        </div>

        <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-800/55 px-3 py-2.5 text-sm light:bg-slate-100">
          <span className="max-w-[35%] truncate font-semibold text-cyan-300 light:text-cyan-700">{sourceLabel}</span>
          <ArrowRight className="h-4 w-4 shrink-0 text-slate-500" />
          <Badge variant="outline" className="shrink-0">{line}</Badge>
          <ArrowRight className="h-4 w-4 shrink-0 text-slate-500" />
          <span className="max-w-[35%] truncate text-right font-semibold text-blue-300 light:text-blue-700">{destinationLabel}</span>
        </div>

        <div className="grid grid-cols-2 gap-x-5 gap-y-3 text-sm">
          <div><p className="flex items-center gap-1 text-xs text-slate-500"><MapPin className="h-3 w-3" /> Source</p><p className="mt-0.5 font-medium text-slate-200 light:text-slate-800">{sourceLabel}</p></div>
          <div><p className="flex items-center gap-1 text-xs text-slate-500"><MapPin className="h-3 w-3" /> Destination</p><p className="mt-0.5 font-medium text-slate-200 light:text-slate-800">{destinationLabel}</p></div>
          <div><p className="flex items-center gap-1 text-xs text-slate-500"><Clock3 className="h-3 w-3" /> Started</p><p className="mt-0.5 font-medium text-slate-200 light:text-slate-800">{formatTimestamp(item?.current_order?.actual_start_time)}</p></div>
          <div><p className="flex items-center gap-1 text-xs text-slate-500"><Timer className="h-3 w-3" /> Elapsed</p><p className="mt-0.5 font-medium text-slate-200 light:text-slate-800">{item?.current_order ? formatDuration(item.current_order.elapsed_seconds) : '—'}</p></div>
          <div><p className="text-xs text-slate-500">Production</p><p className="mt-0.5 font-medium text-slate-400">{item?.production_name || 'Not mapped'}</p></div>
          {(line === 'P3' || line === 'P4') && <div><p className="text-xs text-slate-500">Selection</p><p className="mt-0.5 font-medium text-violet-300 light:text-violet-700">{item?.selection ?? '—'} · {selectionMeaning(item?.selection)}</p></div>}
        </div>
        <div className="border-t border-slate-700/50 pt-3 text-xs text-slate-500 light:border-slate-200">Last updated: {formatTimestamp(timestamp)}</div>
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
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-lg border border-slate-700/50 bg-slate-900/60 px-4 py-3 light:border-gray-200 light:bg-white">
        <div className="flex items-center gap-2"><Activity className="h-4 w-4 text-cyan-400" /><span className="text-sm font-medium">Live DB7 line monitor</span></div>
        <span className="text-sm text-slate-400"><strong className="text-emerald-400">{runningCount}</strong> of 4 lines running</span>
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
