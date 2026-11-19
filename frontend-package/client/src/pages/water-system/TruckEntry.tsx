import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { WaterSystemLayout } from "../../components/water-system/WaterSystemLayout";
import {
  ArrowUpFromLine,
  BarChart3,
  Crosshair,
  ClipboardList,
  FileSpreadsheet,
  Hourglass,
  Layers,
  MapPin,
  Package,
  Printer,
  RefreshCw,
  Scale,
  Trash2,
  Truck,
  User,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { API_BASE_URL } from "../../config/api";
import { useMaterialCodes } from "../../constants/materialCodes";
import truck3 from "@/assets/truck3.png";
import { TempSiloDialog } from "../../components/water-system/TempSiloDialog";
import { SearchableSelect } from "../../components/water-system/SearchableSelect";
import { fetchWeighbridgeOrders, type WeighbridgeOrder } from "../../api/weighbridgeOrders";
import { printTable } from "../../utils/printTable";
import { exportTableToExcel, type ExportColumn } from "../../utils/exportTable";
import {
  createTruckWeighOrder,
  deleteTruckWeighOrder,
  fetchAllDrivers,
  fetchCompletedToday,
  fetchOpenOrders,
  fetchScaleLive,
  fetchSilosForMaterial,
  fetchTruckWeighOrder,
  saveFirstWeight,
  saveSecondWeight,
  type DriverOption,
  type ScaleLiveReading,
  type SilosForMaterial,
  type SiloOption,
  type TruckWeighOrder,
} from "../../api/truckEntry";

interface TruckOption {
  id: number;
  license: string;
  model: string;
  capacity?: string;
}

function fmtTime(ts?: string | null) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return "—";
  }
}

function fmtWeight(kg: number | null | undefined) {
  if (kg == null || Number.isNaN(kg)) return "—";
  return kg.toLocaleString(undefined, { maximumFractionDigits: 0, minimumFractionDigits: 0 });
}

const NO_SILOS: SilosForMaterial = { matching: [], unassigned: [], tempMatching: [], tempFree: [] };

function siloLabel(s: SiloOption) {
  const name = s.materialName ? ` — ${s.materialName}` : "";
  return `Silo ${s.siloNo}${name} — ${fmtWeight(s.quantityKg)} kg`;
}

function rowTimestamp(o: TruckWeighOrder) {
  return o.second_ts || o.first_ts || o.created_at || "";
}

export default function TruckEntry() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [truckData, setTruckData] = useState<TruckOption[]>([]);
  const [openOrders, setOpenOrders] = useState<TruckWeighOrder[]>([]);
  const [completedToday, setCompletedToday] = useState<TruckWeighOrder[]>([]);
  const [activeOrder, setActiveOrder] = useState<TruckWeighOrder | null>(null);

  const [newTruckId, setNewTruckId] = useState("");
  const [newMaterialCode, setNewMaterialCode] = useState("");
  const [newSiloNo, setNewSiloNo] = useState("");
  // Weighbridge order (optional): gives the trip its product, client and ordered quantity.
  const [newOrderNo, setNewOrderNo] = useState("");
  // Driver (from Management > Drivers) and loading point 1-3, both optional.
  const [newDriverId, setNewDriverId] = useState("");
  const [newLoadingPoint, setNewLoadingPoint] = useState("");
  const [drivers, setDrivers] = useState<DriverOption[]>([]);
  const [wbOrders, setWbOrders] = useState<WeighbridgeOrder[]>([]);
  const [silos, setSilos] = useState<SilosForMaterial>(NO_SILOS);
  const [silosState, setSilosState] = useState<"idle" | "loading" | "error">("idle");
  const [silosReload, setSilosReload] = useState(0);
  const [tempDialogOpen, setTempDialogOpen] = useState(false);
  const [newEntryFormKey, setNewEntryFormKey] = useState(0);

  const [liveReading, setLiveReading] = useState<ScaleLiveReading | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [livePolling, setLivePolling] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TruckWeighOrder | null>(null);

  const selectableMaterials = useMaterialCodes();

  const outPendingOrders = useMemo(
    () => openOrders.filter((o) => o.status === "awaiting_second"),
    [openOrders]
  );
  const awaitingFirstOrders = useMemo(
    () => openOrders.filter((o) => o.status === "awaiting_first"),
    [openOrders]
  );
  const awaitingFirstCount = awaitingFirstOrders.length;

  const busyTruckIds = useMemo(
    () => new Set(openOrders.map((o) => o.truck_id)),
    [openOrders]
  );

  /** Trucks already on site (open trip) stay hidden until exit completes */
  const availableTrucks = useMemo(
    () => truckData.filter((t) => !busyTruckIds.has(t.id)),
    [truckData, busyTruckIds]
  );

  // When a trip is open its truck is no longer "available", but the field must still show it.
  const truckOptions = useMemo(() => {
    const list = availableTrucks.slice();
    const current = truckData.find((t) => String(t.id) === newTruckId);
    if (current && !list.some((t) => t.id === current.id)) list.unshift(current);
    return list.map((t) => ({
      value: String(t.id),
      label: `${t.license}${t.model ? ` — ${t.model}` : ""}`,
    }));
  }, [availableTrucks, truckData, newTruckId]);
  const orderOptions = useMemo(
    () => [
      { value: "", label: "No order" },
      ...wbOrders
        .slice()
        .sort((a, b) => a.order_no - b.order_no)
        .map((o) => ({
          value: String(o.order_no),
          label: `${o.order_no} — ${o.product_code} ${o.product_name} — ${fmtWeight(o.quantity_kg)} kg — ${o.client_name}`,
        })),
    ],
    [wbOrders]
  );
  const selectedOrder = wbOrders.find((o) => String(o.order_no) === newOrderNo) ?? null;

  const driverOptions = useMemo(
    () => [
      { value: "", label: "No driver" },
      ...drivers.map((d) => ({
        value: String(d.id),
        label: `${d.id} — ${d.name}${d.license_no ? ` — ${d.license_no}` : ""}`,
      })),
    ],
    [drivers]
  );
  const selectedDriver = drivers.find((d) => String(d.id) === newDriverId) ?? null;
  const loadingPointOptions = useMemo(
    () => [
      { value: "", label: "No loading point" },
      { value: "1", label: "Loading point 1" },
      { value: "2", label: "Loading point 2" },
      { value: "3", label: "Loading point 3" },
    ],
    []
  );

  const materialOptions = useMemo(
    () => selectableMaterials.map((m) => ({ value: m.code, label: `${m.code} — ${m.name}` })),
    [selectableMaterials]
  );

  const isEntryPhase = activeOrder?.status === "awaiting_first";
  const isExitPhase = activeOrder?.status === "awaiting_second";

  const selectedTruck = truckData.find((t) => String(t.id) === newTruckId);
  const selectedMaterial = selectableMaterials.find((m) => m.code === newMaterialCode);
  const selectedSilo = [
    ...silos.matching,
    ...silos.unassigned,
    ...silos.tempMatching,
    ...silos.tempFree,
  ].find(
    (s) => String(s.siloNo) === newSiloNo
  );

  // Silo choices follow the chosen material.
  useEffect(() => {
    if (!newMaterialCode) {
      setSilos(NO_SILOS);
      setSilosState("idle");
      return;
    }
    const ctrl = new AbortController();
    setSilosState("loading");
    fetchSilosForMaterial(newMaterialCode, ctrl.signal)
      .then((r) => {
        setSilos(r);
        setSilosState("idle");
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name === "AbortError") return;
        setSilos(NO_SILOS);
        setSilosState("error");
      });
    return () => ctrl.abort();
  }, [newMaterialCode, silosReload]);

  /** New entry ready: truck + material chosen — live Scale 1 before capture */
  const readyForNewEntry = Boolean(newTruckId && newMaterialCode) && !isExitPhase;

  const activeScaleId: 1 | 2 | null = useMemo(() => {
    if (isExitPhase) return 2;
    if (isEntryPhase) return 1;
    if (readyForNewEntry) return 1;
    return null;
  }, [isExitPhase, isEntryPhase, readyForNewEntry]);

  const previewTruck = useMemo(() => {
    if (activeOrder) {
      return (
        truckData.find((t) => t.id === activeOrder.truck_id) ?? {
          id: activeOrder.truck_id,
          license: activeOrder.truck_plate ?? `Truck ${activeOrder.truck_id}`,
          model: "",
        }
      );
    }
    return selectedTruck ?? null;
  }, [activeOrder, truckData, selectedTruck]);

  const previewMaterialName = activeOrder
    ? activeOrder.material_name || activeOrder.material_code
    : selectedMaterial?.name || selectedMaterial?.code || null;

  const previewPlate =
    activeOrder?.truck_plate ?? previewTruck?.license ?? null;

  const liveKg = liveReading?.ok ? liveReading.weight_kg : null;
  const grossKg = liveKg;
  const tareKg = isExitPhase ? activeOrder?.first_weight_kg ?? null : null;
  const netKg =
    grossKg != null && tareKg != null ? Math.round(grossKg - tareKg) : null;

  const scaleLive = Boolean(activeScaleId && liveReading?.ok);
  const motionDetected = scaleLive && liveReading && !liveReading.stable;
  const scaleStable = scaleLive && Boolean(liveReading?.stable);

  /** Open trips only — completed cycles appear on Weighbridge Log */
  const openTripRows = useMemo(() => {
    return [...openOrders].sort((a, b) => {
      const ta = new Date(rowTimestamp(a)).getTime() || 0;
      const tb = new Date(rowTimestamp(b)).getTime() || 0;
      return tb - ta;
    });
  }, [openOrders]);

  const refreshData = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const [open, today] = await Promise.all([
        fetchOpenOrders(signal),
        fetchCompletedToday(undefined, signal),
      ]);
      setOpenOrders(open);
      setCompletedToday(today.rows ?? []);
      // Open weighbridge orders for the Order Number field. The page works without them.
      fetchWeighbridgeOrders("open", signal)
        .then((r) => setWbOrders(r.orders))
        .catch(() => undefined);
      fetchAllDrivers(signal)
        .then(setDrivers)
        .catch(() => undefined);
      setActiveOrder((prev) => {
        if (!prev) return null;
        return open.find((o) => o.id === prev.id) ?? null;
      });
    } catch (err: unknown) {
      // Navigating away aborts these fetches — that is not an error to show.
      if ((err as { name?: string })?.name === "AbortError") return;
      setErrorMsg(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  const fetchTrucks = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/trucks/`);
      const data = await res.json();
      setTruckData(Array.isArray(data) ? data : data?.items ?? []);
    } catch {
      setTruckData([]);
    }
  }, []);

  useEffect(() => {
    // Abort the initial /open + /today loads if the operator navigates away
    // before they resolve (these can take seconds on a loaded backend).
    const controller = new AbortController();
    fetchTrucks();
    void refreshData(controller.signal);
    return () => controller.abort();
  }, [fetchTrucks, refreshData]);

  // Drop selection if truck became busy (open trip)
  useEffect(() => {
    if (newTruckId && busyTruckIds.has(Number(newTruckId))) {
      setNewTruckId("");
      setNewEntryFormKey((k) => k + 1);
    }
  }, [busyTruckIds, newTruckId]);

  useEffect(() => {
    if (!activeScaleId) {
      setLiveReading(null);
      setLiveError(null);
      setLivePolling(false);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      setLivePolling(true);
      try {
        const reading = await fetchScaleLive(activeScaleId);
        if (cancelled) return;
        setLiveReading(reading);
        setLiveError(reading.ok ? null : reading.error || "Scale unreachable");
      } catch (err: unknown) {
        if (cancelled) return;
        setLiveReading(null);
        setLiveError(err instanceof Error ? err.message : "Scale read failed");
      } finally {
        if (!cancelled) {
          setLivePolling(false);
          timer = setTimeout(poll, 1000);
        }
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeScaleId]);

  /** Start exit weigh on Scale 2 for a truck that already has entry weight */
  function startTruckExit(order: TruckWeighOrder) {
    if (order.status !== "awaiting_second") return;
    setActiveOrder(order);
    setErrorMsg(null);
    setMessage(
      `Exit weigh for ${order.truck_plate ?? `Truck ${order.truck_id}`} — place on Scale 2, wait for STABLE, then Capture Exit.`
    );
  }

  /** Resume / start entry weigh on Scale 1 */
  function startTruckEntry(order: TruckWeighOrder) {
    if (order.status !== "awaiting_first") return;
    setActiveOrder(order);
    setErrorMsg(null);
    setMessage(
      `Entry weigh for ${order.truck_plate ?? `Truck ${order.truck_id}`} — place on Scale 1, wait for STABLE, then Capture Weight.`
    );
  }

  function clearActiveOrder() {
    setActiveOrder(null);
  }

  async function confirmDeleteOrder() {
    if (!deleteTarget) return;
    const order = deleteTarget;
    const plate = order.truck_plate ?? `Truck ${order.truck_id}`;

    setLoading(true);
    setErrorMsg(null);
    setMessage(null);
    setDeleteTarget(null);
    try {
      await deleteTruckWeighOrder(order.id);
      if (activeOrder?.id === order.id) clearActiveOrder();
      setMessage(`Trip ${order.ticket} deleted — ${plate} is free for a new entry.`);
      await refreshData();
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to delete trip");
    } finally {
      setLoading(false);
    }
  }

  function resetNewEntryForm() {
    setNewTruckId("");
    setNewMaterialCode("");
    setNewSiloNo("");
    setNewOrderNo("");
    setNewDriverId("");
    setNewLoadingPoint("");
    setNewEntryFormKey((k) => k + 1);
  }

  /** Single action: create trip (if needed) + save entry weight, or save exit weight */
  async function handleCaptureAndSave() {
    const w = liveReading?.weight_kg;
    if (w == null || w <= 0) {
      setErrorMsg("Wait for a live scale reading before capturing.");
      return;
    }
    if (!liveReading?.stable) {
      setErrorMsg("Scale is unstable — wait until STABLE, then capture.");
      return;
    }
    const rounded = Math.round(w * 10) / 10;

    // ── EXIT ──
    if (isExitPhase && activeOrder) {
      setLoading(true);
      setErrorMsg(null);
      setMessage(null);
      try {
        const updated = await saveSecondWeight(activeOrder.id, rounded);
        setMessage(
          `Trip completed. NET = ${Math.round(updated.net_kg ?? 0)} kg — see Weighbridge Log.`
        );
        clearActiveOrder();
        await refreshData();
      } catch (err: unknown) {
        setErrorMsg(err instanceof Error ? err.message : "Failed to save exit weight");
      } finally {
        setLoading(false);
      }
      return;
    }

    // ── ENTRY: one click create + capture (or capture if trip already open) ──
    setLoading(true);
    setErrorMsg(null);
    setMessage(null);
    try {
      let order = activeOrder?.status === "awaiting_first" ? activeOrder : null;

      if (!order) {
        const truckId = Number(newTruckId);
        if (!truckId || !newMaterialCode) {
          setErrorMsg("Select a truck and material.");
          setLoading(false);
          return;
        }
        if (!newSiloNo) {
          setErrorMsg("Select a silo.");
          setLoading(false);
          return;
        }
        try {
          order = await createTruckWeighOrder(
            truckId,
            newMaterialCode,
            Number(newSiloNo),
            newOrderNo ? Number(newOrderNo) : null,
            newDriverId ? Number(newDriverId) : null,
            newLoadingPoint ? Number(newLoadingPoint) : null
          );
        } catch (err: unknown) {
          const conflict = err as Error & { code?: string; orderId?: number };
          if (conflict?.code === "OPEN_ORDER" && conflict.orderId) {
            const existing = await fetchTruckWeighOrder(conflict.orderId);
            if (existing.status === "awaiting_second") {
              setActiveOrder(existing);
              resetNewEntryForm();
              setMessage(
                `Open trip ${existing.ticket} needs exit — use Truck Exit, then Capture Exit.`
              );
              setLoading(false);
              await refreshData();
              return;
            }
            order = existing;
          } else {
            throw err;
          }
        }
      }

      await saveFirstWeight(order.id, rounded);
      clearActiveOrder();
      resetNewEntryForm();
      setMessage(
        `Entry ${fmtWeight(rounded)} kg saved for ${order.truck_plate ?? `Truck ${order.truck_id}`}. Use Truck Exit when ready.`
      );
      await refreshData();
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to capture entry weight");
    } finally {
      setLoading(false);
    }
  }

  const canCapture =
    !loading &&
    Boolean(liveReading?.ok) &&
    Boolean(liveReading?.stable) &&
    liveReading?.weight_kg != null &&
    liveReading.weight_kg > 0 &&
    (isExitPhase || isEntryPhase || readyForNewEntry);

  const showTruckVisual = Boolean(previewTruck || activeOrder);
  const showInMode = !isExitPhase;

  // Print / Excel of the Open Trips table: same rows and columns as shown, without the Action column.
  function openTripsTable() {
    const exitKgOf = (row: TruckWeighOrder) =>
      activeOrder?.id === row.id && isExitPhase && liveKg != null ? liveKg : row.second_weight_kg ?? null;
    const raw = (n?: number | null) => (n != null && !Number.isNaN(n) ? Math.round(n) : null);
    const statusText = (row: TruckWeighOrder) =>
      activeOrder?.id === row.id && activeScaleId
        ? "On Scale"
        : row.status === "awaiting_second"
          ? "Exit Pending"
          : "Entry Pending";
    const columns: ExportColumn<TruckWeighOrder>[] = [
      { header: "Time", cell: (r) => fmtTime(rowTimestamp(r)) },
      { header: "Order", cell: (r) => (r.order_no != null ? r.order_no : "—") },
      { header: "Truck No", cell: (r) => r.truck_plate ?? `Truck ${r.truck_id}` },
      { header: "Material", cell: (r) => r.material_name ?? r.material_code },
      {
        header: "Silo",
        cell: (r) =>
          r.silo_no != null
            ? `Silo ${r.silo_no}${r.silo_no >= 1001 && r.silo_no <= 1200 ? " (temp)" : ""}`
            : "—",
      },
      { header: "Type", cell: (r) => (r.status === "awaiting_first" ? "IN" : "OUT") },
      { header: "Entry Weight (kg)", cell: (r) => fmtWeight(r.first_weight_kg ?? null), excel: (r) => raw(r.first_weight_kg), numeric: true },
      { header: "Exit Weight (kg)", cell: (r) => fmtWeight(exitKgOf(r)), excel: (r) => raw(exitKgOf(r)), numeric: true },
      { header: "Status", cell: statusText },
    ];
    const subtitles = [`${openTripRows.length} open trip${openTripRows.length === 1 ? "" : "s"}`];
    return { columns, subtitles };
  }

  async function handleOpenTripsPrint() {
    const t = openTripsTable();
    const err = await printTable({
      title: "Open Trips — On Site",
      subtitles: t.subtitles,
      columns: t.columns,
      rows: openTripRows,
      landscape: true,
    });
    if (err) setErrorMsg(err);
  }

  async function handleOpenTripsExcel() {
    const t = openTripsTable();
    const err = await exportTableToExcel({
      title: "Open Trips — On Site",
      subtitles: t.subtitles,
      columns: t.columns,
      rows: openTripRows,
      filename: "open-trips",
      sheetName: "Open Trips",
    });
    if (err) setErrorMsg(err);
  }

  function statusBadge(row: TruckWeighOrder) {
    if (activeOrder?.id === row.id && activeScaleId) {
      return (
        <span className="wb-badge wb-badge-cyan">
          <span className="wb-badge-dot" /> On Scale
        </span>
      );
    }
    if (row.status === "awaiting_second") {
      return (
        <span className="wb-badge wb-badge-amber">
          <span className="wb-badge-dot" /> Exit Pending
        </span>
      );
    }
    return (
      <span className="wb-badge wb-badge-amber">
        <span className="wb-badge-dot" /> Entry Pending
      </span>
    );
  }

  return (
    <WaterSystemLayout
      title="Weighbridge Entry"
      subtitle="Scale 1 for entry · Scale 2 for exit — live capture from Baykon indicators"
    >
      <div className="wb-console space-y-4">
        {(message || errorMsg) && (
          <div className="text-sm px-0.5">
            {message && <span className="text-[#19D37E] light:text-green-700">{message}</span>}
            {errorMsg && <span className="text-[#FF4D5E] light:text-red-600 ml-3">{errorMsg}</span>}
          </div>
        )}

        {/* ── KPI row ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiTile
            label="Out Pending"
            value={outPendingOrders.length}
            unit={outPendingOrders.length === 1 ? "Truck" : "Trucks"}
            icon={<Truck className="h-4 w-4" />}
            tone="cyan"
          />
          <KpiTile
            label="Awaiting Weight"
            value={awaitingFirstCount}
            unit={awaitingFirstCount === 1 ? "Truck" : "Trucks"}
            icon={<Hourglass className="h-4 w-4" />}
            tone="amber"
          />
          <KpiTile
            label="On Scale"
            value={activeScaleId ? 1 : 0}
            unit="Truck"
            icon={<Scale className="h-4 w-4" />}
            tone="cyan"
          />
          <KpiTile
            label="Today Entries"
            value={completedToday.length}
            unit="Total"
            icon={<BarChart3 className="h-4 w-4" />}
            tone="cyan"
          />
        </div>

        {/* ── NEW ENTRY ── */}
        <section className="wb-panel p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="h-1.5 w-1.5 rounded-full bg-[#00D9FF]" />
            <div>
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] wb-text">
                New Entry
              </h2>
              <p className="text-[11px] wb-text-muted mt-0.5">
                Select truck and material — live Scale 1 weight appears, then Capture Entry
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-auto h-8 bg-transparent border wb-border wb-text-sec hover:opacity-90 light:border-gray-300 light:bg-white"
              onClick={() => setTempDialogOpen(true)}
              data-testid="open-temp-silos"
            >
              <Layers className="h-3.5 w-3.5 mr-1.5" />
              Temporary silos
            </Button>
          </div>

          <div
            key={newEntryFormKey}
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 gap-3 items-end"
          >
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider wb-text-sec">
                Order Number (optional)
              </label>
              <SearchableSelect
                value={newOrderNo}
                onChange={(v) => {
                  setNewOrderNo(v);
                  const o = wbOrders.find((x) => String(x.order_no) === v);
                  if (o) {
                    // The order decides the material.
                    setNewMaterialCode(o.product_code);
                    setNewSiloNo("");
                  }
                  if (activeOrder?.status === "awaiting_first") clearActiveOrder();
                }}
                options={orderOptions}
                placeholder="Type order number"
                disabled={isExitPhase}
                icon={<ClipboardList className="h-3.5 w-3.5" />}
                testId="select-order"
                listMinWidth={520}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider wb-text-sec">
                Select Truck
              </label>
              <SearchableSelect
                value={newTruckId}
                onChange={(v) => {
                  setNewTruckId(v);
                  // Propose the driver assigned to this truck; the operator can change it.
                  const usual =
                    drivers.find((d) => String(d.truck_id) === v && d.status === "Active") ??
                    drivers.find((d) => String(d.truck_id) === v);
                  setNewDriverId(usual ? String(usual.id) : "");
                  if (activeOrder?.status === "awaiting_first") clearActiveOrder();
                }}
                options={truckOptions}
                placeholder="Select or type truck plate"
                emptyText="No free trucks — all have open trips"
                disabled={isExitPhase}
                icon={<Truck className="h-3.5 w-3.5" />}
                testId="select-truck"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider wb-text-sec">
                Select Material
              </label>
              <SearchableSelect
                value={newMaterialCode}
                onChange={(v) => {
                  setNewMaterialCode(v);
                  setNewSiloNo("");
                  if (activeOrder?.status === "awaiting_first") clearActiveOrder();
                }}
                options={materialOptions}
                placeholder="Select or type material"
                disabled={isExitPhase || Boolean(selectedOrder)}
                icon={<Package className="h-3.5 w-3.5" />}
                testId="select-material"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider wb-text-sec">
                Select Silo
              </label>
              <Select
                value={newSiloNo || undefined}
                onValueChange={(v) => {
                  setNewSiloNo(v);
                  if (activeOrder?.status === "awaiting_first") clearActiveOrder();
                }}
                disabled={isExitPhase || !newMaterialCode}
              >
                <SelectTrigger className="wb-input h-12 wb-text">
                  <SelectValue placeholder={newMaterialCode ? "Select silo" : "Select material first"} />
                </SelectTrigger>
                <SelectContent className="wb-select-content wb-text max-h-60">
                  {silosState === "loading" && (
                    <div className="px-3 py-2 text-xs wb-text-muted">Loading silos…</div>
                  )}
                  {silosState === "error" && (
                    <div className="px-3 py-2 text-xs wb-text-muted">Could not load silos</div>
                  )}
                  {silosState === "idle" &&
                    silos.matching.length === 0 &&
                    silos.unassigned.length === 0 &&
                    silos.tempMatching.length === 0 &&
                    silos.tempFree.length === 0 && (
                      <div className="px-3 py-2 text-xs wb-text-muted">No suitable silos</div>
                    )}
                  {silos.matching.length > 0 && (
                    <SelectGroup>
                      <SelectLabel className="text-[10px] uppercase tracking-wider wb-text-muted">
                        Silos holding this material
                      </SelectLabel>
                      {silos.matching.map((s) => (
                        <SelectItem key={s.siloNo} value={String(s.siloNo)}>
                          {siloLabel(s)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  {silos.unassigned.length > 0 && (
                    <SelectGroup>
                      <SelectLabel className="text-[10px] uppercase tracking-wider wb-text-muted">
                        Unassigned silos
                      </SelectLabel>
                      {silos.unassigned.map((s) => (
                        <SelectItem key={s.siloNo} value={String(s.siloNo)}>
                          {siloLabel(s)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  {silos.tempMatching.length > 0 && (
                    <SelectGroup>
                      <SelectLabel className="text-[10px] uppercase tracking-wider wb-text-muted">
                        Temporary silos holding this material
                      </SelectLabel>
                      {silos.tempMatching.map((s) => (
                        <SelectItem key={s.siloNo} value={String(s.siloNo)}>
                          {siloLabel(s)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  {silos.tempFree.length > 0 && (
                    <SelectGroup>
                      <SelectLabel className="text-[10px] uppercase tracking-wider wb-text-muted">
                        Free temporary silos (ground)
                      </SelectLabel>
                      {silos.tempFree.map((s) => (
                        <SelectItem key={s.siloNo} value={String(s.siloNo)}>
                          {`Silo ${s.siloNo} — free`}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider wb-text-sec">
                Driver (optional)
              </label>
              <SearchableSelect
                value={newDriverId}
                onChange={(v) => {
                  setNewDriverId(v);
                  if (activeOrder?.status === "awaiting_first") clearActiveOrder();
                }}
                options={driverOptions}
                placeholder="Type driver number or name"
                disabled={isExitPhase}
                icon={<User className="h-3.5 w-3.5" />}
                testId="select-driver"
                listMinWidth={340}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider wb-text-sec">
                Loading Point (optional)
              </label>
              <SearchableSelect
                value={newLoadingPoint}
                onChange={(v) => {
                  setNewLoadingPoint(v);
                  if (activeOrder?.status === "awaiting_first") clearActiveOrder();
                }}
                options={loadingPointOptions}
                placeholder="1, 2 or 3"
                disabled={isExitPhase}
                icon={<MapPin className="h-3.5 w-3.5" />}
                testId="select-loading-point"
              />
            </div>
          </div>
        </section>

        {/* ── MAIN WORKSPACE ── */}
        <div className="grid grid-cols-1 xl:grid-cols-[1.65fr_1fr] gap-4">
          {/* Truck Preview */}
          <section className="wb-panel overflow-hidden flex flex-col min-h-[340px]">
            <div className="px-4 py-3 flex flex-wrap items-center justify-between gap-2 border-b wb-border">
              <div>
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] wb-text">
                  Truck Preview
                </h2>
                <p className="text-[10px] wb-text-muted mt-0.5">Live vehicle position</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {previewPlate && (
                  <span className="wb-chip">
                    Truck <strong>{previewPlate}</strong>
                  </span>
                )}
                {previewMaterialName && (
                  <span className="wb-chip">
                    Material <strong className="truncate max-w-[140px]">{previewMaterialName}</strong>
                  </span>
                )}
                {activeScaleId ? (
                  motionDetected ? (
                    <span className="wb-badge wb-badge-amber">
                      <span className="wb-badge-dot animate-pulse" /> Motion Detected
                    </span>
                  ) : scaleStable ? (
                    <span className="wb-badge wb-badge-ok">
                      <span className="wb-badge-dot" /> Weight Stable
                    </span>
                  ) : (
                    <span className="wb-badge wb-badge-cyan">
                      <span className="wb-badge-dot" /> On Scale
                    </span>
                  )
                ) : null}
              </div>
            </div>

            <div className="relative flex-1 wb-stage min-h-[280px] flex items-center justify-center">
              {showTruckVisual ? (
                <img
                  src={truck3}
                  alt="Truck on weighbridge"
                  className="max-h-[320px] w-full object-contain object-center px-2 py-4"
                />
              ) : (
                <div className="text-center px-6 py-16 space-y-3">
                  <div className="mx-auto h-12 w-12 rounded-lg border wb-border flex items-center justify-center wb-text-cyan opacity-70">
                    <Truck className="h-6 w-6" />
                  </div>
                  <p className="text-sm font-medium tracking-wide wb-text-sec uppercase">
                    Select a truck to begin
                  </p>
                  <p className="text-xs wb-text-muted">
                    Choose truck and material above, then create entry
                  </p>
                </div>
              )}

              {activeScaleId && (
                <div className="absolute bottom-3 left-3 flex items-center gap-2 text-[10px] wb-text-sec">
                  {livePolling || liveReading?.ok ? (
                    <Wifi className="h-3 w-3 text-[#19D37E]" />
                  ) : (
                    <WifiOff className="h-3 w-3 text-[#FF4D5E]" />
                  )}
                  Scale {activeScaleId}
                  {liveReading?.ip ? ` · ${liveReading.ip}` : ""}
                </div>
              )}
            </div>
          </section>

          {/* Right column */}
          <div className="flex flex-col gap-4 min-h-0">
            {/* Live weight */}
            <section
              className={`wb-panel p-4 ${
                activeScaleId ? "wb-panel-active" : ""
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] wb-text">
                  Live Weight Reading
                </h2>
                <span className="rounded border wb-border px-2 py-0.5 text-[10px] font-semibold uppercase wb-text-sec">
                  kg
                </span>
              </div>

              <div className="flex gap-4 items-center">
                <div className="flex-1 min-w-0">
                  {liveError && activeScaleId && !liveReading?.ok ? (
                    <div className="space-y-1">
                      <p className="text-[#FF4D5E] text-sm font-medium">Scale connection lost</p>
                      <p className="text-[11px] wb-text-muted break-all">{liveError}</p>
                    </div>
                  ) : (
                    <div
                      className={`text-[40px] md:text-[48px] leading-none font-semibold tabular-nums tracking-tight ${
                        activeScaleId
                          ? "wb-weight-live drop-shadow-[0_0_18px_rgba(0,217,255,0.25)] light:drop-shadow-none"
                          : "wb-weight-idle"
                      }`}
                    >
                      {activeScaleId ? fmtWeight(liveKg) : "— — —"}
                    </div>
                  )}
                  {activeScaleId && (
                    <div className="mt-2">
                      {scaleStable ? (
                        <span className="wb-badge wb-badge-ok">
                          <span className="wb-badge-dot" /> Stable
                        </span>
                      ) : motionDetected ? (
                        <span className="wb-badge wb-badge-amber">
                          <span className="wb-badge-dot animate-pulse" /> Motion
                        </span>
                      ) : (
                        <span className="text-[10px] wb-text-muted uppercase tracking-wider">
                          Waiting for reading…
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <div className="w-[96px] shrink-0 space-y-2.5 border-l wb-border pl-3">
                  {(
                    [
                      ["Gross", grossKg],
                      ["Tare", tareKg],
                      ["Net", netKg],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label}>
                      <div className="text-[9px] uppercase tracking-wider wb-text-muted">
                        {label}
                      </div>
                      <div className="text-sm font-semibold tabular-nums wb-text">
                        {fmtWeight(value)}
                        {value != null ? (
                          <span className="text-[10px] wb-text-muted ml-0.5">kg</span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* Entry details */}
            <section className="wb-panel p-4 flex-1 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] wb-text">
                  Entry Details
                </h2>
                {activeOrder && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearActiveOrder}
                    className="h-7 text-[11px] wb-text-sec hover:opacity-90"
                  >
                    Clear
                  </Button>
                )}
              </div>

              {activeOrder && (
                <p className="text-[10px] font-mono wb-text-muted truncate">
                  {activeOrder.ticket}
                </p>
              )}

              {(activeOrder ? activeOrder.order_no != null : Boolean(selectedOrder)) && (
                <div className="space-y-1.5" data-testid="entry-order">
                  <label className="text-[10px] uppercase tracking-wider wb-text-sec">
                    Order
                  </label>
                  <div className="wb-input px-3 py-2 text-sm wb-text space-y-0.5">
                    <div className="font-semibold">
                      Order {activeOrder ? activeOrder.order_no : selectedOrder?.order_no}
                    </div>
                    <div className="wb-text-sec truncate">
                      Client: {(activeOrder ? activeOrder.order_client_name : selectedOrder?.client_name) || "—"}
                    </div>
                    <div className="wb-text-sec">
                      Ordered: {fmtWeight(activeOrder ? activeOrder.order_quantity_kg : selectedOrder?.quantity_kg)} kg
                    </div>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-wider wb-text-sec">
                  Selected Truck
                </label>
                <div className="wb-input h-10 flex items-center px-3 text-sm wb-text truncate">
                  {activeOrder
                    ? `${activeOrder.truck_plate ?? `Truck ${activeOrder.truck_id}`}${
                        previewTruck?.model ? ` — ${previewTruck.model}` : ""
                      }`
                    : selectedTruck
                      ? `${selectedTruck.license}${selectedTruck.model ? ` — ${selectedTruck.model}` : ""}`
                      : "—"}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-wider wb-text-sec">
                  Selected Material
                </label>
                <div className="wb-input h-10 flex items-center px-3 text-sm wb-text truncate">
                  {activeOrder
                    ? `${activeOrder.material_code}${
                        activeOrder.material_name ? ` — ${activeOrder.material_name}` : ""
                      }`
                    : selectedMaterial
                      ? `${selectedMaterial.code} — ${selectedMaterial.name}`
                      : "—"}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-wider wb-text-sec">
                  Selected Silo
                </label>
                <div className="wb-input h-10 flex items-center px-3 text-sm wb-text truncate">
                  {activeOrder
                    ? activeOrder.silo_no != null
                      ? `Silo ${activeOrder.silo_no}${activeOrder.silo_no >= 1001 && activeOrder.silo_no <= 1200 ? " (temporary)" : ""}`
                      : "—"
                    : selectedSilo
                      ? siloLabel(selectedSilo)
                      : "—"}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2" data-testid="entry-driver-lp">
                <div className="space-y-1.5">
                  <label className="text-[10px] uppercase tracking-wider wb-text-sec">Driver</label>
                  <div className="wb-input h-10 flex items-center px-3 text-sm wb-text truncate">
                    {activeOrder
                      ? activeOrder.driver_name
                        ? `${activeOrder.driver_id} — ${activeOrder.driver_name}`
                        : "—"
                      : selectedDriver
                        ? `${selectedDriver.id} — ${selectedDriver.name}`
                        : "—"}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] uppercase tracking-wider wb-text-sec">Loading Point</label>
                  <div className="wb-input h-10 flex items-center px-3 text-sm wb-text truncate">
                    {activeOrder
                      ? activeOrder.loading_point ?? "—"
                      : newLoadingPoint || "—"}
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <div className="inline-flex rounded-md border wb-border overflow-hidden p-0.5 wb-stage">
                  <span
                    className={`px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wider rounded ${
                      showInMode
                        ? "bg-[#00D9FF]/20 text-[#0e7490] dark:text-[#5CEBFF] light:bg-cyan-100 light:text-cyan-800"
                        : "wb-text-muted"
                    }`}
                  >
                    In
                  </span>
                  <span
                    className={`px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wider rounded ${
                      isExitPhase
                        ? "bg-[#FFB020]/20 text-[#c2410c] dark:text-[#FFB020] light:bg-orange-100 light:text-orange-700"
                        : "wb-text-muted"
                    }`}
                  >
                    Out
                  </span>
                </div>

                <Button
                  className="wb-btn-primary h-10 flex-1 min-w-[160px] gap-2 font-semibold disabled:opacity-40"
                  onClick={handleCaptureAndSave}
                  disabled={!canCapture}
                >
                  <Crosshair className="h-4 w-4" />
                  {loading
                    ? "Saving…"
                    : isExitPhase
                      ? "Capture Exit"
                      : "Capture Entry"}
                </Button>
              </div>

              <p className="text-[10px] wb-text-muted leading-relaxed">
                {isExitPhase
                  ? `Entry ${fmtWeight(activeOrder?.first_weight_kg)} kg · place on Scale 2, wait for STABLE, then Capture Exit.`
                  : readyForNewEntry || isEntryPhase
                    ? "Live Scale 1 weight shown — wait for STABLE, then Capture Entry (creates trip + saves weight)."
                    : "Select truck & material above — live weight starts, then Capture Entry in one click."}
              </p>
            </section>
          </div>
        </div>

        {/* ── OPEN TRIPS (entry / exit in progress) ── */}
        <section className="wb-panel overflow-hidden">
          <div className="px-4 py-3 border-b wb-border flex items-center justify-between gap-3">
            <div>
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] wb-text">
                Open Trips — On Site
              </h2>
              <p className="text-[10px] wb-text-muted mt-0.5">
                Entry &amp; exit in progress. Completed cycles move to Weighbridge Log.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { void refreshData() }}
                disabled={loading}
                className="h-7 gap-1 wb-text-sec hover:opacity-90"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { void handleOpenTripsPrint() }}
                disabled={openTripRows.length === 0}
                className="h-7 gap-1 wb-text-sec hover:opacity-90"
                data-testid="open-trips-print"
              >
                <Printer className="h-3.5 w-3.5" />
                Print
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { void handleOpenTripsExcel() }}
                disabled={openTripRows.length === 0}
                className="h-7 gap-1 wb-text-sec hover:opacity-90"
                data-testid="open-trips-excel"
              >
                <FileSpreadsheet className="h-3.5 w-3.5" />
                Export Excel
              </Button>
              <Link
                href="/fakieh/weighbridge"
                className="text-[11px] font-semibold uppercase tracking-wider wb-text-cyan hover:opacity-80"
              >
                Weighbridge Log →
              </Link>
            </div>
          </div>

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="wb-border hover:bg-transparent wb-table-head">
                  {(
                    [
                      "Time",
                      "Order",
                      "Truck No",
                      "Material",
                      "Silo",
                      "Type",
                      "Entry Weight",
                      "Exit Weight",
                      "Status",
                      "Action",
                    ] as const
                  ).map((h) => (
                    <TableHead
                      key={h}
                      className={`text-[10px] uppercase tracking-wider wb-text-muted h-10 ${
                        h === "Action" ? "text-right" : ""
                      }`}
                    >
                      {["Entry Weight", "Exit Weight"].includes(h) ? `${h} (kg)` : h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {openTripRows.map((row) => {
                  const needsEntry = row.status === "awaiting_first";
                  const needsExit = row.status === "awaiting_second";
                  const type = needsEntry ? "IN" : "OUT";
                  const entryKg = row.first_weight_kg ?? null;
                  const exitKg =
                    activeOrder?.id === row.id && isExitPhase && liveKg != null
                      ? liveKg
                      : row.second_weight_kg ?? null;
                  return (
                    <TableRow
                      key={row.id}
                      className={`wb-border hover:bg-[var(--wb-row-hover)] ${
                        activeOrder?.id === row.id ? "bg-[var(--wb-row-active)]" : ""
                      }`}
                    >
                      <TableCell className="text-xs tabular-nums wb-text-sec py-2.5">
                        {fmtTime(rowTimestamp(row))}
                      </TableCell>
                      <TableCell className="text-sm wb-text-sec py-2.5 tabular-nums">
                        {row.order_no != null ? row.order_no : "—"}
                      </TableCell>
                      <TableCell className="py-2.5">
                        <button
                          type="button"
                          className="text-sm font-medium wb-text-cyan hover:opacity-80"
                          onClick={() =>
                            needsExit ? startTruckExit(row) : startTruckEntry(row)
                          }
                        >
                          {row.truck_plate ?? `Truck ${row.truck_id}`}
                        </button>
                      </TableCell>
                      <TableCell className="text-sm wb-text py-2.5 max-w-[160px] truncate">
                        {row.material_name ?? row.material_code}
                      </TableCell>
                      <TableCell className="text-sm wb-text-sec py-2.5">
                        {row.silo_no != null ? `Silo ${row.silo_no}${row.silo_no >= 1001 && row.silo_no <= 1200 ? " (temp)" : ""}` : "—"}
                      </TableCell>
                      <TableCell className="py-2.5">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ${
                            type === "IN"
                              ? "border-[#00D9FF]/40 wb-text-cyan-bright light:border-cyan-300 light:bg-cyan-50"
                              : "border-[#FFB020]/40 text-[#FFB020] light:border-orange-300 light:text-orange-700 light:bg-orange-50"
                          }`}
                        >
                          {type}
                        </span>
                      </TableCell>
                      <TableCell className="tabular-nums text-sm wb-text py-2.5">
                        {fmtWeight(entryKg)}
                      </TableCell>
                      <TableCell className="tabular-nums text-sm wb-text-sec py-2.5">
                        {fmtWeight(exitKg)}
                      </TableCell>
                      <TableCell className="py-2.5">{statusBadge(row)}</TableCell>
                      <TableCell className="text-right py-2.5">
                        <div className="inline-flex items-center gap-2 justify-end">
                          {needsExit ? (
                            <Button
                              size="sm"
                              className="h-8 gap-1.5 bg-[#FFB020] hover:bg-[#e09a18] text-[#001018] font-semibold light:bg-orange-500 light:hover:bg-orange-600 light:text-white"
                              onClick={() => startTruckExit(row)}
                            >
                              <ArrowUpFromLine className="h-3.5 w-3.5" />
                              Truck Exit
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              className="h-8 gap-1.5 wb-btn-primary font-semibold"
                              onClick={() => startTruckEntry(row)}
                            >
                              Capture Entry
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 px-2 border-[#FF4D5E]/40 text-[#FF4D5E] hover:bg-[#FF4D5E]/10"
                            onClick={() => setDeleteTarget(row)}
                            disabled={loading}
                            title="Cancel trip"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {openTripRows.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={10}
                      className="text-center py-10 wb-text-muted text-sm"
                    >
                      No open trips — create a new entry above. Finished cycles are on Weighbridge
                      Log.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </section>

        <TempSiloDialog
          open={tempDialogOpen}
          onOpenChange={setTempDialogOpen}
          onSaved={() => setSilosReload((n) => n + 1)}
        />

        <AlertDialog
          open={!!deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        >
          <AlertDialogContent className="wb-panel wb-text sm:max-w-md light:bg-white">
            <AlertDialogHeader>
              <div className="mx-auto sm:mx-0 mb-2 h-11 w-11 rounded-full bg-[#FF4D5E]/15 light:bg-red-50 flex items-center justify-center">
                <Trash2 className="h-5 w-5 text-[#FF4D5E]" />
              </div>
              <AlertDialogTitle className="wb-text">Delete open trip?</AlertDialogTitle>
              <AlertDialogDescription className="wb-text-sec space-y-2">
                <span className="block">
                  Remove{" "}
                  <span className="font-mono wb-text">{deleteTarget?.ticket}</span> for{" "}
                  <span className="font-semibold wb-text">
                    {deleteTarget?.truck_plate ??
                      (deleteTarget ? `Truck ${deleteTarget.truck_id}` : "")}
                  </span>
                  .
                </span>
                <span className="block text-xs">
                  The truck will be free for a new weigh entry after this. This cannot be undone.
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="gap-2 sm:gap-0">
              <AlertDialogCancel className="bg-transparent border wb-border wb-text-sec hover:opacity-90 light:border-gray-300 light:bg-white">
                Keep trip
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-[#FF4D5E] hover:bg-[#e04454] text-white"
                onClick={(e) => {
                  e.preventDefault();
                  void confirmDeleteOrder();
                }}
              >
                Delete trip
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </WaterSystemLayout>
  );
}

function KpiTile({
  label,
  value,
  unit,
  icon,
  tone,
}: {
  label: string;
  value: number;
  unit: string;
  icon: React.ReactNode;
  tone: "cyan" | "amber";
}) {
  return (
    <div className="wb-panel flex items-center gap-3 px-3.5 py-[14px] min-h-[70px]">
      <div
        className={`h-9 w-9 rounded-md flex items-center justify-center shrink-0 border ${
          tone === "amber" ? "wb-kpi-icon-amber" : "wb-kpi-icon-cyan"
        }`}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wider wb-text-sec truncate">
          {label}
        </div>
        <div className="flex items-baseline gap-1.5 mt-0.5">
          <span className="text-[22px] font-semibold leading-none wb-text tabular-nums">
            {value}
          </span>
          <span className="text-[10px] uppercase tracking-wider wb-text-muted">{unit}</span>
        </div>
      </div>
    </div>
  );
}

export { TruckEntry };
