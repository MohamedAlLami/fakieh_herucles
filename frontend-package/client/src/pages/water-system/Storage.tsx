import React, { useState, useEffect } from "react";
import axios from "axios";
import { WaterSystemLayout } from "../../components/water-system/WaterSystemLayout";
import { KPICard } from "../../components/water-system/KPICard";
import { AlertTriangle, CheckCircle, Clock, Filter, Database, Zap, Printer, Pencil, FileSpreadsheet } from "lucide-react";
import asmLogo from "@/assets/Asm_Logo.png";
import fakiehBrandLogo from "@/assets/fakiehlogo.webp";
import herculesLogo from "@/assets/Hercules_New.png";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSilos, useSilosPolling } from "../../contexts/SiloContext";
import { usePolling } from "../../hooks/usePolling";
import { fetchTempSilos, type TempSilo } from "../../api/tempSilos";
import { TempSiloDialog } from "../../components/water-system/TempSiloDialog";
import { useRowSelection } from "../../hooks/useRowSelection";
import { rowsToPrint } from "../../utils/printTable";
import { exportTableToExcel, type ExportColumn } from "../../utils/exportTable";

const TEMP_GROUP = "temp";
const TEMP_GROUP_LABEL = "Temporary silos (1001–1200)";

// // ✅ Mock data
// const mockSilos = [
//   {
//     id: 1,
//     name: "Silo A",
//     material: "Wheat",
//     capacity: 1000,
//     current: 750,
//     temperature: 25,
//     humidity: 60,
//     lastUpdated: "2025-08-02",
//     status: "Online",
//     utilization: 75,
//   },
//   {
//     id: 2,
//     name: "Silo B",
//     material: "Corn",
//     capacity: 1200,
//     current: 900,
//     temperature: 24,
//     humidity: 58,
//     lastUpdated: "2025-08-02",
//     status: "Warning",
//     utilization: 75,
//   },
//   {
//     id: 3,
//     name: "Silo C",
//     material: "Barley",
//     capacity: 1500,
//     current: 300,
//     temperature: 26,
//     humidity: 55,
//     lastUpdated: "2025-08-02",
//     status: "Offline",
//     utilization: 20,
//   },
// ];

// const mockBinMaterials = [
//   {
//     binName: "Bin X",
//     materialName: "Rice",
//     materialCode: "RC123",
//     hlActive: true,
//     lockActive: false,
//   },
//   {
//     binName: "Bin Y",
//     materialName: "Barley",
//     materialCode: "BL456",
//     hlActive: false,
//     lockActive: true,
//   },
// ];

export function Storage() {
  const { 
    allSilos, 
    db1Silos, 
    db2Silos, 
    db3Silos, 
    loading, 
    error, 
    lastUpdated, 
    fetchSilos
  } = useSilos();
  // Storage is a live silo view — opt in to polling here (not app-wide).
  useSilosPolling(15000);

  const [filters, setFilters] = useState({
    binName: "",
    materialName: "",
    materialCode: "",
    hlActive: "all",
    lockActive: "all",
    dbFilter: "all", // Filter by database (DB1, DB2, DB3, DB5)
    groupFilter: "all", // Hundreds group of the silo number (100, 200, ...)
  });
  const [printError, setPrintError] = useState<string | null>(null);

  // Temporary silos 1001-1200: ground storage kept in Hercules only, never read from the PLC.
  const [tempSilos, setTempSilos] = useState<TempSilo[]>([]);
  const [tempError, setTempError] = useState<string | null>(null);
  const [editTempSilo, setEditTempSilo] = useState<number | null>(null);
  const loadTempSilos = async (signal?: AbortSignal) => {
    try {
      setTempSilos(await fetchTempSilos(signal));
      setTempError(null);
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      setTempError("Could not load the temporary silos");
    }
  };
  usePolling((signal) => loadTempSilos(signal), 15000);
  const allRows = [
    ...allSilos.map((s) => ({ ...s, isTemp: false })),
    ...tempSilos.map((t) => ({
      bin_name: t.binName,
      material_code: t.materialCode,
      material_name: t.materialName,
      hl_active: false,
      lock_active: false,
      quantity_kg: t.quantityKg as number | null | undefined,
      dbSource: "TEMP",
      dbType: "Temporary",
      silo_no: t.siloNo as number | undefined,
      isTemp: true,
    })),
  ];
  
  const syncWithPLC = async () => {
    try {
      // First, sync with PLC to get fresh data
      const syncResponse = await axios.post('/api/plc/silos/sync');
      // Then refresh silo data from the updated database
      await fetchSilos();
    } catch (err) {
      
      // Still try to fetch silos even if sync fails
      await fetchSilos();
    }
  };
  
  

 
  // Get unique values for filters
  const uniqueMaterials = Array.from(
    new Set(allRows.map((item) => item.material_name).filter(name => name && name.trim() !== ""))
  ).sort();
  const uniqueCodes = Array.from(
    new Set(allRows.map((item) => item.material_code).filter(code => code && code.trim() !== ""))
  ).sort();
  const uniqueBins = Array.from(
    new Set(allRows.map((item) => item.bin_name).filter(name => name && name.trim() !== ""))
  ).sort();

  // Hundreds groups (100, 200, ...) that exist in the loaded data
  const uniqueGroups = Array.from(
    new Set(
      allSilos
        .map((item) => item.silo_no ?? 0)
        .filter((n) => n > 0)
        .map((n) => Math.floor(n / 100) * 100)
    )
  ).sort((a, b) => a - b);

  // Filter silos based on current filters
  const filteredSilos = allRows.filter((item) => {
    return (
      (filters.binName === "" ||
        item.bin_name.toLowerCase().includes(filters.binName.toLowerCase())) &&
      (filters.materialName === "all" ||
        filters.materialName === "" ||
        item.material_name === filters.materialName) &&
      (filters.materialCode === "all" ||
        filters.materialCode === "" ||
        item.material_code === filters.materialCode) &&
      (filters.hlActive === "all" ||
        (filters.hlActive === "true" ? item.hl_active : !item.hl_active)) &&
      (filters.lockActive === "all" ||
        (filters.lockActive === "true" ? item.lock_active : !item.lock_active)) &&
      (filters.dbFilter === "all" ||
        item.dbSource === filters.dbFilter) &&
      (filters.groupFilter === "all" ||
        (filters.groupFilter === TEMP_GROUP
          ? item.isTemp
          : !item.isTemp &&
            (item.silo_no ?? 0) > 0 &&
            Math.floor((item.silo_no as number) / 100) * 100 === Number(filters.groupFilter)))
    );
  });

  // Tick boxes: print or export only the ticked silos, or everything shown when none is ticked.
  type StorageRow = (typeof filteredSilos)[number];
  const siloKey = (s: StorageRow) => `${s.dbSource}-${s.silo_no ?? s.bin_name}`;
  const selection = useRowSelection(filteredSilos.map(siloKey));
  const siloStatus = (s: StorageRow) =>
    s.material_code || s.material_name || s.hl_active || s.lock_active ? "ACTIVE" : s.isTemp ? "FREE" : "EMPTY";
  const groupTitle =
    filters.groupFilter === "all"
      ? "Storage — all groups"
      : filters.groupFilter === TEMP_GROUP
        ? `Storage — ${TEMP_GROUP_LABEL}`
        : `Storage — ${filters.groupFilter} group`;
  const filterSummary = () => {
    const summary: string[] = [];
    if (filters.binName.trim()) summary.push(`Bin: ${filters.binName.trim()}`);
    if (filters.materialName && filters.materialName !== "all") summary.push(`Material: ${filters.materialName}`);
    if (filters.materialCode && filters.materialCode !== "all") summary.push(`Code: ${filters.materialCode}`);
    if (filters.hlActive !== "all") summary.push(`High level: ${filters.hlActive === "true" ? "active" : "inactive"}`);
    if (filters.lockActive !== "all") summary.push(`Lock: ${filters.lockActive === "true" ? "locked" : "unlocked"}`);
    if (filters.dbFilter !== "all") summary.push(`Database: ${filters.dbFilter}`);
    return summary;
  };

  const handleExcel = async () => {
    setPrintError(null);
    const rows = rowsToPrint(filteredSilos, selection.selected, siloKey);
    const columns: ExportColumn<StorageRow>[] = [
      { header: "Silo", cell: (s) => s.bin_name },
      { header: "Material", cell: (s) => s.material_name },
      { header: "Material Code", cell: (s) => s.material_code },
      { header: "Quantity (kg)", cell: (s) => s.quantity_kg ?? 0, excel: (s) => s.quantity_kg ?? 0, numeric: true },
      { header: "High Level", cell: (s) => (s.isTemp ? "" : s.hl_active ? "HIGH" : "NORMAL") },
      { header: "Lock", cell: (s) => (s.isTemp ? "" : s.lock_active ? "LOCKED" : "UNLOCKED") },
      { header: "Status", cell: siloStatus },
    ];
    const subtitles: string[] = [];
    const summary = filterSummary();
    if (summary.length) subtitles.push(`Filters: ${summary.join(" | ")}`);
    if (selection.count > 0) subtitles.push(`${rows.length} of ${filteredSilos.length} silos selected`);
    const total = rows.reduce((sum, s) => sum + (s.quantity_kg ?? 0), 0);
    const err = await exportTableToExcel({
      title: groupTitle,
      subtitles,
      columns,
      rows,
      footer: [`Total: ${rows.length} silo${rows.length === 1 ? "" : "s"}`, "", "", total, "", "", ""],
      filename: "storage",
      sheetName: "Storage",
    });
    setPrintError(err);
  };

  const clearFilters = () => {
    setFilters({
      binName: "",
      materialName: "",
      materialCode: "",
      hlActive: "all",
      lockActive: "all",
      dbFilter: "all",
      groupFilter: "all",
    });
  };

  const escapeHtml = (value: unknown): string =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const imageToDataUrl = async (src: string): Promise<string> => {
    try {
      const blob = await (await fetch(src)).blob();
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch {
      return src;
    }
  };

  // Print exactly the rows currently shown in the table (after all filters)
  const handlePrint = async () => {
    setPrintError(null);
    const rows = rowsToPrint(filteredSilos, selection.selected, siloKey);
    if (rows.length === 0) {
      setPrintError("No silos to print");
      return;
    }
    try {
      const [herculesLogoSrc, fakiehLogoSrc, asmLogoSrc] = await Promise.all([
        imageToDataUrl(herculesLogo),
        imageToDataUrl(fakiehBrandLogo),
        imageToDataUrl(asmLogo),
      ]);

      const printWindow = window.open("", "_blank", "width=800,height=600");
      if (!printWindow) {
        setPrintError("Please allow popups to print the storage table");
        return;
      }

      const fmtQty = (n: number) =>
        n.toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 0 });
      const title =
        filters.groupFilter === "all"
          ? "Storage — all groups"
          : filters.groupFilter === TEMP_GROUP
            ? `Storage — ${TEMP_GROUP_LABEL}`
            : `Storage — ${filters.groupFilter} group`;
      const summary: string[] = [];
      if (filters.binName.trim()) summary.push(`Bin: ${filters.binName.trim()}`);
      if (filters.materialName && filters.materialName !== "all") summary.push(`Material: ${filters.materialName}`);
      if (filters.materialCode && filters.materialCode !== "all") summary.push(`Code: ${filters.materialCode}`);
      if (filters.hlActive !== "all") summary.push(`High level: ${filters.hlActive === "true" ? "active" : "inactive"}`);
      if (filters.lockActive !== "all") summary.push(`Lock: ${filters.lockActive === "true" ? "locked" : "unlocked"}`);
      if (filters.dbFilter !== "all") summary.push(`Database: ${filters.dbFilter}`);
      const filterLine =
        (summary.length > 0 ? `Filters: ${summary.join(" | ")}` : "No other filters") +
        (selection.count > 0 ? ` | ${rows.length} of ${filteredSilos.length} silos selected` : "");

      const totalQty = rows.reduce((sum, s) => sum + (s.quantity_kg ?? 0), 0);
      const bodyRows = rows
        .map((silo) => `
              <tr>
                <td>${escapeHtml(silo.bin_name)}</td>
                <td>${escapeHtml(silo.material_name || "—")}</td>
                <td>${escapeHtml(silo.material_code || "—")}</td>
                <td class="num">${escapeHtml(fmtQty(silo.quantity_kg ?? 0))}</td>
                <td>${silo.isTemp ? "—" : silo.hl_active ? "HIGH" : "NORMAL"}</td>
                <td>${silo.isTemp ? "—" : silo.lock_active ? "LOCKED" : "UNLOCKED"}</td>
                <td>${silo.material_code || silo.material_name || silo.hl_active || silo.lock_active ? "ACTIVE" : silo.isTemp ? "FREE" : "EMPTY"}</td>
              </tr>`)
        .join("");

      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4 portrait; margin: 15mm 12mm; }
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; margin: 0; padding: 0; color: #000; background: #fff; }
    .page-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 12px; }
    .page-header img { max-height: 50px; max-width: 150px; object-fit: contain; }
    .logo-right { display: flex; gap: 16px; align-items: center; }
    h1 { font-size: 20px; margin: 0 0 4px 0; text-align: center; color: #000; }
    .meta { text-align: center; font-size: 11px; margin: 2px 0; color: #000; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 11px; }
    thead { display: table-header-group; }
    tfoot { display: table-footer-group; }
    tr { page-break-inside: avoid; }
    th, td { border: 1px solid #000; padding: 5px 6px; text-align: left; color: #000; background: #fff; }
    th { font-weight: bold; }
    th.num, td.num { text-align: right; }
    tfoot td { font-weight: bold; }
    @media print { * { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
</head>
<body>
  <div class="page-header">
    <img src="${escapeHtml(herculesLogoSrc)}" alt="Hercules" />
    <div class="logo-right">
      <img src="${escapeHtml(fakiehLogoSrc)}" alt="Fakieh" />
      <img src="${escapeHtml(asmLogoSrc)}" alt="ASM" />
    </div>
  </div>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">Printed: ${escapeHtml(new Date().toLocaleString())}</p>
  <p class="meta">${escapeHtml(filterLine)}</p>
  <table>
    <thead>
      <tr>
        <th>Silo</th>
        <th>Material</th>
        <th>Material Code</th>
        <th class="num">Quantity (kg)</th>
        <th>High Level</th>
        <th>Lock</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody>${bodyRows}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="3">Total: ${rows.length} silo${rows.length === 1 ? "" : "s"}</td>
        <td class="num">${escapeHtml(fmtQty(totalQty))}</td>
        <td colspan="3"></td>
      </tr>
    </tfoot>
  </table>
</body>
</html>`;

      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.onload = () => {
        setTimeout(() => {
          printWindow.focus();
          printWindow.print();
          printWindow.close();
        }, 300);
      };
    } catch {
      setPrintError("Error printing storage table. Please try again.");
    }
  };

  // Calculate statistics
  const totalSilos = allSilos.length;
  const activeSilos = allSilos.filter(silo => silo.material_code || silo.material_name).length;
  const hlActiveCount = allSilos.filter(silo => silo.hl_active).length;
  const lockActiveCount = allSilos.filter(silo => silo.lock_active).length;
  const totalQtyKg = allSilos.reduce((sum, s) => sum + (s.quantity_kg ?? 0), 0);

  return (
    <WaterSystemLayout
      title="Storage Management"
      subtitle="Real-time monitoring of silos and raw levels"
    >
      <div className="space-y-6">
        {/* KPI Cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <KPICard
            title="TOTAL SILOS"
            value={totalSilos.toString()}
            subtitle="All Databases"
            icon="gauge"
            color="blue"
            chartType="bar"
          />
          <KPICard
            title="ACTIVE SILOS"
            value={activeSilos.toString()}
            subtitle="With Materials"
            icon="water"
            color="green"
            chartType="line"
          />
          <KPICard
            title="HIGH LEVEL"
            value={hlActiveCount.toString()}
            subtitle="Sensors Active"
            icon="activity"
            color="orange"
            chartType="bar"
          />
          <KPICard
            title="LOCKED SILOS"
            value={lockActiveCount.toString()}
            subtitle="Currently Locked"
            icon="pump"
            color="purple"
            chartType="line"
          />
          <KPICard
            title="TOTAL INVENTORY"
            value={totalQtyKg.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            subtitle="KG (DB5 qty)"
            icon="gauge"
            color="cyan"
            chartType="bar"
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Button 
              onClick={() => { void fetchSilos(); void loadTempSilos(); }}
              variant="outline"
              className="text-sm border-slate-600 text-white light:border-gray-300 light:text-gray-700 hover:bg-slate-700 light:hover:bg-gray-100"
              disabled={loading}
            >
              {loading ? "🔄 Loading..." : "🔁 Refresh"}
            </Button>
            <Button 
              onClick={syncWithPLC} 
              variant="outline" 
              className="text-sm border-cyan-600 text-cyan-400 hover:bg-cyan-600/20"
              disabled={loading}
            >
              {loading ? "🔄 Syncing..." : "⚡ Sync PLC"}
            </Button>
            <Button
              onClick={() => { void handlePrint() }}
              variant="outline"
              className="text-sm border-slate-600 text-white light:border-gray-300 light:text-gray-700 hover:bg-slate-700 light:hover:bg-gray-100"
              disabled={filteredSilos.length === 0}
            >
              <Printer className="h-4 w-4 mr-2" />
              {selection.count > 0 ? `Print selected (${selection.count})` : "Print"}
            </Button>
            <Button
              onClick={() => { void handleExcel() }}
              variant="outline"
              className="text-sm border-slate-600 text-white light:border-gray-300 light:text-gray-700 hover:bg-slate-700 light:hover:bg-gray-100"
              disabled={filteredSilos.length === 0}
              data-testid="storage-excel"
            >
              <FileSpreadsheet className="h-4 w-4 mr-2" />
              {selection.count > 0 ? `Export selected (${selection.count})` : "Export Excel"}
            </Button>
            {error && (
              <div className="text-red-400 text-sm">
                ⚠️ {error}
              </div>
            )}
            {tempError && (
              <div className="text-red-400 text-sm">
                ⚠️ {tempError}
              </div>
            )}
            {printError && (
              <div className="text-red-400 text-sm">
                ⚠️ {printError}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <Database className="h-4 w-4" />
            <span>Last updated: {lastUpdated}</span>
            <Zap className="h-4 w-4 text-green-400" />
            <span>Real-time</span>
          </div>
        </div>

        {/* Filter section */}
        <Card className="bg-slate-800/30 light:bg-white border-slate-700 light:border-gray-200 mb-4 light:shadow-md">
          <CardHeader className="pb-3">
            <CardTitle className="text-white light:text-gray-900 flex items-center gap-2 text-lg">
              <Filter className="h-4 w-4 text-cyan-400 light:text-blue-600" />
              Bin Materials Filters
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-8 gap-3">
              <div>
                <label className="text-slate-300 light:text-gray-700 text-xs mb-1 block">
                  Bin Name
                </label>
                <Input
                  type="text"
                  placeholder="Search bin..."
                  value={filters.binName}
                  onChange={(e) =>
                    setFilters({ ...filters, binName: e.target.value })
                  }
                  className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-700 h-8 text-sm"
                />
              </div>
              <div>
                <label className="text-slate-300 light:text-gray-700 text-xs mb-1 block">
                  Material Name
                </label>
                <Select
                  onValueChange={(value) =>
                    setFilters({ ...filters, materialName: value })
                  }
                >
                  <SelectTrigger className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-700 h-8 text-sm">
                    <SelectValue placeholder="All Materials" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300">
                    <SelectItem value="all">All Materials</SelectItem>
                    {uniqueMaterials.map((material) => (
                      <SelectItem key={material} value={material || "unknown"}>
                        {material || "Unknown Material"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-slate-300 light:text-gray-700 text-xs mb-1 block">
                  Material Code
                </label>
                <Select
                  onValueChange={(value) =>
                    setFilters({ ...filters, materialCode: value })
                  }
                >
                  <SelectTrigger className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-700 h-8 text-sm">
                    <SelectValue placeholder="All Codes" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300">
                    <SelectItem value="all">All Codes</SelectItem>
                    {uniqueCodes.map((code) => (
                      <SelectItem key={code} value={code || "unknown"}>
                        {code || "Unknown Code"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-slate-300 light:text-gray-700 text-xs mb-1 block">
                  HL Active
                </label>
                <Select
                  onValueChange={(value) =>
                    setFilters({ ...filters, hlActive: value })
                  }
                >
                  <SelectTrigger className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-700 h-8 text-sm">
                    <SelectValue placeholder="All Status" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300">
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="true">Active (TRUE)</SelectItem>
                    <SelectItem value="false">Inactive (FALSE)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-slate-300 light:text-gray-700 text-xs mb-1 block">
                  Lock Active
                </label>
                <Select
                  onValueChange={(value) =>
                    setFilters({ ...filters, lockActive: value })
                  }
                >
                  <SelectTrigger className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-700 h-8 text-sm">
                    <SelectValue placeholder="All Status" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300">
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="true">Locked (TRUE)</SelectItem>
                    <SelectItem value="false">Unlocked (FALSE)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-slate-300 light:text-gray-700 text-xs mb-1 block">
                  Database
                </label>
                <Select
                  onValueChange={(value) =>
                    setFilters({ ...filters, dbFilter: value })
                  }
                >
                  <SelectTrigger className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-700 h-8 text-sm">
                    <SelectValue placeholder="All DBs" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300">
                    <SelectItem value="all">All Databases</SelectItem>
                    <SelectItem value="DB1">DB1 - Intake</SelectItem>
                    <SelectItem value="DB2">DB2 - Outloading</SelectItem>
                    <SelectItem value="DB3">DB3 - Main Storage</SelectItem>
                    <SelectItem value="DB5">DB5 - Qty Only</SelectItem>
                    <SelectItem value="TEMP">Temporary - Hercules only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-slate-300 light:text-gray-700 text-xs mb-1 block">
                  Group
                </label>
                <Select
                  value={filters.groupFilter}
                  onValueChange={(value) =>
                    setFilters({ ...filters, groupFilter: value })
                  }
                >
                  <SelectTrigger className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300 text-white light:text-gray-700 h-8 text-sm">
                    <SelectValue placeholder="All groups" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-700 light:bg-white border-slate-600 light:border-gray-300">
                    <SelectItem value="all">All groups</SelectItem>
                    {uniqueGroups.map((group) => (
                      <SelectItem key={group} value={String(group)}>
                        {group} group
                      </SelectItem>
                    ))}
                    <SelectItem value={TEMP_GROUP}>{TEMP_GROUP_LABEL}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end gap-2">
                <Button
                  onClick={clearFilters}
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

        {/* Real-time Silo Data Table */}
        <div className="bg-slate-950/50 light:bg-white border border-slate-700/30 light:border-gray-200 rounded-lg backdrop-blur-sm light:shadow-lg">
          {/* Header */}
          <div className="p-6 border-b border-slate-700/30 light:border-gray-200">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white light:text-gray-900">
                Real-time Silo Monitoring
              </h3>
              <div className="text-sm text-slate-400">
                Showing {filteredSilos.length} of {allRows.length} silos
              </div>
            </div>
          </div>

          {/* Data Table */}
          <div className="p-6">
            <div className="rounded-md border border-slate-700/30 light:border-gray-200">
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-700/30 light:border-gray-200 hover:bg-slate-800/50 light:hover:bg-gray-50">
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        aria-label="Select all shown silos"
                        className="h-4 w-4 accent-cyan-500 cursor-pointer"
                        checked={selection.allSelected}
                        onChange={selection.toggleAll}
                        disabled={filteredSilos.length === 0}
                      />
                    </TableHead>
                    <TableHead className="text-white light:text-gray-900 font-semibold">
                      Silo Name
                    </TableHead>
                    <TableHead className="text-white light:text-gray-900 font-semibold">
                      Material Name
                    </TableHead>
                    <TableHead className="text-white light:text-gray-900 font-semibold">
                      Material Code
                    </TableHead>
                    <TableHead className="text-white light:text-gray-900 font-semibold">
                      Quantity (KG)
                    </TableHead>
                    <TableHead className="text-white light:text-gray-900 font-semibold">
                      High Level
                    </TableHead>
                    <TableHead className="text-white light:text-gray-900 font-semibold">
                      Lock Status
                    </TableHead>
                    <TableHead className="text-white light:text-gray-900 font-semibold">
                      Status
                    </TableHead>
                    <TableHead className="text-white light:text-gray-900 font-semibold w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredSilos.map((silo, index) => {
                    const isEven = index % 2 === 0;
                    const hasMaterial = silo.material_code || silo.material_name;
                    const isActive = hasMaterial || silo.hl_active || silo.lock_active;
                    
                    return (
                      <TableRow
                        key={`${silo.dbSource}-${silo.bin_name}-${index}`}
                        className={`border-slate-700/30 light:border-gray-200 transition-colors ${
                          isEven 
                            ? "bg-slate-800/20 light:bg-white hover:bg-slate-700/30 light:hover:bg-gray-50" 
                            : "bg-slate-900/20 light:bg-blue-50/20 hover:bg-slate-700/30 light:hover:bg-blue-50/40"
                        }`}
                      >
                        <TableCell>
                          <input
                            type="checkbox"
                            aria-label={`Select ${silo.bin_name}`}
                            className="h-4 w-4 accent-cyan-500 cursor-pointer"
                            checked={selection.selected.has(siloKey(silo))}
                            onChange={() => selection.toggle(siloKey(silo))}
                          />
                        </TableCell>
                        <TableCell className="text-white light:text-gray-900 font-medium">
                          {silo.bin_name}
                        </TableCell>
                        <TableCell className="text-slate-300 light:text-gray-700">
                          {silo.material_name || "—"}
                        </TableCell>
                        <TableCell className="text-slate-300 light:text-gray-700">
                          {silo.material_code || "—"}
                        </TableCell>
                        <TableCell className="text-slate-300 light:text-gray-700 tabular-nums">
                          {(silo.quantity_kg ?? 0).toLocaleString(undefined, {
                            maximumFractionDigits: 1,
                            minimumFractionDigits: 0,
                          })}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                              silo.hl_active
                                ? "text-orange-400 light:text-orange-600 bg-orange-500/10 light:bg-orange-100"
                                : "text-gray-400 light:text-gray-600 bg-gray-500/10 light:bg-gray-100"
                            }`}
                          >
                            {silo.isTemp ? "—" : silo.hl_active ? "HIGH" : "NORMAL"}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                              silo.lock_active
                                ? "text-red-400 light:text-red-600 bg-red-500/10 light:bg-red-100"
                                : silo.isTemp
                                  ? "text-gray-400 light:text-gray-600 bg-gray-500/10 light:bg-gray-100"
                                  : "text-green-400 light:text-green-600 bg-green-500/10 light:bg-green-100"
                            }`}
                          >
                            {silo.isTemp ? "—" : silo.lock_active ? "LOCKED" : "UNLOCKED"}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                              isActive
                                ? "text-green-400 light:text-green-600 bg-green-500/10 light:bg-green-100"
                                : "text-gray-400 light:text-gray-600 bg-gray-500/10 light:bg-gray-100"
                            }`}
                          >
                            {isActive ? "ACTIVE" : silo.isTemp ? "FREE" : "EMPTY"}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          {silo.isTemp && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-xs border-cyan-600 text-cyan-400 light:text-blue-700 light:border-blue-300 hover:bg-cyan-600/20"
                              onClick={() => setEditTempSilo(silo.silo_no ?? null)}
                              data-testid={`temp-edit-${silo.silo_no}`}
                            >
                              <Pencil className="h-3 w-3 mr-1" />
                              Edit
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>

        <TempSiloDialog
          open={editTempSilo != null}
          onOpenChange={(o) => { if (!o) setEditTempSilo(null); }}
          siloNo={editTempSilo}
          onSaved={() => { void loadTempSilos(); }}
        />
      </div>
    </WaterSystemLayout>
  );
}
