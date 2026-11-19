import React, { useState, useEffect } from 'react'
import { WaterSystemLayout } from '@/components/water-system/WaterSystemLayout'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CalendarIcon, Search, Filter, Download, RefreshCw, Clock, CheckCircle, XCircle, AlertCircle, Printer, FileSpreadsheet } from 'lucide-react'
import { format } from 'date-fns'
import axios from 'axios'
import { cn } from '@/lib/utils'
import { API_BASE_URL } from '../../config/api'
import { printTable, rowsToPrint } from '@/utils/printTable'
import { useRowSelection } from '@/hooks/useRowSelection'
import { exportTableToExcel, type ExportColumn } from '@/utils/exportTable'

const baseUrl = API_BASE_URL

interface OrderData {
  id: number
  badgeNo: string
  sourceMaterialCode: string
  declaredQuantityKG: number
  destinationSilo1: string
  destinationSilo2: string
  statusWord: string
  line: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  idleAt?: string
  updatedAt: string
  isComplete: boolean
  // Additional fields for different order types
  sourceSilo?: string
  cc25Sel?: string
  scaleSel?: string
  pitNo?: string
  rawCode?: string
  rfidSet?: string
  activDestSet?: string
  // Resolved material names returned by the backend `to_dict()` for every
  // order model (see Backend/models/orders.py) — optional because bulk/pit
  // rows do not populate all of them.
  sourceMaterialName?: string
  rawMaterialName?: string
  destinationSilo1MaterialName?: string
  destinationSilo2MaterialName?: string
}

interface OrdersResponse {
  ok: boolean
  total_orders: number
  active_orders: number
  completed_orders: number
  filters: {
    type: string
    from?: string
    to?: string
  }
  orders: {
    intake: OrderData[]
    outloading: OrderData[]
    bulk: OrderData[]
    pit: OrderData[]
  }
  timestamp: string
}

export function OrderHistory() {
  const [orders, setOrders] = useState<OrdersResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState('intake-line-1')
  const [searchTerm, setSearchTerm] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState<Date | undefined>()
  const [dateTo, setDateTo] = useState<Date | undefined>()

  // Action handlers

  const handleDeleteOrder = async (order: OrderData) => {
    if (!confirm(`Are you sure you want to delete order ${order.badgeNo || order.id}?`)) {
      return
    }
    
    try {
      const response = await axios.delete(`${baseUrl}/orders/${order.id}`)
      if (response.status === 200) {
        // Refresh the orders list
        fetchOrders()
        }
    } catch (error) {
      
      alert('Failed to delete order')
    }
  }

  const fetchOrders = async () => {
    try {
      setLoading(true)
      setError(null)
      
      const params = new URLSearchParams()
      if (activeTab !== 'all') {
        params.append('type', activeTab)
      }
      if (dateFrom) {
        params.append('from', dateFrom.toISOString())
      }
      if (dateTo) {
        params.append('to', dateTo.toISOString())
      }

      const response = await axios.get(`${baseUrl}/orders/history?${params.toString()}`)
      setOrders(response.data)
    } catch (err) {
      
      setError('Failed to fetch orders. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchOrders()
  }, [activeTab, dateFrom, dateTo])

  const getStatusBadge = (order: OrderData) => {
    if (order.isComplete) {
      return <Badge variant="default" className="bg-green-600 hover:bg-green-700"><CheckCircle className="w-3 h-3 mr-1" />Completed</Badge>
    } else if (order.statusWord === '1') {
      return <Badge variant="secondary" className="bg-yellow-600 hover:bg-yellow-700"><Clock className="w-3 h-3 mr-1" />Idle</Badge>
    } else if (['2', '6'].includes(order.statusWord)) {
      return <Badge variant="default" className="bg-blue-600 hover:bg-blue-700"><AlertCircle className="w-3 h-3 mr-1" />Running</Badge>
    } else {
      return <Badge variant="outline"><Clock className="w-3 h-3 mr-1" />Status: {order.statusWord}</Badge>
    }
  }

  const formatDateTime = (dateString?: string | null) => {
    if (!dateString) return 'N/A'
    return format(new Date(dateString), 'MMM dd, yyyy h:mm:ss a')
  }

  const getOrderTypeLabel = (order: OrderData, type: string) => {
    switch (type) {
      case 'intake':
        return `Intake Line ${order.line}`
      case 'outloading':
        return `Outloading Line ${order.line}`
      case 'bulk':
        return 'Bulk Line'
      case 'pit':
        return 'PIT Line'
      default:
        return 'Unknown'
    }
  }

  const filteredOrders = (orderList: OrderData[]) => {
    return orderList.filter(order => {
      const matchesSearch = searchTerm === '' || 
        order.badgeNo.toLowerCase().includes(searchTerm.toLowerCase()) ||
        order.sourceMaterialCode.toLowerCase().includes(searchTerm.toLowerCase()) ||
        order.destinationSilo1.toLowerCase().includes(searchTerm.toLowerCase()) ||
        order.destinationSilo2.toLowerCase().includes(searchTerm.toLowerCase())
      
      const matchesStatus = statusFilter === 'all' || 
        (statusFilter === 'active' && !order.isComplete) ||
        (statusFilter === 'completed' && order.isComplete)
      
      return matchesSearch && matchesStatus
    })
  }

  // Table rendering functions for different order types
  const renderIntakeTable = (data: OrderData[], title: string) => (
    <div className="bg-slate-950/50 light:bg-white border border-slate-700/30 light:border-gray-200 rounded-lg backdrop-blur-sm light:shadow-lg">
      <div className="p-6 border-b border-slate-700/30 light:border-gray-200">
        <h3 className="text-lg font-semibold text-white light:text-gray-900">{title}</h3>
      </div>
      <div className="p-6">
        <div className="rounded-md border border-slate-700/30 light:border-gray-200">
          <Table>
            <TableHeader>
              <TableRow className="border-slate-700/30 light:border-gray-200 hover:bg-slate-800/50 light:hover:bg-gray-50">
                <TableHead className="w-10">
                  <input type="checkbox" className="h-4 w-4 accent-cyan-500 cursor-pointer" aria-label="Select all shown rows" checked={selection.allSelected} onChange={selection.toggleAll} />
                </TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">RFID</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Source Material</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Quantity (KG)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Destination 1 (Material)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Destination 2 (Material)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Line</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Status</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Created</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Started</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Finished</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((order, index) => (
                <TableRow key={rowId(order)} className={`border-slate-700/30 light:border-gray-200 hover:bg-slate-800/30 light:hover:bg-gray-50 transition-colors ${index % 2 === 0 ? 'bg-slate-900/20 light:bg-gray-50' : 'bg-slate-800/10 light:bg-gray-100'}`}>
                  <TableCell className="w-10">
                    <input type="checkbox" className="h-4 w-4 accent-cyan-500 cursor-pointer" aria-label={`Select order ${order.badgeNo || order.sourceSilo || order.pitNo || order.id}`} checked={selection.selected.has(rowId(order))} onChange={() => selection.toggle(rowId(order))} />
                  </TableCell>
                  <TableCell className="text-cyan-400 light:text-blue-600 font-medium">{order.badgeNo || '-'}</TableCell>
                  <TableCell className="text-white light:text-gray-900">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-400 light:text-gray-500">{order.sourceMaterialCode || '-'}</span>
                      <span className="font-medium">{order.sourceMaterialName || '-'}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 light:bg-yellow-100 border border-yellow-500/20 light:border-yellow-300 text-yellow-400 light:text-yellow-600">
                      {order.declaredQuantityKG || 0}
                    </span>
                  </TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-400 light:text-gray-500">Silo {order.destinationSilo1 || '-'}</span>
                      <span className="font-medium">{order.destinationSilo1MaterialName || '-'}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-400 light:text-gray-500">Silo {order.destinationSilo2 || '-'}</span>
                      <span className="font-medium">{order.destinationSilo2MaterialName || '-'}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700">{order.line || '-'}</TableCell>
                  <TableCell>{getStatusBadge(order)}</TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700 text-xs">{formatDateTime(order.createdAt)}</TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700 text-xs">{formatDateTime(order.startedAt)}</TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700 text-xs">{formatDateTime(order.finishedAt)}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => handleDeleteOrder(order)} className="text-xs px-2 py-1 bg-red-600 text-white hover:bg-red-700 light:bg-red-600 light:text-white light:hover:bg-red-700">
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )

  const renderOutloadingTable = (data: OrderData[], title: string) => (
    <div className="bg-slate-950/50 light:bg-white border border-slate-700/30 light:border-gray-200 rounded-lg backdrop-blur-sm light:shadow-lg">
      <div className="p-6 border-b border-slate-700/30 light:border-gray-200">
        <h3 className="text-lg font-semibold text-white light:text-gray-900">{title}</h3>
      </div>
      <div className="p-6">
        <div className="rounded-md border border-slate-700/30 light:border-gray-200">
          <Table>
            <TableHeader>
              <TableRow className="border-slate-700/30 light:border-gray-200 hover:bg-slate-800/50 light:hover:bg-gray-50">
                <TableHead className="w-10">
                  <input type="checkbox" className="h-4 w-4 accent-cyan-500 cursor-pointer" aria-label="Select all shown rows" checked={selection.allSelected} onChange={selection.toggleAll} />
                </TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">RFID</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Source Material</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Quantity (KG)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Destination 1 (Material)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Destination 2 (Material)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Line</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Status</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Created</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Started</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Finished</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((order, index) => (
                <TableRow key={rowId(order)} className={`border-slate-700/30 light:border-gray-200 hover:bg-slate-800/30 light:hover:bg-gray-50 transition-colors ${index % 2 === 0 ? 'bg-slate-900/20 light:bg-gray-50' : 'bg-slate-800/10 light:bg-gray-100'}`}>
                  <TableCell className="w-10">
                    <input type="checkbox" className="h-4 w-4 accent-cyan-500 cursor-pointer" aria-label={`Select order ${order.badgeNo || order.sourceSilo || order.pitNo || order.id}`} checked={selection.selected.has(rowId(order))} onChange={() => selection.toggle(rowId(order))} />
                  </TableCell>
                  <TableCell className="text-cyan-400 light:text-blue-600 font-medium">{order.badgeNo || '-'}</TableCell>
                  <TableCell className="text-white light:text-gray-900">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-400 light:text-gray-500">{order.sourceMaterialCode || '-'}</span>
                      <span className="font-medium">{order.sourceMaterialName || '-'}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 light:bg-yellow-100 border border-yellow-500/20 light:border-yellow-300 text-yellow-400 light:text-yellow-600">
                      {order.declaredQuantityKG || 0}
                    </span>
                  </TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-400 light:text-gray-500">Silo {order.destinationSilo1 || '-'}</span>
                      <span className="font-medium">{order.destinationSilo1MaterialName || '-'}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-400 light:text-gray-500">Silo {order.destinationSilo2 || '-'}</span>
                      <span className="font-medium">{order.destinationSilo2MaterialName || '-'}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700">{order.line || '-'}</TableCell>
                  <TableCell>{getStatusBadge(order)}</TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700 text-xs">{formatDateTime(order.createdAt)}</TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700 text-xs">{formatDateTime(order.startedAt)}</TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700 text-xs">{formatDateTime(order.finishedAt)}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => handleDeleteOrder(order)} className="text-xs px-2 py-1 bg-red-600 text-white hover:bg-red-700 light:bg-red-600 light:text-white light:hover:bg-red-700">
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )

  const renderBulkTable = (data: OrderData[], title: string) => (
    <div className="bg-slate-950/50 light:bg-white border border-slate-700/30 light:border-gray-200 rounded-lg backdrop-blur-sm light:shadow-lg">
      <div className="p-6 border-b border-slate-700/30 light:border-gray-200">
        <h3 className="text-lg font-semibold text-white light:text-gray-900">{title}</h3>
      </div>
      <div className="p-6">
        <div className="rounded-md border border-slate-700/30 light:border-gray-200">
          <Table>
            <TableHeader>
              <TableRow className="border-slate-700/30 light:border-gray-200 hover:bg-slate-800/50 light:hover:bg-gray-50">
                <TableHead className="w-10">
                  <input type="checkbox" className="h-4 w-4 accent-cyan-500 cursor-pointer" aria-label="Select all shown rows" checked={selection.allSelected} onChange={selection.toggleAll} />
                </TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Source Silo</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Source Material</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Quantity (KG)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Destination 1 (Material)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Destination 2 (Material)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">CC25 Sel</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Scale Sel</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Status</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Created</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Started</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Finished</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((order, index) => (
                <TableRow key={rowId(order)} className={`border-slate-700/30 light:border-gray-200 hover:bg-slate-800/30 light:hover:bg-gray-50 transition-colors ${index % 2 === 0 ? 'bg-slate-900/20 light:bg-gray-50' : 'bg-slate-800/10 light:bg-gray-100'}`}>
                  <TableCell className="w-10">
                    <input type="checkbox" className="h-4 w-4 accent-cyan-500 cursor-pointer" aria-label={`Select order ${order.badgeNo || order.sourceSilo || order.pitNo || order.id}`} checked={selection.selected.has(rowId(order))} onChange={() => selection.toggle(rowId(order))} />
                  </TableCell>
                  <TableCell className="text-cyan-400 light:text-blue-600 font-medium">{order.sourceSilo || '-'}</TableCell>
                  <TableCell className="text-white light:text-gray-900">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-400 light:text-gray-500">{order.sourceMaterialCode || '-'}</span>
                      <span className="font-medium">{order.sourceMaterialName || '-'}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 light:bg-yellow-100 border border-yellow-500/20 light:border-yellow-300 text-yellow-400 light:text-yellow-600">
                      {order.declaredQuantityKG || 0}
                    </span>
                  </TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-400 light:text-gray-500">Silo {order.destinationSilo1 || '-'}</span>
                      <span className="font-medium">{order.destinationSilo1MaterialName || '-'}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-400 light:text-gray-500">Silo {order.destinationSilo2 || '-'}</span>
                      <span className="font-medium">{order.destinationSilo2MaterialName || '-'}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700">{order.cc25Sel || '-'}</TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700">{order.scaleSel || '-'}</TableCell>
                  <TableCell>{getStatusBadge(order)}</TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700 text-xs">{formatDateTime(order.createdAt)}</TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700 text-xs">{formatDateTime(order.startedAt)}</TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700 text-xs">{formatDateTime(order.finishedAt)}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => handleDeleteOrder(order)} className="text-xs px-2 py-1 bg-red-600 text-white hover:bg-red-700 light:bg-red-600 light:text-white light:hover:bg-red-700">
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )

  const renderPitTable = (data: OrderData[], title: string) => (
    <div className="bg-slate-950/50 light:bg-white border border-slate-700/30 light:border-gray-200 rounded-lg backdrop-blur-sm light:shadow-lg">
      <div className="p-6 border-b border-slate-700/30 light:border-gray-200">
        <h3 className="text-lg font-semibold text-white light:text-gray-900">{title}</h3>
      </div>
      <div className="p-6">
        <div className="rounded-md border border-slate-700/30 light:border-gray-200">
          <Table>
            <TableHeader>
              <TableRow className="border-slate-700/30 light:border-gray-200 hover:bg-slate-800/50 light:hover:bg-gray-50">
                <TableHead className="w-10">
                  <input type="checkbox" className="h-4 w-4 accent-cyan-500 cursor-pointer" aria-label="Select all shown rows" checked={selection.allSelected} onChange={selection.toggleAll} />
                </TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">PIT No</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Raw Material</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Quantity (KG)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Destination 1 (Material)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Destination 2 (Material)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Scale Sel</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Status</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Created</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Started</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Finished</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((order, index) => (
                <TableRow key={rowId(order)} className={`border-slate-700/30 light:border-gray-200 hover:bg-slate-800/30 light:hover:bg-gray-50 transition-colors ${index % 2 === 0 ? 'bg-slate-900/20 light:bg-gray-50' : 'bg-slate-800/10 light:bg-gray-100'}`}>
                  <TableCell className="w-10">
                    <input type="checkbox" className="h-4 w-4 accent-cyan-500 cursor-pointer" aria-label={`Select order ${order.badgeNo || order.sourceSilo || order.pitNo || order.id}`} checked={selection.selected.has(rowId(order))} onChange={() => selection.toggle(rowId(order))} />
                  </TableCell>
                  <TableCell className="text-cyan-400 light:text-blue-600 font-medium">{order.pitNo || '-'}</TableCell>
                  <TableCell className="text-white light:text-gray-900">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-400 light:text-gray-500">{order.rawCode || '-'}</span>
                      <span className="font-medium">{order.rawMaterialName || '-'}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 light:bg-yellow-100 border border-yellow-500/20 light:border-yellow-300 text-yellow-400 light:text-yellow-600">
                      {order.declaredQuantityKG || 0}
                    </span>
                  </TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-400 light:text-gray-500">Silo {order.destinationSilo1 || '-'}</span>
                      <span className="font-medium">{order.destinationSilo1MaterialName || '-'}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-400 light:text-gray-500">Silo {order.destinationSilo2 || '-'}</span>
                      <span className="font-medium">{order.destinationSilo2MaterialName || '-'}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700">{order.scaleSel || '-'}</TableCell>
                  <TableCell>{getStatusBadge(order)}</TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700 text-xs">{formatDateTime(order.createdAt)}</TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700 text-xs">{formatDateTime(order.startedAt)}</TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700 text-xs">{formatDateTime(order.finishedAt)}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => handleDeleteOrder(order)} className="text-xs px-2 py-1 bg-red-600 text-white hover:bg-red-700 light:bg-red-600 light:text-white light:hover:bg-red-700">
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )

  // Helper functions to filter orders by line
  const getOrdersByLine = (orderType: string, lineNumber: string | number) => {
    if (!orders) return []
    
    const lineNum = typeof lineNumber === 'string' ? parseInt(lineNumber) : lineNumber
    
    switch (orderType) {
      case 'intake':
        return orders.orders.intake.filter(order => order.line === lineNum.toString())
      case 'outloading':
        return orders.orders.outloading.filter(order => order.line === lineNum.toString())
      case 'bulk':
        return orders.orders.bulk
      case 'pit':
        return orders.orders.pit
      default:
        return []
    }
  }


  // ---- Print / row selection -------------------------------------------------
  type TabInfo = { type: 'intake' | 'outloading' | 'bulk' | 'pit'; line: number; title: string }
  const TAB_INFO: Record<string, TabInfo> = {
    'intake-line-1': { type: 'intake', line: 1, title: 'Intake Line 1 Orders' },
    'intake-line-2': { type: 'intake', line: 2, title: 'Intake Line 2 Orders' },
    'mineral-intake': { type: 'intake', line: 3, title: 'Mineral Intake Orders' },
    'outloading-1': { type: 'outloading', line: 1, title: 'Outloading 1 Orders' },
    'outloading-2': { type: 'outloading', line: 2, title: 'Outloading 2 Orders' },
    'outloading-3': { type: 'outloading', line: 3, title: 'Outloading 3 Orders' },
    'bulk-line': { type: 'bulk', line: 1, title: 'Bulk Line Orders' },
    'pt-line': { type: 'pit', line: 1, title: 'PIT Line Orders' },
  }
  const activeInfo: TabInfo | undefined = TAB_INFO[activeTab]

  // Rows currently rendered in the table of the active tab (nothing while loading / on error).
  const shownRows: OrderData[] = !activeInfo || loading || error
    ? []
    : filteredOrders(getOrdersByLine(activeInfo.type, activeInfo.line))

  // Unique and stable: order type + database id.
  const rowId = (order: OrderData) => `${activeInfo?.type ?? 'order'}-${order.id}`

  const selection = useRowSelection(shownRows.map(rowId))
  const [printError, setPrintError] = useState<string | null>(null)

  const statusText = (order: OrderData) => {
    if (order.isComplete) return 'Completed'
    if (order.statusWord === '1') return 'Idle'
    if (['2', '6'].includes(order.statusWord)) return 'Running'
    return `Status: ${order.statusWord}`
  }
  const materialText = (code?: string, name?: string) => [code, name].filter(Boolean).join(' ') || '-'
  const siloText = (silo?: string, name?: string) => `Silo ${silo || '-'} ${name || '-'}`

  const printColumns = (type: TabInfo['type']): ExportColumn<OrderData>[] => {
    const qty: ExportColumn<OrderData> = { header: 'Quantity (KG)', numeric: true, cell: o => o.declaredQuantityKG || 0, excel: o => Number(o.declaredQuantityKG) || 0 }
    const dest: ExportColumn<OrderData>[] = [
      { header: 'Destination 1 (Material)', cell: o => siloText(o.destinationSilo1, o.destinationSilo1MaterialName) },
      { header: 'Destination 2 (Material)', cell: o => siloText(o.destinationSilo2, o.destinationSilo2MaterialName) },
    ]
    const status: ExportColumn<OrderData> = { header: 'Status', cell: statusText }
    const times: ExportColumn<OrderData>[] = [
      { header: 'Created', cell: o => formatDateTime(o.createdAt) },
      { header: 'Started', cell: o => formatDateTime(o.startedAt) },
      { header: 'Finished', cell: o => formatDateTime(o.finishedAt) },
    ]
    if (type === 'bulk') {
      return [
        { header: 'Source Silo', cell: o => o.sourceSilo || '-' },
        { header: 'Source Material', cell: o => materialText(o.sourceMaterialCode, o.sourceMaterialName) },
        qty, ...dest,
        { header: 'CC25 Sel', cell: o => o.cc25Sel || '-' },
        { header: 'Scale Sel', cell: o => o.scaleSel || '-' },
        status, ...times,
      ]
    }
    if (type === 'pit') {
      return [
        { header: 'PIT No', cell: o => o.pitNo || '-' },
        { header: 'Raw Material', cell: o => materialText(o.rawCode, o.rawMaterialName) },
        qty, ...dest,
        { header: 'Scale Sel', cell: o => o.scaleSel || '-' },
        status, ...times,
      ]
    }
    return [
      { header: 'RFID', cell: o => o.badgeNo || '-' },
      { header: 'Source Material', cell: o => materialText(o.sourceMaterialCode, o.sourceMaterialName) },
      qty, ...dest,
      { header: 'Line', cell: o => o.line || '-' },
      status, ...times,
    ]
  }

  // What gets printed or exported: the ticked rows, or every row shown when none is ticked.
  const orderTable = () => {
    if (!activeInfo) return null
    const rows = rowsToPrint(shownRows, selection.selected, rowId)
    const columns = printColumns(activeInfo.type)
    const subtitles: string[] = [activeInfo.title]
    if (statusFilter === 'active') subtitles.push('Status: Active orders only')
    if (statusFilter === 'completed') subtitles.push('Status: Completed orders only')
    if (searchTerm.trim() !== '') subtitles.push(`Search: "${searchTerm.trim()}"`)
    if (dateFrom && dateTo) subtitles.push(`Date range: ${format(dateFrom, 'MMM dd, yyyy')} to ${format(dateTo, 'MMM dd, yyyy')}`)
    else if (dateFrom) subtitles.push(`From: ${format(dateFrom, 'MMM dd, yyyy')}`)
    else if (dateTo) subtitles.push(`Up to: ${format(dateTo, 'MMM dd, yyyy')}`)
    if (selection.count > 0) subtitles.push(`${rows.length} of ${shownRows.length} rows selected`)

    const total = Math.round(rows.reduce((sum, o) => sum + (Number(o.declaredQuantityKG) || 0), 0) * 100) / 100
    const qtyIndex = columns.findIndex(c => c.header === 'Quantity (KG)')
    const footer = columns.map((_, i) => (i === 0 ? `${rows.length} rows` : i === qtyIndex ? String(total) : ''))
    const excelFooter = columns.map((_, i) => (i === 0 ? `${rows.length} rows` : i === qtyIndex ? total : ''))
    return { rows, columns, subtitles, footer, excelFooter }
  }

  const handlePrint = async () => {
    const t = orderTable()
    if (!t || !activeInfo) return
    setPrintError(null)
    const err = await printTable<OrderData>({
      title: 'Order History',
      subtitles: t.subtitles,
      columns: t.columns,
      rows: t.rows,
      footer: t.footer,
      landscape: t.columns.length > 7,
    })
    if (err) setPrintError(err)
  }

  const handleExcel = async () => {
    const t = orderTable()
    if (!t || !activeInfo) return
    setPrintError(null)
    const err = await exportTableToExcel<OrderData>({
      title: 'Order History',
      subtitles: t.subtitles,
      columns: t.columns,
      rows: t.rows,
      footer: t.excelFooter,
      filename: `order-history_${activeTab}`,
      sheetName: activeInfo.title.slice(0, 31),
    })
    if (err) setPrintError(err)
  }

  const allOrders = orders ? [
    ...orders.orders.intake.map(order => ({ ...order, type: 'intake' })),
    ...orders.orders.outloading.map(order => ({ ...order, type: 'outloading' })),
    ...orders.orders.bulk.map(order => ({ ...order, type: 'bulk' })),
    ...orders.orders.pit.map(order => ({ ...order, type: 'pit' }))
  ] : []

  return (
    <WaterSystemLayout 
      title="Order History" 
      subtitle="Complete order history from PostgreSQL database"
    >
      <div className="space-y-6">
        {/* Header with Statistics */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="bg-slate-800/50 light:bg-white border-slate-700 light:border-gray-200">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-400 light:text-gray-600">Total Orders</p>
                  <p className="text-2xl font-bold text-white light:text-gray-900">{orders?.total_orders || 0}</p>
                </div>
                <div className="h-8 w-8 bg-blue-600 rounded-full flex items-center justify-center">
                  <Clock className="h-4 w-4 text-white" />
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card className="bg-slate-800/50 light:bg-white border-slate-700 light:border-gray-200">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-400 light:text-gray-600">Active Orders</p>
                  <p className="text-2xl font-bold text-yellow-400">{orders?.active_orders || 0}</p>
                </div>
                <div className="h-8 w-8 bg-yellow-600 rounded-full flex items-center justify-center">
                  <AlertCircle className="h-4 w-4 text-white" />
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card className="bg-slate-800/50 light:bg-white border-slate-700 light:border-gray-200">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-400 light:text-gray-600">Completed</p>
                  <p className="text-2xl font-bold text-green-400">{orders?.completed_orders || 0}</p>
                </div>
                <div className="h-8 w-8 bg-green-600 rounded-full flex items-center justify-center">
                  <CheckCircle className="h-4 w-4 text-white" />
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card className="bg-slate-800/50 light:bg-white border-slate-700 light:border-gray-200">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-400 light:text-gray-600">Completion Rate</p>
                  <p className="text-2xl font-bold text-cyan-400">
                    {orders?.total_orders ? Math.round((orders.completed_orders / orders.total_orders) * 100) : 0}%
                  </p>
                </div>
                <div className="h-8 w-8 bg-cyan-600 rounded-full flex items-center justify-center">
                  <XCircle className="h-4 w-4 text-white" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters and Search */}
        <Card className="bg-slate-800/50 light:bg-white border-slate-700 light:border-gray-200">
          <CardContent className="p-4">
            <div className="flex flex-col lg:flex-row gap-4">
              <div className="flex-1">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 h-4 w-4" />
                  <Input
                    placeholder="Search by badge, material, or destination..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-10 bg-slate-700/50 light:bg-gray-100 border-slate-600 light:border-gray-300 text-white light:text-gray-900"
                  />
                </div>
              </div>
              
              <div className="flex gap-2">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-32 bg-slate-700/50 light:bg-gray-100 border-slate-600 light:border-gray-300">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                  </SelectContent>
                </Select>
                
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="bg-slate-700/50 light:bg-gray-100 border-slate-600 light:border-gray-300">
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {dateFrom ? format(dateFrom, 'MMM dd') : 'From'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0">
                    <Calendar
                      mode="single"
                      selected={dateFrom}
                      onSelect={setDateFrom}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
                
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="bg-slate-700/50 light:bg-gray-100 border-slate-600 light:border-gray-300">
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {dateTo ? format(dateTo, 'MMM dd') : 'To'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0">
                    <Calendar
                      mode="single"
                      selected={dateTo}
                      onSelect={setDateTo}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
                
                <Button onClick={fetchOrders} variant="outline" className="bg-slate-700/50 light:bg-gray-100 border-slate-600 light:border-gray-300">
                  <RefreshCw className="h-4 w-4" />
                </Button>

                <Button onClick={handlePrint} disabled={shownRows.length === 0} variant="outline" className="bg-slate-700/50 light:bg-gray-100 border-slate-600 light:border-gray-300" data-testid={`order-history-${activeTab}-print`}>
                  <Printer className="mr-2 h-4 w-4" />
                  {selection.count > 0 ? `Print selected (${selection.count})` : 'Print'}
                </Button>

                <Button onClick={handleExcel} disabled={shownRows.length === 0} variant="outline" className="bg-slate-700/50 light:bg-gray-100 border-slate-600 light:border-gray-300" data-testid={`order-history-${activeTab}-excel`}>
                  <FileSpreadsheet className="mr-2 h-4 w-4" />
                  {selection.count > 0 ? `Export selected (${selection.count})` : 'Export Excel'}
                </Button>
              </div>
            </div>
            {printError && <p className="mt-3 text-sm text-red-400 light:text-red-600">{printError}</p>}
          </CardContent>
        </Card>

        {/* Orders Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-4 lg:grid-cols-8 bg-slate-800/50 light:bg-gray-100">
            <TabsTrigger value="intake-line-1" className="text-xs data-[state=active]:bg-cyan-600 data-[state=active]:text-white light:data-[state=active]:bg-cyan-600 light:data-[state=active]:text-white">INTAKE LINE 1</TabsTrigger>
            <TabsTrigger value="intake-line-2" className="text-xs data-[state=active]:bg-cyan-600 data-[state=active]:text-white light:data-[state=active]:bg-cyan-600 light:data-[state=active]:text-white">INTAKE LINE 2</TabsTrigger>
            <TabsTrigger value="mineral-intake" className="text-xs data-[state=active]:bg-cyan-600 data-[state=active]:text-white light:data-[state=active]:bg-cyan-600 light:data-[state=active]:text-white">Mineral Intake</TabsTrigger>
            <TabsTrigger value="outloading-1" className="text-xs data-[state=active]:bg-cyan-600 data-[state=active]:text-white light:data-[state=active]:bg-cyan-600 light:data-[state=active]:text-white">Outloading 1</TabsTrigger>
            <TabsTrigger value="outloading-2" className="text-xs data-[state=active]:bg-cyan-600 data-[state=active]:text-white light:data-[state=active]:bg-cyan-600 light:data-[state=active]:text-white">Outloading 2</TabsTrigger>
            <TabsTrigger value="outloading-3" className="text-xs data-[state=active]:bg-cyan-600 data-[state=active]:text-white light:data-[state=active]:bg-cyan-600 light:data-[state=active]:text-white">Outloading 3</TabsTrigger>
            <TabsTrigger value="bulk-line" className="text-xs data-[state=active]:bg-cyan-600 data-[state=active]:text-white light:data-[state=active]:bg-cyan-600 light:data-[state=active]:text-white">Bulk Line</TabsTrigger>
            <TabsTrigger value="pt-line" className="text-xs data-[state=active]:bg-cyan-600 data-[state=active]:text-white light:data-[state=active]:bg-cyan-600 light:data-[state=active]:text-white">PIT Line</TabsTrigger>
          </TabsList>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <RefreshCw className="h-8 w-8 animate-spin text-cyan-400 mx-auto mb-4" />
                <p className="text-slate-400 light:text-gray-600">Loading orders...</p>
              </div>
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <XCircle className="h-8 w-8 text-red-400 mx-auto mb-4" />
                <p className="text-red-400">{error}</p>
                <Button onClick={fetchOrders} className="mt-4">
                  Try Again
                </Button>
              </div>
            </div>
          ) : (
            <>
              <TabsContent value="intake-line-1" className="space-y-4">
                {(() => {
                  const intakeLine1Data = getOrdersByLine('intake', 1)
                  return filteredOrders(intakeLine1Data).length > 0 ? (
                    renderIntakeTable(filteredOrders(intakeLine1Data), "Intake Line 1 Orders")
                  ) : (
                    <div className="text-center py-12">
                      <p className="text-slate-400 light:text-gray-600">No Intake Line 1 orders found.</p>
                    </div>
                  )
                })()}
              </TabsContent>

              <TabsContent value="intake-line-2" className="space-y-4">
                {(() => {
                  const intakeLine2Data = getOrdersByLine('intake', 2)
                  return filteredOrders(intakeLine2Data).length > 0 ? (
                    renderIntakeTable(filteredOrders(intakeLine2Data), "Intake Line 2 Orders")
                  ) : (
                    <div className="text-center py-12">
                      <p className="text-slate-400 light:text-gray-600">No Intake Line 2 orders found.</p>
                    </div>
                  )
                })()}
              </TabsContent>

              <TabsContent value="mineral-intake" className="space-y-4">
                {(() => {
                  const mineralIntakeData = getOrdersByLine('intake', 3)
                  return filteredOrders(mineralIntakeData).length > 0 ? (
                    renderIntakeTable(filteredOrders(mineralIntakeData), "Mineral Intake Orders")
                  ) : (
                    <div className="text-center py-12">
                      <p className="text-slate-400 light:text-gray-600">No Mineral Intake orders found.</p>
                    </div>
                  )
                })()}
              </TabsContent>

              <TabsContent value="outloading-1" className="space-y-4">
                {(() => {
                  const outloading1Data = getOrdersByLine('outloading', 1)
                  return filteredOrders(outloading1Data).length > 0 ? (
                    renderOutloadingTable(filteredOrders(outloading1Data), "Outloading 1 Orders")
                  ) : (
                    <div className="text-center py-12">
                      <p className="text-slate-400 light:text-gray-600">No Outloading 1 orders found.</p>
                    </div>
                  )
                })()}
              </TabsContent>

              <TabsContent value="outloading-2" className="space-y-4">
                {(() => {
                  const outloading2Data = getOrdersByLine('outloading', 2)
                  return filteredOrders(outloading2Data).length > 0 ? (
                    renderOutloadingTable(filteredOrders(outloading2Data), "Outloading 2 Orders")
                  ) : (
                    <div className="text-center py-12">
                      <p className="text-slate-400 light:text-gray-600">No Outloading 2 orders found.</p>
                    </div>
                  )
                })()}
              </TabsContent>

              <TabsContent value="outloading-3" className="space-y-4">
                {(() => {
                  const outloading3Data = getOrdersByLine('outloading', 3)
                  return filteredOrders(outloading3Data).length > 0 ? (
                    renderOutloadingTable(filteredOrders(outloading3Data), "Outloading 3 Orders")
                  ) : (
                    <div className="text-center py-12">
                      <p className="text-slate-400 light:text-gray-600">No Outloading 3 orders found.</p>
                    </div>
                  )
                })()}
              </TabsContent>

              <TabsContent value="bulk-line" className="space-y-4">
                {(() => {
                  const bulkLineData = getOrdersByLine('bulk', 1)
                  return filteredOrders(bulkLineData).length > 0 ? (
                    renderBulkTable(filteredOrders(bulkLineData), "Bulk Line Orders")
                  ) : (
                    <div className="text-center py-12">
                      <p className="text-slate-400 light:text-gray-600">No Bulk Line orders found.</p>
                    </div>
                  )
                })()}
              </TabsContent>

              <TabsContent value="pt-line" className="space-y-4">
                {(() => {
                  const ptLineData = getOrdersByLine('pit', 1)
                  return filteredOrders(ptLineData).length > 0 ? (
                    renderPitTable(filteredOrders(ptLineData), "PIT Line Orders")
                  ) : (
                    <div className="text-center py-12">
                      <p className="text-slate-400 light:text-gray-600">No PIT Line orders found.</p>
                    </div>
                  )
                })()}
              </TabsContent>
            </>
          )}
        </Tabs>
      </div>
    </WaterSystemLayout>
  )
}
