/**
 * Material codes — shared by Orders and Truck Weighbridge.
 *
 * The live list comes from the backend, which follows the batch system's Materials.xml, so it
 * changes by itself when the plant adds or removes a material. The list written out below is
 * the copy from 2026-11-10: it is what shows until the live list has loaded, and the fallback
 * if the backend cannot be reached.
 */
import { useSyncExternalStore } from "react";
import { API_BASE_URL } from "../config/api";

export interface MaterialCode {
  code: string;
  name: string;
}

export const MATERIAL_CODES: MaterialCode[] = [
  { code: "None", name: "None" },
  { code: "0", name: "Empty" },
  { code: "1", name: "Not Used" },
  { code: "3", name: "CYROMAZINE 1%" },
  { code: "4", name: "REHYDRAPRO RM" },
  { code: "5", name: "COXISTAC" },
  { code: "6", name: "NOVELA ECL" },
  { code: "7", name: "ENSPIRA PLUS" },
  { code: "8", name: "SENITHETIC LYSIN" },
  { code: "9", name: "VINCON" },
  { code: "10", name: "LIGNOBOND DD" },
  { code: "12", name: "Methionine" },
  { code: "13", name: "CIBENZA" },
  { code: "14", name: "OXISTAT" },
  { code: "15", name: "OXY-NIL RX Dry" },
  { code: "16", name: "NEOMYCINE" },
  { code: "17", name: "COXIRIL" },
  { code: "18", name: "ENDOX DRY" },
  { code: "19", name: "HADOX DRY" },
  { code: "20", name: "OXYTETRACYCLINE" },
  { code: "21", name: "Provi Oxi Stop" },
  { code: "22", name: "FLUBENOL" },
  { code: "23", name: "CAROPHYLL RED" },
  { code: "24", name: "LEADER RED" },
  { code: "25", name: "A-SORB" },
  { code: "26", name: "Choline Chloride 60%" },
  { code: "27", name: "MONTOBAN" },
  { code: "28", name: "FORMAXOL-F, KEMIN" },
  { code: "29", name: "KEMSAVOR DRY" },
  { code: "30", name: "LYSOFORTE DRY" },
  { code: "31", name: "Broiler Mineral Mix" },
  { code: "32", name: "BRD MIN" },
  { code: "33", name: "TermiN-8" },
  { code: "34", name: "LAY MINERAL MIX" },
  { code: "35", name: "SOUDIOM Bicarbon" },
  { code: "36", name: "CYCOSTAT *66 G" },
  { code: "37", name: "SALMO NIL LIQUID" },
  { code: "38", name: "VATEC 15% CC" },
  { code: "39", name: "VIRGENIAMYCIN" },
  { code: "40", name: "Lay Min. Old" },
  { code: "41", name: "FYSAL LIQ(ANTISA" },
  { code: "42", name: "METHIONINE LIQUE" },
  { code: "43", name: "Moldonin Liquid" },
  { code: "44", name: "Phytase 10000 1000FTU (100g)" },
  { code: "45", name: "NOVIBAC F Liquid" },
  { code: "46", name: "BENTONELT" },
  { code: "47", name: "SALGARD LEQUID" },
  { code: "48", name: "MAXUS 100" },
  { code: "49", name: "Pelcin" },
  { code: "50", name: "BROILER VIT MIX" },
  { code: "51", name: "LAYER VIT MIX" },
  { code: "52", name: "AMNIL" },
  { code: "53", name: "SelenoSource AF3" },
  { code: "54", name: "FOSPAC PLUS T PR" },
  { code: "55", name: "BERGAZYM" },
  { code: "56", name: "VITAMIN C" },
  { code: "57", name: "BREEDER VIT 2" },
  { code: "58", name: "SELISSEO 0.1%SE" },
  { code: "59", name: "Breeder Vit" },
  { code: "60", name: "L Threonine" },
  { code: "62", name: "Econase XT25(100g)" },
  { code: "69", name: "Broiler Starter PX" },
  { code: "70", name: "Broiler Grower PX" },
  { code: "71", name: "Broiler Finisher PX" },
  { code: "72", name: "L-VALINE 98%" },
  { code: "73", name: "L Isoleucine" },
  { code: "74", name: "Rovabio Advance" },
  { code: "75", name: "ROVABIO PhyPlus" },
  { code: "77", name: "KENZYME PRO" },
  { code: "78", name: "SAL CURB" },
  { code: "79", name: "Sangrovit" },
  { code: "80", name: "Celatom AFA" },
  { code: "81", name: "Ronozyme Pro Act" },
  { code: "82", name: "AVIZYME" },
  { code: "83", name: "PHYZYME" },
  { code: "84", name: "LYSOFORTE" },
  { code: "85", name: "NUTRILAC" },
  { code: "86", name: "LINCO MIX 44" },
  { code: "87", name: "limestone 20kg" },
  { code: "88", name: "BINDER" },
  { code: "89", name: "RONOZYМE" },
  { code: "90", name: "Hemicell-MP" },
  { code: "91", name: "Sacox (500g)" },
  { code: "92", name: "Micro Crube Liq." },
  { code: "93", name: "LIMESTONE FLISH" },
  { code: "94", name: "LIMESTONEIZE" },
  { code: "95", name: "SALKIL" },
  { code: "96", name: "KAMERA LIQUID" },
  { code: "97", name: "MICROVIT(E)TPM50" },
  { code: "98", name: "NOVIMOLD LIQUID" },
  { code: "99", name: "MIX(20%SAL+80%WA" },
  { code: "100", name: "Maize" },
  { code: "101", name: "MAIZE-B" },
  { code: "102", name: "MAIZE-C" },
  { code: "104", name: "BARLY" },
  { code: "105", name: "SOYA" },
  { code: "106", name: "SOYA-B" },
  { code: "109", name: "SOYA YUONBA" },
  { code: "110", name: "REWORK 22110" },
  { code: "111", name: "HY-Bond" },
  { code: "112", name: "Wheat- Bran" },
  { code: "113", name: "Limestone" },
  { code: "114", name: "WHEAT FLOUR" },
  { code: "115", name: "TECHNOMOS" },
  { code: "116", name: "D.D.G.S" },
  { code: "118", name: "RHODIMET AT 88" },
  { code: "120", name: "Availa Zn 120" },
  { code: "121", name: "FORMALIN LIQUID" },
  { code: "122", name: "FORMI NDF" },
  { code: "123", name: "L&amp;STONE COARSE" },
  { code: "124", name: "SOLIS" },
  { code: "125", name: "Integral" },
  { code: "126", name: "LEVUCELL SBO" },
  { code: "127", name: "SILO HEALTH 110" },
  { code: "128", name: "Quantum Blue 5G" },
  { code: "129", name: "AXTRAPHY" },
  { code: "130", name: "Optiphos Plus 10" },
  { code: "131", name: "Cabanin CSD" },
  { code: "132", name: "Salmocid - F" },
  { code: "133", name: "MiaBond360" },
  { code: "134", name: "Formycine Liq." },
  { code: "135", name: "AXTRA XB201 TРТ" },
  { code: "136", name: "ENVIVA PRO201 BA" },
  { code: "137", name: "Galli PRO Fit" },
  { code: "138", name: "Xcelsio" },
  { code: "139", name: "INTEGRAL-LR" },
  { code: "140", name: "BIOSTRONG 510" },
  { code: "141", name: "BIOSTRONG-FL" },
  { code: "142", name: "BETAIN HCL" },
  { code: "143", name: "ARBOCEL-RC" },
  { code: "144", name: "AVAILA ZMC" },
  { code: "146", name: "CELMANAX DRY" },
  { code: "147", name: "Panbonis 20" },
  { code: "148", name: "Omega pro Extra" },
  { code: "149", name: "HERBIN" },
  { code: "150", name: "AXXESS XY" },
  { code: "151", name: "Sodium Sulphate" },
  { code: "152", name: "Lysine Sulfate" },
  { code: "153", name: "MDCP" },
  { code: "156", name: "PHYTOCEЕ" },
  { code: "158", name: "MyCofix" },
  { code: "159", name: "Allzyme Vegpro" },
  { code: "176", name: "Rovabio P10" },
  { code: "179", name: "ACTIVO" },
  { code: "199", name: "MIXED MEALE" },
  { code: "202", name: "Salt" },
  { code: "204", name: "Monocalcium Phos" },
  { code: "205", name: "DICAL PHOS S" },
  { code: "210", name: "Soya Oil" },
  { code: "300", name: "Water" },
  { code: "999", name: "Out Of Service" },
  { code: "5000", name: "PRODUCT1" },
  { code: "11203", name: "Flush system" },
  { code: "12355", name: "BR-GR" },
  { code: "12395", name: "BR-FN" },
  { code: "12542", name: "LY-PR-003" },
  { code: "12550", name: "LY-PR-01" },
  { code: "12560", name: "LY-PR-02" },
  { code: "12570", name: "LY-PR-03" },
  { code: "13335", name: "BR-ST" },
  { code: "13402", name: "LY-ST" },
  { code: "13412", name: "LY-GR" },
  { code: "13422", name: "LA-DV" },
  { code: "13432", name: "LY-PL" },
  { code: "22355", name: "BR-GR-Bags" },
  { code: "22357", name: "CM-BR-GRF" },
  { code: "22395", name: "BR-FN-Bags" },
  { code: "22397", name: "CM-BR-FNF" },
  { code: "23315", name: "CM-BR-STF" },
  { code: "23335", name: "BR-ST-Bags" },
  { code: "23357", name: "CM-BR-GRF1" },
];

/** Codes used before the 2026-11 master list; kept only so old records still show a name. */
export const LEGACY_MATERIAL_CODES: MaterialCode[] = [
  { code: "002", name: "Soya" },
  { code: "035", name: "Sodium Bicarbonate" },
  { code: "012", name: "DL Methionine" },
  { code: "073", name: "L Isoleucine" },
  { code: "060", name: "L Threonine" },
  { code: "072", name: "L Valine" },
];

/** Codes that exist in the PLC list but are not real materials. */
export const NON_SELECTABLE_MATERIAL_CODES = new Set(["None", "0", "000", "1", "999", ""]);

export interface MaterialMasterStatus {
  source?: string;
  file_changed_at?: string | null;
  last_copy_at?: string | null;
  synced_at?: string | null;
  active_count?: number;
  inactive_count?: number;
  error?: string | null;
}

// ---- live list -------------------------------------------------------------------------------
const REFRESH_MS = 60_000;
const BUILT_IN_SELECTABLE = MATERIAL_CODES.filter((m) => !NON_SELECTABLE_MATERIAL_CODES.has(m.code));
let liveSelectable: MaterialCode[] | null = null;
let liveNames: Map<string, string> | null = null;
let liveStatus: MaterialMasterStatus | null = null;
let started = false;
const listeners = new Set<() => void>();

function sameList(a: MaterialCode[] | null, b: MaterialCode[]): boolean {
  return !!a && a.length === b.length && a.every((m, i) => m.code === b[i].code && m.name === b[i].name);
}

/** Fetch the live list now. Safe to call any time; failures keep the list already in use. */
export async function refreshMaterialMaster(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE_URL}/material-master`);
    if (!res.ok) return;
    const data = (await res.json()) as {
      materials?: MaterialCode[];
      inactive?: MaterialCode[];
      status?: MaterialMasterStatus;
    };
    const active = (data.materials ?? []).filter((m) => m && m.code != null);
    if (active.length === 0) return;
    const selectable = active
      .map((m) => ({ code: String(m.code), name: String(m.name ?? "") }))
      .filter((m) => !NON_SELECTABLE_MATERIAL_CODES.has(m.code))
      .sort((x, y) => Number(x.code) - Number(y.code) || x.code.localeCompare(y.code));
    const names = new Map<string, string>();
    for (const m of [...(data.inactive ?? []), ...active]) names.set(String(m.code), String(m.name ?? ""));
    const changed = !sameList(liveSelectable, selectable) || names.size !== (liveNames?.size ?? -1);
    liveNames = names;
    liveStatus = data.status ?? null;
    if (changed) {
      liveSelectable = selectable;
      listeners.forEach((fn) => fn());
    }
  } catch {
    /* backend not reachable: keep what we have */
  }
}

function ensureStarted(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  void refreshMaterialMaster();
  window.setInterval(() => void refreshMaterialMaster(), REFRESH_MS);
}

function subscribe(fn: () => void): () => void {
  ensureStarted();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getMaterialNameFromCode(materialCode: string | number | null | undefined): string {
  if (!materialCode || materialCode === "") return "-";
  ensureStarted();
  const code = String(materialCode).trim();
  const live = liveNames?.get(code);
  if (live) return live;
  const material =
    MATERIAL_CODES.find((m) => m.code === code) ?? LEGACY_MATERIAL_CODES.find((m) => m.code === code);
  return material ? material.name : code;
}

/** Materials a user may pick (excludes None, Empty, Not Used and Out Of Service). */
export function getSelectableMaterialCodes(): MaterialCode[] {
  ensureStarted();
  return liveSelectable ?? BUILT_IN_SELECTABLE;
}

/** The pickable materials, re-rendering the component when the plant's list changes. */
export function useMaterialCodes(): MaterialCode[] {
  return useSyncExternalStore(subscribe, getSelectableMaterialCodes, getSelectableMaterialCodes);
}

/** Where the list came from and when, for a small note on screen. */
export function getMaterialMasterStatus(): MaterialMasterStatus | null {
  return liveStatus;
}
