import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard,
  Database,
  Truck,
  History,
  Radio,
  Scale,
  ShoppingCart,
  Calendar,
  FileBarChart,
  Table2,
  BarChart3,
  Send,
  Users,
  Sparkles,
  Boxes,
  PackageSearch,
} from 'lucide-react'

export interface SidebarNavItem {
  path: string
  icon: LucideIcon
  label: string
  description: string
}

export interface SidebarNavGroup {
  id: string
  label: string
  description: string
  icon: LucideIcon
  items: SidebarNavItem[]
}

export type SidebarNavEntry = SidebarNavItem | SidebarNavGroup

export function isSidebarNavGroup(entry: SidebarNavEntry): entry is SidebarNavGroup {
  return 'items' in entry && Array.isArray((entry as SidebarNavGroup).items)
}

const ordersItems: SidebarNavItem[] = [
  {
    path: '/fakieh/live_orders',
    icon: Truck,
    label: 'Live orders',
    description: 'Real-time Orders from SCADA',
  },
  {
    path: '/fakieh/order-history',
    icon: History,
    label: 'Order History',
    description: 'Complete Order History from Database',
  },
]

const managementItems: SidebarNavItem[] = [
  {
    path: '/fakieh/management/rfid',
    icon: Radio,
    label: 'RFID',
    description: 'RFID tracking and assignment',
  },
  {
    path: '/fakieh/management/trucks',
    icon: Truck,
    label: 'Trucks',
    description: 'Manage fleet trucks',
  },
  {
    path: '/fakieh/management/drivers',
    icon: Users,
    label: 'Drivers',
    description: 'Manage drivers and assignments',
  },
  {
    path: '/fakieh/management/clients',
    icon: Users,
    label: 'Clients',
    description: 'Manage client name and contact number',
  },
]

const weighbridgeItems: SidebarNavItem[] = [
  {
    path: '/fakieh/truck-entry',
    icon: Scale,
    label: 'Weighbridge Entry',
    description: 'Create entries and record first and second weights',
  },
  {
    path: '/fakieh/weighbridge',
    icon: Scale,
    label: 'Weighbridge Log',
    description: 'Read-only log of completed weigh trips',
  },
]

const fakiehReportingItems: SidebarNavItem[] = [
  {
    path: '/fakieh/fakieh-dashboard',
    icon: LayoutDashboard,
    label: 'Fakieh Dashboard',
    description: 'Main production dashboard',
  },
  {
    path: '/fakieh/batch-calendar',
    icon: Calendar,
    label: 'Batch calendar',
    description: 'Daily production from batch materials',
  },
  {
    path: '/fakieh/batch-raw-data',
    icon: Table2,
    label: 'Raw data',
    description: 'Filtered batch material rows and CSV export',
  },
  {
    path: '/fakieh/batch-historical-reports',
    icon: FileBarChart,
    label: 'Historical reports',
    description: 'Summaries, weekly, monthly, daily, material usage',
  },
  {
    path: '/fakieh/pallet-report',
    icon: PackageSearch,
    label: 'Pallet Report',
    description: 'Live DB7 pallet status and historian',
  },
]

/** Sidebar navigation entries */
export const sidebarNavEntries: SidebarNavEntry[] = [
  {
    id: 'fakieh-reporting',
    label: 'Fakieh Reporting',
    description: 'Dashboard and batch reporting',
    icon: BarChart3,
    items: fakiehReportingItems,
  },
  {
    path: '/fakieh/storage',
    icon: Database,
    label: 'Storage',
    description: 'Storage Management',
  },
  {
    path: '/fakieh/plant-3d',
    icon: Boxes,
    label: 'Plant 3D',
    description: '3D view of the plant and silos',
  },
  {
    id: 'orders',
    label: 'Orders',
    description: 'Live orders and order history',
    icon: ShoppingCart,
    items: ordersItems,
  },
  {
    id: 'weighbridge',
    label: 'Weighbridge',
    description: 'Weighbridge entry and completed trip log',
    icon: Scale,
    items: weighbridgeItems,
  },
  {
    id: 'management',
    label: 'Management',
    description: 'RFID, trucks, drivers, and clients',
    icon: Users,
    items: managementItems,
  },
  {
    path: '/fakieh/distribution',
    icon: Send,
    label: 'Distribution',
    description: 'Scheduled report email & disk delivery',
  },
  {
    path: '/fakieh/ai-assistant',
    icon: Sparkles,
    label: 'Hercules AI',
    description: 'Ask Hercules, predictive dosing, live monitoring',
  },
]

export type TopNavLinkItem = {
  kind: 'link'
  path: string
  label: string
  /** Shorter label for the top navigation bar when space is tight. */
  shortLabel?: string
  icon: LucideIcon
}

export type TopNavGroupItem = {
  kind: 'group'
  label: string
  /** Shorter label for the top navigation bar when space is tight. */
  shortLabel?: string
  icon: LucideIcon
  items: { path: string; label: string }[]
}

export type TopNavItem = TopNavLinkItem | TopNavGroupItem

/** Top bar: Admin omitted (gear in chrome). */
export const topNavItems: TopNavItem[] = [
  {
    kind: 'group',
    label: 'Fakieh Reporting',
    shortLabel: 'Reporting',
    icon: BarChart3,
    items: [
      { path: '/fakieh/fakieh-dashboard', label: 'Fakieh Dashboard' },
      { path: '/fakieh/batch-calendar', label: 'Batch calendar' },
      { path: '/fakieh/batch-raw-data', label: 'Raw data' },
      { path: '/fakieh/batch-historical-reports', label: 'Historical reports' },
      { path: '/fakieh/pallet-report', label: 'Pallet Report' },
    ],
  },
  {
    kind: 'link',
    path: '/fakieh/storage',
    label: 'Storage',
    icon: Database,
  },
  {
    kind: 'link',
    path: '/fakieh/plant-3d',
    label: 'Plant 3D',
    icon: Boxes,
  },
  {
    kind: 'group',
    label: 'Orders',
    icon: ShoppingCart,
    items: [
      { path: '/fakieh/live_orders', label: 'Live orders' },
      { path: '/fakieh/order-history', label: 'Order history' },
    ],
  },
  {
    kind: 'group',
    label: 'Management',
    shortLabel: 'Management',
    icon: Users,
    items: [
      { path: '/fakieh/management/rfid', label: 'RFID' },
      { path: '/fakieh/management/trucks', label: 'Trucks' },
      { path: '/fakieh/management/drivers', label: 'Drivers' },
      { path: '/fakieh/management/clients', label: 'Clients' },
    ],
  },
  {
    kind: 'group',
    label: 'Weighbridge',
    icon: Scale,
    items: [
      { path: '/fakieh/truck-entry', label: 'Weighbridge entry' },
      { path: '/fakieh/weighbridge', label: 'Weighbridge log' },
    ],
  },
  {
    kind: 'link',
    path: '/fakieh/distribution',
    label: 'Distribution',
    icon: Send,
  },
  {
    kind: 'link',
    path: '/fakieh/ai-assistant',
    label: 'Hercules AI',
    shortLabel: 'AI',
    icon: Sparkles,
  },
]
