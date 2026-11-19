import { useEffect, useRef, useState } from "react";
import { FileDown, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { MemoDetails, TruckWeighOrder } from "../../api/truckEntry";
import { printMemo, saveMemoPdf } from "../../utils/printMemo";

const OPERATOR_KEY = "wb.scaleOperator";

function rememberedOperator(): string {
  try {
    return localStorage.getItem(OPERATOR_KEY) ?? "";
  } catch {
    return "";
  }
}

const fieldClass =
  "h-10 w-full rounded-md border border-slate-600 bg-slate-900 px-3 text-sm text-white outline-none " +
  "focus:border-cyan-400 light:border-gray-300 light:bg-white light:text-gray-900";
const labelClass = "text-[11px] font-semibold uppercase tracking-wider text-slate-300 light:text-gray-600";
const panelClass = "border-slate-700 bg-[#0b1626] text-white sm:max-w-md light:border-gray-200 light:bg-white light:text-gray-900";

/**
 * Asked the moment Capture Exit is pressed: the number of bags (may be skipped), plus the
 * scale operator and a note for the memo. Enter saves, "Skip" saves without a bag count.
 */
export function ExitMemoPrompt({
  open,
  weightKg,
  saving,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  weightKg: number | null;
  saving: boolean;
  onCancel: () => void;
  onConfirm: (details: MemoDetails) => void;
}) {
  const [bags, setBags] = useState("");
  const [operator, setOperator] = useState(rememberedOperator);
  const [notes, setNotes] = useState("");
  const bagsRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setBags("");
    setNotes("");
    setOperator(rememberedOperator());
    const t = setTimeout(() => bagsRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [open]);

  const send = (withBags: boolean) => {
    const name = operator.trim();
    try {
      localStorage.setItem(OPERATOR_KEY, name);
    } catch {
      /* the name is simply not remembered */
    }
    onConfirm({ bags: withBags ? bags.trim() : "", notes: notes.trim(), operator: name });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !saving && onCancel()}>
      <DialogContent className={panelClass} data-testid="exit-memo-prompt">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!saving) send(true);
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>Number of bags</DialogTitle>
            <DialogDescription className="text-slate-300 light:text-gray-600">
              Exit weight {weightKg == null ? "—" : `${Math.round(weightKg).toLocaleString()} kg`}. Type the
              bags for the memo, or skip.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <label className={labelClass} htmlFor="exit-memo-bags">No. of Bags</label>
            <input
              id="exit-memo-bags"
              ref={bagsRef}
              type="number"
              min={0}
              inputMode="numeric"
              className={`${fieldClass} h-12 text-lg font-semibold`}
              value={bags}
              onChange={(e) => setBags(e.target.value)}
              data-testid="exit-memo-bags"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={labelClass} htmlFor="exit-memo-operator">Scale Operator</label>
              <input
                id="exit-memo-operator"
                type="text"
                maxLength={100}
                placeholder="Your name"
                className={fieldClass}
                value={operator}
                onChange={(e) => setOperator(e.target.value)}
                data-testid="exit-memo-operator"
              />
            </div>
            <div className="space-y-1.5">
              <label className={labelClass} htmlFor="exit-memo-notes">Memo Notes</label>
              <input
                id="exit-memo-notes"
                type="text"
                maxLength={500}
                placeholder="Optional"
                className={fieldClass}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                data-testid="exit-memo-notes"
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={onCancel} data-testid="exit-memo-cancel">
              Cancel
            </Button>
            <Button type="button" variant="outline" disabled={saving} onClick={() => send(false)} data-testid="exit-memo-skip">
              Skip bags
            </Button>
            <Button type="submit" disabled={saving} className="bg-cyan-500 text-slate-950 hover:bg-cyan-400" data-testid="exit-memo-save">
              {saving ? "Saving…" : "Save exit"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type MemoAction = "pdf" | "both" | "print";

/** After the exit (or from the log): save the memo as PDF, save and print, or just print. */
export function MemoActionsDialog({
  order,
  title,
  onClose,
}: {
  order: TruckWeighOrder | null;
  title?: string;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<MemoAction | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setBusy(null);
    setNote(null);
    setFailed(false);
  }, [order?.id]);

  const run = async (action: MemoAction) => {
    if (!order || busy) return;
    setBusy(action);
    setNote(null);
    setFailed(false);
    const problems: string[] = [];
    let saved = false;
    if (action !== "print") {
      const err = await saveMemoPdf(order);
      if (err) problems.push(`${err}. Use Print and choose "Save as PDF" as the printer.`);
      else saved = true;
    }
    if (action !== "pdf") {
      const err = await printMemo(order);
      if (err) problems.push(err);
    }
    setBusy(null);
    if (problems.length) {
      setFailed(true);
      setNote(problems.join(" "));
    } else {
      setNote(saved ? "The PDF is in your Downloads folder." : null);
    }
  };

  const choice = "h-14 justify-start gap-3 px-4 text-left text-sm font-semibold";
  return (
    <Dialog open={!!order} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className={panelClass} data-testid="memo-actions">
        <DialogHeader>
          <DialogTitle>{title ?? "Dispatch and Receive Memo"}</DialogTitle>
          <DialogDescription className="text-slate-300 light:text-gray-600">
            {order ? (
              <>
                <span className="font-mono">{order.ticket}</span>
                {order.truck_plate ? ` · ${order.truck_plate}` : ""}
                {order.net_kg != null ? ` · NET ${Math.round(order.net_kg).toLocaleString()} kg` : ""}
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <Button
            className={`${choice} bg-cyan-500 text-slate-950 hover:bg-cyan-400`}
            disabled={!!busy}
            onClick={() => void run("both")}
            data-testid="memo-save-and-print"
          >
            <Printer className="h-5 w-5 shrink-0" />
            {busy === "both" ? "Working…" : "Save as PDF and print"}
          </Button>
          <Button variant="outline" className={choice} disabled={!!busy} onClick={() => void run("pdf")} data-testid="memo-save-pdf">
            <FileDown className="h-5 w-5 shrink-0" />
            {busy === "pdf" ? "Making the PDF…" : "Save as PDF"}
          </Button>
          <Button variant="outline" className={choice} disabled={!!busy} onClick={() => void run("print")} data-testid="memo-print">
            <Printer className="h-5 w-5 shrink-0" />
            {busy === "print" ? "Opening…" : "Print"}
          </Button>
        </div>

        {note && (
          <p
            className={`text-sm ${failed ? "text-amber-300 light:text-amber-700" : "text-emerald-300 light:text-emerald-700"}`}
            data-testid="memo-actions-note"
          >
            {note}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="memo-actions-close">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
