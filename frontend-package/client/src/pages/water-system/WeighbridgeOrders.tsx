import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ClipboardList, Pencil, FileSpreadsheet, Plus, Printer, RefreshCw, Trash2, X } from 'lucide-react'
import { SearchableSelect } from '../../components/water-system/SearchableSelect'
import { useMaterialCodes } from '../../constants/materialCodes'
import { useRowSelection } from '../../hooks/useRowSelection'
import { printTable, rowsToPrint } from '../../utils/printTable'
import { exportTableToExcel, type ExportColumn } from '../../utils/exportTable'
import {
  createWeighbridgeOrder,
  deleteWeighbridgeOrder,
  fetchAllClients,
  fetchWeighbridgeOrders,
  orderStatusLabel,
  updateWeighbridgeOrder,
  type ClientOption,
  type WeighbridgeOrder,
} from '../../api/weighbridgeOrders'

const fmtKg = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 })

function fmtDateTime(ts?: string | null) {
  if (!ts) return '—'
  try {
    return new Date(ts).toLocaleString([], {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return '—'
  }
}

const STATUS_CLASS: Record<WeighbridgeOrder['status'], string> = {
  open: 'text-green-400 light:text-green-700 bg-green-500/10 light:bg-green-100',
  in_progress: 'text-amber-400 light:text-amber-700 bg-amber-500/10 light:bg-amber-100',
  closed: 'text-gray-400 light:text-gray-600 bg-gray-500/10 light:bg-gray-100',
}

const EMPTY_FORM = { order_no: '', product_code: '', quantity_kg: '', client_id: '' }

/** Management > Weighbridge Orders: what each truck is coming for (product, quantity, client). */
export default function WeighbridgeOrders(): JSX.Element {
  const [orders, setOrders] = useState<WeighbridgeOrder[]>([])
  const [nextNo, setNextNo] = useState(1)
  const [clients, setClients] = useState<ClientOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<WeighbridgeOrder | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [toDelete, setToDelete] = useState<WeighbridgeOrder | null>(null)

  const materials = useMaterialCodes()
  const productOptions = useMemo(
    () => materials.map((m) => ({ value: m.code, label: `${m.code} — ${m.name}` })),
    [materials],
  )
  const clientOptions = useMemo(
    () =>
      clients.map((c) => ({
        value: String(c.id),
        label: c.client_number ? `${c.client_number} — ${c.name}` : c.name,
      })),
    [clients],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchWeighbridgeOrders()
      setOrders(data.orders)
      setNextNo(data.next_order_no)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load orders')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadClients = useCallback(async () => {
    try {
      setClients(await fetchAllClients())
    } catch {
      setClients([])
    }
  }, [])

  useEffect(() => {
    void load()
    void loadClients()
  }, [load, loadClients])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return orders.filter((o) => {
      if (statusFilter !== 'all' && o.status !== statusFilter) return false
      if (!q) return true
      return `${o.order_no} ${o.product_code} ${o.product_name} ${o.client_name}`.toLowerCase().includes(q)
    })
  }, [orders, search, statusFilter])

  const selection = useRowSelection(shown.map((o) => o.id))

  const openCount = orders.filter((o) => o.status === 'open').length
  const onSiteCount = orders.filter((o) => o.status === 'in_progress').length
  const closedCount = orders.filter((o) => o.status === 'closed').length

  const openAdd = () => {
    setEditing(null)
    setForm({ ...EMPTY_FORM, order_no: String(nextNo) })
    setFormError(null)
    setShowModal(true)
    void loadClients()
  }

  const openEdit = (o: WeighbridgeOrder) => {
    setEditing(o)
    setForm({
      order_no: String(o.order_no),
      product_code: o.product_code,
      quantity_kg: String(o.quantity_kg),
      client_id: o.client_id != null ? String(o.client_id) : '',
    })
    setFormError(null)
    setShowModal(true)
    void loadClients()
  }

  const save = async () => {
    const orderNo = Number(form.order_no)
    const qty = Number(form.quantity_kg)
    if (!editing && (!Number.isInteger(orderNo) || orderNo < 1)) {
      setFormError('The order number must be a whole number, 1 or more.')
      return
    }
    if (!form.product_code) {
      setFormError('Select the product.')
      return
    }
    if (form.quantity_kg.trim() === '' || !Number.isFinite(qty) || qty <= 0) {
      setFormError('Enter the quantity in kg, above zero.')
      return
    }
    if (!form.client_id) {
      setFormError('Select the client.')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const input = {
        product_code: form.product_code,
        quantity_kg: qty,
        client_id: Number(form.client_id),
      }
      if (editing) await updateWeighbridgeOrder(editing.id, input)
      else await createWeighbridgeOrder({ ...input, order_no: orderNo })
      setShowModal(false)
      await load()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not save the order')
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!toDelete) return
    setSaving(true)
    setError(null)
    try {
      await deleteWeighbridgeOrder(toDelete.id)
      setToDelete(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the order')
      setToDelete(null)
    } finally {
      setSaving(false)
    }
  }

  // What gets printed or exported: the ticked orders, or every order shown when none is ticked.
  const ordersTable = () => {
    const rows = rowsToPrint(shown, selection.selected, (o) => o.id)
    const subtitles: string[] = []
    if (statusFilter !== 'all') subtitles.push(`Status: ${orderStatusLabel(statusFilter as WeighbridgeOrder['status'])}`)
    if (search.trim()) subtitles.push(`Search: ${search.trim()}`)
    if (selection.count > 0) subtitles.push(`${rows.length} of ${shown.length} orders selected`)
    const total = rows.reduce((s, o) => s + o.quantity_kg, 0)
    const columns: ExportColumn<WeighbridgeOrder>[] = [
      { header: 'Order No', cell: (o) => o.order_no },
      { header: 'Product Code', cell: (o) => o.product_code },
      { header: 'Product Name', cell: (o) => o.product_name },
      { header: 'Quantity (kg)', cell: (o) => fmtKg(o.quantity_kg), excel: (o) => o.quantity_kg, numeric: true },
      { header: 'Client', cell: (o) => o.client_name },
      { header: 'Status', cell: (o) => orderStatusLabel(o.status) },
      { header: 'Created', cell: (o) => fmtDateTime(o.created_at) },
      { header: 'Closed', cell: (o) => fmtDateTime(o.closed_at) },
    ]
    const label = `Total: ${rows.length} order${rows.length === 1 ? '' : 's'}`
    return { rows, subtitles, total, columns, label }
  }

  const handlePrint = async () => {
    const t = ordersTable()
    const err = await printTable({
      title: 'Weighbridge Orders',
      subtitles: t.subtitles,
      rows: t.rows,
      columns: t.columns,
      footer: [t.label, '', '', fmtKg(t.total), '', '', '', ''],
      landscape: true,
    })
    setError(err)
  }

  const handleExcel = async () => {
    const t = ordersTable()
    const err = await exportTableToExcel({
      title: 'Weighbridge Orders',
      subtitles: t.subtitles,
      rows: t.rows,
      columns: t.columns,
      footer: [t.label, '', '', t.total, '', '', '', ''],
      filename: 'weighbridge-orders',
      sheetName: 'Weighbridge Orders',
    })
    setError(err)
  }

  const inputClass =
    'bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-900'
  const labelClass = 'text-xs text-slate-300 light:text-gray-600 mb-1 block'

  return (
    <>
      <div className="p-6 pt-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          {[
            { label: 'OPEN ORDERS', value: openCount },
            { label: 'TRUCK ON SITE', value: onSiteCount },
            { label: 'CLOSED ORDERS', value: closedCount },
          ].map((k) => (
            <div
              key={k.label}
              className="bg-slate-800 light:bg-white p-4 rounded-lg text-white light:text-gray-900 border border-slate-700 light:border-gray-200"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-300 light:text-gray-600">{k.label}</p>
                  <p className="text-2xl font-bold">{k.value}</p>
                </div>
                <ClipboardList className="h-8 w-8 text-cyan-400 light:text-cyan-600" />
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 mb-4">
          <div className="flex flex-col md:flex-row gap-3 w-full lg:w-auto flex-1">
            <Input
              placeholder="Search order number, product or client..."
              className={`w-full md:flex-1 md:min-w-[16rem] ${inputClass}`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="orders-search"
            />
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className={`w-full md:w-48 ${inputClass}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300">
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="in_progress">Truck on site</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button
              variant="outline"
              onClick={() => void load()}
              disabled={loading}
              className="border-slate-600 text-slate-300 light:border-gray-300 light:text-gray-700 hover:bg-slate-700 light:hover:bg-gray-100"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </Button>
            <Button
              variant="outline"
              onClick={() => void handlePrint()}
              disabled={shown.length === 0}
              className="border-slate-600 text-slate-300 light:border-gray-300 light:text-gray-700 hover:bg-slate-700 light:hover:bg-gray-100"
              data-testid="orders-print"
            >
              <Printer className="h-4 w-4 mr-2" />
              {selection.count > 0 ? `Print selected (${selection.count})` : 'Print'}
            </Button>
            <Button
              variant="outline"
              onClick={() => void handleExcel()}
              disabled={shown.length === 0}
              className="border-slate-600 text-slate-300 light:border-gray-300 light:text-gray-700 hover:bg-slate-700 light:hover:bg-gray-100"
              data-testid="wb-orders-excel"
            >
              <FileSpreadsheet className="h-4 w-4 mr-2" />
              {selection.count > 0 ? `Export selected (${selection.count})` : 'Export Excel'}
            </Button>
            <Button
              onClick={openAdd}
              className="bg-cyan-600 text-white hover:bg-cyan-700"
              style={{ backgroundColor: '#0891b2', color: 'white' }}
              data-testid="orders-add"
            >
              <Plus className="h-4 w-4 mr-2" /> Add Order
            </Button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-500/40 bg-red-950/40 light:bg-red-50 px-4 py-3 text-sm text-red-300 light:text-red-700">
            {error}
          </div>
        )}

        <div className="overflow-x-auto rounded-lg border border-slate-700 light:border-gray-200">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-800 light:bg-gray-50">
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    aria-label="Select all shown orders"
                    className="h-4 w-4 accent-cyan-500 cursor-pointer"
                    checked={selection.allSelected}
                    onChange={selection.toggleAll}
                    disabled={shown.length === 0}
                  />
                </TableHead>
                <TableHead>Order No</TableHead>
                <TableHead>Product Code</TableHead>
                <TableHead>Product Name</TableHead>
                <TableHead className="text-right">Quantity (kg)</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Closed</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="text-center py-8 text-slate-400 light:text-gray-500">
                    {loading ? 'Loading orders...' : orders.length === 0 ? 'No orders yet. Press Add Order.' : 'No orders match'}
                  </TableCell>
                </TableRow>
              ) : (
                shown.map((o) => (
                  <TableRow key={o.id} className="border-slate-700 light:border-gray-200" data-testid={`order-row-${o.order_no}`}>
                    <TableCell>
                      <input
                        type="checkbox"
                        aria-label={`Select order ${o.order_no}`}
                        className="h-4 w-4 accent-cyan-500 cursor-pointer"
                        checked={selection.selected.has(o.id)}
                        onChange={() => selection.toggle(o.id)}
                      />
                    </TableCell>
                    <TableCell className="font-mono font-semibold text-cyan-400 light:text-cyan-700">{o.order_no}</TableCell>
                    <TableCell className="font-mono text-slate-200 light:text-gray-800">{o.product_code}</TableCell>
                    <TableCell className="text-slate-200 light:text-gray-800">{o.product_name || '—'}</TableCell>
                    <TableCell className="text-right tabular-nums text-slate-200 light:text-gray-800">{fmtKg(o.quantity_kg)}</TableCell>
                    <TableCell className="text-slate-200 light:text-gray-800">{o.client_name || '—'}</TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_CLASS[o.status]}`}>
                        {orderStatusLabel(o.status)}
                      </span>
                    </TableCell>
                    <TableCell className="text-slate-400 light:text-gray-600 text-xs">{fmtDateTime(o.created_at)}</TableCell>
                    <TableCell className="text-slate-400 light:text-gray-600 text-xs">{fmtDateTime(o.closed_at)}</TableCell>
                    <TableCell className="text-right">
                      {o.status === 'open' ? (
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEdit(o)}
                            className="text-slate-300 light:text-gray-600 hover:text-white light:hover:text-gray-900"
                            aria-label={`Edit order ${o.order_no}`}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setToDelete(o)}
                            className="text-red-400 hover:text-red-300"
                            aria-label={`Delete order ${o.order_no}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-500 light:text-gray-400">locked</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <p className="mt-3 text-xs text-slate-400 light:text-gray-500">
          Showing {shown.length} of {orders.length} orders. An order closes by itself when its truck exits the weighbridge.
        </p>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-slate-900 light:bg-white text-white light:text-gray-900 rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 relative">
            <button
              onClick={() => setShowModal(false)}
              className="absolute top-4 right-4 p-1 text-red-500 hover:text-red-600"
              aria-label="Close"
            >
              <X className="w-6 h-6" />
            </button>
            <h2 className="text-xl font-semibold">{editing ? `Edit Order ${editing.order_no}` : 'Add New Order'}</h2>
            <div className="space-y-4">
              <div>
                <label className={labelClass}>Order Number</label>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={form.order_no}
                  disabled={Boolean(editing)}
                  onChange={(e) => setForm({ ...form, order_no: e.target.value })}
                  className={inputClass}
                  data-testid="order-form-no"
                />
              </div>
              <div>
                <label className={labelClass}>Product</label>
                <SearchableSelect
                  value={form.product_code}
                  onChange={(v) => setForm((f) => ({ ...f, product_code: v }))}
                  options={productOptions}
                  placeholder="Select or type product code or name"
                  testId="order-form-product"
                />
              </div>
              <div>
                <label className={labelClass}>Quantity (kg)</label>
                <Input
                  type="number"
                  min={0}
                  step="any"
                  inputMode="decimal"
                  placeholder="0"
                  value={form.quantity_kg}
                  onChange={(e) => setForm({ ...form, quantity_kg: e.target.value })}
                  className={inputClass}
                  data-testid="order-form-qty"
                />
              </div>
              <div>
                <label className={labelClass}>Client</label>
                <SearchableSelect
                  value={form.client_id}
                  onChange={(v) => setForm((f) => ({ ...f, client_id: v }))}
                  options={clientOptions}
                  placeholder="Select or type client name"
                  emptyText="No clients yet — add them in Management > Clients"
                  testId="order-form-client"
                />
              </div>
              {formError && (
                <p className="text-sm text-red-400 light:text-red-600" data-testid="order-form-error">
                  {formError}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="ghost"
                onClick={() => setShowModal(false)}
                className="text-slate-300 light:text-gray-600 hover:text-white light:hover:text-gray-900"
              >
                Cancel
              </Button>
              <Button
                onClick={() => void save()}
                disabled={saving}
                className="bg-cyan-600 hover:bg-cyan-700 text-white"
                style={{ backgroundColor: '#0891b2', color: 'white' }}
                data-testid="order-form-save"
              >
                {saving ? 'Saving...' : editing ? 'Update Order' : 'Save Order'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {toDelete && (
        <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-slate-900 light:bg-white text-white light:text-gray-900 rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-red-600/20 rounded-full">
                <Trash2 className="w-6 h-6 text-red-400" />
              </div>
              <h2 className="text-xl font-semibold">Delete Order {toDelete.order_no}</h2>
            </div>
            <p className="text-slate-300 light:text-gray-600">
              {toDelete.product_code} — {toDelete.product_name}, {fmtKg(toDelete.quantity_kg)} kg, {toDelete.client_name}. This cannot be undone.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="ghost"
                onClick={() => setToDelete(null)}
                className="text-slate-300 light:text-gray-600 hover:text-white light:hover:text-gray-900"
              >
                Cancel
              </Button>
              <Button onClick={() => void confirmDelete()} disabled={saving} className="bg-red-600 hover:bg-red-700 text-white">
                {saving ? 'Deleting...' : 'Delete Order'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
