import { API_BASE_URL } from "../config/api";

export type TruckWeighStatus = "awaiting_first" | "awaiting_second" | "completed" | "cancelled";

export interface TruckWeighOrder {
  id: number;
  ticket: string;
  truck_id: number;
  truck_plate?: string | null;
  truck_driver?: string | null;
  material_code: string;
  material_name?: string | null;
  first_weight_kg?: number | null;
  first_ts?: string | null;
  second_weight_kg?: number | null;
  second_ts?: string | null;
  net_kg?: number | null;
  status: TruckWeighStatus;
  site_status?: string;
  created_at?: string | null;
  silo_no?: number | null;
  /** Signed kg: positive = silo gains (truck in heavy, out light). */
  stock_delta_kg?: number | null;
  stock_status?: "applied" | "pending" | "skipped" | null;
  stock_qty_before?: number | null;
  stock_qty_after?: number | null;
  stock_applied_at?: string | null;
  stock_note?: string | null;
  /** Weighbridge order this trip is for (Management > Weighbridge Orders), if any. */
  order_no?: number | null;
  order_client_name?: string | null;
  order_quantity_kg?: number | null;
  /** Driver and loading point chosen on the weighbridge for this trip (optional). */
  driver_id?: number | null;
  driver_name?: string | null;
  loading_point?: number | null;
}

export interface DriverOption {
  id: number;
  name: string;
  license_no?: string;
  status?: string;
  truck_id?: number | null;
}

/** Every driver from Management > Drivers, for the weighbridge dropdown. */
export async function fetchAllDrivers(signal?: AbortSignal): Promise<DriverOption[]> {
  const out: DriverOption[] = [];
  let offset = 0;
  for (let page = 0; page < 100; page++) {
    const res = await fetch(`${API_BASE_URL}/trucks/drivers?limit=200&offset=${offset}`, { signal });
    const data = await parseJson<{ items?: DriverOption[]; has_more?: boolean }>(res);
    const items = data.items ?? [];
    out.push(...items);
    if (!data.has_more || items.length === 0) break;
    offset += items.length;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface SiloOption {
  siloNo: number;
  materialCode: string;
  materialName: string;
  quantityKg: number | null;
  lockActive: boolean;
}

export interface SilosForMaterial {
  matching: SiloOption[];
  unassigned: SiloOption[];
  /** Temporary silos (1001-1200, Hercules only) that already hold this material. */
  tempMatching: SiloOption[];
  /** Temporary silos with no material yet. */
  tempFree: SiloOption[];
}

export interface ScaleLiveReading {
  ok: boolean;
  scale: number;
  name?: string;
  role?: "entry" | "exit" | string;
  ip?: string;
  mac?: string;
  weight_kg: number | null;
  stable: boolean;
  unit?: string;
  mode?: string;
  error?: string | null;
}

const BASE = `${API_BASE_URL}/truck-entry`;

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || res.statusText);
  }
  if (!res.ok) {
    const err = data as { error?: string };
    throw new Error(err?.error || text || res.statusText);
  }
  return data as T;
}

export async function createTruckWeighOrder(
  truckId: number,
  materialCode: string,
  siloNo?: number | null,
  orderNo?: number | null,
  driverId?: number | null,
  loadingPoint?: number | null
): Promise<TruckWeighOrder> {
  const res = await fetch(`${BASE}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      truck_id: truckId,
      material_code: materialCode,
      ...(siloNo != null ? { silo_no: siloNo } : {}),
      ...(orderNo != null ? { order_no: orderNo } : {}),
      ...(driverId != null ? { driver_id: driverId } : {}),
      ...(loadingPoint != null ? { loading_point: loadingPoint } : {}),
    }),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || res.statusText);
  }
  if (res.status === 409) {
    const err = data as { error?: string; order_id?: number; ticket?: string; status?: string };
    const conflict = new Error(err?.error || "Truck already has an open weigh order") as Error & {
      orderId?: number;
      ticket?: string;
      status?: string;
      code?: "OPEN_ORDER";
    };
    conflict.code = "OPEN_ORDER";
    conflict.orderId = err?.order_id;
    conflict.ticket = err?.ticket;
    conflict.status = err?.status;
    throw conflict;
  }
  if (!res.ok) {
    const err = data as { error?: string };
    throw new Error(err?.error || text || res.statusText);
  }
  return data as TruckWeighOrder;
}

export async function fetchSilosForMaterial(
  materialCode: string,
  signal?: AbortSignal
): Promise<SilosForMaterial> {
  const res = await fetch(`${BASE}/silos?material_code=${encodeURIComponent(materialCode)}`, { signal });
  const data = await parseJson<Partial<SilosForMaterial>>(res);
  return {
    matching: data.matching ?? [],
    unassigned: data.unassigned ?? [],
    tempMatching: data.tempMatching ?? [],
    tempFree: data.tempFree ?? [],
  };
}

/** Retry the silo stock update of a completed order whose stock_status is 'pending'. */
export async function applyOrderStock(orderId: number): Promise<TruckWeighOrder> {
  const res = await fetch(`${BASE}/orders/${orderId}/apply-stock`, { method: "POST" });
  return parseJson(res);
}

export async function saveFirstWeight(orderId: number, weight: number): Promise<TruckWeighOrder> {
  const res = await fetch(`${BASE}/orders/${orderId}/first`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ weight }),
  });
  return parseJson(res);
}

export async function saveSecondWeight(orderId: number, weight: number): Promise<TruckWeighOrder> {
  const res = await fetch(`${BASE}/orders/${orderId}/second`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ weight }),
  });
  return parseJson(res);
}

export async function fetchOpenOrders(signal?: AbortSignal): Promise<TruckWeighOrder[]> {
  const res = await fetch(`${BASE}/orders/open`, { signal });
  const data = await parseJson<{ orders: TruckWeighOrder[] }>(res);
  return data.orders ?? [];
}

export interface CompletedTodayResult {
  date: string | null;
  rows: TruckWeighOrder[];
}

export async function fetchCompletedToday(
  date?: string,
  signal?: AbortSignal
): Promise<CompletedTodayResult> {
  const qs = date ? `?date=${encodeURIComponent(date)}` : "";
  const res = await fetch(`${BASE}/orders/today${qs}`, { signal });
  const data = await parseJson<{ date?: string; rows: TruckWeighOrder[] }>(res);
  return { date: data.date ?? null, rows: data.rows ?? [] };
}

export async function fetchTruckWeighOrder(orderId: number): Promise<TruckWeighOrder> {
  const res = await fetch(`${BASE}/orders/${orderId}`);
  return parseJson(res);
}

/** Cancel an open trip (awaiting entry or exit) so the truck can be reused. */
export async function deleteTruckWeighOrder(orderId: number): Promise<TruckWeighOrder> {
  const res = await fetch(`${BASE}/orders/${orderId}`, { method: "DELETE" });
  return parseJson(res);
}

/** Scale 1 = entry, Scale 2 = exit */
export async function fetchScaleLive(scaleId: 1 | 2): Promise<ScaleLiveReading> {
  const res = await fetch(`${BASE}/scales/${scaleId}/live`);
  const text = await res.text();
  let data: ScaleLiveReading;
  try {
    data = text
      ? (JSON.parse(text) as ScaleLiveReading)
      : ({ ok: false, scale: scaleId, weight_kg: null, stable: false } as ScaleLiveReading);
  } catch {
    throw new Error(text || res.statusText);
  }
  if (!res.ok && !data?.error && data?.weight_kg == null) {
    throw new Error(text || res.statusText);
  }
  return data;
}
