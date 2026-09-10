import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, ChevronLeft, ChevronRight, PackageSearch, RefreshCw } from 'lucide-react'

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
import { formatSaudiTime } from '@/utils/timezone'

type LineName = 'P1' | 'P2' | 'P3' | 'P4'

interface PalletLine {
  line: LineName
  source1: number
  source2: number | null
  destination1: number | null
  destination2: number | null
  quantity: number
  running: boolean
  selection?: number
  selected?: boolean
}

interface HistoryItem extends PalletLine {
  id: number
  recorded_at: string
  created_at: string
}

interface HistoryResponse {
  success: boolean
  items: HistoryItem[]
  pagination: { page: number; page_size: number; total: number; pages: number }
  error?: string
}

interface LiveResponse {
  success: boolean
  timestamp: string
  lines: Record<LineName, PalletLine>
  error?: string
}

const formatTimestamp = (value?: string) => value ? formatSaudiTime(value, true) : '—'

const displayValue = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : value.toLocaleString()

function HistoryPanel() {
  const [items, setItems] = useState<HistoryItem[]>([])
  const [pagination, setPagination] = useState({ page: 1, page_size: 50, total: 0, pages: 0 })
  const [line, setLine] = useState('ALL')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const loadHistory = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        page: String(pagination.page),
        page_size: String(pagination.page_size),
        line,
      })
      if (startDate) params.set('start_date', startDate)
      if (endDate) params.set('end_date', endDate)
      const response = await fetch(`${API_ENDPOINTS.PALLET_REPORT.HISTORY}?${params}`, { signal })
      const body = (await response.json()) as HistoryResponse
      if (!response.ok || !body.success) throw new Error(body.error || 'Unable to load pallet history')
      setItems(body.items)
      setPagination(body.pagination)
    } catch (cause) {
      if ((cause as { name?: string }).name !== 'AbortError') {
        setError(cause instanceof Error ? cause.message : 'Unable to load pallet history')
      }
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [pagination.page, pagination.page_size, line, startDate, endDate, refreshKey])

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
      <Card className="border-slate-700/50 bg-slate-900/70 light:border-gray-200 light:bg-white">
        <CardContent className="flex flex-wrap items-end gap-4 p-4">
          <div className="min-w-40 space-y-1.5">
            <label className="text-sm font-medium text-slate-300 light:text-gray-700">Line</label>
            <Select value={line} onValueChange={(value) => updateFilter(setLine, value)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {['ALL', 'P1', 'P2', 'P3', 'P4'].map((value) => (
                  <SelectItem key={value} value={value}>{value === 'ALL' ? 'All lines' : value}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-slate-300 light:text-gray-700">Start date</label>
            <Input type="date" value={startDate} onChange={(event) => updateFilter(setStartDate, event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-slate-300 light:text-gray-700">End date</label>
            <Input type="date" value={endDate} min={startDate || undefined} onChange={(event) => updateFilter(setEndDate, event.target.value)} />
          </div>
          <Button variant="outline" onClick={() => setRefreshKey((value) => value + 1)} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
          <span className="ml-auto text-sm text-slate-400 light:text-gray-500">
            {pagination.total.toLocaleString()} running samples
          </span>
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{error}</AlertDescription></Alert>
      )}

      <Card className="overflow-hidden border-slate-700/50 bg-slate-900/70 light:border-gray-200 light:bg-white">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {['Time', 'Line', 'Source 1', 'Source 2', 'Destination 1', 'Destination 2', 'Quantity', 'Selection'].map((heading) => (
                  <TableHead key={heading} className="whitespace-nowrap">{heading}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? Array.from({ length: 6 }).map((_, index) => (
                <TableRow key={index}>{Array.from({ length: 8 }).map((__, cell) => <TableCell key={cell}><Skeleton className="h-5 w-20" /></TableCell>)}</TableRow>
              )) : items.length ? items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="whitespace-nowrap text-slate-300 light:text-gray-700">{formatTimestamp(item.recorded_at)}</TableCell>
                  <TableCell><Badge className="bg-cyan-600 hover:bg-cyan-600">{item.line}</Badge></TableCell>
                  <TableCell>{displayValue(item.source1)}</TableCell>
                  <TableCell>{displayValue(item.source2)}</TableCell>
                  <TableCell>{displayValue(item.destination1)}</TableCell>
                  <TableCell>{displayValue(item.destination2)}</TableCell>
                  <TableCell className="font-medium text-amber-400 light:text-amber-700">{displayValue(item.quantity)}</TableCell>
                  <TableCell>{displayValue(item.selection)}</TableCell>
                </TableRow>
              )) : (
                <TableRow><TableCell colSpan={8} className="h-32 text-center text-slate-400">No running pallet samples match these filters.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-700/50 p-4 light:border-gray-200">
          <Select value={String(pagination.page_size)} onValueChange={(value) => setPagination((current) => ({ ...current, page: 1, page_size: Number(value) }))}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>{[25, 50, 100].map((size) => <SelectItem key={size} value={String(size)}>{size} per page</SelectItem>)}</SelectContent>
          </Select>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" disabled={loading || pagination.page <= 1} onClick={() => setPagination((current) => ({ ...current, page: current.page - 1 }))}>
              <ChevronLeft className="mr-1 h-4 w-4" /> Previous
            </Button>
            <span className="text-sm text-slate-300 light:text-gray-700">Page {pagination.page} of {Math.max(1, pagination.pages)}</span>
            <Button variant="outline" size="sm" disabled={loading || pagination.page >= pagination.pages} onClick={() => setPagination((current) => ({ ...current, page: current.page + 1 }))}>
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card>
    </div>
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
        setError(cause instanceof Error ? cause.message : 'Unable to retrieve live pallet data')
      }
    }
  }, 3000, active)

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{error}. Existing dashboard features remain available.</AlertDescription></Alert>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {(['P1', 'P2', 'P3', 'P4'] as LineName[]).map((line) => {
          const item = data?.lines[line]
          return (
            <Card key={line} className="border-slate-700/50 bg-slate-900/70 light:border-gray-200 light:bg-white">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
                <CardTitle className="flex items-center gap-2 text-xl"><PackageSearch className="h-5 w-5 text-cyan-400" />{line}</CardTitle>
                {item ? <Badge className={item.running ? 'bg-emerald-600 hover:bg-emerald-600' : 'bg-slate-600 hover:bg-slate-600'}>{item.running ? 'Running' : 'Stopped'}</Badge> : <Skeleton className="h-6 w-20" />}
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {[
                  ['Source 1', item?.source1],
                  ['Source 2', item?.source2],
                  ['Destination 1', item?.destination1],
                  ['Destination 2', item?.destination2],
                  ['Quantity', item?.quantity],
                  ...(line === 'P3' || line === 'P4' ? [['Selection', item?.selection]] : []),
                ].map(([label, value]) => (
                  <div key={String(label)} className="flex justify-between gap-4 border-b border-slate-700/40 pb-2 last:border-0 light:border-gray-200">
                    <span className="text-slate-400 light:text-gray-500">{label}</span>
                    <span className="font-medium text-slate-100 light:text-gray-900">{item ? displayValue(value as number | null | undefined) : '—'}</span>
                  </div>
                ))}
                <p className="pt-1 text-xs text-slate-500">Last updated: {formatTimestamp(data?.timestamp)}</p>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

export function PalletReport() {
  const [activeTab, setActiveTab] = useState('history')
  return (
    <WaterSystemLayout title="Pallet Report" subtitle="DB7 pallet historian and live production-line status">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-5">
        <div className="flex justify-center">
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="history">Pallet History</TabsTrigger>
            <TabsTrigger value="live">Pallet Live</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="history" className="mt-0"><HistoryPanel /></TabsContent>
        <TabsContent value="live" className="mt-0"><LivePanel active={activeTab === 'live'} /></TabsContent>
      </Tabs>
    </WaterSystemLayout>
  )
}
