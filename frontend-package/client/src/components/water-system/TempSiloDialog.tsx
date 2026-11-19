import React, { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMaterialCodes } from "../../constants/materialCodes";
import { SearchableSelect } from "./SearchableSelect";
import { fetchTempSilos, saveTempSilo, type TempSilo } from "../../api/tempSilos";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Silo to edit. Leave out to let the operator pick one of the 200. */
  siloNo?: number | null;
  onSaved?: (silo: TempSilo) => void;
}

const fmtKg = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });

function sameCode(a: string, b: string) {
  const norm = (s: string) => s.trim().replace(/^0+/, "") || "0";
  return norm(a) === norm(b);
}

/** Hand edit of a temporary silo (1001-1200): material and quantity, saved in Hercules only. */
export function TempSiloDialog({ open, onOpenChange, siloNo, onSaved }: Props) {
  const materials = useMaterialCodes();
  const materialOptions = useMemo(
    () => materials.map((m) => ({ value: m.code, label: `${m.code} — ${m.name}` })),
    [materials]
  );
  const [silos, setSilos] = useState<TempSilo[]>([]);
  const [picked, setPicked] = useState("");
  const [materialCode, setMaterialCode] = useState("");
  const [quantity, setQuantity] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const current = silos.find((s) => String(s.siloNo) === picked) ?? null;

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setError(null);
    setLoadError(null);
    setPicked(siloNo != null ? String(siloNo) : "");
    setMaterialCode("");
    setQuantity("");
    fetchTempSilos(ctrl.signal)
      .then(setSilos)
      .catch((e: unknown) => {
        if ((e as Error)?.name === "AbortError") return;
        setLoadError("Could not load the temporary silos");
      });
    return () => ctrl.abort();
  }, [open, siloNo]);

  // Show the chosen silo's present values in the fields.
  useEffect(() => {
    if (!current) return;
    const match = materials.find((m) => sameCode(m.code, current.materialCode));
    setMaterialCode(current.materialCode ? match?.code ?? "" : "");
    setQuantity(current.materialCode || current.quantityKg ? String(current.quantityKg) : "");
    setError(null);
  }, [current?.siloNo, current?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (empty: boolean) => {
    if (!current) {
      setError("Select a temporary silo.");
      return;
    }
    const qty = empty ? 0 : Number(quantity);
    if (!empty) {
      if (quantity.trim() === "" || !Number.isFinite(qty)) {
        setError("Enter the quantity in kg.");
        return;
      }
      if (qty < 0) {
        setError("The quantity cannot be below zero.");
        return;
      }
      if (qty > 0 && !materialCode) {
        setError("Select the material.");
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await saveTempSilo(current.siloNo, qty > 0 ? materialCode : "", qty);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (e: unknown) {
      setError((e as Error)?.message || "Could not save.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="wb-panel wb-text sm:max-w-md light:bg-white">
        <DialogHeader>
          <DialogTitle className="wb-text">
            {siloNo != null ? `Temporary silo ${siloNo}` : "Temporary silos"}
          </DialogTitle>
          <DialogDescription className="wb-text-sec">
            Ground storage, kept in Hercules only. It is not sent to the PLC or SCADA.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {siloNo == null && (
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider wb-text-sec">Silo</label>
              <Select value={picked || undefined} onValueChange={setPicked} disabled={busy}>
                <SelectTrigger className="wb-input h-11 wb-text" data-testid="temp-silo-pick">
                  <SelectValue placeholder="Select temporary silo" />
                </SelectTrigger>
                <SelectContent className="wb-select-content wb-text max-h-60">
                  {silos.map((s) => (
                    <SelectItem key={s.siloNo} value={String(s.siloNo)}>
                      {s.materialCode
                        ? `Silo ${s.siloNo} — ${s.materialName || s.materialCode} — ${fmtKg(s.quantityKg)} kg`
                        : `Silo ${s.siloNo} — free`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {current && (
            <p className="text-xs wb-text-sec" data-testid="temp-silo-now">
              Now:{" "}
              {current.materialCode
                ? `${current.materialName || current.materialCode} (${current.materialCode}), ${fmtKg(current.quantityKg)} kg`
                : "free, no material"}
            </p>
          )}

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wider wb-text-sec">Material</label>
            <SearchableSelect
              value={materialCode}
              onChange={setMaterialCode}
              options={materialOptions}
              placeholder="Select or type material"
              disabled={busy || !current}
              testId="temp-silo-material"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wider wb-text-sec">Quantity (kg)</label>
            <Input
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              disabled={busy || !current}
              placeholder="0"
              className="wb-input h-11 wb-text"
              data-testid="temp-silo-qty"
            />
          </div>

          {(error || loadError) && (
            <p className="text-sm text-red-400 light:text-red-600" data-testid="temp-silo-error">
              {error || loadError}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            className="bg-transparent border wb-border wb-text-sec hover:opacity-90 light:border-gray-300 light:bg-white"
            onClick={() => void save(true)}
            disabled={busy || !current || (!current.materialCode && !current.quantityKg)}
            data-testid="temp-silo-empty"
          >
            Empty silo
          </Button>
          <Button
            type="button"
            className="wb-btn-primary"
            onClick={() => void save(false)}
            disabled={busy || !current}
            data-testid="temp-silo-save"
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
