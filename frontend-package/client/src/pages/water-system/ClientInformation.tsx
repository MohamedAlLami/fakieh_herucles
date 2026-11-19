import React, { useCallback, useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Plus, Pencil, Trash2, X, Users, ChevronLeft, ChevronRight, Printer, FileSpreadsheet } from 'lucide-react'
import { API_BASE_URL } from '../../config/api'
import { printTable } from '../../utils/printTable'
import { exportTableToExcel, type ExportColumn } from '../../utils/exportTable'

interface Client {
  id: number
  name: string
  phone: string
  client_number?: string
  created_at?: string | null
}

const API_BASE = API_BASE_URL
const PAGE_SIZE_OPTIONS = [25, 50, 100]

export default function ClientInformation(): JSX.Element {
  const [clients, setClients] = useState<Client[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [searchName, setSearchName] = useState('')
  const [searchId, setSearchId] = useState('')
  const [debouncedName, setDebouncedName] = useState('')
  const [debouncedId, setDebouncedId] = useState('')

  const [currentPage, setCurrentPage] = useState(1)
  const [rowsPerPage, setRowsPerPage] = useState(25)

  const [showModal, setShowModal] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [selectedClient, setSelectedClient] = useState<Client | null>(null)
  const [clientToDelete, setClientToDelete] = useState<Client | null>(null)
  const [form, setForm] = useState({ name: '', phone: '', client_number: '' })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedName(searchName.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchName])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedId(searchId.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchId])

  useEffect(() => {
    setCurrentPage(1)
  }, [debouncedName, debouncedId, rowsPerPage])

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(total / rowsPerPage)),
    [total, rowsPerPage],
  )

  const fetchClients = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        limit: String(rowsPerPage),
        offset: String((currentPage - 1) * rowsPerPage),
      })
      if (debouncedName) params.append('name', debouncedName)
      if (debouncedId) params.append('id', debouncedId)

      const res = await axios.get(`${API_BASE}/clients/?${params}`)
      setClients(Array.isArray(res.data.items) ? res.data.items : [])
      setTotal(typeof res.data.total === 'number' ? res.data.total : 0)
      setHasMore(Boolean(res.data.has_more))
    } catch (err: unknown) {
      const message = axios.isAxiosError(err)
        ? err.response?.data?.error || err.message
        : 'Failed to load clients'
      setError(message)
      setClients([])
      setTotal(0)
      setHasMore(false)
    } finally {
      setLoading(false)
    }
  }, [currentPage, rowsPerPage, debouncedName, debouncedId])

  useEffect(() => {
    fetchClients()
  }, [fetchClients])

  // Print / Excel of the clients on the page shown (after the name / ID search), without the action buttons.
  const clientColumns: ExportColumn<Client>[] = [
    { header: 'Client ID', cell: (c) => c.id },
    { header: 'Client Number', cell: (c) => c.client_number || '' },
    { header: 'Client Name', cell: (c) => c.name },
    { header: 'Phone Number', cell: (c) => c.phone },
  ]
  const clientSubtitles = () => {
    const sub = [`${clients.length} of ${total} clients (page ${currentPage})`]
    if (debouncedName) sub.push(`Name: ${debouncedName}`)
    if (debouncedId) sub.push(`Client ID: ${debouncedId}`)
    return sub
  }
  const handleClientsPrint = async () => {
    setError(await printTable({ title: 'Client Information', subtitles: clientSubtitles(), columns: clientColumns, rows: clients }))
  }
  const handleClientsExcel = async () => {
    setError(await exportTableToExcel({
      title: 'Client Information',
      subtitles: clientSubtitles(),
      columns: clientColumns,
      rows: clients,
      filename: 'clients',
      sheetName: 'Clients',
    }))
  }
  const listButtonClass = 'shrink-0 border-slate-600 text-slate-300 light:border-gray-300 light:text-gray-700 hover:bg-slate-700 light:hover:bg-gray-100'

  const openAddModal = () => {
    setEditMode(false)
    setSelectedClient(null)
    setForm({ name: '', phone: '', client_number: '' })
    setShowModal(true)
  }

  const openEditModal = (client: Client) => {
    setEditMode(true)
    setSelectedClient(client)
    setForm({
      name: client.name,
      phone: client.phone,
      client_number: client.client_number || '',
    })
    setShowModal(true)
  }

  const handleSave = async () => {
    if (!form.name.trim() || !form.phone.trim() || !form.client_number.trim()) {
      setError('Client name, client number, and phone number are required')
      return
    }

    setSaving(true)
    setError(null)
    try {
      if (editMode && selectedClient) {
        await axios.put(`${API_BASE}/clients/${selectedClient.id}`, form)
      } else {
        await axios.post(`${API_BASE}/clients/`, form)
      }
      setShowModal(false)
      await fetchClients()
    } catch (err: unknown) {
      const message = axios.isAxiosError(err)
        ? err.response?.data?.error || err.message
        : 'Failed to save client'
      setError(message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!clientToDelete) return

    setSaving(true)
    setError(null)
    try {
      await axios.delete(`${API_BASE}/clients/${clientToDelete.id}`)
      setShowDeleteModal(false)
      setClientToDelete(null)
      if (clients.length === 1 && currentPage > 1) {
        setCurrentPage((p) => p - 1)
      } else {
        await fetchClients()
      }
    } catch (err: unknown) {
      const message = axios.isAxiosError(err)
        ? err.response?.data?.error || err.message
        : 'Failed to delete client'
      setError(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="p-6 pt-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div className="bg-slate-800 light:bg-white p-4 rounded-lg text-white light:text-gray-900 border border-slate-700 light:border-gray-200">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-300 light:text-gray-600">TOTAL CLIENTS</p>
                <p className="text-2xl font-bold">{total}</p>
              </div>
              <Users className="h-8 w-8 text-cyan-400 light:text-cyan-600" />
            </div>
          </div>
        </div>

        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 mb-4">
          <div className="flex flex-col md:flex-row gap-3 w-full lg:w-auto flex-1">
            <Input
              placeholder="Search by client name..."
              className="w-full md:flex-1 bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-700"
              value={searchName}
              onChange={(e) => setSearchName(e.target.value)}
            />
            <Input
              placeholder="Search by client ID..."
              className="w-full md:w-48 bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-700"
              value={searchId}
              onChange={(e) => setSearchId(e.target.value.replace(/\D/g, ''))}
            />
          </div>
          <Button
            variant="outline"
            className={listButtonClass}
            onClick={() => void handleClientsPrint()}
            disabled={clients.length === 0}
            data-testid="clients-print"
          >
            <Printer className="h-4 w-4 mr-2" /> Print
          </Button>
          <Button
            variant="outline"
            className={listButtonClass}
            onClick={() => void handleClientsExcel()}
            disabled={clients.length === 0}
            data-testid="clients-excel"
          >
            <FileSpreadsheet className="h-4 w-4 mr-2" /> Export Excel
          </Button>
          <Button
            className="bg-cyan-600 text-white light:bg-cyan-600 light:text-white hover:bg-cyan-700 light:hover:bg-cyan-700 shrink-0"
            onClick={openAddModal}
            style={{ backgroundColor: '#0891b2', color: 'white' }}
          >
            <Plus className="h-4 w-4 mr-2" /> Add Client
          </Button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-500/40 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="overflow-x-auto rounded-lg border border-slate-700 light:border-gray-200">
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-800 dark:bg-slate-800 bg-gray-50 text-black dark:text-white">
                <TableHead>Client ID</TableHead>
                <TableHead>Client Number</TableHead>
                <TableHead>Client Name</TableHead>
                <TableHead>Phone Number</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-slate-400">
                    Loading clients...
                  </TableCell>
                </TableRow>
              ) : clients.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-slate-400">
                    No clients found
                  </TableCell>
                </TableRow>
              ) : (
                clients.map((client) => (
                  <TableRow key={client.id} className="border-slate-700 light:border-gray-200">
                    <TableCell className="font-mono text-cyan-400 light:text-cyan-600">{client.id}</TableCell>
                    <TableCell className="font-mono">{client.client_number || '—'}</TableCell>
                    <TableCell>{client.name}</TableCell>
                    <TableCell>{client.phone}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEditModal(client)}
                          className="text-slate-300 hover:text-white"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setClientToDelete(client)
                            setShowDeleteModal(true)
                          }}
                          className="text-red-400 hover:text-red-300"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex flex-col md:flex-row items-center justify-between gap-4 mt-4">
          <div className="flex items-center gap-2 text-sm text-slate-400 light:text-gray-600">
            <span>Rows per page:</span>
            <Select
              value={String(rowsPerPage)}
              onValueChange={(v) => setRowsPerPage(Number(v))}
            >
              <SelectTrigger className="w-24 bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-700">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300">
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span>
              Page {currentPage} of {totalPages} ({total} total)
            </span>
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage <= 1 || loading}
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              className="border-slate-600 text-slate-300 hover:bg-slate-700"
            >
              <ChevronLeft className="h-4 w-4 mr-1" /> Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasMore || loading}
              onClick={() => setCurrentPage((p) => p + 1)}
              className="border-slate-600 text-slate-300 hover:bg-slate-700"
            >
              Next <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center">
          <div className="bg-slate-900 light:bg-white text-white light:text-gray-900 rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 relative">
            <button
              onClick={() => setShowModal(false)}
              className="absolute top-4 right-4 p-1 text-red-500 hover:text-red-600 transition-all duration-200"
            >
              <X className="w-6 h-6" />
            </button>
            <h2 className="text-xl font-semibold mb-4">
              {editMode ? 'Edit Client' : 'Add New Client'}
            </h2>
            <div className="space-y-4">
              <Input
                placeholder="Client Number"
                value={form.client_number}
                onChange={(e) => setForm({ ...form, client_number: e.target.value })}
                className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-900"
              />
              <Input
                placeholder="Client Name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-900"
              />
              <Input
                placeholder="Phone Number"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-900"
              />
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <Button
                variant="ghost"
                onClick={() => setShowModal(false)}
                className="text-slate-300 light:text-gray-600 hover:text-white light:hover:text-gray-900"
              >
                Cancel
              </Button>
              <Button
                className="bg-cyan-600 hover:bg-cyan-700 text-white light:bg-cyan-600 light:hover:bg-cyan-700 light:text-white"
                onClick={handleSave}
                disabled={saving}
                style={{ backgroundColor: '#0891b2', color: 'white' }}
              >
                {saving ? 'Saving...' : editMode ? 'Update Client' : 'Save Client'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showDeleteModal && clientToDelete && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center">
          <div className="bg-slate-900 light:bg-white text-white light:text-gray-900 rounded-xl shadow-xl w-full max-w-md p-6 space-y-4 relative">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-red-600/20 rounded-full">
                <Trash2 className="w-6 h-6 text-red-400" />
              </div>
              <h2 className="text-xl font-semibold">Delete Client</h2>
            </div>
            <p className="text-slate-300 light:text-gray-600">
              Are you sure you want to delete client{' '}
              <span className="font-semibold text-cyan-400 light:text-cyan-600">
                {clientToDelete.name}
              </span>
              ? This action cannot be undone.
            </p>
            <div className="bg-slate-800/50 light:bg-gray-100 p-3 rounded-lg">
              <p className="text-sm text-slate-400 light:text-gray-500">
                <strong>ID:</strong> {clientToDelete.id}
                <br />
                <strong>Client Number:</strong> {clientToDelete.client_number || '—'}
                <br />
                <strong>Phone:</strong> {clientToDelete.phone}
              </p>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <Button
                variant="ghost"
                onClick={() => {
                  setShowDeleteModal(false)
                  setClientToDelete(null)
                }}
                className="text-slate-300 light:text-gray-600 hover:text-white light:hover:text-gray-900"
              >
                Cancel
              </Button>
              <Button
                className="bg-red-600 hover:bg-red-700 text-white light:bg-red-600 light:hover:bg-red-700 light:text-white"
                onClick={handleDelete}
                disabled={saving}
              >
                Delete Client
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
