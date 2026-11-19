import { API_BASE_URL } from "../config/api";
import type { TruckWeighOrder } from "../api/truckEntry";

/**
 * The Fakieh "Dispatch and Receive Memo" (QMS F/TRN/04) for one weighbridge trip.
 * The backend builds the page, so the printed memo and the saved PDF are the same thing.
 *  - printMemo: the browser's print dialog, through a hidden frame (no popup window).
 *  - saveMemoPdf: a real PDF file made on the Hercules server and downloaded.
 */

const memoUrl = (orderId: number, kind: "html" | "pdf") =>
  `${API_BASE_URL}/truck-entry/orders/${orderId}/memo.${kind}`;

const FRAME_ID = "fakieh-memo-print-frame";

async function errorText(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    return data?.error || fallback;
  } catch {
    return fallback;
  }
}

/** The filled memo page as HTML text. */
export async function fetchMemoHtml(orderId: number): Promise<string> {
  const res = await fetch(memoUrl(orderId, "html"));
  if (!res.ok) throw new Error(await errorText(res, "Could not load the memo"));
  return res.text();
}

/**
 * Open the browser's print dialog with the filled memo.
 * Returns an error text to show the user, or null when the dialog was asked for.
 */
export async function printMemo(order: Pick<TruckWeighOrder, "id">): Promise<string | null> {
  try {
    const html = await fetchMemoHtml(order.id);
    document.getElementById(FRAME_ID)?.remove();
    const frame = document.createElement("iframe");
    frame.id = FRAME_ID;
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;";
    frame.onload = () => {
      const win = frame.contentWindow;
      if (!win) return;
      // Give the inlined logo a moment to decode before the dialog takes its snapshot.
      setTimeout(() => {
        try {
          win.focus();
          win.print();
        } catch {
          /* the dialog was refused; the frame is simply left for the next try */
        }
      }, 250);
    };
    frame.srcdoc = html;
    document.body.appendChild(frame);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Could not open the memo for printing. Please try again.";
  }
}

/**
 * Download the memo as a PDF file.
 * Returns an error text to show the user, or null when the file was handed to the browser.
 */
export async function saveMemoPdf(order: Pick<TruckWeighOrder, "id" | "ticket">): Promise<string | null> {
  try {
    const res = await fetch(memoUrl(order.id, "pdf"));
    if (!res.ok) return await errorText(res, "Could not make the PDF");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `Dispatch-Memo-${order.ticket || order.id}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Could not make the PDF. Please try again.";
  }
}
