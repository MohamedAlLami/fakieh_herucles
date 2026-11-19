import React, { useState, useEffect, useCallback } from 'react'
import { WaterSystemLayout } from '../../components/water-system/WaterSystemLayout'
import { Truck, Package, Calendar, MapPin, CheckCircle, Clock, FileText, Search, RefreshCw, X, Radio, Printer, FileSpreadsheet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from '@/components/ui/pagination'
import { useSilos, useSilosPolling } from '../../contexts/SiloContext'
import { usePolling } from '../../hooks/usePolling'
import axios from 'axios'
import { API_BASE_URL, PLC_BASE_URL } from '../../config/api'
import { useToast } from '@/hooks/use-toast'
import {
  isOutloadingTab,
  isSiloSelectableForOrder,
  getOutloadingSiloStatusSuffix,
  formatDestSelLabel,
  isOutloadingHighSilo,
} from '../../utils/outloadingSilos'
import { SearchableSelect, type SearchableOption } from '../../components/water-system/SearchableSelect'
import { printTable } from '../../utils/printTable'
import { exportTableToExcel, type ExportColumn } from '../../utils/exportTable'
import { useMaterialCodes, getMaterialNameFromCode } from '../../constants/materialCodes'
import { RfidAssignModal, orderRefLabelFromActiveTab } from '../../components/water-system/RfidAssignModal'

const baseUrl = API_BASE_URL
const plcBase = PLC_BASE_URL;

type OrderType = 'intake' | 'outloading' | 'bulk' | 'pit';
const toNum = (v: any) => (v === '' || v === null || v === undefined ? 0 : Number(v));

const ORDER_BTN =
  'bg-cyan-600 hover:bg-cyan-700 text-white light:bg-cyan-600 light:hover:bg-cyan-700 light:text-white';
const ORDER_BTN_OUTLINE =
  'text-xs bg-cyan-600 hover:bg-cyan-700 text-white border-cyan-600 hover:border-cyan-700 light:bg-cyan-600 light:hover:bg-cyan-700 light:text-white light:border-cyan-600 light:hover:border-cyan-700';
const ORDER_BTN_SM =
  'text-xs px-2 py-1 bg-cyan-600 text-white hover:bg-cyan-700 light:bg-cyan-600 light:text-white light:hover:bg-cyan-700';

// Shared column widths so the live-order table and the waiting-order table line up.
const COLW_INTAKE = ['8%', '16%', '12%', '14%', '14%', '12%', '10%', '14%'];
const COLW_OUTLOADING = ['7%', '14%', '10%', '9%', '12%', '12%', '11%', '10%', '15%'];
const COLW_BULK = ['14%', '14%', '14%', '11%', '12%', '11%', '10%', '14%'];
const COLW_PIT = ['11%', '11%', '15%', '15%', '12%', '11%', '11%', '14%'];

const ColGroup = ({ widths }: { widths: string[] }) => (
  <colgroup>
    {widths.map((w, i) => (
      <col key={i} style={{ width: w }} />
    ))}
  </colgroup>
);

// Truck and client are no longer chosen on the order form; the backend accepts null for both.
const orderMetaFields = () => ({
  truck_id: null,
  client_id: null,
});

// Compare material codes ignoring leading zeros ("012" == "12"); empty never matches.
const normalizeMaterialCode = (code: unknown) => String(code ?? '').trim().replace(/^0+(?=\d)/, '');
const sameMaterialCode = (a: unknown, b: unknown) => {
  const x = normalizeMaterialCode(a);
  return x !== '' && x === normalizeMaterialCode(b);
};

const plcEndpointFor = (orderType: OrderType, line?: number, isMineralOrder: boolean = false) => {
  if (orderType === 'intake') {
    if (isMineralOrder) {
      return `${plcBase}/db/3/intake/line/${line}/write`;  // Mineral orders use DB3
    } else {
      return `${plcBase}/db/1/intake/line/${line}/write`;  // Regular intake uses DB1
    }
  }
  if (orderType === 'outloading')return `${plcBase}/db/2/outloading/line/${line}/write`;
  if (orderType === 'bulk')      return `${plcBase}/db/4/bulk/write`;
  if (orderType === 'pit')        return `${plcBase}/db/4/pit/write`;
  throw new Error('Unknown orderType');
};

const payloadFor = (orderType: OrderType, item: any) => {
  if (orderType === 'intake' || orderType === 'outloading') {
    // Extract just the material code (e.g., "100" from "100 - Yellow Maize 7.8%")
    const materialCode = item.sourceMaterialCode && item.sourceMaterialCode.includes(' - ') 
      ? item.sourceMaterialCode.split(' - ')[0] 
      : item.sourceMaterialCode;
    
    const p: any = {
      badge_no: item.badgeNo,                          // STRING or INT (ok)
      material_code: materialCode,                     // STRING - just the code part
      declared_qty_kg: toNum(item.declaredQuantityKG), // REAL
      dest1: toNum(item.destinationSilo1),             // INT
      dest2: toNum(item.destinationSilo2),             // INT
    };
    if (orderType === 'outloading') {
      p.dest_sel = toNum(item.destSel ?? 0);
    } else if (item.destSel !== undefined && item.destSel !== null) {
      p.dest_sel = toNum(item.destSel);
    }
    return { ...p, ...orderMetaFields() };
  }
  if (orderType === 'bulk') {
    return {
      source_silo: toNum(item.sourceSilo),
      dest1: toNum(item.destinationSilo1),
      dest2: toNum(item.destinationSilo2),
      cc25_sel: toNum(item.cc25Sel),
      declared_qty_kg: toNum(item.declaredQuantityKG),
      scale_sel: toNum(item.scaleSel),
      ...orderMetaFields(),
    };
  }
  if (orderType === 'pit') {
    // Extract just the material code (e.g., "100" from "100 - Yellow Maize 7.8%")
    const rawCode = item.rawCode && item.rawCode.includes(' - ') 
      ? item.rawCode.split(' - ')[0] 
      : item.rawCode;
    
    return {
      pit_no: toNum(item.pitNo),
      raw_code: rawCode,  // STRING - just the code part
      dest1: toNum(item.destinationSilo1),
      dest2: toNum(item.destinationSilo2),
      declared_qty_kg: toNum(item.declaredQuantityKG),
      scale_sel: toNum(item.scaleSel),
      ...orderMetaFields(),
    };
  }
};

const sendToPLC = async (orderType: OrderType, item: any, line?: number, isMineralOrder: boolean = false) => {
  try {
    const url = plcEndpointFor(orderType, line, isMineralOrder);
    const payload = payloadFor(orderType, item);
    const { data } = await axios.post(url, payload);

    if (data?.ok) {
      const dbStatus = data.db_success ? '✅' : '⚠️';
      const dbMessage = data.db_success ? 'stored in database' : 'failed to store in database';
      alert(`✅ Sent to PLC (${orderType}${line ? ` / line ${line}` : ''}) ${dbStatus} ${dbMessage}`);
    } else {
      alert(`⚠️ PLC response: ${JSON.stringify(data)}`);
    }
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      const msg = err.response?.data?.error || err.response?.data?.message || err.message;

      // common backend rejections you'll see
      if (status === 409) {
        alert(`⛔ Line not Idle. PLC says: ${msg}`);
      } else if (status === 422) {
        // Your HL/LOCK rule
        alert(`⛔ Blocked by HL/LOCK: ${msg}`);
      } else {
        alert(`❌ PLC write failed: ${msg}`);
      }
    } else {
      alert(`❌ PLC write failed: ${(err as Error).message}`);
    }
  }
};


const getStatusColor = (status: string) => {
  switch (status) {
    case 'Idle':
      return 'text-green-400 light:text-green-600 bg-green-500/10 light:bg-green-100 border-green-500/20 light:border-green-300'
    case 'Starting':
      return 'text-blue-400 light:text-blue-600 bg-blue-500/10 light:bg-blue-100 border-blue-500/20 light:border-blue-300'
    case 'Running':
      return 'text-purple-400 light:text-purple-600 bg-purple-500/10 light:bg-purple-100 border-purple-500/20 light:border-purple-300'
    case 'Stopping':
      return 'text-orange-400 light:text-orange-600 bg-orange-500/10 light:bg-orange-100 border-orange-500/20 light:border-orange-300'
    case 'No Status':
      return 'text-slate-400 light:text-slate-600 bg-slate-500/10 light:bg-slate-100 border-slate-500/20 light:border-slate-300'
    // Legacy status types for backward compatibility
    case 'Completed':
      return 'text-green-400 light:text-green-600 bg-green-500/10 light:bg-green-100 border-green-500/20 light:border-green-300'
    case 'Active':
    case 'Loading':
      return 'text-blue-400 light:text-blue-600 bg-blue-500/10 light:bg-blue-100 border-blue-500/20 light:border-blue-300'
    case 'Pending':
    case 'Scheduled':
      return 'text-orange-400 light:text-orange-600 bg-orange-500/10 light:bg-orange-100 border-orange-500/20 light:border-orange-300'
    case 'Processing':
    case 'Preparing':
      return 'text-purple-400 light:text-purple-600 bg-purple-500/10 light:bg-purple-100 border-purple-500/20 light:border-purple-300'
    default:
      return 'text-slate-400 light:text-slate-600 bg-slate-500/10 light:bg-slate-100 border-slate-500/20 light:border-slate-300'
  }
}

const getStatusIcon = (status: string) => {
  switch (status) {
    case 'Idle':
      return <CheckCircle className="h-3 w-3" />
    case 'Starting':
      return <Clock className="h-3 w-3" />
    case 'Running':
      return <Clock className="h-3 w-3" />
    case 'Stopping':
      return <Clock className="h-3 w-3" />
    case 'No Status':
      return <Clock className="h-3 w-3" />
    // Legacy status types for backward compatibility
    case 'Completed':
      return <CheckCircle className="h-3 w-3" />
    case 'Active':
    case 'Loading':
    case 'Processing':
      return <Clock className="h-3 w-3" />
    case 'Pending':
    case 'Scheduled':
    case 'Preparing':
      return <Clock className="h-3 w-3" />
    default:
      return <Clock className="h-3 w-3" />
  }
}

export function Orders() {
  const { getSilosForOrder, getAvailableSilos } = useSilos();
  // Live silo locks/levels are needed here (destination pickers) — opt in.
  useSilosPolling(15000);
  const { toast } = useToast();
  
  const liveMaterialCodes = useMaterialCodes();
  const materialCodes = liveMaterialCodes.slice().sort((a, b) => Number(a.code) - Number(b.code));
  
  // Helper function to get material name for a silo number
  const getMaterialNameForSilo = (siloNumber: string | number) => {
    if (!siloNumber || siloNumber === '') return '-';
    
    const allSilos = getAvailableSilos();
    
    const silo = allSilos.find(s => {
      // Try multiple ways to match the silo number
      const siloNum = s.silo_no || parseInt(s.bin_name.split(' ')[1]) || 0;
      return siloNum === Number(siloNumber) || s.bin_name === `Silo ${siloNumber}`;
    });
    
    
    if (silo && silo.material_name) {
      return silo.material_name;
    }
    
    if (silo && silo.material_code) {
      // Fallback to material code if no name available
      return silo.material_code;
    }
    
    return `Silo ${siloNumber}`;
  };
  
  // Helper function to extract used silos from current orders
  const extractUsedSilos = (orders: any[]) => {
    const used = new Set<string>();
    orders.forEach(order => {
      // Add destination silos that are currently being used
      if (order.destinationSilo1 && order.destinationSilo1 !== 'None' && order.destinationSilo1 !== '') {
        used.add(order.destinationSilo1);
      }
      if (order.destinationSilo2 && order.destinationSilo2 !== 'None' && order.destinationSilo2 !== '') {
        used.add(order.destinationSilo2);
      }
      // Add source silos for bulk orders
      if (order.sourceSilo && order.sourceSilo !== 'None' && order.sourceSilo !== '') {
        used.add(order.sourceSilo);
      }
    });
    return used;
  };
  
  const resolveOrderTypeFromTab = (tab: string): { orderType: string; line: number; isMineralOrder: boolean } => {
    if (tab === 'intake-line-1') return { orderType: 'intake', line: 1, isMineralOrder: false };
    if (tab === 'intake-line-2') return { orderType: 'intake', line: 2, isMineralOrder: false };
    if (tab === 'mineral-intake') return { orderType: 'intake', line: 3, isMineralOrder: true };
    if (tab === 'outloading-1') return { orderType: 'outloading', line: 1, isMineralOrder: false };
    if (tab === 'outloading-2') return { orderType: 'outloading', line: 2, isMineralOrder: false };
    if (tab === 'outloading-3') return { orderType: 'outloading', line: 3, isMineralOrder: false };
    if (tab === 'bulk-line') return { orderType: 'bulk', line: 1, isMineralOrder: false };
    if (tab === 'pt-line') return { orderType: 'pit', line: 1, isMineralOrder: false };
    return { orderType: 'intake', line: 1, isMineralOrder: false };
  };

  // Helper function to get available silos count for user feedback
  const getAvailableSilosCount = (fieldName: string) => {
    const allSilos = getAvailableSilos();
    const { orderType, line, isMineralOrder } = resolveOrderTypeFromTab(activeTab);
    if (fieldName === 'destinationSilo1' || fieldName === 'destinationSilo2') {
      return getSilosForOrderType(orderType, line, isMineralOrder).filter(
        (silo) => isSiloSelectableForOrder(silo, orderType, allSilos) && !usedSilos.has(silo.bin_name)
      ).length;
    } else if (fieldName === 'sourceSilo') {
      return getAvailableSilos().filter(silo => (silo.material_code || silo.material_name) && !usedSilos.has(silo.bin_name)).length;
    }
    return getAvailableSilos().filter(silo => !usedSilos.has(silo.bin_name)).length;
  };

  // Helper to get silos for specific order type based on your exact silo mapping order
  const getSilosForOrderType = (orderType: string, line?: number, isMineralOrder: boolean = false, isDestination: boolean = false) => {
    // Get silos from the appropriate database based on order type
    let availableSilos = []
    
    
    switch (orderType) {
      case 'intake':
        if (isMineralOrder) {
          // Mineral Intake: Use DB3 silos (401-408)
          availableSilos = getAvailableSilos().filter(silo => silo.dbSource === 'DB3')
        } else {
          // Regular Intake Line 1 & 2: Use DB1 silos
          availableSilos = getAvailableSilos().filter(silo => silo.dbSource === 'DB1')
        }
        break
      
      case 'outloading':
        // Outloading: Use DB2 silos
        availableSilos = getAvailableSilos().filter(silo => silo.dbSource === 'DB2')
        break
      
      case 'bulk':
        if (isDestination) {
          // Bulk Line Destinations: Use only silos 301-322 (destination silos for bulk line)
          availableSilos = getAvailableSilos().filter(silo => {
            const siloNumber = parseInt(silo.bin_name.split(' ')[1]);
            return siloNumber >= 301 && siloNumber <= 322;
          })
        } else {
          // Bulk Line Sources: Use only silos 101-115 (source silos for bulk line)
          availableSilos = getAvailableSilos().filter(silo => {
            const siloNumber = parseInt(silo.bin_name.split(' ')[1]);
            return siloNumber >= 101 && siloNumber <= 115;
          })
        }
        break
      
      case 'pit':
        // PIT Line: Use only silos 301-322 for destinations
        availableSilos = getAvailableSilos().filter(silo => {
          const siloNumber = parseInt(silo.bin_name.split(' ')[1]);
          return siloNumber >= 301 && siloNumber <= 322;
        })
        break
      
      default:
        availableSilos = getAvailableSilos()
    }
    
    // Define the exact order of silos as per your spreadsheet
    const siloOrderMappings = {
      'intake': {
        // Intake Line 1 & 2: Silo 101-115, then 201-203, then 301-322 (in exact order)
        silos: [
          'Silo 101', 'Silo 102', 'Silo 103', 'Silo 104', 'Silo 105', 'Silo 106', 'Silo 107', 'Silo 108', 'Silo 109', 'Silo 110',
          'Silo 111', 'Silo 112', 'Silo 113', 'Silo 114', 'Silo 115',
          'Silo 201', 'Silo 202', 'Silo 203',
          'Silo 301', 'Silo 302', 'Silo 303', 'Silo 304', 'Silo 305', 'Silo 306', 'Silo 307', 'Silo 308', 'Silo 309', 'Silo 310',
          'Silo 311', 'Silo 312', 'Silo 313', 'Silo 314', 'Silo 315', 'Silo 316', 'Silo 317', 'Silo 318', 'Silo 319', 'Silo 320',
          'Silo 321', 'Silo 322'
        ]
      },
      'mineral': {
        // Mineral Intake: Silo 401-408 (in exact order)
        silos: [
          'Silo 401', 'Silo 402', 'Silo 403', 'Silo 404', 'Silo 405', 'Silo 406', 'Silo 407', 'Silo 408'
        ]
      },
      'outloading': {
        // Outloading: Silo 801-848 (in exact order)
        silos: [
          'Silo 801', 'Silo 802', 'Silo 803', 'Silo 804', 'Silo 805', 'Silo 806', 'Silo 807', 'Silo 808', 'Silo 809', 'Silo 810',
          'Silo 811', 'Silo 812', 'Silo 813', 'Silo 814', 'Silo 815', 'Silo 816', 'Silo 817', 'Silo 818', 'Silo 819', 'Silo 820',
          'Silo 821', 'Silo 822', 'Silo 823', 'Silo 824', 'Silo 825', 'Silo 826', 'Silo 827', 'Silo 828', 'Silo 829', 'Silo 830',
          'Silo 831', 'Silo 832', 'Silo 833', 'Silo 834', 'Silo 835', 'Silo 836', 'Silo 837', 'Silo 838', 'Silo 839', 'Silo 840',
          'Silo 841', 'Silo 842', 'Silo 843', 'Silo 844', 'Silo 845', 'Silo 846', 'Silo 847', 'Silo 848'
        ]
      },
      'bulk': {
        // Bulk Source: Silo 101-118, Bulk Destination: Silo 301-322 (in exact order)
        silos: [
          'Silo 101', 'Silo 102', 'Silo 103', 'Silo 104', 'Silo 105', 'Silo 106', 'Silo 107', 'Silo 108', 'Silo 109', 'Silo 110',
          'Silo 111', 'Silo 112', 'Silo 113', 'Silo 114', 'Silo 115', 'Silo 116', 'Silo 117', 'Silo 118',
          'Silo 301', 'Silo 302', 'Silo 303', 'Silo 304', 'Silo 305', 'Silo 306', 'Silo 307', 'Silo 308', 'Silo 309', 'Silo 310',
          'Silo 311', 'Silo 312', 'Silo 313', 'Silo 314', 'Silo 315', 'Silo 316', 'Silo 317', 'Silo 318', 'Silo 319', 'Silo 320',
          'Silo 321', 'Silo 322'
        ]
      },
      'pit': {
        // PIT Line: Use only silos 301-322 for destinations
        silos: [
          'Silo 301', 'Silo 302', 'Silo 303', 'Silo 304', 'Silo 305', 'Silo 306', 'Silo 307', 'Silo 308', 'Silo 309', 'Silo 310',
          'Silo 311', 'Silo 312', 'Silo 313', 'Silo 314', 'Silo 315', 'Silo 316', 'Silo 317', 'Silo 318', 'Silo 319', 'Silo 320',
          'Silo 321', 'Silo 322'
        ]
      }
    }
    
    let targetSilos: string[] = []
    
    switch (orderType) {
      case 'intake':
        if (isMineralOrder) {
          // Mineral Intake
          targetSilos = siloOrderMappings.mineral.silos
        } else {
          // Intake Line 1 & 2
          targetSilos = siloOrderMappings.intake.silos
        }
        break
      
      case 'outloading':
        targetSilos = siloOrderMappings.outloading.silos
        break
      
      case 'bulk':
        targetSilos = siloOrderMappings.bulk.silos
        break
      
      case 'pit':
        targetSilos = siloOrderMappings.pit.silos
        break
      
      default:
        availableSilos = getAvailableSilos()
    }
    
    // Filter and sort available silos according to the exact order from your spreadsheet
    const orderedSilos = targetSilos
      .map(siloName => availableSilos.find(silo => silo.bin_name === siloName))
      .filter(silo => silo !== undefined) // Remove undefined entries
    if (orderType === 'outloading') {
      return orderedSilos.filter((silo) => isOutloadingHighSilo(silo));
    }
    return orderedSilos
  }
  
  const [showModal, setShowModal] = useState(false)
  const [showAssignModal, setShowAssignModal] = useState(false)
  const [activeTab, setActiveTab] = useState('intake-line-1')
  
  // State to track currently used silos
  const [usedSilos, setUsedSilos] = useState<Set<string>>(new Set())
  
  // Debug: Log activeTab changes
  useEffect(() => {
  }, [activeTab]);
  const [formData, setFormData] = useState<Record<string, string | number>>({})
  const [viewModal, setViewModal] = useState(false)
  const [viewOrder, setViewOrder] = useState<any>(null)
  const [editModal, setEditModal] = useState(false)
  const [editOrder, setEditOrder] = useState<any>(null)
  const [editFormData, setEditFormData] = useState<any>({})
  const [isLoading, setIsLoading] = useState(true)
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date())

  
  const [intakeLine1Data, setIntakeLine1Data] = useState<any[]>([])
  const [intakeLine2Data, setIntakeLine2Data] = useState<any[]>([])
  const [mineralIntakeData, setMineralIntakeData] = useState<any[]>([])
  const [outloading1Data, setOutloading1Data] = useState<any[]>([])
  const [outloading2Data, setOutloading2Data] = useState<any[]>([])
  const [outloading3Data, setOutloading3Data] = useState<any[]>([])
  const [bulkLineData, setBulkLineData] = useState<any[]>([])
  const [ptLineData, setPtLineData] = useState<any[]>([])
  const [binMaterials, setBinMaterials] = useState<any[]>([])
  const [rfidConfigs, setRfidConfigs] = useState<any[]>([])
  const [queueItems, setQueueItems] = useState<any[]>([])
  const [trucks, setTrucks] = useState<Array<{ id: number; license: string; model: string }>>([])
  
  // Note: Pagination removed since we're getting live PLC data

  // Read-only: broadcast is always-on on the backend (no Start/Stop for operators).
  const [broadcastStatus, setBroadcastStatus] = useState<'running' | 'stopped'>('stopped');


  const fetchBinMaterials = useCallback(async () => {
    try {
      const response = await axios.get(`${baseUrl}/bin-materials`)
      setBinMaterials(response.data || [])
    } catch (error) {
      
    }
  }, [])

  const fetchRfidConfigs = useCallback(async () => {
    try {
      const response = await axios.get(`${baseUrl}/rfid/config`, {
        params: { limit: 2000, offset: 0 },
      })
      const body = response.data
      const list = Array.isArray(body) ? body : body?.items ?? []
      setRfidConfigs(list)
    } catch (error) {
      
    }
  }, [])

  const fetchQueue = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await axios.get(`${plcBase}/orders/queue`, { signal })
      const body = response.data
      setQueueItems(Array.isArray(body) ? body : body?.items ?? [])
    } catch (error) {
      // keep previous queue on transient error
    }
  }, [])

  const cancelQueuedOrder = useCallback(async (id: number) => {
    try {
      await axios.post(`${plcBase}/orders/queue/${id}/cancel`)
      toast({ title: 'Order cancelled', description: 'Removed from waiting list.', variant: 'default' })
      await fetchQueue()
      await fetchRfidConfigs()
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Failed to cancel order'
      toast({ title: 'Cancel failed', description: msg, variant: 'destructive' })
    }
  }, [fetchQueue, fetchRfidConfigs, toast])

  const startQueuedOrder = useCallback(async (id: number) => {
    try {
      await axios.post(`${plcBase}/orders/queue/${id}/start`)
      toast({ title: 'Order started', description: 'Written to the PLC. It will run when the line begins.', variant: 'default' })
      await fetchQueue()
      await fetchOrders()
    } catch (err: any) {
      const status = err?.response?.status
      const msg = err?.response?.data?.error || err?.message || 'Failed to start order'
      // If the line is busy/not idle, offer a forced start.
      if (status === 409 && window.confirm(`${msg}\n\nForce start anyway? This overwrites whatever is currently on the line.`)) {
        try {
          await axios.post(`${plcBase}/orders/queue/${id}/start?force=true`)
          toast({ title: 'Order force-started', description: 'Written to the PLC.', variant: 'default' })
          await fetchQueue()
          await fetchOrders()
          return
        } catch (err2: any) {
          const msg2 = err2?.response?.data?.error || err2?.message || 'Failed to force start order'
          toast({ title: 'Start failed', description: msg2, variant: 'destructive' })
          return
        }
      }
      toast({ title: 'Start failed', description: msg, variant: 'destructive' })
    }
    // fetchOrders is a stable useCallback defined later; referenced via closure only.
  }, [fetchQueue, toast])

  const fetchTrucks = useCallback(async () => {
    try {
      const response = await axios.get(`${baseUrl}/trucks/`)
      const body = response.data
      setTrucks(Array.isArray(body) ? body : body?.items ?? [])
    } catch (error) {
      setTrucks([])
    }
  }, [])

  const checkBroadcastStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await axios.get(`${baseUrl}/websocket/status`, { signal })
      setBroadcastStatus(response.data.broadcast_running === true ? 'running' : 'stopped')
    } catch (error) {
      if ((error as any)?.name === 'CanceledError') return
      setBroadcastStatus('stopped')
    }
  }, [])

  const fetchOrders = useCallback(async (signal?: AbortSignal) => {
    try {
      // Fetch data directly from PLC
      const plcResponse = await axios.get(`${plcBase}/plant/orders`, { signal });
      const plcData = plcResponse.data;

      // Mineral orders are now included in the PLC data

      // Helper function to convert PLC data to frontend format
      const convertPlcToFrontend = (plcOrder: any) => ({
        id: `plc_${plcOrder.line}_${plcOrder.badge_no || 'empty'}_${Date.now()}`, // Generate unique ID
        badgeNo: plcOrder.badge_no || '',
        sourceMaterialCode: plcOrder.material_code || '',
        declaredQuantityKG: plcOrder.declared_qty_kg || 0,
        destinationSilo1: plcOrder.dest1 || '',
        destinationSilo2: plcOrder.dest2 || '',
        activeDestination: plcOrder.active_destination || '',
        statusWord: typeof plcOrder.status_word === 'object' ? plcOrder.status_word?.label || 'Unknown' : 'Unknown',
        statusCode: typeof plcOrder.status_word === 'object' ? plcOrder.status_word?.code || 0 : plcOrder.status_word || 0,
        rfidBadgeReading: plcOrder.rfid_badge_reading || '',
        activeBadge: plcOrder.active_badge || '',
        destSel: plcOrder.dest_sel ?? plcOrder.active_dest_sel ?? '',
        line: plcOrder.line,
        // Add timestamp for real-time tracking
        lastUpdated: new Date().toISOString()
      });


      // Process intake data (lines 1 and 2)
      const intakeOrders = plcData.intake || [];
      const intake1Orders = intakeOrders
        .filter((order: any) => order.line === 1)
        .map(convertPlcToFrontend);
      const intake2Orders = intakeOrders
        .filter((order: any) => order.line === 2)
        .map(convertPlcToFrontend);
      
      // Process mineral orders from PLC data
      const mineralOrders = (plcData.mineral || []).map(convertPlcToFrontend);

      // Process outloading data (lines 1, 2, 3)
      const outloadingOrders = plcData.outloading || [];
      const outloading1Orders = outloadingOrders
        .filter((order: any) => order.line === 1)
        .map(convertPlcToFrontend);
      const outloading2Orders = outloadingOrders
        .filter((order: any) => order.line === 2)
        .map(convertPlcToFrontend);
      const outloading3Orders = outloadingOrders
        .filter((order: any) => order.line === 3)
        .map(convertPlcToFrontend);

      // Process bulk data
      const bulkData = plcData.bulk;
      const bulkOrders = bulkData ? [{
        id: `plc_bulk_${Date.now()}`,
        sourceSilo: bulkData.source_silo || '',
        destinationSilo1: bulkData.dest1 || '',
        destinationSilo2: bulkData.dest2 || '',
        cc25Sel: bulkData.cc25_sel || '',
        declaredQuantityKG: bulkData.declared_qty_kg || 0,
        scaleSel: bulkData.scale_sel || '',
        statusWord: typeof bulkData.status_word === 'object' ? bulkData.status_word?.label || 'Unknown' : 'Unknown',
        statusCode: typeof bulkData.status_word === 'object' ? bulkData.status_word?.code || 0 : bulkData.status_word || 0,
        lastUpdated: new Date().toISOString()
      }] : [];

      // Process pit data
      const pitData = plcData.pit;
      const ptOrders = pitData ? [{
        id: `plc_pit_${Date.now()}`,
        pitNo: pitData.pit_no || '',
        rawCode: pitData.raw_code || '',
        destinationSilo1: pitData.dest1 || '',
        destinationSilo2: pitData.dest2 || '',
        declaredQuantityKG: pitData.declared_qty_kg || 0,
        scaleSel: pitData.scale_sel || '',
        statusWord: typeof pitData.status_word === 'object' ? pitData.status_word?.label || 'Unknown' : 'Unknown',
        statusCode: typeof pitData.status_word === 'object' ? pitData.status_word?.code || 0 : pitData.status_word || 0,
        lastUpdated: new Date().toISOString()
      }] : [];

      // Set the data directly from PLC
      setIntakeLine1Data(intake1Orders);
      setIntakeLine2Data(intake2Orders);
      setMineralIntakeData(mineralOrders);
      setOutloading1Data(outloading1Orders);
      setOutloading2Data(outloading2Orders);
      setOutloading3Data(outloading3Orders);
      setBulkLineData(bulkOrders);
      setPtLineData(ptOrders);
      
      // Note: Pagination removed since we're getting live PLC data
      
      // Extract used silos from all current orders
      const allCurrentOrders = [
        ...intake1Orders,
        ...intake2Orders,
        ...outloading1Orders,
        ...outloading2Orders,
        ...outloading3Orders,
        ...bulkOrders,
        ...ptOrders,
        ...mineralOrders
      ];
      const usedSilosSet = extractUsedSilos(allCurrentOrders);
      setUsedSilos(usedSilosSet);
      
      setLastUpdate(new Date())
      setIsLoading(false)
      
    } catch (error) {
      
      setIsLoading(false)
      
      // Show user-friendly error message
      if (axios.isAxiosError(error)) {
        const errorMessage = error.response?.data?.message || error.message
        
        alert(`❌ Failed to fetch PLC data: ${errorMessage}`);
      }
    }
  }, []) // Remove currentPage and itemsPerPage dependencies since we're getting live data

  // One-shot reference data: loaded once on mount, never polled.
  useEffect(() => {
    fetchBinMaterials()
    fetchRfidConfigs()
    fetchTrucks()
  }, [])

  // Live PLC status + queue. usePolling runs this immediately, then every 5s,
  // but skips a tick while the previous one is still in flight — this is what
  // stops the request pile-up that used to starve asset requests.
  usePolling(async (signal) => {
    await Promise.all([
      fetchOrders(signal),
      fetchQueue(signal),
      checkBroadcastStatus(signal),
    ])
  }, 5000)

  // Handler for viewing an order
  const handleView = (order: any) => {
    setViewOrder(order)
    setViewModal(true)
  }

  // Handler for editing an order
  const handleEdit = (order: any) => {
    setEditOrder(order)
    setEditFormData({
      badgeNo: order.badgeNo || '',
      sourceMaterialCode: order.sourceMaterialCode || '',
      destSel: order.destSel !== undefined && order.destSel !== '' ? String(order.destSel) : '0',
      declaredQuantityKG: order.declaredQuantityKG || '',
      destinationSilo1: order.destinationSilo1 || '',
      destinationSilo2: order.destinationSilo2 || ''
    })
    setEditModal(true)
  }

  // Enqueue an order into the live queue (WAITING). It is NOT written to the PLC
  // here — the backend dispatcher writes it to the PLC line when the line is Idle
  // and the scanned RFID matches. This allows queuing multiple orders per line.
  const createOrderComprehensive = async (orderType: OrderType, item: any, line?: number, isMineralOrder: boolean = false) => {
    try {
      const base = payloadFor(orderType, item) as any;
      const rfidNumber = item.badgeNo ?? base.badge_no ?? '';
      const materialName = base.material_code
        ? getMaterialNameFromCode(String(base.material_code))
        : (base.raw_code ? getMaterialNameFromCode(String(base.raw_code)) : '');

      const payload = {
        order_type: orderType,
        line: line,
        is_mineral: isMineralOrder,
        rfid_number: rfidNumber,
        material_name: materialName,
        ...base,
      };

      const { data } = await axios.post(`${plcBase}/orders/enqueue`, payload);

      if (data?.ok) {
        const pos = data.order?.queuePosition;
        toast({
          title: "Order Queued 🕒",
          description: `Added to waiting list${pos ? ` (position ${pos})` : ''}. It will start when the line is free and its RFID is scanned.`,
          variant: "default",
        });
        await fetchQueue();
        await fetchRfidConfigs();
        return true;
      } else {
        toast({
          title: "Order Queue Failed",
          description: `Failed to queue order: ${JSON.stringify(data)}`,
          variant: "destructive",
        });
        return false;
      }
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const msg = err.response?.data?.error || err.response?.data?.message || err.message;
        toast({
          title: "Order Creation Failed",
          description: msg,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Order Creation Failed",
          description: (err as Error).message,
          variant: "destructive",
        });
      }
      return false;
    }
  };

  // Handler for editing an order
  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!editOrder) return
    
    try {
      setIsLoading(true)
      
      // Determine order type and line from the editOrder
      // Check the current active tab to determine the order type
      let orderType = 'intake'
      let line = 1
      
      if (activeTab === 'intake-line-1') {
        orderType = 'intake'
        line = 1
      } else if (activeTab === 'intake-line-2') {
        orderType = 'intake'
        line = 2
      } else if (activeTab === 'mineral-intake') {
        orderType = 'intake'
        line = 3 // ✅ CORRECT! Mineral intake uses line 3
      } else if (activeTab === 'outloading-1') {
        orderType = 'outloading'
        line = 1
      } else if (activeTab === 'outloading-2') {
        orderType = 'outloading'
        line = 2
      } else if (activeTab === 'outloading-3') {
        orderType = 'outloading'
        line = 3
      } else if (activeTab === 'bulk-line') {
        orderType = 'bulk'
        line = 1
      } else if (activeTab === 'pt-line') {
        orderType = 'pit'
        line = 1
      }
      
      // Create updated order data (only editable fields)
      // Note: API expects specific field names
      // Add validation to prevent None values
      const updatedOrderData: {
        badge_no: string;
        material_code: string;
        declared_qty_kg: number;
        dest1: number;
        dest2: number;
        dest_sel?: number;
      } = {
        badge_no: editFormData.badgeNo || "",
        material_code: editFormData.sourceMaterialCode || "",
        declared_qty_kg: Number(editFormData.declaredQuantityKG) || 0,
        dest1: Number(editFormData.destinationSilo1) || 0,
        dest2: Number(editFormData.destinationSilo2) || 0
      }
      if (orderType === 'outloading') {
        updatedOrderData.dest_sel = Number(editFormData.destSel ?? 0);
      }
      
      // Validate required fields
      if (!updatedOrderData.badge_no || !updatedOrderData.material_code) {
        alert("❌ Please fill in all required fields (RFID Badge and Material Code)")
        return
      }
      
      if (updatedOrderData.declared_qty_kg <= 0) {
        alert("❌ Please enter a valid quantity greater than 0")
        return
      }
      
      if (updatedOrderData.dest1 <= 0 || updatedOrderData.dest2 <= 0) {
        alert("❌ Please select valid destination silos")
        return
      }
      
      // Call the comprehensive order creation API to update the order
      const response = await axios.post(`http://localhost:5000/api/plc/orders/create`, {
        order_type: orderType,
        line: line,
        ...updatedOrderData
      })
      
      if (response.data.ok) {
        toast({
          title: "Order Updated Successfully! ✅",
          description: `RFID: ${updatedOrderData.badge_no} | Material: ${getMaterialNameFromCode(updatedOrderData.material_code)} | Quantity: ${updatedOrderData.declared_qty_kg} KG | Destinations: ${updatedOrderData.dest1}, ${updatedOrderData.dest2}`,
          variant: "default",
        });
        setEditModal(false)
        setEditOrder(null)
        setEditFormData({})
        // Refresh the orders data
        fetchOrders()
      } else {
        alert(`❌ Failed to update order: ${response.data.error || 'Unknown error'}`)
      }
      
    } catch (error: any) {
      
      alert(`❌ Error updating order: ${error.response?.data?.error || error.message || 'Unknown error'}`)
    } finally {
      setIsLoading(false)
    }
  }

  // Handler for deleting an order (Note: PLC data cannot be deleted directly)
  const handleDelete = async (orderType: string, id: number, line?: string) => {
    alert(`ℹ️ Cannot delete PLC data directly. Orders shown are live data from the PLC.\n\nTo clear an order from the PLC, you would need to:\n1. Reset the PLC status\n2. Clear the order data in the PLC\n3. Or wait for the order to complete naturally\n\nThis data refreshes every 5 seconds from the PLC.`)
  }
  

  // Note: Pagination helpers removed since we're getting live PLC data

  // Helper to get fields for each line
  const getFieldsForLine = (line: string) => {
    switch (line) {
      case 'intake-line-1':
      case 'intake-line-2':
      case 'mineral-intake':
        return [
          { name: 'badgeNo', label: 'RFID', type: 'select' },
          { name: 'sourceMaterialCode', label: 'Source Material Code', type: 'select' },
          { name: 'declaredQuantityKG', label: 'Declared Quantity (KG)', type: 'number' },
          { name: 'destinationSilo1', label: 'Destination Silo 1 (Available Only)', type: 'select' },
          { name: 'destinationSilo2', label: 'Destination Silo 2 (Available Only)', type: 'select' },
          // NOTE: removed rfidBadgeReading, active*, statusWord (read-only)
        ]
      case 'outloading-1':
      case 'outloading-2':
      case 'outloading-3':
        return [
          { name: 'badgeNo', label: 'RFID', type: 'select' },
          { name: 'sourceMaterialCode', label: 'Source Material Code', type: 'select' },
          { name: 'destSel', label: 'Destination (Bulk / Packing)', type: 'select' },
          { name: 'declaredQuantityKG', label: 'Declared Quantity (KG)', type: 'number' },
          { name: 'destinationSilo1', label: 'Destination Silo 1 (Available Only)', type: 'select' },
          { name: 'destinationSilo2', label: 'Destination Silo 2 (Available Only)', type: 'select' },
        ]
      case 'bulk-line':
        return [
          { name: 'sourceSilo', label: 'Source Silo (With Material)', type: 'select' },
          { name: 'destinationSilo1', label: 'Destination 1 (Available Only)', type: 'select' },
          { name: 'destinationSilo2', label: 'Destination 2 (Available Only)', type: 'select' },
          { name: 'cc25Sel', label: 'CC25 Selection', type: 'text' },
          { name: 'declaredQuantityKG', label: 'Weight Quantity (KG)', type: 'number' },
          { name: 'scaleSel', label: 'Scale Selection', type: 'text' },
        ]
      case 'pt-line':
        return [
          { name: 'pitNo', label: 'Pit Number', type: 'text' },
          { name: 'rawCode', label: 'Raw Material Code', type: 'select' },
          { name: 'destinationSilo1', label: 'Destination 1 (Available Only)', type: 'select' },
          { name: 'destinationSilo2', label: 'Destination 2 (Available Only)', type: 'select' },
          { name: 'declaredQuantityKG', label: 'Weight Quantity (KG)', type: 'number' },
          { name: 'scaleSel', label: 'Scale Selection', type: 'text' },
        ]
      default:
        return []
    }
  }

  // ---- Print / Export Excel for the tables on this page ----
  const siloLabel = (silo: any) => `Silo ${silo || '-'} - ${getMaterialNameForSilo(silo)}`;
  const qtyNum = (v: any) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v));
  const qtyCol = (get: (r: any) => any): ExportColumn<any> => ({
    header: 'Declared Quantity_KG',
    cell: (r) => String(get(r) ?? ''),
    excel: (r) => qtyNum(get(r)),
    numeric: true,
  });

  const liveColumns = (kind: 'intake' | 'outloading' | 'bulk' | 'pit'): ExportColumn<any>[] => {
    const d1: ExportColumn<any> = { header: 'Destination 1 (Material)', cell: (r) => siloLabel(r.destinationSilo1) };
    const d2: ExportColumn<any> = { header: 'Destination 2 (Material)', cell: (r) => siloLabel(r.destinationSilo2) };
    const active: ExportColumn<any> = { header: 'Active Destination (Material)', cell: (r) => siloLabel(r.activeDestination) };
    if (kind === 'bulk') {
      return [
        { header: 'Source Silo (Material)', cell: (r) => siloLabel(r.sourceSilo) },
        d1, d2,
        { header: 'CC25 Sel', cell: (r) => r.cc25Sel || '-' },
        { ...qtyCol((r) => r.declaredQuantityKG || 0), header: 'Weight Quantity' },
        { header: 'Scale Sel', cell: (r) => r.scaleSel || '-' },
        { header: 'Status', cell: (r) => r.statusWord || 'Unknown' },
      ];
    }
    if (kind === 'pit') {
      return [
        { header: 'Pit No', cell: (r) => r.pitNo || '-' },
        { header: 'Raw Code', cell: (r) => r.rawCode || '-' },
        d1, d2,
        { ...qtyCol((r) => r.declaredQuantityKG || 0), header: 'Weight Quantity' },
        { header: 'Scale Sel', cell: (r) => r.scaleSel || '-' },
        { header: 'Status', cell: (r) => r.statusWord || 'Unknown' },
      ];
    }
    const cols: ExportColumn<any>[] = [
      { header: 'RFID', cell: (r) => r.badgeNo },
      { header: 'Source/Line Material', cell: (r) => `${r.sourceMaterialCode || '-'} ${getMaterialNameFromCode(r.sourceMaterialCode)}`.trim() },
      qtyCol((r) => r.declaredQuantityKG),
    ];
    if (kind === 'outloading') cols.push({ header: 'Dest. Selection', cell: (r) => formatDestSelLabel(r.destSel) });
    cols.push(d1, d2, active, { header: 'Status Word', cell: (r) => r.statusWord });
    return cols;
  };

  const waitingColumns = (fam: string): ExportColumn<any>[] => {
    const d1: ExportColumn<any> = { header: 'Destination 1 (Material)', cell: (r) => siloLabel(r.destinationSilo1) };
    const d2: ExportColumn<any> = { header: 'Destination 2 (Material)', cell: (r) => siloLabel(r.destinationSilo2) };
    const status: ExportColumn<any> = { header: fam === 'bulk' || fam === 'pit' ? 'Status' : 'Status Word', cell: (r) => r.queueStatus };
    if (fam === 'bulk') {
      return [
        { header: 'Source Silo (Material)', cell: (r) => siloLabel(r.sourceSilo) },
        d1, d2,
        { header: 'CC25 Sel', cell: (r) => r.cc25Sel || '-' },
        { ...qtyCol((r) => r.declaredQuantityKG || 0), header: 'Weight Quantity' },
        { header: 'Scale Sel', cell: (r) => r.scaleSel || '-' },
        status,
      ];
    }
    if (fam === 'pit') {
      return [
        { header: 'Pit No', cell: (r) => r.pitNo || '-' },
        { header: 'Raw Code', cell: (r) => r.rawCode || r.materialCode || '-' },
        d1, d2,
        { ...qtyCol((r) => r.declaredQuantityKG || 0), header: 'Weight Quantity' },
        { header: 'Scale Sel', cell: (r) => r.scaleSel || '-' },
        status,
      ];
    }
    const cols: ExportColumn<any>[] = [
      { header: 'RFID', cell: (r) => r.rfidNumber || r.badgeNo || '-' },
      { header: 'Source/Line Material', cell: (r) => `${r.materialCode || '-'} ${r.materialName || getMaterialNameFromCode(r.materialCode)}`.trim() },
      { ...qtyCol((r) => r.declaredQuantityKG || 0) },
    ];
    if (fam === 'outloading') cols.push({ header: 'Dest. Selection', cell: (r) => formatDestSelLabel(r.destSel) });
    cols.push(d1, d2, { header: 'Active Destination (Material)', cell: (r) => siloLabel(r.activeDestination) }, status);
    return cols;
  };

  const exportSlug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const renderExportButtons = (title: string, columns: ExportColumn<any>[], rows: any[]) => {
    const slug = exportSlug(title);
    const subtitles = [`Rows shown: ${rows.length}`];
    const fail = (what: string, err: string | null) => {
      if (err) toast({ title: `${what} failed`, description: err, variant: 'destructive' });
    };
    return (
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={rows.length === 0}
          className={`${ORDER_BTN_SM} gap-1`}
          data-testid={`live-orders-${slug}-print`}
          onClick={() => {
            void printTable({ title, subtitles, columns, rows, landscape: true }).then((err) => fail('Print', err));
          }}
        >
          <Printer className="h-3.5 w-3.5" /> Print
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={rows.length === 0}
          className={`${ORDER_BTN_SM} gap-1`}
          data-testid={`live-orders-${slug}-excel`}
          onClick={() => {
            void exportTableToExcel({ title, subtitles, columns, rows, filename: `live-orders_${slug}`, sheetName: title }).then((err) => fail('Export', err));
          }}
        >
          <FileSpreadsheet className="h-3.5 w-3.5" /> Export Excel
        </Button>
      </div>
    );
  };

  // Helper function to render table for intake lines
  const renderIntakeTable = (data: any[], title: string, line: string) => {
    const lineNo = Number(line.split('-').pop()) || 1;
    const currentData = data; // Live PLC data

    return (
    <div className="bg-slate-950/50 light:bg-white border border-slate-700/30 light:border-gray-200 rounded-lg backdrop-blur-sm light:shadow-lg">
      <div className="p-6 border-b border-slate-700/30 light:border-gray-200 flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-lg font-semibold text-white light:text-gray-900">{title}</h3>
        {renderExportButtons(title, liveColumns('intake'), Array.isArray(currentData) ? currentData : [])}
      </div>
      <div className="p-6">
        <div className="rounded-md border border-slate-700/30 light:border-gray-200">
          <Table className="table-fixed">
            <ColGroup widths={COLW_INTAKE} />
            <TableHeader>
              <TableRow className="border-slate-700/30 light:border-gray-200 hover:bg-slate-800/50 light:hover:bg-gray-50">
                <TableHead className="text-white light:text-gray-900 font-semibold">RFID</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Source/Line Material</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Declared Quantity_KG</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Destination 1 (Material)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Destination 2 (Material)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Active Destination (Material)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Status Word</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
                {Array.isArray(currentData) && currentData.map((item, index) => (
                <TableRow key={item.id} className={`border-slate-700/30 light:border-gray-200 hover:bg-slate-800/30 light:hover:bg-gray-50 transition-colors ${index % 2 === 0 ? 'bg-slate-900/20 light:bg-gray-50' : 'bg-slate-800/10 light:bg-gray-100'}`}>
                  <TableCell className="text-cyan-400 light:text-blue-600 font-medium">{item.badgeNo}</TableCell>
                  <TableCell className="text-white light:text-gray-900">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-400 light:text-gray-500">{item.sourceMaterialCode || '-'}</span>
                      <span className="font-medium">{getMaterialNameFromCode(item.sourceMaterialCode)}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 light:bg-yellow-100 border border-yellow-500/20 light:border-yellow-300 text-yellow-400 light:text-yellow-600">
                      {item.declaredQuantityKG}
                    </span>
                  </TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-400 light:text-gray-500">Silo {item.destinationSilo1}</span>
                      <span className="font-medium">{getMaterialNameForSilo(item.destinationSilo1)}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-400 light:text-gray-500">Silo {item.destinationSilo2}</span>
                      <span className="font-medium">{getMaterialNameForSilo(item.destinationSilo2)}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-400 light:text-gray-500">Silo {item.activeDestination || '-'}</span>
                      <span className="font-medium">{getMaterialNameForSilo(item.activeDestination)}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${getStatusColor(item.statusWord)}`}>
                      {getStatusIcon(item.statusWord)}
                      <span className="ml-1">{item.statusWord}</span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="outline" onClick={() => handleView(item)} className={ORDER_BTN_SM}>View</Button>
                      <Button size="sm" variant="outline" onClick={() => handleEdit(item)} className={ORDER_BTN_SM}>Edit</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
  };

  // Helper function to render table for outloading lines
  const renderOutloadingTable = (data: any[], title: string, line: string) => {
    const lineNo = Number(line.split('-').pop()) || 1;
    const currentData = data; // Live PLC data

    return (
    <div className="bg-slate-950/50 light:bg-white border border-slate-700/30 light:border-gray-200 rounded-lg backdrop-blur-sm light:shadow-lg">
      <div className="p-6 border-b border-slate-700/30 light:border-gray-200 flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-lg font-semibold text-white light:text-gray-900">{title}</h3>
        {renderExportButtons(title, liveColumns('outloading'), Array.isArray(currentData) ? currentData : [])}
      </div>
      <div className="p-6">
        <div className="rounded-md border border-slate-700/30 light:border-gray-200">
          <Table className="table-fixed">
            <ColGroup widths={COLW_OUTLOADING} />
            <TableHeader>
              <TableRow className="border-slate-700/30 light:border-gray-200 hover:bg-slate-800/50 light:hover:bg-gray-50">
                <TableHead className="text-white light:text-gray-900 font-semibold">RFID</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Source/Line Material</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Declared Quantity_KG</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Dest. Selection</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Destination 1 (Material)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Destination 2 (Material)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Active Destination (Material)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Status Word</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.isArray(currentData) && currentData.map((item, index) => (
                <TableRow key={item.id} className={`border-slate-700/30 light:border-gray-200 hover:bg-slate-800/30 light:hover:bg-gray-50 transition-colors ${index % 2 === 0 ? 'bg-slate-900/20 light:bg-gray-50' : 'bg-slate-800/10 light:bg-gray-100'}`}>
                  <TableCell className="text-cyan-400 light:text-blue-600 font-medium">{item.badgeNo}</TableCell>
                  <TableCell className="text-white light:text-gray-900">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-400 light:text-gray-500">{item.sourceMaterialCode || '-'}</span>
                      <span className="font-medium">{getMaterialNameFromCode(item.sourceMaterialCode)}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 light:bg-yellow-100 border border-yellow-500/20 light:border-yellow-300 text-yellow-400 light:text-yellow-600">
                      {item.declaredQuantityKG}
                    </span>
                  </TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700">
                    {formatDestSelLabel(item.destSel)}
                  </TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-400 light:text-gray-500">Silo {item.destinationSilo1}</span>
                      <span className="font-medium">{getMaterialNameForSilo(item.destinationSilo1)}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-400 light:text-gray-500">Silo {item.destinationSilo2}</span>
                      <span className="font-medium">{getMaterialNameForSilo(item.destinationSilo2)}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-slate-300 light:text-gray-700">
                    <div className="flex flex-col">
                      <span className="text-xs text-slate-400 light:text-gray-500">Silo {item.activeDestination || '-'}</span>
                      <span className="font-medium">{getMaterialNameForSilo(item.activeDestination)}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${getStatusColor(item.statusWord)}`}>
                      {getStatusIcon(item.statusWord)}
                      <span className="ml-1">{item.statusWord}</span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="outline" onClick={() => handleView(item)} className={ORDER_BTN_SM}>View</Button>
                      <Button size="sm" variant="outline" onClick={() => handleEdit(item)} className={ORDER_BTN_SM}>Edit</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
  };

  // Helper function to render table for bulk line
  const renderBulkLineTable = (data: any[], title: string) => {
    const currentData = data; // Live PLC data

    return (
    <div className="bg-slate-950/50 light:bg-white border border-slate-700/30 light:border-gray-200 rounded-lg backdrop-blur-sm light:shadow-lg">
      <div className="p-6 border-b border-slate-700/30 light:border-gray-200 flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-lg font-semibold text-white light:text-gray-900">{title}</h3>
        {renderExportButtons(title, liveColumns('bulk'), Array.isArray(currentData) ? currentData : [])}
      </div>
      <div className="p-6">
        <div className="rounded-md border border-slate-700/30 light:border-gray-200 overflow-x-auto">
          <Table className="table-fixed">
            <ColGroup widths={COLW_BULK} />
            <TableHeader>
              <TableRow className="border-slate-700/30 light:border-gray-200 hover:bg-slate-800/50 light:hover:bg-gray-50">
                <TableHead className="text-white light:text-gray-900 font-semibold">Source Silo (Material)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Destination 1 (Material)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Destination 2 (Material)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">CC25 Sel</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Weight Quantity</TableHead>
                  <TableHead className="text-white light:text-gray-900 font-semibold">Scale Sel</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Status</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.isArray(currentData) && currentData.map((item, index) => (
                <TableRow key={item.id} className={`border-slate-700/30 light:border-gray-200 hover:bg-slate-800/30 light:hover:bg-gray-50 transition-colors ${index % 2 === 0 ? 'bg-slate-900/20 light:bg-gray-50' : 'bg-slate-800/10 light:bg-gray-100'}`}>
                    <TableCell className="text-cyan-400 light:text-blue-600 font-medium">
                      <div className="flex flex-col">
                        <span className="text-xs text-slate-400 light:text-gray-500">Silo {item.sourceSilo || '-'}</span>
                        <span className="font-medium">{getMaterialNameForSilo(item.sourceSilo)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-white light:text-gray-900">
                      <div className="flex flex-col">
                        <span className="text-xs text-slate-400 light:text-gray-500">Silo {item.destinationSilo1 || '-'}</span>
                        <span className="font-medium">{getMaterialNameForSilo(item.destinationSilo1)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-slate-300 light:text-gray-700">
                      <div className="flex flex-col">
                        <span className="text-xs text-slate-400 light:text-gray-500">Silo {item.destinationSilo2 || '-'}</span>
                        <span className="font-medium">{getMaterialNameForSilo(item.destinationSilo2)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-slate-300 light:text-gray-700">{item.cc25Sel || '-'}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 light:bg-yellow-100 border border-yellow-500/20 light:border-yellow-300 text-yellow-400 light:text-yellow-600">
                        {item.declaredQuantityKG || 0}
                    </span>
                  </TableCell>
                    <TableCell className="text-slate-300 light:text-gray-700">{item.scaleSel || '-'}</TableCell>
                  <TableCell>
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${getStatusColor(item.statusWord)}`}>
                        {getStatusIcon(item.statusWord)}
                        <span className="ml-1">{item.statusWord || 'Unknown'}</span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="outline" onClick={() => handleView(item)} className={ORDER_BTN_SM}>View</Button>
                      <Button size="sm" variant="outline" onClick={() => handleEdit(item)} className={ORDER_BTN_SM}>Edit</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
  };

  // Helper function to render table for PIT line
  const renderPTLineTable = (data: any[], title: string) => {
    const currentData = data; // Live PLC data

    return (
    <div className="bg-slate-950/50 light:bg-white border border-slate-700/30 light:border-gray-200 rounded-lg backdrop-blur-sm light:shadow-lg">
      <div className="p-6 border-b border-slate-700/30 light:border-gray-200 flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-lg font-semibold text-white light:text-gray-900">{title}</h3>
        {renderExportButtons(title, liveColumns('pit'), Array.isArray(currentData) ? currentData : [])}
      </div>
      <div className="p-6">
        <div className="rounded-md border border-slate-700/30 light:border-gray-200 overflow-x-auto">
          <Table className="table-fixed">
            <ColGroup widths={COLW_PIT} />
            <TableHeader>
              <TableRow className="border-slate-700/30 light:border-gray-200 hover:bg-slate-800/50 light:hover:bg-gray-50">
                  <TableHead className="text-white light:text-gray-900 font-semibold">Pit No</TableHead>
                  <TableHead className="text-white light:text-gray-900 font-semibold">Raw Code</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Destination 1 (Material)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Destination 2 (Material)</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Weight Quantity</TableHead>
                  <TableHead className="text-white light:text-gray-900 font-semibold">Scale Sel</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Status</TableHead>
                <TableHead className="text-white light:text-gray-900 font-semibold">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.isArray(currentData) && currentData.map((item, index) => (
                <TableRow key={item.id} className={`border-slate-700/30 light:border-gray-200 hover:bg-slate-800/30 light:hover:bg-gray-50 transition-colors ${index % 2 === 0 ? 'bg-slate-900/20 light:bg-gray-50' : 'bg-slate-800/10 light:bg-gray-100'}`}>
                    <TableCell className="text-cyan-400 light:text-blue-600 font-medium">{item.pitNo || '-'}</TableCell>
                    <TableCell className="text-white light:text-gray-900">{item.rawCode || '-'}</TableCell>
                    <TableCell className="text-slate-300 light:text-gray-700">
                      <div className="flex flex-col">
                        <span className="text-xs text-slate-400 light:text-gray-500">Silo {item.destinationSilo1 || '-'}</span>
                        <span className="font-medium">{getMaterialNameForSilo(item.destinationSilo1)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-slate-300 light:text-gray-700">
                      <div className="flex flex-col">
                        <span className="text-xs text-slate-400 light:text-gray-500">Silo {item.destinationSilo2 || '-'}</span>
                        <span className="font-medium">{getMaterialNameForSilo(item.destinationSilo2)}</span>
                      </div>
                    </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 light:bg-yellow-100 border border-yellow-500/20 light:border-yellow-300 text-yellow-400 light:text-yellow-600">
                        {item.declaredQuantityKG || 0}
                    </span>
                  </TableCell>
                    <TableCell className="text-slate-300 light:text-gray-700">{item.scaleSel || '-'}</TableCell>
                  <TableCell>
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${getStatusColor(item.statusWord)}`}>
                        {getStatusIcon(item.statusWord)}
                        <span className="ml-1">{item.statusWord || 'Unknown'}</span>
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="outline" onClick={() => handleView(item)} className={ORDER_BTN_SM}>View</Button>
                      <Button size="sm" variant="outline" onClick={() => handleEdit(item)} className={ORDER_BTN_SM}>Edit</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
  };

  // RFIDs currently in use: locked in the queue (rfid_used) OR loaded as a live
  // PLC order badge (covers orders created outside the queue). These must not be
  // selectable for a new order until they free up.
  const getInUseRfids = (): Set<string> => {
    const s = new Set<string>();
    const add = (arr: any[]) =>
      arr.forEach((o) => {
        const b = String(o?.badgeNo ?? '').trim();
        if (b && b !== '0') s.add(b);
      });
    add(intakeLine1Data);
    add(intakeLine2Data);
    add(mineralIntakeData);
    add(outloading1Data);
    add(outloading2Data);
    add(outloading3Data);
    // Any RFID locked to an open queue order
    queueItems.forEach((q) => {
      const r = String(q?.rfidNumber ?? '').trim();
      if (r) s.add(r);
    });
    return s;
  };

  // Map a tab to the queue's (order_type, line) so we can filter waiting orders.
  const queueMatchForTab = (tab: string): { t: string; l: number } | null => {
    switch (tab) {
      case 'intake-line-1': return { t: 'intake', l: 1 };
      case 'intake-line-2': return { t: 'intake', l: 2 };
      case 'mineral-intake': return { t: 'mineral', l: 3 };
      case 'outloading-1': return { t: 'outloading', l: 1 };
      case 'outloading-2': return { t: 'outloading', l: 2 };
      case 'outloading-3': return { t: 'outloading', l: 3 };
      case 'bulk-line': return { t: 'bulk', l: 0 };
      case 'pt-line': return { t: 'pit', l: 0 };
      default: return null;
    }
  };

  const renderWaitingPanel = (tab: string) => {
    const match = queueMatchForTab(tab);
    if (!match) return null;
    const items = queueItems
      .filter((q) => q.orderType === match.t && Number(q.line) === match.l)
      .sort((a, b) => (a.queuePosition || 0) - (b.queuePosition || 0));

    const waiting = items.filter((q) => q.queueStatus === 'WAITING');
    const dispatched = items.filter((q) => q.queueStatus === 'DISPATCHED' || q.queueStatus === 'RUNNING');

    const badge = (status: string) => {
      const map: Record<string, string> = {
        WAITING: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
        DISPATCHED: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
        RUNNING: 'text-purple-400 bg-purple-500/10 border-purple-500/30',
      };
      return map[status] || 'text-slate-400 bg-slate-500/10 border-slate-500/30';
    };

    // Mirror the live-order table columns for this line family so the two
    // stacked tables line up column-for-column.
    const fam =
      match.t === 'outloading' ? 'outloading'
      : match.t === 'bulk' ? 'bulk'
      : match.t === 'pit' ? 'pit'
      : 'intake';
    const widths =
      fam === 'outloading' ? COLW_OUTLOADING
      : fam === 'bulk' ? COLW_BULK
      : fam === 'pit' ? COLW_PIT
      : COLW_INTAKE;
    const headers =
      fam === 'outloading'
        ? ['RFID', 'Source/Line Material', 'Declared Quantity_KG', 'Dest. Selection', 'Destination 1 (Material)', 'Destination 2 (Material)', 'Active Destination (Material)', 'Status Word', 'Actions']
        : fam === 'bulk'
        ? ['Source Silo (Material)', 'Destination 1 (Material)', 'Destination 2 (Material)', 'CC25 Sel', 'Weight Quantity', 'Scale Sel', 'Status', 'Actions']
        : fam === 'pit'
        ? ['Pit No', 'Raw Code', 'Destination 1 (Material)', 'Destination 2 (Material)', 'Weight Quantity', 'Scale Sel', 'Status', 'Actions']
        : ['RFID', 'Source/Line Material', 'Declared Quantity_KG', 'Destination 1 (Material)', 'Destination 2 (Material)', 'Active Destination (Material)', 'Status Word', 'Actions'];

    const siloCell = (silo: any, key: string) => (
      <TableCell key={key} className="text-slate-300 light:text-gray-700">
        <div className="flex flex-col">
          <span className="text-xs text-slate-400 light:text-gray-500">Silo {silo || '-'}</span>
          <span className="font-medium">{getMaterialNameForSilo(silo)}</span>
        </div>
      </TableCell>
    );
    const qtyCell = (q: any) => (
      <TableCell key="qty">
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-500/10 light:bg-yellow-100 border border-yellow-500/20 light:border-yellow-300 text-yellow-400 light:text-yellow-600">
          {q.declaredQuantityKG || 0}
        </span>
      </TableCell>
    );
    const statusCell = (q: any) => (
      <TableCell key="status">
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs border ${badge(q.queueStatus)}`}>
          {q.queueStatus}
        </span>
      </TableCell>
    );
    const actionsCell = (q: any) => (
      <TableCell key="actions">
        {(q.queueStatus === 'WAITING' || q.queueStatus === 'DISPATCHED') ? (
          <div className="flex items-center gap-1 flex-nowrap">
            {q.queueStatus === 'WAITING' && (
              <Button size="sm" variant="outline" className={`${ORDER_BTN_SM} whitespace-nowrap`} onClick={() => startQueuedOrder(q.id)}>
                <CheckCircle className="h-3 w-3 mr-1" /> Start
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="text-xs px-2 py-1 whitespace-nowrap bg-red-600 hover:bg-red-700 text-white light:bg-red-600 light:hover:bg-red-700 light:text-white"
              onClick={() => cancelQueuedOrder(q.id)}
            >
              <X className="h-3 w-3 mr-1" /> Cancel
            </Button>
          </div>
        ) : (
          <span className="text-xs text-slate-500 light:text-gray-400">—</span>
        )}
      </TableCell>
    );

    const renderRowCells = (q: any) => {
      if (fam === 'outloading' || fam === 'intake') {
        const cells = [
          <TableCell key="rfid" className="text-cyan-400 light:text-blue-600 font-medium">{q.rfidNumber || q.badgeNo || '-'}</TableCell>,
          <TableCell key="src" className="text-white light:text-gray-900">
            <div className="flex flex-col">
              <span className="text-xs text-slate-400 light:text-gray-500">{q.materialCode || '-'}</span>
              <span className="font-medium">{q.materialName || getMaterialNameFromCode(q.materialCode)}</span>
            </div>
          </TableCell>,
          qtyCell(q),
        ];
        if (fam === 'outloading') {
          cells.push(
            <TableCell key="destsel" className="text-slate-300 light:text-gray-700">{formatDestSelLabel(q.destSel)}</TableCell>
          );
        }
        cells.push(siloCell(q.destinationSilo1, 'd1'));
        cells.push(siloCell(q.destinationSilo2, 'd2'));
        cells.push(siloCell(q.activeDestination, 'ad'));
        cells.push(statusCell(q));
        cells.push(actionsCell(q));
        return cells;
      }
      if (fam === 'bulk') {
        return [
          siloCell(q.sourceSilo, 'src'),
          siloCell(q.destinationSilo1, 'd1'),
          siloCell(q.destinationSilo2, 'd2'),
          <TableCell key="cc25" className="text-slate-300 light:text-gray-700">{q.cc25Sel || '-'}</TableCell>,
          qtyCell(q),
          <TableCell key="scale" className="text-slate-300 light:text-gray-700">{q.scaleSel || '-'}</TableCell>,
          statusCell(q),
          actionsCell(q),
        ];
      }
      // pit
      return [
        <TableCell key="pit" className="text-cyan-400 light:text-blue-600 font-medium">{q.pitNo || '-'}</TableCell>,
        <TableCell key="raw" className="text-white light:text-gray-900">{q.rawCode || q.materialCode || '-'}</TableCell>,
        siloCell(q.destinationSilo1, 'd1'),
        siloCell(q.destinationSilo2, 'd2'),
        qtyCell(q),
        <TableCell key="scale" className="text-slate-300 light:text-gray-700">{q.scaleSel || '-'}</TableCell>,
        statusCell(q),
        actionsCell(q),
      ];
    };

    return (
      <div className="bg-slate-950/50 light:bg-white border border-slate-700/30 light:border-gray-200 rounded-lg backdrop-blur-sm light:shadow-lg mt-4">
        <div className="p-6 border-b border-slate-700/30 light:border-gray-200 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white light:text-gray-900 flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-400" /> Waiting Orders
            <span className="text-xs font-normal text-slate-400 light:text-gray-500">
              ({waiting.length} waiting{dispatched.length ? `, ${dispatched.length} in progress above` : ''})
            </span>
          </h3>
          {renderExportButtons(`Waiting Orders - ${tab}`, waitingColumns(fam), waiting)}
        </div>
        <div className="p-6">
          {waiting.length === 0 ? (
            <div className="text-sm text-slate-400 light:text-gray-500 text-center py-4">
              No waiting orders. Use “Add Order” to queue one — it starts automatically when the line is free and its RFID is scanned.
            </div>
          ) : (
            <div className="rounded-md border border-slate-700/30 light:border-gray-200">
              <Table className="table-fixed">
                <ColGroup widths={widths} />
                <TableHeader>
                  <TableRow className="border-slate-700/30 light:border-gray-200">
                    {headers.map((h) => (
                      <TableHead key={h} className="text-white light:text-gray-900 font-semibold">{h}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {waiting.map((q, index) => (
                    <TableRow key={q.id} className={`border-slate-700/30 light:border-gray-200 hover:bg-slate-800/30 light:hover:bg-gray-50 transition-colors ${index % 2 === 0 ? 'bg-slate-900/20 light:bg-gray-50' : 'bg-slate-800/10 light:bg-gray-100'}`}>
                      {renderRowCells(q)}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <WaterSystemLayout 
      title="Orders Management" 
      subtitle="Order processing, bay organization, and fulfillment"
    >
      <div className="space-y-6">
        {/* Real-time Status Bar */}
        <div className="flex items-center justify-between bg-slate-900/50 light:bg-gray-100 p-4 rounded-lg border border-slate-700/30 light:border-gray-200">
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <div className={`w-3 h-3 rounded-full ${
                broadcastStatus === 'running' ? 'bg-green-500' : 'bg-red-500'
              }`}></div>
              <span className="text-sm text-white light:text-gray-700">
                PLC orders: {broadcastStatus === 'running' ? 'Running' : 'Stopped'}
              </span>
            </div>
            <div className="flex items-center space-x-2">
              <div className="w-3 h-3 rounded-full bg-green-500 animate-pulse"></div>
              <span className="text-sm text-white light:text-gray-700">
                Live PLC Data (5s updates)
              </span>
            </div>
            <span className="text-xs text-slate-400 light:text-gray-500">
              Last updated: {lastUpdate.toLocaleTimeString()}
            </span>
          </div>
          <div className="flex items-center space-x-2">
            {isLoading && (
              <div className="flex items-center space-x-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-cyan-500"></div>
                <span className="text-sm text-slate-400 light:text-gray-500">Loading...</span>
              </div>
            )}
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => { void fetchOrders() }}
              disabled={isLoading}
              className={ORDER_BTN_OUTLINE}
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              Refresh
            </Button>
          </div>
        </div>

        <div className="flex gap-2 mb-4">
          {/* RFID Assign temporarily disabled (feature kept for later re-enable)
          <Button
            className={ORDER_BTN}
            onClick={() => setShowAssignModal(true)}
          >
            <Radio className="h-4 w-4 mr-2" /> RFID Assign
          </Button>
          */}
          <Button
            className={ORDER_BTN}
            onClick={() => {
              setFormData(isOutloadingTab(activeTab) ? { destSel: '0' } : {});
              setShowModal(true);
            }}
          >
            Add Order
          </Button>
        </div>
        {showModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-slate-900 p-4 rounded-xl w-full max-w-xl space-y-3 border border-slate-700 shadow-xl overflow-y-auto max-h-[90vh]">
              <h2 className="text-lg font-semibold text-white mb-2 text-center">Add New Order ({activeTab === 'pt-line' ? 'PIT line' : activeTab.replace(/-/g, ' ')})</h2>
              <form onSubmit={async e => {
                    e.preventDefault()
                    try {
                      const newOrder = { ...formData }
                      
                      // Convert "none" values to empty strings for backend compatibility
                      Object.keys(newOrder).forEach(key => {
                        if (newOrder[key] === 'none') {
                          newOrder[key] = '';
                        }
                      });

                      let orderType: OrderType;
                      let line: number | undefined;
                      
                      if (activeTab === 'intake-line-1') {
                        orderType = 'intake';
                        line = 1;
                      } else if (activeTab === 'intake-line-2') {
                        orderType = 'intake';
                        line = 2;
                      } else if (activeTab === 'mineral-intake') {
                        orderType = 'intake';
                        line = 3; // ✅ CORRECT! Mineral intake uses line 3
                      } else if (activeTab === 'outloading-1') {
                        orderType = 'outloading';
                        line = 1;
                      } else if (activeTab === 'outloading-2') {
                        orderType = 'outloading';
                        line = 2;
                      } else if (activeTab === 'outloading-3') {
                        orderType = 'outloading';
                        line = 3;
                      } else if (activeTab === 'bulk-line') {
                        orderType = 'bulk';
                      } else if (activeTab === 'pt-line') {
                        orderType = 'pit';
                      } else {
                        throw new Error('Unknown order type');
                      }

                      // Create order in both PLC and database
                      const isMineralOrder = activeTab === 'mineral-intake';

                      if (orderType === 'outloading') {
                        const ds = toNum(newOrder.destSel);
                        if (ds !== 0 && ds !== 1) {
                          toast({
                            title: 'Destination required',
                            description: 'Select Bulk (0) or Packing (1) for destination selection.',
                            variant: 'destructive',
                          });
                          return;
                        }
                      }
                      
                      // Validate mineral order destinations (401-408)
                      if (isMineralOrder) {
                        const dest1 = parseInt(String(newOrder.destinationSilo1));
                        const dest2 = parseInt(String(newOrder.destinationSilo2));
                        
                        if ((dest1 < 401 || dest1 > 408) && (dest2 < 401 || dest2 > 408)) {
                          toast({
                            title: "Invalid Destination Silo",
                            description: "Mineral orders must have at least one destination silo in range 401-408",
                            variant: "destructive",
                          });
                          return;
                        }
                        
                        if (dest1 >= 401 && dest1 <= 408 && (dest2 < 401 || dest2 > 408) && dest2 !== 0) {
                          toast({
                            title: "Invalid Destination Silo",
                            description: "Mineral orders: If destination 2 is provided, it must be in range 401-408",
                            variant: "destructive",
                          });
                          return;
                        }
                        
                        if (dest2 >= 401 && dest2 <= 408 && (dest1 < 401 || dest1 > 408) && dest1 !== 0) {
                          toast({
                            title: "Invalid Destination Silo",
                            description: "Mineral orders: If destination 1 is provided, it must be in range 401-408",
                            variant: "destructive",
                          });
                          return;
                        }
                      }
                      
                      const success = await createOrderComprehensive(orderType, newOrder, line, isMineralOrder);
                      
                      if (success) {
                        // Refresh all data after successful creation
                        await fetchOrders();
                        setFormData({})
                        setShowModal(false)
                      }
                    } catch (err) {
                      
                      if (axios.isAxiosError(err)) {
                        const errorMessage = err.response?.data?.message || err.message
                        
                        toast({
                          title: "Order Creation Failed",
                          description: errorMessage,
                          variant: "destructive",
                        });
                      } else {
                        toast({
                          title: "Order Creation Failed",
                          description: (err as Error).message,
                          variant: "destructive",
                        });
                      }
                    }
                  }}>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {getFieldsForLine(activeTab).map(field => {
                    // Hide destination silo fields until source is selected (different logic for different order types)
                    let shouldHideSiloFields = false;
                    
                    if (field.name === 'destinationSilo1' || field.name === 'destinationSilo2') {
                      if (activeTab === 'bulk-line') {
                        // For bulk orders, check if sourceSilo is selected
                        shouldHideSiloFields = !formData.sourceSilo || formData.sourceSilo === '';
                      } else if (activeTab === 'pt-line') {
                        // For pit orders, check if rawCode is selected
                        shouldHideSiloFields = !formData.rawCode || formData.rawCode === '';
                      } else {
                        // For intake/outloading orders, check if sourceMaterialCode is selected
                        shouldHideSiloFields = !formData.sourceMaterialCode || formData.sourceMaterialCode === '';
                      }
                    }
                    
                    if (shouldHideSiloFields) {
                      return null;
                    }
                    
                    const availableCount = getAvailableSilosCount(field.name);
                    const labelWithCount = field.type === 'select' && (field.name.includes('Silo') || field.name === 'sourceSilo') 
                      ? `${field.label} (${availableCount} available)`
                      : field.label;
                    
                    return (
                    <div key={field.name} className="flex flex-col">
                      <label className="block text-slate-300 mb-1 text-xs font-medium">{labelWithCount}</label>
{field.type === 'select' ? (() => {
                        const handleSelectChange = (value: string) => {
                          const newFormData = { ...formData, [field.name]: value };
                          // If changing destinationSilo1, clear destinationSilo2 if it's the same
                          if (field.name === 'destinationSilo1' && formData.destinationSilo2 === value) {
                            newFormData.destinationSilo2 = '';
                          }
                          setFormData(newFormData);
                        };
                        if (field.name === 'destSel') {
                          return (
                            <Select
                              value={String(formData.destSel ?? '0')}
                              onValueChange={handleSelectChange}
                            >
                              <SelectTrigger className="bg-slate-800/70 light:bg-white border-slate-600 light:border-gray-200 text-white light:text-gray-900 w-full h-8 text-sm">
                                <SelectValue placeholder={`Select ${field.label}`} />
                              </SelectTrigger>
                              <SelectContent className="bg-slate-800 light:bg-white border-slate-600 light:border-gray-200 max-h-72">
                                <SelectItem value="0">Bulk</SelectItem>
                                <SelectItem value="1">Packing</SelectItem>
                              </SelectContent>
                            </Select>
                          );
                        }
                        const selectOptions: SearchableOption[] = [{ value: 'none', label: 'None' }];
                        let selectPlaceholder = `Select ${field.label}`;
                        if (field.name === 'badgeNo') {
                          // Only available RFID tags: not locked in the queue and not
                          // currently loaded on a live PLC order.
                          const inUse = getInUseRfids();
                          const available = rfidConfigs.filter(
                            (rfid) => !rfid.rfid_used && !inUse.has(String(rfid.rfid_number))
                          );
                          if (available.length === 0) {
                            selectPlaceholder = 'No RFID available';
                          }
                          available.forEach((rfid) => {
                            selectOptions.push({ value: String(rfid.rfid_number), label: `${rfid.rfid_number} (Available)` });
                          });
                        } else if (field.name === 'sourceMaterialCode' || field.name === 'rawCode') {
                          // Material codes dropdown (for both sourceMaterialCode and rawCode)
                          materialCodes.forEach((material) => {
                            selectOptions.push({ value: material.code, label: `${material.code} - ${material.name}` });
                          });
                        } else if (field.name !== 'pitNo') {
                          // Get available silos based on order type and filter by status and material
                                let availableSilos = [];
                                
                                // Determine which silos to show based on field name and order type
                                // Get order type and line for proper silo filtering
                                let orderType = 'intake';
                                let line = 1;
                                
                                if (activeTab === 'intake-line-1') {
                                  orderType = 'intake';
                                  line = 1;
                                } else if (activeTab === 'intake-line-2') {
                                  orderType = 'intake';
                                  line = 2;
                                } else if (activeTab === 'mineral-intake') {
                                  orderType = 'intake';
                                  line = 3; // ✅ CORRECT! Mineral intake uses line 3
                                } else if (activeTab === 'outloading-1') {
                                  orderType = 'outloading';
                                  line = 1;
                                } else if (activeTab === 'outloading-2') {
                                  orderType = 'outloading';
                                  line = 2;
                                } else if (activeTab === 'outloading-3') {
                                  orderType = 'outloading';
                                  line = 3;
                                } else if (activeTab === 'bulk-line') {
                                  orderType = 'bulk';
                                  line = 1;
                                } else if (activeTab === 'pt-line') {
                                  orderType = 'pit';
                                  line = 1;
                                }

                                if (field.name === 'destinationSilo1' || field.name === 'destinationSilo2') {
                                  // For destination silos, filter by order type, material code and status
                                  const isMineralOrder = activeTab === 'mineral-intake';
                                  const allSilosForType = getSilosForOrderType(orderType, line, isMineralOrder, true);
                                  
                                  // Get material code for filtering (declare outside filter function)
                                    let materialCodeStr = '';
                                    let materialCodeField = '';
                                    if (activeTab === 'pt-line') {
                                      materialCodeStr = String(formData.rawCode || '');
                                      materialCodeField = 'rawCode';
                                  } else if (activeTab === 'bulk-line') {
                                    // For bulk orders, get material from selected source silo
                                    const sourceSilos = getSilosForOrderType(orderType, line, isMineralOrder, false); // Get source silos (101-115)
                                    
                                    // Try multiple ways to find the selected source silo
                                    let selectedSourceSilo = sourceSilos.find(s => s.bin_name === formData.sourceSilo);
                                    
                                    // If not found by full name, try by silo number
                                    if (!selectedSourceSilo && formData.sourceSilo) {
                                      const siloNumber = formData.sourceSilo.toString();
                                      selectedSourceSilo = sourceSilos.find(s => s.bin_name.includes(siloNumber));
                                      }
                                    
                                    if (selectedSourceSilo) {
                                      // Use the full material display format like "210 - Soya Oil"
                                      materialCodeStr = selectedSourceSilo.material_code && selectedSourceSilo.material_name 
                                        ? `${selectedSourceSilo.material_code} - ${selectedSourceSilo.material_name}`
                                        : selectedSourceSilo.material_name || selectedSourceSilo.material_code || '';
                                      materialCodeField = 'sourceSilo';
                                      } else {
                                      }
                                    } else {
                                      materialCodeStr = String(formData.sourceMaterialCode || '');
                                      materialCodeField = 'sourceMaterialCode';
                                    }
                                    
                                  const allSilosList = getAvailableSilos();
                                  // FINAL: Filter by material code + availability + exclude already used silos
                                  availableSilos = allSilosForType.filter(silo => {
                                    const isAvailable = isSiloSelectableForOrder(silo, orderType, allSilosList);
                                    
                                    // Must not be already used by another order
                                    const isNotUsed = !usedSilos.has(silo.bin_name);
                                    
                                    let materialMatches = false;
                                    if (activeTab === 'bulk-line') {
                                      // For bulk orders, filter by material from source silo
                                      if (materialCodeStr && materialCodeStr !== '' && materialCodeStr !== 'None' && materialCodeStr !== 'None - None') {
                                        // Extract material code and name from source silo
                                        const sourceMaterialCode = materialCodeStr.includes(' - ') ? materialCodeStr.split(' - ')[0] : materialCodeStr;
                                        const sourceMaterialName = materialCodeStr.includes(' - ') ? materialCodeStr.split(' - ')[1] : materialCodeStr;
                                        
                                        // Check if destination silo matches source material (multiple ways to match)
                                        materialMatches = Boolean(sameMaterialCode(silo.material_code, sourceMaterialCode) ||
                                                        silo.material_name === sourceMaterialName ||
                                                        sameMaterialCode(silo.material_code, materialCodeStr) ||
                                                        silo.material_name === materialCodeStr ||
                                                        // Also check if material names contain the same key words
                                                        (sourceMaterialName && silo.material_name && 
                                                         sourceMaterialName.toLowerCase().includes('soya') && 
                                                         silo.material_name.toLowerCase().includes('soya')) ||
                                                        (sourceMaterialName && silo.material_name && 
                                                         sourceMaterialName.toLowerCase().includes('oil') && 
                                                         silo.material_name.toLowerCase().includes('oil')));
                                        
                                        } else {
                                        materialMatches = false;
                                      }
                                    } else {
                                      // For other order types, use the original logic
                                      materialMatches = Boolean(!materialCodeStr || 
                                                          materialCodeStr === '' ||
                                                          materialCodeStr === 'None' ||
                                                          materialCodeStr === 'None - None' ||
                                                          sameMaterialCode(silo.material_code, materialCodeStr) ||
                                                          silo.material_name === materialCodeStr ||
                                                          // Extract just the code part from "210 - Soya Oil" format
                                                          (materialCodeStr && materialCodeStr.includes(' - ') && 
                                                           sameMaterialCode(silo.material_code, materialCodeStr.split(' - ')[0])) ||
                                                          // Also check if silo material matches the full display text
                                                          (materialCodeStr && materialCodeStr.includes(' - ') && 
                                                           silo.material_name === materialCodeStr.split(' - ')[1]));
                                    }
                                    
                                    // Debug logging for bulk orders
                                    if (activeTab === 'bulk-line' && (field.name === 'destinationSilo1' || field.name === 'destinationSilo2')) {
                                      }
                                    
                                    // For destinationSilo2, exclude the silo already selected in destinationSilo1
                                    // Also exclude the pit number silo from destination dropdowns
                                    const siloNumber = silo.bin_name.split(' ')[1] || 'unknown';
                                    const isNotAlreadySelected = (field.name !== 'destinationSilo2' || 
                                                               !formData.destinationSilo1 || 
                                                               formData.destinationSilo1 !== siloNumber) &&
                                                               // Exclude pit number silo from destination dropdowns
                                                               (!formData.pitNo || formData.pitNo !== siloNumber);
                                    
                                    return isAvailable && isNotUsed && materialMatches && isNotAlreadySelected;
                                  });
                                  
                                  // Summary for bulk orders
                                  if (activeTab === 'bulk-line') {
                                    }
                                } else if (field.name === 'sourceSilo') {
                                  // For source silos (bulk line), filter by material code + exclude locked/high level + exclude already used silos
                                  const isMineralOrder = activeTab === 'mineral-intake';
                                  availableSilos = getSilosForOrderType(orderType, line, isMineralOrder).filter(silo => {
                                    // Must be unlocked and normal level
                                    const isAvailable = !silo.lock_active && !silo.hl_active;
                                    
                                    // Must not be already used by another order
                                    const isNotUsed = !usedSilos.has(silo.bin_name);
                                    
                                    // Must match the material code if one is specified
                                    const materialCodeStr = String(formData.sourceMaterialCode || '');
                                    const materialMatches = !formData.sourceMaterialCode || 
                                                          materialCodeStr === '' ||
                                                          materialCodeStr === 'None' ||
                                                          materialCodeStr === 'None - None' ||
                                                          sameMaterialCode(silo.material_code, formData.sourceMaterialCode) ||
                                                          silo.material_name === formData.sourceMaterialCode ||
                                                          // Extract just the code part from "210 - Soya Oil" format
                                                          (materialCodeStr && materialCodeStr.includes(' - ') && 
                                                           sameMaterialCode(silo.material_code, materialCodeStr.split(' - ')[0])) ||
                                                          // Also check if silo material matches the full display text
                                                          (materialCodeStr && materialCodeStr.includes(' - ') && 
                                                           silo.material_name === materialCodeStr.split(' - ')[1]);
                                    
                                    return isAvailable && isNotUsed && materialMatches;
                                  });
                                } else {
                                  // For other fields, filter by material code + exclude locked/high level + exclude already used silos
                                  const isMineralOrder = activeTab === 'mineral-intake';
                                  availableSilos = getSilosForOrderType(orderType, line, isMineralOrder).filter(silo => {
                                    // Must be unlocked and normal level
                                    const isAvailable = !silo.lock_active && !silo.hl_active;
                                    
                                    // Must not be already used by another order
                                    const isNotUsed = !usedSilos.has(silo.bin_name);
                                    
                                    // Must match the material code if one is specified
                                    const materialCodeStr = String(formData.sourceMaterialCode || '');
                                    const materialMatches = !formData.sourceMaterialCode || 
                                                          materialCodeStr === '' ||
                                                          materialCodeStr === 'None' ||
                                                          materialCodeStr === 'None - None' ||
                                                          sameMaterialCode(silo.material_code, formData.sourceMaterialCode) ||
                                                          silo.material_name === formData.sourceMaterialCode ||
                                                          // Extract just the code part from "210 - Soya Oil" format
                                                          (materialCodeStr && materialCodeStr.includes(' - ') && 
                                                           sameMaterialCode(silo.material_code, materialCodeStr.split(' - ')[0])) ||
                                                          // Also check if silo material matches the full display text
                                                          (materialCodeStr && materialCodeStr.includes(' - ') && 
                                                           silo.material_name === materialCodeStr.split(' - ')[1]);
                                    
                                    return isAvailable && isNotUsed && materialMatches;
                                  });
                                }
                                
                          availableSilos.forEach((silo: any) => {
                            const siloNumber = silo.bin_name.split(' ')[1] || 'unknown';
                            const materialInfo = silo.material_name || silo.material_code || 'No Material';
                            const allSilosList = getAvailableSilos();
                            const statusText =
                              orderType === 'outloading'
                                ? getOutloadingSiloStatusSuffix(silo, allSilosList)
                                : silo.lock_active
                                  ? ' (Locked)'
                                  : silo.hl_active
                                    ? ' (High Level)'
                                    : ' (Available)';
                            selectOptions.push({ value: siloNumber, label: `${silo.bin_name} - ${materialInfo}${statusText}` });
                          });
                        }
                        return (
                          <SearchableSelect
                            testId={`live-orders-field-${field.name}`}
                            value={String(formData[field.name] || '')}
                            onChange={handleSelectChange}
                            options={selectOptions}
                            placeholder={selectPlaceholder}
                            listMinWidth={field.name.includes('Silo') ? 320 : undefined}
                          />
                        );
                      })() : (
                      <Input
                        type={field.type}
                        value={formData[field.name] || ''}
                        onChange={e => setFormData({ ...formData, [field.name]: e.target.value })}
                        className="bg-slate-800/70 light:bg-white border-slate-600 light:border-gray-200 text-white light:text-gray-900 w-full h-8 text-sm px-2"
                      />
                      )}
                    </div>
                    );
                  })}
                </div>
                
                {/* Helper message for destination silos */}
                {(() => {
                  let shouldShowTip = false;
                  let tipMessage = '';
                  
                  if (activeTab === 'bulk-line') {
                    shouldShowTip = !formData.sourceSilo || formData.sourceSilo === '';
                    tipMessage = '💡 <strong>Tip:</strong> Select a source silo first to see available destination silos.';
                  } else if (activeTab === 'pt-line') {
                    shouldShowTip = !formData.rawCode || formData.rawCode === '';
                    tipMessage = '💡 <strong>Tip:</strong> Enter a pit number and select raw material code first to see available destination silos.';
                  } else {
                    shouldShowTip = !formData.sourceMaterialCode || formData.sourceMaterialCode === '';
                    tipMessage = '💡 <strong>Tip:</strong> Enter a material code first to see destination silos that can store that specific material.';
                  }
                  
                  return shouldShowTip ? (
                  <div className="mt-4 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                      <p className="text-sm text-blue-400 light:text-blue-600" dangerouslySetInnerHTML={{ __html: tipMessage }} />
                  </div>
                  ) : null;
                })()}
                
                {/* Helper message when source is selected but no matching silos */}
                {((activeTab === 'bulk-line' && formData.sourceSilo && formData.sourceSilo !== '') ||
                  (activeTab === 'pt-line' && formData.rawCode && formData.rawCode !== '') ||
                  (activeTab !== 'bulk-line' && activeTab !== 'pt-line' && formData.sourceMaterialCode && formData.sourceMaterialCode !== '')) && (
                  (() => {
                    // Get order type and line for warning message
                    let orderType = 'intake';
                    let line = 1;
                    
                    if (activeTab === 'intake-line-1') {
                      orderType = 'intake';
                      line = 1;
                    } else if (activeTab === 'intake-line-2') {
                      orderType = 'intake';
                      line = 2;
                    } else if (activeTab === 'mineral-intake') {
                      orderType = 'intake';
                      line = 3; // ✅ CORRECT! Mineral intake uses line 3
                    } else if (activeTab === 'outloading-1') {
                      orderType = 'outloading';
                      line = 1;
                    } else if (activeTab === 'outloading-2') {
                      orderType = 'outloading';
                      line = 2;
                    } else if (activeTab === 'outloading-3') {
                      orderType = 'outloading';
                      line = 3;
                    } else if (activeTab === 'bulk-line') {
                      orderType = 'bulk';
                      line = 1;
                    } else if (activeTab === 'pt-line') {
                      orderType = 'pit';
                      line = 1;
                    }

                    const isMineralOrder = activeTab === 'mineral-intake';
                    let matchingSilos = [];
                    let warningMessage = '';
                    
                    if (activeTab === 'bulk-line') {
                      // For bulk orders, just check if there are any available destination silos (301-322)
                      matchingSilos = getSilosForOrderType(orderType, line, isMineralOrder, true).filter(silo => {
                        const isAvailable = !silo.lock_active && !silo.hl_active;
                        return isAvailable;
                      });
                      warningMessage = `⚠️ <strong>No available destination silos:</strong> No available destination silos found for bulk transfer. Check if silos are locked or at high level.`;
                    } else if (activeTab === 'pt-line') {
                      // For pit orders, filter by raw material code
                      matchingSilos = getSilosForOrderType(orderType, line, isMineralOrder).filter(silo => {
                        const isAvailable = !silo.lock_active && !silo.hl_active;
                        
                        // Must match the raw material code if one is specified
                        const materialCodeStr = String(formData.rawCode || '');
                        const materialMatches = !formData.rawCode ||
                                              materialCodeStr === '' ||
                                              materialCodeStr === 'None' ||
                                              materialCodeStr === 'None - None' ||
                                              sameMaterialCode(silo.material_code, formData.rawCode) ||
                                              silo.material_name === formData.rawCode ||
                                              // Extract just the code part from "210 - Soya Oil" format
                                              (materialCodeStr && materialCodeStr.includes(' - ') && 
                                               sameMaterialCode(silo.material_code, materialCodeStr.split(' - ')[0])) ||
                                              // Also check if silo material matches the full display text
                                              (materialCodeStr && materialCodeStr.includes(' - ') && 
                                               silo.material_name === materialCodeStr.split(' - ')[1]);
                        
                        return isAvailable && materialMatches;
                      });
                      warningMessage = `⚠️ <strong>No matching silos:</strong> No available silos found that can store raw material "${formData.rawCode}". Check if the material code is correct or if silos are locked/full.`;
                    } else {
                      const allSilosList = getAvailableSilos();
                      matchingSilos = getSilosForOrderType(orderType, line, isMineralOrder).filter(silo => {
                      const isAvailable = isSiloSelectableForOrder(silo, orderType, allSilosList);
                      
                      // Must match the material code if one is specified
                      const materialCodeStr = String(formData.sourceMaterialCode || '');
                      const materialMatches = !formData.sourceMaterialCode ||
                                            materialCodeStr === '' ||
                                            materialCodeStr === 'None' ||
                                              materialCodeStr === 'None - None' ||
                                            sameMaterialCode(silo.material_code, formData.sourceMaterialCode) ||
                                            silo.material_name === formData.sourceMaterialCode ||
                                            // Extract just the code part from "210 - Soya Oil" format
                                            (materialCodeStr && materialCodeStr.includes(' - ') && 
                                             sameMaterialCode(silo.material_code, materialCodeStr.split(' - ')[0])) ||
                                            // Also check if silo material matches the full display text
                                            (materialCodeStr && materialCodeStr.includes(' - ') && 
                                             silo.material_name === materialCodeStr.split(' - ')[1]);
                      
                      return isAvailable && materialMatches;
                    });
                      warningMessage = orderType === 'outloading'
                        ? `⚠️ <strong>No matching silos:</strong> No available high-level outloading silos (801–824) for material "${formData.sourceMaterialCode}". Check material code, locks, or low-level active on paired bins.`
                        : `⚠️ <strong>No matching silos:</strong> No available silos found that can store material "${formData.sourceMaterialCode}". Check if the material code is correct or if silos are locked/full.`;
                    }
                    
                    if (matchingSilos.length === 0) {
                      return (
                        <div className="mt-4 p-3 bg-orange-500/10 border border-orange-500/20 rounded-lg">
                          <p className="text-sm text-orange-400 light:text-orange-600" dangerouslySetInnerHTML={{ __html: warningMessage }} />
                        </div>
                      );
                    }
                    return null;
                  })()
                )}
                
                <div className="flex justify-end space-x-2 pt-3 mt-2">
                  <Button variant="ghost" className="!text-slate-400 hover:!bg-slate-700/50 light:!text-white light:hover:!bg-gray-600 px-3 py-1 text-sm border border-slate-600 light:border-gray-300" onClick={() => setShowModal(false)} type="button">Cancel</Button>
                  <Button className={`${ORDER_BTN} px-4 py-1 text-sm`} type="submit">Add</Button>
                </div>
              </form>
            </div>
          </div>
        )}
        {viewModal && viewOrder && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-white light:bg-white dark:bg-slate-900 p-6 rounded-xl w-full max-w-4xl space-y-3 border border-slate-700 light:border-gray-200 shadow-xl overflow-y-auto max-h-[90vh] relative">
              {/* Cancel Icon at top right */}
              <button
                onClick={() => setViewModal(false)}
                className="absolute top-4 right-4 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
              
              <h2 className="text-lg font-semibold mb-4 text-center text-gray-900 light:text-gray-900 dark:text-white">Order Details</h2>
              
              {/* Form-like layout with two columns */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {Object.entries(viewOrder).map(([key, value]) => (
                  <div key={key} className="flex flex-col space-y-1">
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300 capitalize">
                      {key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}
                    </label>
                    <div className="text-sm text-gray-900 dark:text-white bg-gray-50 dark:bg-slate-800 p-2 rounded border border-gray-200 dark:border-slate-600 min-h-[2rem] flex items-center">
                      {value !== null && value !== undefined ? String(value) : '-'}
                    </div>
                  </div>
                ))}
              </div>
              
              {/* Close button at bottom right */}
              <div className="flex justify-end pt-4 mt-4 border-t border-gray-200 dark:border-slate-600">
                <Button 
                  onClick={() => setViewModal(false)}
                  className={ORDER_BTN}
                >
                  Close
                </Button>
              </div>
            </div>
          </div>
        )}
        
        {/* Edit Order Modal */}
        {editModal && editOrder && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-white light:bg-white dark:bg-slate-900 p-6 rounded-xl w-full max-w-4xl space-y-3 border border-slate-700 light:border-gray-200 shadow-xl overflow-y-auto max-h-[90vh] relative">
              {/* Cancel Icon at top right */}
              <button
                onClick={() => setEditModal(false)}
                className="absolute top-4 right-4 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
              
              <h2 className="text-lg font-semibold mb-4 text-center text-gray-900 light:text-gray-900 dark:text-white">Edit Order</h2>
              
              <form onSubmit={handleEditSubmit} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* RFID Badge */}
                  <div className="flex flex-col space-y-1">
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      RFID Badge
                    </label>
                    <input
                      type="text"
                      value={editFormData.badgeNo || ''}
                      onChange={(e) => setEditFormData({...editFormData, badgeNo: e.target.value})}
                      className="text-sm text-gray-900 dark:text-white bg-gray-50 dark:bg-slate-800 p-2 rounded border border-gray-200 dark:border-slate-600 focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                      placeholder="Enter RFID badge number"
                    />
                  </div>

                  {/* Source Material Code */}
                  <div className="flex flex-col space-y-1">
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      Source Material Code
                    </label>
                    <SearchableSelect
                      testId="live-orders-edit-material"
                      value={String(editFormData.sourceMaterialCode || '')}
                      onChange={(v) => setEditFormData({...editFormData, sourceMaterialCode: v})}
                      placeholder="Select Material"
                      options={[
                        { value: '', label: 'Select Material' },
                        ...materialCodes.map((material) => ({ value: material.code, label: `${material.code} - ${material.name}` })),
                      ]}
                    />
                  </div>

                  {/* Declared Quantity */}
                  <div className="flex flex-col space-y-1">
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      Declared Quantity (KG)
                    </label>
                    <input
                      type="number"
                      value={editFormData.declaredQuantityKG || ''}
                      onChange={(e) => setEditFormData({...editFormData, declaredQuantityKG: e.target.value})}
                      className="text-sm text-gray-900 dark:text-white bg-gray-50 dark:bg-slate-800 p-2 rounded border border-gray-200 dark:border-slate-600 focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                      placeholder="Enter quantity in KG"
                      min="0"
                      step="0.1"
                    />
                  </div>

                  {isOutloadingTab(activeTab) && (
                    <div className="flex flex-col space-y-1">
                      <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        Destination (Bulk / Packing)
                      </label>
                      <select
                        value={String(editFormData.destSel ?? '0')}
                        onChange={(e) => setEditFormData({ ...editFormData, destSel: e.target.value })}
                        className="text-sm text-gray-900 dark:text-white bg-gray-50 dark:bg-slate-800 p-2 rounded border border-gray-200 dark:border-slate-600 focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                      >
                        <option value="0">Bulk</option>
                        <option value="1">Packing</option>
                      </select>
                    </div>
                  )}

                  {/* Destination Silo 1 */}
                  <div className="flex flex-col space-y-1">
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      Destination Silo 1
                    </label>
                    <SearchableSelect
                      testId="live-orders-edit-silo1"
                      listMinWidth={320}
                      value={String(editFormData.destinationSilo1 || '')}
                      placeholder="Select Silo 1"
                      onChange={(newValue) => {
                        setEditFormData({
                          ...editFormData, 
                          destinationSilo1: newValue,
                          // Clear destinationSilo2 if it's the same as the newly selected destinationSilo1
                          destinationSilo2: editFormData.destinationSilo2 === newValue ? '' : editFormData.destinationSilo2
                        });
                      }}
                      options={[{ value: '', label: 'Select Silo 1' }, ...(() => {
                        // Get order type and line for edit modal
                        let orderType = 'intake';
                        let line = 1;
                        
                        if (activeTab === 'intake-line-1') {
                          orderType = 'intake';
                          line = 1;
                        } else if (activeTab === 'intake-line-2') {
                          orderType = 'intake';
                          line = 2;
                        } else if (activeTab === 'mineral-intake') {
                          orderType = 'intake';
                          line = 3; // ✅ CORRECT! Mineral intake uses line 3
                        } else if (activeTab === 'outloading-1') {
                          orderType = 'outloading';
                          line = 1;
                        } else if (activeTab === 'outloading-2') {
                          orderType = 'outloading';
                          line = 2;
                        } else if (activeTab === 'outloading-3') {
                          orderType = 'outloading';
                          line = 3;
                        } else if (activeTab === 'bulk-line') {
                          orderType = 'bulk';
                          line = 1;
                        } else if (activeTab === 'pt-line') {
                          orderType = 'pit';
                          line = 1;
                        }

                        const isMineralOrder = activeTab === 'mineral-intake';
                        const allSilosList = getAvailableSilos();
                        return getSilosForOrderType(orderType, line, isMineralOrder).filter(silo => {
                          const isAvailable = isSiloSelectableForOrder(silo, orderType, allSilosList);
                          
                          // Must match the material code if one is specified
                          const materialCodeStr = String(editFormData.sourceMaterialCode || '');
                          const materialMatches = !editFormData.sourceMaterialCode ||
                                                materialCodeStr === '' ||
                                                materialCodeStr === 'None' ||
                                                materialCodeStr === 'None - None' ||
                                                sameMaterialCode(silo.material_code, editFormData.sourceMaterialCode) ||
                                                silo.material_name === editFormData.sourceMaterialCode ||
                                                // Extract just the code part from "210 - Soya Oil" format
                                                (materialCodeStr && materialCodeStr.includes(' - ') && 
                                                 sameMaterialCode(silo.material_code, materialCodeStr.split(' - ')[0])) ||
                                                // Also check if silo material matches the full display text
                                                (materialCodeStr && materialCodeStr.includes(' - ') && 
                                                 silo.material_name === materialCodeStr.split(' - ')[1]);
                          
                          return isAvailable && materialMatches;
                        }).map((silo) => {
                        const materialInfo = silo.material_name ? ` - ${silo.material_name}` : '';
                        const statusText =
                          orderType === 'outloading'
                            ? getOutloadingSiloStatusSuffix(silo, allSilosList)
                            : silo.lock_active ? ' (Locked)' : silo.hl_active ? ' (High Level)' : ' (Available)';
                        return { value: String(silo.silo_no || 0), label: `${silo.bin_name}${materialInfo}${statusText}` };
                      });
})()]}
/>
                  </div>

                  {/* Destination Silo 2 */}
                  <div className="flex flex-col space-y-1">
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      Destination Silo 2
                    </label>
                    <SearchableSelect
                      testId="live-orders-edit-silo2"
                      listMinWidth={320}
                      value={String(editFormData.destinationSilo2 || '')}
                      onChange={(v) => setEditFormData({...editFormData, destinationSilo2: v})}
                      placeholder="Select Silo 2"
                      options={[{ value: '', label: 'Select Silo 2' }, ...(() => {
                        // Get order type and line for edit modal
                        let orderType = 'intake';
                        let line = 1;
                        
                        if (activeTab === 'intake-line-1') {
                          orderType = 'intake';
                          line = 1;
                        } else if (activeTab === 'intake-line-2') {
                          orderType = 'intake';
                          line = 2;
                        } else if (activeTab === 'mineral-intake') {
                          orderType = 'intake';
                          line = 3; // ✅ CORRECT! Mineral intake uses line 3
                        } else if (activeTab === 'outloading-1') {
                          orderType = 'outloading';
                          line = 1;
                        } else if (activeTab === 'outloading-2') {
                          orderType = 'outloading';
                          line = 2;
                        } else if (activeTab === 'outloading-3') {
                          orderType = 'outloading';
                          line = 3;
                        } else if (activeTab === 'bulk-line') {
                          orderType = 'bulk';
                          line = 1;
                        } else if (activeTab === 'pt-line') {
                          orderType = 'pit';
                          line = 1;
                        }

                        const isMineralOrder = activeTab === 'mineral-intake';
                        const isDestinationField = true; // In edit modal, we're always dealing with destination fields
                        const allSilosList = getAvailableSilos();
                        return getSilosForOrderType(orderType, line, isMineralOrder, isDestinationField).filter(silo => {
                          const isAvailable = isSiloSelectableForOrder(silo, orderType, allSilosList);
                          
                          // Must not be already used by another order
                          const isNotUsed = !usedSilos.has(silo.bin_name);
                          
                          // Must match the material code if one is specified
                          let materialCodeStr = '';
                          if (activeTab === 'bulk-line') {
                            // For bulk orders, get material from selected source silo
                            const sourceSilos = getSilosForOrderType(orderType, line, isMineralOrder, false); // Get source silos (101-115)
                            const selectedSourceSilo = sourceSilos.find(s => s.bin_name === editFormData.sourceSilo);
                            if (selectedSourceSilo) {
                              materialCodeStr = selectedSourceSilo.material_name || selectedSourceSilo.material_code || '';
                            }
                          } else {
                            materialCodeStr = String(editFormData.sourceMaterialCode || '');
                          }
                          
                          let materialMatches = false;
                          if (activeTab === 'bulk-line') {
                            // For bulk orders, be strict - only show silos with matching material
                            if (materialCodeStr && materialCodeStr !== '' && materialCodeStr !== 'None' && materialCodeStr !== 'None - None') {
                              materialMatches = Boolean(sameMaterialCode(silo.material_code, materialCodeStr) ||
                                              silo.material_name === materialCodeStr ||
                                              // Extract just the code part from "210 - Soya Oil" format
                                              (materialCodeStr && materialCodeStr.includes(' - ') && 
                                               sameMaterialCode(silo.material_code, materialCodeStr.split(' - ')[0])) ||
                                              // Also check if silo material matches the full display text
                                              (materialCodeStr && materialCodeStr.includes(' - ') && 
                                               silo.material_name === materialCodeStr.split(' - ')[1]));
                            }
                            // If no source silo selected or no material found, don't show any destination silos
                          } else {
                            // For other order types, use the original logic
                            materialMatches = Boolean(!materialCodeStr ||
                                                materialCodeStr === '' ||
                                                materialCodeStr === 'None' ||
                                                materialCodeStr === 'None - None' ||
                                          sameMaterialCode(silo.material_code, materialCodeStr) ||
                                          silo.material_name === materialCodeStr ||
                                                // Extract just the code part from "210 - Soya Oil" format
                                                (materialCodeStr && materialCodeStr.includes(' - ') && 
                                                 sameMaterialCode(silo.material_code, materialCodeStr.split(' - ')[0])) ||
                                                // Also check if silo material matches the full display text
                                                (materialCodeStr && materialCodeStr.includes(' - ') && 
                                                 silo.material_name === materialCodeStr.split(' - ')[1]));
                          }
                          
                          // For destinationSilo2, exclude the silo already selected in destinationSilo1
                          // Also exclude the pit number silo from destination dropdowns
                          const siloNumber = silo.bin_name.split(' ')[1] || 'unknown';
                          const isNotAlreadySelected = (!editFormData.destinationSilo1 || 
                                                     editFormData.destinationSilo1 !== siloNumber) &&
                                                     // Exclude pit number silo from destination dropdowns
                                                     (!editFormData.pitNo || editFormData.pitNo !== siloNumber);
                          
                          return isAvailable && isNotUsed && materialMatches && isNotAlreadySelected;
                        }).map((silo) => {
                        const materialInfo = silo.material_name ? ` - ${silo.material_name}` : '';
                        const statusText =
                          orderType === 'outloading'
                            ? getOutloadingSiloStatusSuffix(silo, allSilosList)
                            : silo.lock_active ? ' (Locked)' : silo.hl_active ? ' (High Level)' : ' (Available)';
                        return { value: String(silo.silo_no || 0), label: `${silo.bin_name}${materialInfo}${statusText}` };
                      });
})()]}
/>
                  </div>

                </div>

                {/* Action Buttons */}
                <div className="flex justify-end space-x-2 pt-4">
                  <Button 
                    type="button"
                    variant="ghost" 
                    className="!text-slate-400 hover:!bg-slate-700/50 light:!text-white light:hover:!bg-gray-600 px-3 py-1 text-sm border border-slate-600 light:border-gray-300" 
                    onClick={() => setEditModal(false)}
                  >
                    Cancel
                  </Button>
                  <Button 
                    type="submit"
                    className={`${ORDER_BTN} px-4 py-1 text-sm`}
                    disabled={isLoading}
                  >
                    {isLoading ? 'Updating...' : 'Update Order'}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}
        
        <Tabs defaultValue="intake-line-1" className="w-full" onValueChange={(value) => {
          setActiveTab(value)
        }}>
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

          <TabsContent value="intake-line-1" className="space-y-4">
            {renderIntakeTable(intakeLine1Data, "Intake Line 1 Orders", "intake-line-1")}
            {renderWaitingPanel("intake-line-1")}
          </TabsContent>

          <TabsContent value="intake-line-2" className="space-y-4">
            {renderIntakeTable(intakeLine2Data, "Intake Line 2 Orders", "intake-line-2")}
            {renderWaitingPanel("intake-line-2")}
          </TabsContent>

          <TabsContent value="mineral-intake" className="space-y-4">
            {renderIntakeTable(mineralIntakeData, "Mineral Intake Orders", "mineral-intake")}
            {renderWaitingPanel("mineral-intake")}
          </TabsContent>

          <TabsContent value="outloading-1" className="space-y-4">
            {renderOutloadingTable(outloading1Data, "Outloading 1 Orders", "outloading-1")}
            {renderWaitingPanel("outloading-1")}
          </TabsContent>

          <TabsContent value="outloading-2" className="space-y-4">
            {renderOutloadingTable(outloading2Data, "Outloading 2 Orders", "outloading-2")}
            {renderWaitingPanel("outloading-2")}
          </TabsContent>

          <TabsContent value="outloading-3" className="space-y-4">
            {renderOutloadingTable(outloading3Data, "Outloading 3 Orders", "outloading-3")}
            {renderWaitingPanel("outloading-3")}
          </TabsContent>

          <TabsContent value="bulk-line" className="space-y-4">
            {renderBulkLineTable(bulkLineData, "Bulk Line Orders")}
            {renderWaitingPanel("bulk-line")}
          </TabsContent>

          <TabsContent value="pt-line" className="space-y-4">
            {renderPTLineTable(ptLineData, "PIT Line Orders")}
            {renderWaitingPanel("pt-line")}
          </TabsContent>
        </Tabs>

        <RfidAssignModal
          open={showAssignModal}
          onOpenChange={setShowAssignModal}
          rfidTags={rfidConfigs}
          trucks={trucks}
          defaultOrderRef={orderRefLabelFromActiveTab(activeTab)}
          onAssigned={fetchRfidConfigs}
        />
      </div>
    </WaterSystemLayout>
  )
}