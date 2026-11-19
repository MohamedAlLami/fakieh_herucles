import React, { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Plus, Eye, Pencil, Trash2, X, Truck, Users, Wrench, Scale, Printer, FileSpreadsheet } from 'lucide-react'
import { printTable } from '../../utils/printTable'
import { exportTableToExcel, type ExportColumn } from '../../utils/exportTable'

interface Truck {
  id: number
  license: string
  model: string
  year: string
  capacity: string
  company: string
  contact: string
}

interface Driver {
  id: number
  name: string
  license_no: string
  assigned_truck: string
  rfid: string
  contact: string
  status: 'Active' | 'Inactive'
}

interface Maintenance {
  id: number
  truck: string
  type: string
  issue: string
  scheduledDate: string
  lastServiceDate: string
  status: 'pending' | 'in-progress' | 'completed'
  technician: string
}

// IN/OUT pair for a truck for a given day
interface WeightPair {
  truck_id: number
  in_weight: number | null
  out_weight: number | null
  net: number | null
  in_ts?: string | null
  out_ts?: string | null
}

import { API_BASE_URL } from '../../config/api'
const API_BASE = API_BASE_URL

const getStatusColor = (status: string) => {
  const statusLower = status.toLowerCase()
  if (statusLower === 'active') return 'bg-green-600 text-white'
  if (statusLower === 'maintenance' || statusLower === 'pending') return 'bg-yellow-600 text-white'
  if (statusLower === 'in-progress') return 'bg-blue-600 text-white'
  if (statusLower === 'completed') return 'bg-gray-600 text-white'
  if (statusLower === 'inactive') return 'bg-red-500 text-white'
  return 'bg-red-500 text-white'
}

function formatTime(ts?: string | null) {
  if (!ts) return '-'
  try {
    const d = new Date(ts)
    // Show local HH:MM
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return '-'
  }
}

export default function TruckManagement({
  section = 'trucks',
}: {
  section?: 'trucks' | 'drivers'
}): JSX.Element {
  const [activeTab, setActiveTab] = useState<'trucks' | 'drivers' | 'maintenance'>(section)

  useEffect(() => {
    setActiveTab(section)
  }, [section])

  const [search, setSearch] = useState('')
  const [listError, setListError] = useState<string | null>(null)

  const [truckData, setTruckData] = useState<Truck[]>([])
  const [driverData, setDriverData] = useState<Driver[]>([])
  const [maintenanceData, setMaintenanceData] = useState<Maintenance[]>([])

  // New: weights map by truck_id
  const [weightsByTruck, setWeightsByTruck] = useState<Record<number, WeightPair>>({})

  // --- CRUD states for Trucks ---
  const [showAddModal, setShowAddModal] = useState(false)
  const [showViewModal, setShowViewModal] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [selectedTruck, setSelectedTruck] = useState<Truck | null>(null)
  const [truckToDelete, setTruckToDelete] = useState<Truck | null>(null)
  const [editMode, setEditMode] = useState(false)
  const [newTruck, setNewTruck] = useState({
    license: '',
    model: '',
    year: '',
    capacity: '',
    company: '',
    contact: '',
  })

  // --- CRUD states for Drivers ---
  const [showAddDriverModal, setShowAddDriverModal] = useState(false)
  const [selectedDriver, setSelectedDriver] = useState<Driver | null>(null)
  const [editDriverMode, setEditDriverMode] = useState(false)
  const [newDriver, setNewDriver] = useState({
    name: '',
    license_no: '',
    assigned_truck: '',
    truck_id: '',
    rfid: '',
    contact: '',
    status: 'Active',
  })

  // --- CRUD states for Maintenance ---
  const [showAddMaintenanceModal, setShowAddMaintenanceModal] = useState(false)
  const [newMaintenance, setNewMaintenance] = useState({
    truck: '',
    type: '',
    issue: '',
    scheduledDate: '',
    lastServiceDate: '',
    technician: '',
    status: 'pending',
  })

  const fetchTrucks = async () => {
    try {
      const res = await axios.get(`${API_BASE}/trucks/`)
      const body = res.data
      setTruckData(Array.isArray(body) ? body : body?.items ?? [])
    } catch (err) {
      
    }
  }

  const fetchDrivers = async () => {
    try {
      const res = await axios.get(`${API_BASE}/trucks/drivers`)
      const body = res.data
      setDriverData(Array.isArray(body) ? body : body?.items ?? [])
    } catch (err) {
      
    }
  }

  const fetchMaintenance = async () => {
    try {
      const res = await axios.get(`${API_BASE}/maintenance/`)
      setMaintenanceData(res.data)
    } catch (err) {
      
    }
  }

  // NEW: fetch today's IN/OUT pairs (supports both shapes: {pairs:[...]} or {rows:[...]})
  const fetchWeightsToday = async () => {
    try {
      const res = await axios.get(`${API_BASE}/weights/today?unit=kg`)
      const data = res.data || {}
      const map: Record<number, WeightPair> = {}

      if (Array.isArray(data.pairs)) {
        data.pairs.forEach((p: any) => {
          const tid = Number(p.truck_id)
          map[tid] = {
            truck_id: tid,
            in_weight: p.in_weight ?? null,
            out_weight: p.out_weight ?? null,
            net: p.net ?? (p.out_weight != null && p.in_weight != null ? p.out_weight - p.in_weight : null),
            in_ts: p.in_ts ?? null,
            out_ts: p.out_ts ?? null,
          }
        })
      } else if (Array.isArray(data.rows)) {
        // Fallback if your endpoint returns table rows with only net
        data.rows.forEach((r: any) => {
          const tid = Number(r.truck_id)
          map[tid] = {
            truck_id: tid,
            in_weight: null,
            out_weight: null,
            net: typeof r.weight_kg === 'number' ? r.weight_kg : null,
            in_ts: r.in_ts ?? null,
            out_ts: r.out_ts ?? null,
          }
        })
      }

      setWeightsByTruck(map)
    } catch (err) {
      
      setWeightsByTruck({})
    }
  }

  useEffect(() => {
    fetchTrucks()
    fetchDrivers()
    fetchMaintenance()
    fetchWeightsToday()
  }, [])

  const handleChange = (field: string, value: string) => {
    setNewTruck({ ...newTruck, [field]: value })
  }

  const handleChangeDriver = (field: string, value: string) => {
    if (field === 'truck_id' && value === 'none') {
      setNewDriver({ ...newDriver, [field]: '' })
    } else {
      setNewDriver({ ...newDriver, [field]: value })
    }
  }

  const handleChangeMaintenance = (field: string, value: string) => {
    setNewMaintenance({ ...newMaintenance, [field]: value })
  }

  const handleAddTruck = async () => {
    try {
      if (editMode && selectedTruck) {
        await axios.put(`${API_BASE}/trucks/${selectedTruck.id}`, newTruck)
      } else {
        await axios.post(`${API_BASE}/trucks/`, newTruck)
      }
      setShowAddModal(false)
      setEditMode(false)
      setSelectedTruck(null)
      setNewTruck({ license: '', model: '', year: '', capacity: '', company: '', contact: '' })
      fetchTrucks()
    } catch (err) {
      
    }
  }

  const handleAddDriver = async () => {
    try {
      if (editDriverMode && selectedDriver) {
        await axios.put(`${API_BASE}/trucks/drivers/${selectedDriver.id}`, newDriver)
      } else {
        await axios.post(`${API_BASE}/trucks/drivers`, newDriver)
      }
      setShowAddDriverModal(false)
      setEditDriverMode(false)
      setSelectedDriver(null)
      setNewDriver({ name: '', license_no: '', assigned_truck: '', truck_id: '', rfid: '', contact: '', status: 'Active' })
      fetchDrivers()
    } catch (err) {
      
    }
  }

  const handleAddMaintenance = async () => {
    try {
      await axios.post(`${API_BASE}/maintenance/`, newMaintenance)
      setShowAddMaintenanceModal(false)
      setNewMaintenance({ truck: '', type: '', issue: '', scheduledDate: '', lastServiceDate: '', technician: '', status: 'pending' })
      fetchMaintenance()
    } catch (err) {
      
    }
  }

  const handleDeleteTruck = async () => {
    if (!truckToDelete) return
    try {
      await axios.delete(`${API_BASE}/trucks/${truckToDelete.id}`)
      setShowDeleteModal(false)
      setTruckToDelete(null)
      fetchTrucks()
    } catch (err) {
      
    }
  }

  const confirmDeleteTruck = (truck: Truck) => {
    setTruckToDelete(truck)
    setShowDeleteModal(true)
  }

  const handleDeleteDriver = async (id: number) => {
    try {
      await axios.delete(`${API_BASE}/trucks/drivers/${id}`)
      fetchDrivers()
    } catch (err) {
      
    }
  }

  const filteredTrucks = useMemo(() => {
    return truckData.filter((t) => {
      return t.license.toLowerCase().includes(search.toLowerCase()) || t.model.toLowerCase().includes(search.toLowerCase())
    })
  }, [truckData, search])

  // Print / Excel of the list on screen (trucks after the search, or all drivers), without the action buttons.
  const truckColumns: ExportColumn<Truck>[] = [
    { header: 'License Plate', cell: (t) => t.license },
    { header: 'Model', cell: (t) => t.model },
    { header: 'Year', cell: (t) => t.year },
    { header: 'Capacity', cell: (t) => t.capacity },
    { header: 'Owner Company', cell: (t) => t.company },
    { header: 'Contact', cell: (t) => t.contact },
  ]
  const driverColumns: ExportColumn<Driver>[] = [
    { header: 'Name', cell: (d) => d.name },
    { header: 'RFID', cell: (d) => d.rfid },
    { header: 'License No.', cell: (d) => d.license_no },
    { header: 'Contact', cell: (d) => d.contact },
    { header: 'Assigned Truck', cell: (d) => d.assigned_truck },
    { header: 'Status', cell: (d) => d.status },
  ]
  const isTrucks = activeTab === 'trucks'
  const listRowCount = isTrucks ? filteredTrucks.length : driverData.length
  const listTitle = isTrucks ? 'Trucks' : 'Drivers'
  const listSubtitles = () => {
    const sub = [`${listRowCount} ${listTitle.toLowerCase()}`]
    if (isTrucks && search.trim()) sub.push(`Search: ${search.trim()}`)
    return sub
  }
  async function handleListPrint() {
    const err = isTrucks
      ? await printTable({ title: listTitle, subtitles: listSubtitles(), columns: truckColumns, rows: filteredTrucks })
      : await printTable({ title: listTitle, subtitles: listSubtitles(), columns: driverColumns, rows: driverData })
    setListError(err)
  }
  async function handleListExcel() {
    const err = isTrucks
      ? await exportTableToExcel({ title: listTitle, subtitles: listSubtitles(), columns: truckColumns, rows: filteredTrucks, filename: 'trucks', sheetName: 'Trucks' })
      : await exportTableToExcel({ title: listTitle, subtitles: listSubtitles(), columns: driverColumns, rows: driverData, filename: 'drivers', sheetName: 'Drivers' })
    setListError(err)
  }
  const listButtonClass = 'mr-2 border-slate-600 text-slate-300 light:border-gray-300 light:text-gray-700 hover:bg-slate-700 light:hover:bg-gray-100'

  return (
    <>
      <div className="p-6 space-y-6 truck-management-container">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-slate-800 light:bg-white p-4 rounded-lg text-white light:text-gray-900 border border-slate-700 light:border-gray-200">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-300 light:text-gray-600">TOTAL TRUCKS</p>
            <p className="text-2xl font-bold">{truckData.length}</p>
              </div>
              <Truck className="h-8 w-8 text-cyan-400 light:text-cyan-600" />
            </div>
          </div>
          <div className="bg-slate-800 light:bg-white p-4 rounded-lg text-white light:text-gray-900 border border-slate-700 light:border-gray-200">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-300 light:text-gray-600">PENDING MAINTENANCE</p>
            <p className="text-2xl font-bold">{maintenanceData.filter(m => m.status === 'pending').length}</p>
              </div>
              <Wrench className="h-8 w-8 text-green-400 light:text-green-600" />
            </div>
          </div>
          <div className="bg-slate-800 light:bg-white p-4 rounded-lg text-white light:text-gray-900 border border-slate-700 light:border-gray-200">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-300 light:text-gray-600">ACTIVE DRIVERS</p>
            <p className="text-2xl font-bold">{driverData.filter(d => d.status === 'Active').length}</p>
              </div>
              <Users className="h-8 w-8 text-blue-400 light:text-blue-600" />
            </div>
          </div>
          <div className="bg-slate-800 light:bg-white p-4 rounded-lg text-white light:text-gray-900 border border-slate-700 light:border-gray-200">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-300 light:text-gray-600">COMPLETED WEIGHS (Today)</p>
            <p className="text-2xl font-bold">{Object.keys(weightsByTruck).length}</p>
              </div>
              <Scale className="h-8 w-8 text-yellow-400 light:text-yellow-600" />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end mt-2">
          {(activeTab === 'trucks' || activeTab === 'drivers') && (
            <>
              <Button
                variant="outline"
                onClick={() => void handleListPrint()}
                disabled={listRowCount === 0}
                className={listButtonClass}
                data-testid={isTrucks ? 'trucks-print' : 'drivers-print'}
              >
                <Printer className="h-4 w-4 mr-2" /> Print
              </Button>
              <Button
                variant="outline"
                onClick={() => void handleListExcel()}
                disabled={listRowCount === 0}
                className={listButtonClass}
                data-testid={isTrucks ? 'trucks-excel' : 'drivers-excel'}
              >
                <FileSpreadsheet className="h-4 w-4 mr-2" /> Export Excel
              </Button>
            </>
          )}
          {activeTab === 'trucks' && (
            <Button 
              className="bg-cyan-600 text-white light:bg-cyan-600 light:text-white hover:bg-cyan-700 light:hover:bg-cyan-700" 
              onClick={() => {
                setEditMode(false)
                setNewTruck({ license: '', model: '', year: '', capacity: '', company: '', contact: '' })
                setShowAddModal(true)
              }}
              style={{ backgroundColor: '#0891b2', color: 'white' }}
            >
              <Plus className="h-4 w-4 mr-2" /> Add Truck
            </Button>
          )}
          {activeTab === 'drivers' && (
            <Button 
              className="bg-cyan-600 text-white light:bg-cyan-600 light:text-white hover:bg-cyan-700 light:hover:bg-cyan-700" 
              onClick={() => {
                setEditDriverMode(false)
                setSelectedDriver(null)
                setNewDriver({ name: '', license_no: '', assigned_truck: '', truck_id: '', rfid: '', contact: '', status: 'Active' })
                setShowAddDriverModal(true)
              }}
              style={{ backgroundColor: '#0891b2', color: 'white' }}
            >
              <Plus className="h-4 w-4 mr-2" /> Add Driver
            </Button>
          )}
        </div>

        {listError && <p className="text-sm text-red-400 light:text-red-600">{listError}</p>}

        {/* Search */}
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-4 mt-6">
          <Input 
            placeholder="Search..." 
            className="w-full md:w-1/2 bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-700" 
            value={search} 
            onChange={(e) => setSearch(e.target.value)} 
          />
        </div>

        {/* Tab Content */}
        {activeTab === 'trucks' && (
          <div className="overflow-x-auto rounded-lg border border-slate-700 light:border-gray-200">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-800 dark:bg-slate-800 bg-gray-50 text-black dark:text-white">
                  <TableHead>License Plate</TableHead>
                  <TableHead>Capacity</TableHead>
                  <TableHead>Owner Company</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTrucks.map((truck) => (
                    <TableRow key={truck.id} className="bg-slate-900 light:bg-white hover:bg-slate-800 light:hover:bg-gray-50 text-white light:text-gray-900">
                      <TableCell className="text-cyan-400 light:text-cyan-600 font-semibold">{truck.license}</TableCell>
                      <TableCell>{truck.capacity}</TableCell>
                      <TableCell>{truck.company}</TableCell>
                      <TableCell>{truck.contact}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end space-x-2">
                          <button 
                            className="h-10 w-10 rounded-md border border-gray-200 bg-white hover:bg-gray-50 flex items-center justify-center transition-colors"
                            onClick={() => {
                              setSelectedTruck(truck)
                              setShowViewModal(true)
                            }}
                          >
                            <Eye className="w-4 h-4 text-blue-600 hover:text-blue-700" />
                          </button>
                          <button 
                            className="h-10 w-10 rounded-md border border-gray-200 bg-white hover:bg-gray-50 flex items-center justify-center transition-colors"
                            onClick={() => {
                              setSelectedTruck(truck)
                              setNewTruck({
                                license: truck.license,
                                model: truck.model,
                                year: truck.year,
                                capacity: truck.capacity,
                                company: truck.company,
                                contact: truck.contact,
                              })
                              setEditMode(true)
                              setShowAddModal(true)
                            }}
                          >
                            <Pencil className="w-4 h-4 text-yellow-600 hover:text-yellow-700" />
                          </button>
                          <button 
                            className="h-10 w-10 rounded-md border border-gray-200 bg-white hover:bg-gray-50 flex items-center justify-center transition-colors"
                            onClick={() => confirmDeleteTruck(truck)}
                          >
                            <Trash2 className="w-4 h-4 text-red-600 hover:text-red-700" />
                          </button>
                        </div>
                      </TableCell>
                    </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {activeTab === 'drivers' && (
          <div className="overflow-x-auto rounded-lg border border-slate-700 dark:border-slate-700 border-gray-200">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-800 dark:bg-slate-800 bg-gray-50 text-black dark:text-white">
                  <TableHead>Name</TableHead>
                  <TableHead>RFID</TableHead>
                  <TableHead>License No.</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Assigned Truck</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {driverData.map((d) => (
                  <TableRow key={d.id} className="bg-slate-900 hover:bg-slate-800 text-white">
                    <TableCell className="text-cyan-400 font-semibold">{d.name}</TableCell>
                    <TableCell>{d.rfid}</TableCell>
                    <TableCell>{d.license_no}</TableCell>
                    <TableCell>{d.contact}</TableCell>
                    <TableCell>{d.assigned_truck}</TableCell>
                    <TableCell><span className={`px-2 py-1 text-xs rounded-full font-medium ${getStatusColor(d.status)}`}>{d.status}</span></TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end space-x-2">
                        <button 
                          className="h-10 w-10 rounded-md border border-gray-200 bg-white hover:bg-gray-50 flex items-center justify-center transition-colors"
                          onClick={() => {
                            // View driver details - you can implement this functionality
                            }}
                        >
                          <Eye className="w-4 h-4 text-blue-600 hover:text-blue-700" />
                        </button>
                        <button 
                          className="h-10 w-10 rounded-md border border-gray-200 bg-white hover:bg-gray-50 flex items-center justify-center transition-colors"
                          onClick={() => {
                            setSelectedDriver(d)
                            setNewDriver({ 
                              name: d.name,
                              license_no: d.license_no,
                              assigned_truck: d.assigned_truck,
                              truck_id: d.assigned_truck, // Map assigned_truck to truck_id
                              rfid: d.rfid,
                              contact: d.contact,
                              status: d.status
                            })
                            setEditDriverMode(true)
                            setShowAddDriverModal(true)
                          }}
                        >
                          <Pencil className="w-4 h-4 text-yellow-600 hover:text-yellow-700" />
                        </button>
                        <button 
                          className="h-10 w-10 rounded-md border border-gray-200 bg-white hover:bg-gray-50 flex items-center justify-center transition-colors"
                          onClick={() => handleDeleteDriver(d.id)}
                        >
                          <Trash2 className="w-4 h-4 text-red-600 hover:text-red-700" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {activeTab === 'maintenance' && (
          <div className="overflow-x-auto rounded-lg border border-slate-700 dark:border-slate-700 border-gray-200">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-800 dark:bg-slate-800 bg-gray-50 text-black dark:text-white">
                  <TableHead>Truck</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Issue</TableHead>
                  <TableHead>Scheduled Date</TableHead>
                  <TableHead>Last Service</TableHead>
                  <TableHead>Technician</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {maintenanceData.map((m) => (
                  <TableRow key={m.id} className="bg-slate-900 hover:bg-slate-800 text-white">
                    <TableCell className="text-cyan-400 font-semibold">{m.truck}</TableCell>
                    <TableCell>{m.type}</TableCell>
                    <TableCell>{m.issue}</TableCell>
                    <TableCell>{m.scheduledDate}</TableCell>
                    <TableCell>{m.lastServiceDate}</TableCell>
                    <TableCell>{m.technician}</TableCell>
                    <TableCell><span className={`px-2 py-1 text-xs rounded-full font-medium ${getStatusColor(m.status)}`}>{m.status}</span></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

      </div>

      {/* View Truck Modal */}
      {showViewModal && selectedTruck && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center">
          <div className="bg-slate-900 light:bg-white text-white light:text-gray-900 rounded-xl shadow-xl w-full max-w-2xl p-6 space-y-4 relative">
            <button 
              onClick={() => setShowViewModal(false)} 
              className="absolute top-4 right-4 p-1 text-red-500 hover:text-red-600 transition-all duration-200"
            >
              <X className="w-6 h-6" />
            </button>
            <h2 className="text-xl font-semibold mb-4">Truck Details</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-slate-300 light:text-gray-600">License Plate</label>
                  <p className="text-lg font-semibold text-cyan-400 light:text-cyan-600">{selectedTruck.license}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-300 light:text-gray-600">Capacity</label>
                  <p className="text-lg">{selectedTruck.capacity}</p>
                </div>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-slate-300 light:text-gray-600">Owner Company</label>
                  <p className="text-lg">{selectedTruck.company}</p>
                </div>
                <div>
                  <label className="text-sm font-medium text-slate-300 light:text-gray-600">Contact</label>
                  <p className="text-lg">{selectedTruck.contact}</p>
                </div>
              </div>
            </div>
            
            {/* Today's Weight Information */}
            {weightsByTruck[selectedTruck.id] && (
              <div className="mt-6 p-4 bg-slate-800/50 light:bg-gray-100 rounded-lg">
                <h3 className="text-lg font-semibold mb-3 text-cyan-400 light:text-cyan-600">Today's Weight Information</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="text-sm font-medium text-slate-300 light:text-gray-600">In Weight</label>
                    <p className="text-lg font-semibold">
                      {weightsByTruck[selectedTruck.id].in_weight ? `${weightsByTruck[selectedTruck.id].in_weight} kg` : 'Not weighed'}
                    </p>
                    <p className="text-xs text-slate-400 light:text-gray-500">
                      {formatTime(weightsByTruck[selectedTruck.id].in_ts)}
                    </p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-300 light:text-gray-600">Out Weight</label>
                    <p className="text-lg font-semibold">
                      {weightsByTruck[selectedTruck.id].out_weight ? `${weightsByTruck[selectedTruck.id].out_weight} kg` : 'Not weighed'}
                    </p>
                    <p className="text-xs text-slate-400 light:text-gray-500">
                      {formatTime(weightsByTruck[selectedTruck.id].out_ts)}
                    </p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-300 light:text-gray-600">Net Weight</label>
                    <p className="text-lg font-semibold text-green-400 light:text-green-600">
                      {weightsByTruck[selectedTruck.id].net ? `${weightsByTruck[selectedTruck.id].net} kg` : 'N/A'}
                    </p>
                  </div>
                </div>
              </div>
            )}
            
            <div className="flex justify-end gap-2 mt-6">
              <Button 
                variant="ghost" 
                onClick={() => setShowViewModal(false)}
                className="text-slate-300 light:text-gray-600 hover:text-white light:hover:text-gray-900"
              >
                Close
              </Button>
              <Button 
                className="bg-cyan-600 hover:bg-cyan-700 text-white light:bg-cyan-600 light:hover:bg-cyan-700 light:text-white"
                onClick={() => {
                  setShowViewModal(false)
                  setNewTruck({
                    license: selectedTruck.license,
                    model: selectedTruck.model,
                    year: selectedTruck.year,
                    capacity: selectedTruck.capacity,
                    company: selectedTruck.company,
                    contact: selectedTruck.contact,
                  })
                  setEditMode(true)
                  setShowAddModal(true)
                }}
              >
                Edit Truck
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteModal && truckToDelete && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center">
          <div className="bg-slate-900 light:bg-white text-white light:text-gray-900 rounded-xl shadow-xl w-full max-w-md p-6 space-y-4 relative">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-red-600/20 rounded-full">
                <Trash2 className="w-6 h-6 text-red-400" />
              </div>
              <h2 className="text-xl font-semibold">Delete Truck</h2>
            </div>
            <p className="text-slate-300 light:text-gray-600">
              Are you sure you want to delete truck <span className="font-semibold text-cyan-400 light:text-cyan-600">{truckToDelete.license}</span>? 
              This action cannot be undone.
            </p>
            <div className="bg-slate-800/50 light:bg-gray-100 p-3 rounded-lg">
              <p className="text-sm text-slate-400 light:text-gray-500">
                <strong>Model:</strong> {truckToDelete.model}<br/>
                <strong>Company:</strong> {truckToDelete.company}
              </p>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <Button 
                variant="ghost" 
                onClick={() => {
                  setShowDeleteModal(false)
                  setTruckToDelete(null)
                }}
                className="text-slate-300 light:text-gray-600 hover:text-white light:hover:text-gray-900"
              >
                Cancel
              </Button>
              <Button 
                className="bg-red-600 hover:bg-red-700 text-white light:bg-red-600 light:hover:bg-red-700 light:text-white"
                onClick={handleDeleteTruck}
              >
                Delete Truck
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Add/Edit Truck Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center">
          <div className="bg-slate-900 light:bg-white text-white light:text-gray-900 rounded-xl shadow-xl w-full max-w-2xl p-6 space-y-4 relative">
            <button 
              onClick={() => setShowAddModal(false)} 
              className="absolute top-4 right-4 p-1 text-red-500 hover:text-red-600 transition-all duration-200"
            >
              <X className="w-6 h-6" />
            </button>
            <h2 className="text-xl font-semibold mb-4">{editMode ? 'Edit Truck' : 'Add New Truck'}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input 
                placeholder="License Plate" 
                value={newTruck.license} 
                onChange={(e) => handleChange('license', e.target.value)}
                className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-900"
              />
              <Input 
                placeholder="Capacity" 
                value={newTruck.capacity} 
                onChange={(e) => handleChange('capacity', e.target.value)}
                className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-900"
              />
              <Input 
                placeholder="Owner Company" 
                value={newTruck.company} 
                onChange={(e) => handleChange('company', e.target.value)}
                className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-900"
              />
              <Input 
                placeholder="Contact" 
                value={newTruck.contact} 
                onChange={(e) => handleChange('contact', e.target.value)}
                className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-900"
              />
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <Button 
                variant="ghost" 
                onClick={() => setShowAddModal(false)}
                className="text-slate-300 light:text-gray-600 hover:text-white light:hover:text-gray-900"
              >
                Cancel
              </Button>
              <Button 
                className="bg-cyan-600 hover:bg-cyan-700 text-white light:bg-cyan-600 light:hover:bg-cyan-700 light:text-white"
                onClick={handleAddTruck}
                style={{ backgroundColor: '#0891b2', color: 'white' }}
              >
                {editMode ? 'Update Truck' : 'Save Truck'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Add Driver Modal */}
      {showAddDriverModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center">
          <div className="bg-slate-900 light:bg-white text-white light:text-gray-900 rounded-xl shadow-xl w-full max-w-2xl p-6 space-y-4 relative">
            <button 
              onClick={() => setShowAddDriverModal(false)} 
              className="absolute top-4 right-4 p-1 text-red-500 hover:text-red-600 transition-all duration-200"
            >
              <X className="w-6 h-6" />
            </button>
            <h2 className="text-xl font-semibold mb-4">{editDriverMode ? 'Edit Driver' : 'Add New Driver'}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input placeholder="Name" value={newDriver.name} onChange={e => handleChangeDriver('name', e.target.value)} />
              <Input placeholder="RFID" value={newDriver.rfid} onChange={e => handleChangeDriver('rfid', e.target.value)} />
              <Input placeholder="License No." value={newDriver.license_no} onChange={e => handleChangeDriver('license_no', e.target.value)} />
              <Input placeholder="Contact" value={newDriver.contact} onChange={e => handleChangeDriver('contact', e.target.value)} />
              <Input placeholder="Assigned Truck" value={newDriver.assigned_truck} onChange={e => handleChangeDriver('assigned_truck', e.target.value)} />
              <div>
                <Select onValueChange={v => handleChangeDriver('truck_id', v)} value={newDriver.truck_id || "none"}>
                  <SelectTrigger><SelectValue placeholder="Select Truck ID" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No Truck Assigned</SelectItem>
                    {truckData.map((truck) => (
                      <SelectItem key={truck.id} value={String(truck.id)}>
                        {truck.id} - {truck.license} ({truck.model})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Select onValueChange={v => handleChangeDriver('status', v)} defaultValue={newDriver.status}>
                  <SelectTrigger><SelectValue placeholder="Status" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Active">Active</SelectItem>
                    <SelectItem value="Inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="ghost" onClick={() => setShowAddDriverModal(false)}>Cancel</Button>
              <Button className="bg-green-600 text-white" onClick={handleAddDriver}>
                {editDriverMode ? 'Update Driver' : 'Save Driver'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Add Maintenance Modal */}
      {showAddMaintenanceModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center">
          <div className="bg-slate-900 light:bg-white text-white light:text-gray-900 rounded-xl shadow-xl w-full max-w-2xl p-6 space-y-4 relative">
            <button 
              onClick={() => setShowAddMaintenanceModal(false)} 
              className="absolute top-4 right-4 p-1 text-red-500 hover:text-red-600 transition-all duration-200"
            >
              <X className="w-6 h-6" />
            </button>
            <h2 className="text-xl font-semibold mb-4">Add New Maintenance</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input placeholder="Truck" value={newMaintenance.truck} onChange={e => handleChangeMaintenance('truck', e.target.value)} />
              <Input placeholder="Type" value={newMaintenance.type} onChange={e => handleChangeMaintenance('type', e.target.value)} />
              <Input placeholder="Issue" value={newMaintenance.issue} onChange={e => handleChangeMaintenance('issue', e.target.value)} />
              <Input placeholder="Scheduled Date" value={newMaintenance.scheduledDate} onChange={e => handleChangeMaintenance('scheduledDate', e.target.value)} />
              <Input placeholder="Last Service" value={newMaintenance.lastServiceDate} onChange={e => handleChangeMaintenance('lastServiceDate', e.target.value)} />
              <Input placeholder="Technician" value={newMaintenance.technician} onChange={e => handleChangeMaintenance('technician', e.target.value)} />
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="ghost" onClick={() => setShowAddMaintenanceModal(false)}>Cancel</Button>
              <Button className="bg-green-600 text-white" onClick={handleAddMaintenance}>Save Maintenance</Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export { TruckManagement }
