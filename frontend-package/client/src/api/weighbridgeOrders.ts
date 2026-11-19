import { API_BASE_URL } from "../config/api";

export type WeighbridgeOrderStatus = "open" | "in_progress" | "closed";

/** An order entered on Management > Weighbridge Orders: what a truck is coming for. */
export interface WeighbridgeOrder {
  id: number;
  order_no: number;
  product_code: string;
  product_name: string;
  quantity_kg: number;
  client_id: number | null;
  client_name: string;
  status: WeighbridgeOrderStatus;
  trip_id: number | null;
  created_at: string | null;
  closed_at: string | null;
}

export interface WeighbridgeOrderInput {
  /** Leave out to get the next number. */
  order_no?: number | null;
  product_code: string;
  quantity_kg: number;
  client_id: number;
}

export interface ClientOption {
  id: number;
  name: string;
  client_number?: string;
}

const BASE = `${API_BASE_URL}/weighbridge-orders`;

async function parse<T>(res: Response): Promise<T> {
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

export async function fetchWeighbridgeOrders(
  status?: WeighbridgeOrderStatus,
  signal?: AbortSignal
): Promise<{ orders: WeighbridgeOrder[]; next_order_no: number }> {
  const qs = status ? `?status=${status}` : "";
  const data = await parse<{ orders?: WeighbridgeOrder[]; next_order_no?: number }>(
    await fetch(`${BASE}${qs}`, { signal })
  );
  return { orders: data.orders ?? [], next_order_no: data.next_order_no ?? 1 };
}

export async function createWeighbridgeOrder(input: WeighbridgeOrderInput): Promise<WeighbridgeOrder> {
  return parse(
    await fetch(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}

export async function updateWeighbridgeOrder(
  id: number,
  input: WeighbridgeOrderInput
): Promise<WeighbridgeOrder> {
  return parse(
    await fetch(`${BASE}/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  );
}

export async function deleteWeighbridgeOrder(id: number): Promise<void> {
  await parse(await fetch(`${BASE}/${id}`, { method: "DELETE" }));
}

/** Every client, for the dropdown (the clients list is paged, so read all pages). */
export async function fetchAllClients(signal?: AbortSignal): Promise<ClientOption[]> {
  const out: ClientOption[] = [];
  let offset = 0;
  for (let page = 0; page < 200; page++) {
    const data = await parse<{ items?: ClientOption[]; has_more?: boolean }>(
      await fetch(`${API_BASE_URL}/clients/?limit=100&offset=${offset}`, { signal })
    );
    const items = data.items ?? [];
    out.push(...items);
    if (!data.has_more || items.length === 0) break;
    offset += items.length;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function orderStatusLabel(status: WeighbridgeOrderStatus): string {
  if (status === "in_progress") return "Truck on site";
  if (status === "closed") return "Closed";
  return "Open";
}
