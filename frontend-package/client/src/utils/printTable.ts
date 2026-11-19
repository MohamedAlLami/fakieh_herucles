import asmLogo from "@/assets/Asm_Logo.png";
import fakiehBrandLogo from "@/assets/fakiehlogo.webp";
import herculesLogo from "@/assets/Hercules_New.png";

export interface PrintColumn<T> {
  header: string;
  /** Text for one cell. */
  cell: (row: T) => string | number | null | undefined;
  /** Right-align (numbers). */
  numeric?: boolean;
}

export interface PrintTableOptions<T> {
  title: string;
  /** Lines under the title, e.g. the date or the active filters. */
  subtitles?: string[];
  columns: PrintColumn<T>[];
  rows: T[];
  /** One text per column for a bold totals row; use "" for empty cells. */
  footer?: string[];
  landscape?: boolean;
}

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

async function imageToDataUrl(src: string): Promise<string> {
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
}

/** The page that gets printed. Exported so it can be checked without opening a window. */
export function buildPrintHtml<T>(opts: PrintTableOptions<T>, logos: string[]): string {
  const { title, subtitles = [], columns, rows, footer, landscape } = opts;
  const head = columns
    .map((c) => `<th${c.numeric ? ' class="num"' : ""}>${escapeHtml(c.header)}</th>`)
    .join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${columns
          .map((c) => {
            const v = c.cell(r);
            return `<td${c.numeric ? ' class="num"' : ""}>${escapeHtml(v == null || v === "" ? "—" : v)}</td>`;
          })
          .join("")}</tr>`
    )
    .join("\n");
  const foot = footer
    ? `<tfoot><tr>${footer
        .map((t, i) => `<td${columns[i]?.numeric ? ' class="num"' : ""}>${escapeHtml(t)}</td>`)
        .join("")}</tr></tfoot>`
    : "";
  const [hercules, fakieh, asm] = logos;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: A4 ${landscape ? "landscape" : "portrait"}; margin: 15mm 12mm; }
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; margin: 0; padding: 0; color: #000; background: #fff; }
    .page-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 12px; }
    .page-header img { max-height: 50px; max-width: 150px; object-fit: contain; }
    .logo-right { display: flex; gap: 16px; align-items: center; }
    h1 { font-size: 20px; margin: 0 0 4px 0; text-align: center; color: #000; }
    .meta { text-align: center; font-size: 11px; margin: 2px 0; color: #000; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 11px; }
    thead { display: table-header-group; }
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
    <img src="${escapeHtml(hercules)}" alt="Hercules" />
    <div class="logo-right">
      <img src="${escapeHtml(fakieh)}" alt="Fakieh" />
      <img src="${escapeHtml(asm)}" alt="ASM" />
    </div>
  </div>
  <h1>${escapeHtml(title)}</h1>
  <p class="meta">Printed: ${escapeHtml(new Date().toLocaleString())}</p>
  ${subtitles.map((s) => `<p class="meta">${escapeHtml(s)}</p>`).join("\n  ")}
  <table>
    <thead><tr>${head}</tr></thead>
    <tbody>
${body}
    </tbody>
    ${foot}
  </table>
</body>
</html>`;
}

/**
 * Print a table of rows in a new window, with the three logos on top.
 * Returns an error text to show the user, or null when the print window opened.
 */
export async function printTable<T>(opts: PrintTableOptions<T>): Promise<string | null> {
  if (opts.rows.length === 0) return "Nothing to print";
  try {
    const logos = await Promise.all([herculesLogo, fakiehBrandLogo, asmLogo].map(imageToDataUrl));
    const win = window.open("", "_blank", "width=1000,height=700");
    if (!win) return "Please allow popups to print";
    win.document.write(buildPrintHtml(opts, logos));
    win.document.close();
    win.onload = () => {
      setTimeout(() => {
        win.focus();
        win.print();
        win.close();
      }, 300);
    };
    return null;
  } catch {
    return "Could not print. Please try again.";
  }
}

/**
 * Which rows to print: the ticked ones when any are ticked, otherwise all rows shown.
 */
export function rowsToPrint<T>(shown: T[], selected: Set<string | number>, idOf: (row: T) => string | number): T[] {
  if (selected.size === 0) return shown;
  return shown.filter((r) => selected.has(idOf(r)));
}
