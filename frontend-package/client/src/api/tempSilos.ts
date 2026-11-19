import { API_BASE_URL } from "../config/api";

/** Temporary silos 1001-1200: ground storage kept in Hercules only (never in the PLC). */
export const TEMP_SILO_FIRST = 1001;
export const TEMP_SILO_LAST = 1200;

export function isTempSilo(siloNo: number | null | undefined): boolean {
  return siloNo != null && siloNo >= TEMP_SILO_FIRST && siloNo <= TEMP_SILO_LAST;
}

export interface TempSilo {
  siloNo: number;
  binName: string;
  materialCode: string;
  materialName: string;
  quantityKg: number;
  updatedAt: string | null;
}

const BASE = `${API_BASE_URL}/temp-silos`;

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

export async function fetchTempSilos(signal?: AbortSignal): Promise<TempSilo[]> {
  return parse<TempSilo[]>(await fetch(BASE, { signal }));
}

/** Hand edit. Quantity 0 empties the silo and makes it free again. */
export async function saveTempSilo(
  siloNo: number,
  materialCode: string,
  quantityKg: number
): Promise<TempSilo> {
  const res = await fetch(`${BASE}/${siloNo}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ material_code: materialCode, quantity_kg: quantityKg }),
  });
  return parse<TempSilo>(res);
}
