import React, { useState, useEffect } from 'react'
import axios from 'axios'
import { API_BASE_URL } from '../../config/api'
import { Filter, Eye, Pencil, Trash2, Plus, Activity, CheckCircle, XCircle, AlertTriangle, Printer, FileSpreadsheet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useToast } from '@/hooks/use-toast'
import { printTable } from '../../utils/printTable'
import { exportTableToExcel, type ExportColumn } from '../../utils/exportTable'

// Mock RFID table data based on the provided image
const rfidTableData = [
  {
    rfidNumber: 'RFID-001',
    rfidUsed: 'Yes',
    rfidLinkedToOrder: 'Intake Line 1'
  },
  {
    rfidNumber: 'RFID-002',
    rfidUsed: 'No',
    rfidLinkedToOrder: 'NA'
  },
  {
    rfidNumber: 'RFID-003',
    rfidUsed: 'Yes',
    rfidLinkedToOrder: 'Processing Line 2'
  },
  {
    rfidNumber: 'RFID-004',
    rfidUsed: 'Yes',
    rfidLinkedToOrder: 'Storage Bay A'
  },
  {
    rfidNumber: 'RFID-005',
    rfidUsed: 'No',
    rfidLinkedToOrder: 'NA'
  },
  {
    rfidNumber: 'RFID-006',
    rfidUsed: 'Yes',
    rfidLinkedToOrder: 'Intake Line 3'
  },
  {
    rfidNumber: 'RFID-007',
    rfidUsed: 'No',
    rfidLinkedToOrder: 'NA'
  },
  {
    rfidNumber: 'RFID-008',
    rfidUsed: 'Yes',
    rfidLinkedToOrder: 'Processing Line 1'
  },
  {
    rfidNumber: 'RFID-009',
    rfidUsed: 'Yes',
    rfidLinkedToOrder: 'Storage Bay B'
  },
  {
    rfidNumber: 'RFID-010',
    rfidUsed: 'No',
    rfidLinkedToOrder: 'NA'
  }
]

export function RFID() {
  const { toast } = useToast()
  const [rfidTableData, setRfidTableData] = useState<any[]>([])
  const [tableFilters, setTableFilters] = useState({
    rfidNumber: '',
    rfidUsed: 'all',
    rfidLinkedToOrder: 'all'
  })

  // CRUD state
  const [showAddModal, setShowAddModal] = useState(false)
  const [showViewModal, setShowViewModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [selectedTag, setSelectedTag] = useState<any>(null)
  const [form, setForm] = useState<any>({ 
    rfidNumber: '', 
    rfidUsed: false
  })
  const [formError, setFormError] = useState<string | null>(null)
  const [formLoading, setFormLoading] = useState(false)

  // Order data state
  const [selectedOrderType, setSelectedOrderType] = useState('none')

  // Fetch data from backend
  useEffect(() => {
    const fetchData = async () => {
      try {
        const configRes = await axios.get('/api/rfid/config')
        const cfg = configRes.data
        setRfidTableData(Array.isArray(cfg) ? cfg : cfg?.items ?? [])
      } catch (err) {
        
        // Use mock data if API fails
        setRfidTableData(rfidTableData)
      }
    }
    fetchData()
  }, [])

  // CRUD handlers
  const handleView = (tag: any) => {
    setSelectedTag(tag)
    setShowViewModal(true)
  }
  
  const handleEdit = (tag: any) => {
    setSelectedTag(tag)
    setForm({
      rfidNumber: tag.rfid_number,
      rfidUsed: tag.rfid_used
    })
    setFormError(null)
    setShowEditModal(true)
  }
  
  const handleDelete = async (id: number) => {
    if (window.confirm('Are you sure you want to delete this RFID?')) {
      try {
        await axios.delete(`/api/rfid/config/${id}`)
        setRfidTableData(rfidTableData.filter((t) => t.id !== id))
      } catch (error) {
        
      }
    }
  }
  
  const handleAdd = () => {
    setForm({ 
      rfidNumber: '', 
      rfidUsed: false
    })
    setFormError(null)
    setShowAddModal(true)
  }

  const handleAddSubmit = async (e: any) => {
    e.preventDefault()
    setFormError(null)
    setFormLoading(true)
    try {
      if (!form.rfidNumber) {
        setFormError('RFID Number is required.')
        setFormLoading(false)
        return
      }

      // Validate RFID number is integer
      const rfidNumber = parseInt(form.rfidNumber)
      if (isNaN(rfidNumber)) {
        setFormError('RFID Number must be a valid integer.')
        setFormLoading(false)
        return
      }

      const res = await axios.post('/api/rfid/config', {
        rfidNumber: rfidNumber,
        rfidUsed: form.rfidUsed
      })
      setRfidTableData([...rfidTableData, res.data])
      setShowAddModal(false)
    } catch (err) {
      setFormError('Failed to add RFID. Please try again.')
    }
    setFormLoading(false)
  }
  
  const handleEditSubmit = async (e: any) => {
    e.preventDefault()
    setFormError(null)
    setFormLoading(true)
    try {
      if (!form.rfidNumber) {
        setFormError('RFID Number is required.')
        setFormLoading(false)
        return
      }

      // Validate RFID number is integer
      const rfidNumber = parseInt(form.rfidNumber)
      if (isNaN(rfidNumber)) {
        setFormError('RFID Number must be a valid integer.')
        setFormLoading(false)
        return
      }

      const res = await axios.put(`/api/rfid/config/${selectedTag.id}`, {
        rfidNumber: rfidNumber,
        rfidUsed: form.rfidUsed
      })
      setRfidTableData(rfidTableData.map(t => t.id === selectedTag.id ? res.data : t))
      setShowEditModal(false)
    } catch (err) {
      setFormError('Failed to update RFID. Please try again.')
    }
    setFormLoading(false)
  }



  // Get unique values for filter options
  const uniqueOrders = rfidTableData
    .map(item => item.rfidLinkedToOrder)
    .filter(order => order !== 'NA')
    .filter((order, index, arr) => arr.indexOf(order) === index)
    .sort()

  // Filter the table data based on current filters
  const filteredTableData = rfidTableData.filter(item => {
    const rfidUsedMatch = tableFilters.rfidUsed === 'all' || 
      (tableFilters.rfidUsed === 'true' && (item.rfid_used === true || item.rfid_used === 'true')) ||
      (tableFilters.rfidUsed === 'false' && (item.rfid_used === false || item.rfid_used === 'false'))
    
    return (
      (tableFilters.rfidNumber === '' || item.rfid_number.toString().includes(tableFilters.rfidNumber)) &&
      rfidUsedMatch &&
      (tableFilters.rfidLinkedToOrder === 'all' || item.rfid_linked_to_order === tableFilters.rfidLinkedToOrder)
    )
  })

  // Print / Excel of the tags shown after the filters, without the action buttons.
  const rfidColumns: ExportColumn<any>[] = [
    { header: 'RFID Number', cell: (item) => item.rfid_number },
    { header: 'RFID Used', cell: (item) => (item.rfid_used === true || item.rfid_used === 'true' ? 'True' : 'False') },
    { header: 'RFID Linked to Order', cell: (item) => item.rfid_linked_to_order },
  ]
  const rfidSubtitles = () => {
    const sub = [`${filteredTableData.length} of ${rfidTableData.length} tags`]
    if (tableFilters.rfidNumber) sub.push(`RFID Number: ${tableFilters.rfidNumber}`)
    if (tableFilters.rfidUsed !== 'all') sub.push(`RFID Used: ${tableFilters.rfidUsed === 'true' ? 'True' : 'False'}`)
    if (tableFilters.rfidLinkedToOrder !== 'all') sub.push(`Linked to Order: ${tableFilters.rfidLinkedToOrder}`)
    return sub
  }
  const showListError = (err: string | null) => {
    if (err) toast({ title: 'Could not export', description: err, variant: 'destructive' })
  }
  const handleRfidPrint = async () => {
    showListError(await printTable({ title: 'RFID Configuration', subtitles: rfidSubtitles(), columns: rfidColumns, rows: filteredTableData }))
  }
  const handleRfidExcel = async () => {
    showListError(await exportTableToExcel({
      title: 'RFID Configuration',
      subtitles: rfidSubtitles(),
      columns: rfidColumns,
      rows: filteredTableData,
      filename: 'rfid',
      sheetName: 'RFID',
    }))
  }

  const clearTableFilters = () => {
    setTableFilters({
      rfidNumber: '',
      rfidUsed: 'all',
      rfidLinkedToOrder: 'all'
    })
  }

  // Calculate KPI metrics
  const totalRfids = rfidTableData.length
  const usedRfids = rfidTableData.filter(item => item.rfid_used === true || item.rfid_used === 'true').length
  const availableRfids = totalRfids - usedRfids
  const assignedRfids = rfidTableData.filter(item => item.rfid_linked_to_order && item.rfid_linked_to_order !== 'NA').length
  const utilizationRate = totalRfids > 0 ? Math.round((usedRfids / totalRfids) * 100) : 0

  return (
      <div className="space-y-6 p-6 pt-4">
        
        {/* KPI Cards Section */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {/* Total RFID Cards */}
          <Card className="bg-slate-900/50 light:bg-white border-slate-700/30 light:border-gray-200 backdrop-blur-sm light:shadow-lg">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-slate-400 light:text-gray-600 text-sm font-medium">Total RFID Cards</p>
                  <p className="text-2xl font-bold text-white light:text-gray-900">{totalRfids}</p>
                </div>
                <div className="h-12 w-12 rounded-full bg-blue-500/10 light:bg-blue-100 flex items-center justify-center">
                  <Activity className="h-6 w-6 text-blue-400 light:text-blue-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Used RFID Cards */}
          <Card className="bg-slate-900/50 light:bg-white border-slate-700/30 light:border-gray-200 backdrop-blur-sm light:shadow-lg">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-slate-400 light:text-gray-600 text-sm font-medium">Used RFID Cards</p>
                  <p className="text-2xl font-bold text-white light:text-gray-900">{usedRfids}</p>
                </div>
                <div className="h-12 w-12 rounded-full bg-green-500/10 light:bg-green-100 flex items-center justify-center">
                  <CheckCircle className="h-6 w-6 text-green-400 light:text-green-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Available RFID Cards */}
          <Card className="bg-slate-900/50 light:bg-white border-slate-700/30 light:border-gray-200 backdrop-blur-sm light:shadow-lg">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-slate-400 light:text-gray-600 text-sm font-medium">Available RFID Cards</p>
                  <p className="text-2xl font-bold text-white light:text-gray-900">{availableRfids}</p>
                </div>
                <div className="h-12 w-12 rounded-full bg-orange-500/10 light:bg-orange-100 flex items-center justify-center">
                  <XCircle className="h-6 w-6 text-orange-400 light:text-orange-600" />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Utilization Rate */}
          <Card className="bg-slate-900/50 light:bg-white border-slate-700/30 light:border-gray-200 backdrop-blur-sm light:shadow-lg">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-slate-400 light:text-gray-600 text-sm font-medium">Utilization Rate</p>
                  <p className="text-2xl font-bold text-white light:text-gray-900">{utilizationRate}%</p>
                </div>
                <div className="h-12 w-12 rounded-full bg-purple-500/10 light:bg-purple-100 flex items-center justify-center">
                  <AlertTriangle className="h-6 w-6 text-purple-400 light:text-purple-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Add Button */}
        <div className="flex justify-end gap-2 mb-4">
          <Button
            variant="outline"
            onClick={() => void handleRfidPrint()}
            disabled={filteredTableData.length === 0}
            className="border-slate-600 text-slate-300 light:border-gray-300 light:text-gray-700 hover:bg-slate-700 light:hover:bg-gray-100"
            data-testid="rfid-print"
          >
            <Printer className="h-4 w-4 mr-2" /> Print
          </Button>
          <Button
            variant="outline"
            onClick={() => void handleRfidExcel()}
            disabled={filteredTableData.length === 0}
            className="border-slate-600 text-slate-300 light:border-gray-300 light:text-gray-700 hover:bg-slate-700 light:hover:bg-gray-100"
            data-testid="rfid-excel"
          >
            <FileSpreadsheet className="h-4 w-4 mr-2" /> Export Excel
          </Button>
          <Button className="bg-green-600 text-white light:bg-green-600 light:text-white hover:bg-green-700 light:hover:bg-green-700" onClick={handleAdd}><Plus className="h-4 w-4 mr-2" /> Add RFID</Button>
        </div>



        {/* RFID Table Filter Section */}
        <Card className="bg-slate-800/30 light:bg-white border-slate-700 light:border-gray-200 mb-4 light:shadow-md">
          <CardHeader className="pb-3">
            <CardTitle className="text-white light:text-gray-900 flex items-center gap-2 text-lg">
              <Filter className="h-4 w-4 text-cyan-400 light:text-blue-600" />
              RFID Table Filters
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="text-slate-300 light:text-gray-700 text-xs mb-1 block">RFID Number</label>
                <Input
                  type="text"
                  placeholder="Search number..."
                  value={tableFilters.rfidNumber}
                  onChange={(e) => setTableFilters({ ...tableFilters, rfidNumber: e.target.value })}
                  className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-700 h-8 text-sm"
                />
              </div>
              
              <div>
                <label className="text-slate-300 light:text-gray-700 text-xs mb-1 block">RFID Used</label>
                <Select onValueChange={(value) => setTableFilters({ ...tableFilters, rfidUsed: value })}>
                  <SelectTrigger className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-700 h-8 text-sm">
                    <SelectValue placeholder="All Status" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300">
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="true">True</SelectItem>
                    <SelectItem value="false">False</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              <div>
                <label className="text-slate-300 light:text-gray-700 text-xs mb-1 block">Linked to Order</label>
                <Select onValueChange={(value) => setTableFilters({ ...tableFilters, rfidLinkedToOrder: value })}>
                  <SelectTrigger className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-700 h-8 text-sm">
                    <SelectValue placeholder="All Orders" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300">
                    <SelectItem value="all">All Orders</SelectItem>
                    <SelectItem value="NA">Not Assigned (NA)</SelectItem>
                    {uniqueOrders.map(order => (
                      <SelectItem key={order} value={order}>{order}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              <div className="flex items-end gap-2">
                <Button
                  onClick={clearTableFilters}
                  variant="outline"
                  size="sm"
                  className="border-slate-600 text-slate-300 light:border-gray-300 light:text-gray-700 hover:bg-slate-700 light:hover:bg-gray-100 h-8"
                >
                  Clear Filters
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* RFID Data Table */}
        <div className="bg-slate-950/50 light:bg-white border border-slate-700/30 light:border-gray-200 rounded-lg backdrop-blur-sm light:shadow-lg">
          
          {/* Header */}
          <div className="p-6 border-b border-slate-700/30 light:border-gray-200">
            <h3 className="text-lg font-semibold text-white light:text-gray-900">RFID Configuration Table</h3>
          </div>
          
          {/* Data Table */}
          <div className="p-6">
            <div className="rounded-md border border-slate-700/30 light:border-gray-200">
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-700/30 light:border-gray-200 hover:bg-slate-800/50 light:hover:bg-gray-50">
                    <TableHead className="text-white light:text-gray-900 font-semibold">RFID Number</TableHead>
                    <TableHead className="text-white light:text-gray-900 font-semibold">RFID Used</TableHead>
                    <TableHead className="text-white light:text-gray-900 font-semibold">RFID Linked to Order</TableHead>
                    <TableHead className="text-white light:text-gray-900 font-semibold">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTableData.map((item, index) => (
                    <TableRow 
                      key={index} 
                      className="border-slate-700/30 light:border-gray-200 hover:bg-slate-800/30 light:hover:bg-gray-50 transition-colors"
                    >
                      <TableCell className="text-white light:text-gray-900 font-medium">
                        {item.rfid_number}
                      </TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          item.rfid_used === true || item.rfid_used === 'true'
                            ? 'text-green-400 light:text-green-600 bg-green-500/10 light:bg-green-100 border border-green-500/20 light:border-green-300' 
                            : 'text-red-400 light:text-red-600 bg-red-500/10 light:bg-red-100 border border-red-500/20 light:border-red-300'
                        }`}>
                          {item.rfid_used === true || item.rfid_used === 'true' ? 'True' : 'False'}
                        </span>
                      </TableCell>
                      <TableCell className="text-slate-300 light:text-gray-700">
                        <span className={item.rfid_linked_to_order === 'NA' ? 'text-slate-500 light:text-gray-400 italic' : ''}>
                          {item.rfid_linked_to_order}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" onClick={() => handleView(item)}><Eye className="w-4 h-4 text-blue-400" /></Button>
                        <Button variant="ghost" size="icon" onClick={() => handleEdit(item)}><Pencil className="w-4 h-4 text-yellow-400" /></Button>
                        <Button variant="ghost" size="icon" onClick={() => handleDelete(item.id)}><Trash2 className="w-4 h-4 text-red-500" /></Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>



        {/* Add Modal */}
        {showAddModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-white light:bg-white dark:bg-slate-800 p-6 rounded-xl w-full max-w-md space-y-3 border border-slate-700 light:border-gray-200 shadow-xl">
              <h2 className="text-lg font-semibold mb-2 text-center text-slate-900 light:text-gray-900 dark:text-white">Add RFID</h2>
              <form onSubmit={handleAddSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 light:text-gray-700 dark:text-slate-300 mb-1">RFID Number</label>
                  <Input 
                    type="number" 
                    placeholder="Enter RFID Number (e.g., 11)" 
                    value={form.rfidNumber} 
                    onChange={e => setForm({ ...form, rfidNumber: e.target.value })} 
                    className="bg-white light:bg-white dark:bg-slate-700 border-gray-300 light:border-gray-300 dark:border-slate-600 text-gray-900 light:text-gray-900 dark:text-white"
                    required 
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 light:text-gray-700 dark:text-slate-300 mb-1">RFID Used</label>
                  <Select value={form.rfidUsed.toString()} onValueChange={v => setForm({ ...form, rfidUsed: v === 'true' })}>
                    <SelectTrigger className="w-full bg-white light:bg-white dark:bg-slate-700 border-gray-300 light:border-gray-300 dark:border-slate-600 text-gray-900 light:text-gray-900 dark:text-white">
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                    <SelectContent className="bg-white light:bg-white dark:bg-slate-700 border-gray-300 light:border-gray-300 dark:border-slate-600">
                      <SelectItem value="true">True</SelectItem>
                      <SelectItem value="false">False</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                
                {formError && <div className="text-red-500 text-sm">{formError}</div>}
                <div className="flex justify-end pt-3 gap-2">
                  <Button type="button" onClick={() => setShowAddModal(false)} variant="outline" className="border-gray-300 light:border-gray-300 dark:border-slate-600 text-gray-900 light:text-gray-900 dark:text-slate-300">Cancel</Button>
                  <Button type="submit" className="bg-green-600 text-white light:bg-green-600 light:text-white hover:bg-green-700 light:hover:bg-green-700" disabled={formLoading}>{formLoading ? 'Adding...' : 'Add'}</Button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* View Modal */}
        {showViewModal && selectedTag && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-white light:bg-white dark:bg-slate-800 p-6 rounded-xl w-full max-w-md space-y-3 border border-slate-700 light:border-gray-200 shadow-xl">
              <h2 className="text-lg font-semibold mb-2 text-center text-slate-900 light:text-gray-900 dark:text-white">RFID Details</h2>
              <div className="space-y-2 text-sm">
                <div><span className="font-medium text-slate-700 light:text-gray-700 dark:text-slate-300">RFID Number:</span> <span className="text-slate-900 light:text-gray-900 dark:text-white">{selectedTag.rfid_number}</span></div>
                <div><span className="font-medium text-slate-700 light:text-gray-700 dark:text-slate-300">RFID Used:</span> <span className="text-slate-900 light:text-gray-900 dark:text-white">{selectedTag.rfid_used}</span></div>
                <div><span className="font-medium text-slate-700 light:text-gray-700 dark:text-slate-300">RFID Linked to Order:</span> <span className="text-slate-900 light:text-gray-900 dark:text-white">{selectedTag.rfid_linked_to_order}</span></div>
              </div>
              <div className="flex justify-end pt-3">
                <Button onClick={() => setShowViewModal(false)} className="bg-cyan-600 text-white light:bg-cyan-600 light:text-white hover:bg-cyan-700 light:hover:bg-cyan-700">Close</Button>
              </div>
            </div>
          </div>
        )}

        {/* Edit Modal */}
        {showEditModal && selectedTag && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-white light:bg-white dark:bg-slate-800 p-6 rounded-xl w-full max-w-md space-y-3 border border-slate-700 light:border-gray-200 shadow-xl">
              <h2 className="text-lg font-semibold mb-2 text-center text-slate-900 light:text-gray-900 dark:text-white">Edit RFID</h2>
              <form onSubmit={handleEditSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 light:text-gray-700 dark:text-slate-300 mb-1">RFID Number</label>
                  <Input 
                    type="number" 
                    placeholder="Enter RFID Number (e.g., 11)" 
                    value={form.rfidNumber} 
                    onChange={e => setForm({ ...form, rfidNumber: e.target.value })} 
                    className="bg-white light:bg-white dark:bg-slate-700 border-gray-300 light:border-gray-300 dark:border-slate-600 text-gray-900 light:text-gray-900 dark:text-white"
                    required 
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 light:text-gray-700 dark:text-slate-300 mb-1">RFID Used</label>
                  <Select value={form.rfidUsed.toString()} onValueChange={v => setForm({ ...form, rfidUsed: v === 'true' })}>
                    <SelectTrigger className="w-full bg-white light:bg-white dark:bg-slate-700 border-gray-300 light:border-gray-300 dark:border-slate-600 text-gray-900 light:text-gray-900 dark:text-white">
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                    <SelectContent className="bg-white light:bg-white dark:bg-slate-700 border-gray-300 light:border-gray-300 dark:border-slate-600">
                      <SelectItem value="true">True</SelectItem>
                      <SelectItem value="false">False</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                
                {formError && <div className="text-red-500 text-sm">{formError}</div>}
                <div className="flex justify-end pt-3 gap-2">
                  <Button type="button" onClick={() => setShowEditModal(false)} variant="outline" className="border-gray-300 light:border-gray-300 dark:border-slate-600 text-gray-900 light:text-gray-900 dark:text-slate-300">Cancel</Button>
                  <Button type="submit" className="bg-yellow-500 text-white light:bg-yellow-500 light:text-white hover:bg-yellow-600 light:hover:bg-yellow-600" disabled={formLoading}>{formLoading ? 'Saving...' : 'Save'}</Button>
                </div>
              </form>
            </div>
          </div>
        )}

      </div>
  )
}