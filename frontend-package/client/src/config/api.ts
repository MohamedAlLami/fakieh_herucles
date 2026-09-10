// API Configuration
// Use relative URLs to work with Vite proxy in development
// and with the actual domain in production

const isDevelopment = import.meta.env.DEV;

// In development, use relative URLs that will be proxied by Vite
// In production, use the actual API URL
export const API_BASE_URL = isDevelopment ? '/api' : 'http://192.168.199.160:5000/api';
export const PLC_BASE_URL = isDevelopment ? '/api/plc' : 'http://192.168.199.160:5000/api/plc';

// Export individual API endpoints
export const API_ENDPOINTS = {
  // Health check
  HEALTH: '/api/health',
  
  // Orders
  ORDERS: {
    INTAKE1: '/api/orders/intake1',
    INTAKE2: '/api/orders/intake2',
    OUTLOAD1: '/api/orders/outload1',
    OUTLOAD2: '/api/orders/outload2',
    OUTLOAD3: '/api/orders/outload3',
    BULK: '/api/orders/bulk',
    PT: '/api/orders/pt',
    MINERAL: '/api/orders/mineral',
  },
  
  // PLC
  PLC: {
    ORDERS: '/api/plc/plant/orders',
    SILOS: '/api/plc/silos',
    HEALTH: '/api/plc/health',
    INFO: '/api/plc/info',
  },
  
  // Storage
  STORAGE: '/api/storage',
  
  // Trucks
  TRUCKS: '/api/trucks',
  
  // Orders History
  ORDERS_HISTORY: {
    ACTIVE: '/api/orders/active',
    COMPLETED: '/api/orders/completed',
    HISTORY: '/api/orders/history',
    STATS: '/api/orders/stats',
  },
  
  // RFID
  RFID: '/api/rfid',
  
  // Weighbridge
  WEIGHBRIDGE: '/api/weighbridge',

  // Truck entry / weighbridge orders
  TRUCK_ENTRY: {
    ORDERS: '/api/truck-entry/orders',
    OPEN: '/api/truck-entry/orders/open',
    TODAY: '/api/truck-entry/orders/today',
    STATUS_BY_TRUCK: '/api/truck-entry/status/by-truck',
  },
  
  // Reports (Postgres-backed app reports: /daily, /weekly, …)
  REPORTS: '/api/reports',

  PALLET_REPORT: {
    LIVE: `${API_BASE_URL}/pallet-report/live`,
    HISTORY: `${API_BASE_URL}/pallet-report/history`,
    SUMMARY: `${API_BASE_URL}/pallet-report/summary`,
  },

  /** SQL Server BatchMaterials (NFM-style batch reporting) */
  BATCH_KPI: `${API_BASE_URL}/kpi`,
  BATCH_REPORTS_QUERY: `${API_BASE_URL}/reports`,
  /** Calendar-aligned SQL product aggregates (same filter/window as Batch Calendar). */
  BATCH_REPORTS_PRODUCT_SUMMARY: `${API_BASE_URL}/kpi_calendar/product-summary`,
  BATCH_FILTER_OPTIONS: `${API_BASE_URL}/filter-options`,
  BATCH_KPI_CALENDAR: `${API_BASE_URL}/kpi_calendar`,
  BATCH_KPI_CALENDAR_DETAILS: `${API_BASE_URL}/kpi_calendar/details`,
  
  // Production
  PRODUCTION: '/api/production',

  // Hercules AI
  AI: {
    HEALTH: '/api/ai/health',
    INSIGHTS: '/api/ai/insights',
    ASK: '/api/ai/ask',
    ML_INFO: '/api/ai/ml/info',
    ML_PREDICT: '/api/ai/ml/predict',
    ML_TOP_RISKS: '/api/ai/ml/top-risks',
    LIVE_STATE: '/api/ai/live/state',
    LIVE_CONTROL: '/api/ai/live/control',
  },
};

export default API_ENDPOINTS;
