import type { PrintColumn } from "./printTable";

/** A print column that can also give Excel a real number instead of formatted text. */
export interface ExportColumn<T> extends PrintColumn<T> {
  /** Raw value for the Excel cell. Left out: the printed text is used. */
  excel?: (row: T) => string | number | null | undefined;
}

export interface ExportTableOptions<T> {
  title: string;
  subtitles?: string[];
  columns: ExportColumn<T>[];
  rows: T[];
  /** One value per column for a bold totals row; "" for empty cells. Numbers stay numbers. */
  footer?: Array<string | number>;
  /** Without the extension, e.g. "storage". The date and time are added. */
  filename: string;
  sheetName?: string;
}

export function exportFilename(base: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}`;
  return `${base}_${stamp}.xlsx`;
}

/** The workbook as a Blob. Exported so it can be checked without downloading. */
export async function buildTableExcel<T>(opts: ExportTableOptions<T>): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const { title, subtitles = [], columns, rows, footer } = opts;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Hercules";
  wb.created = new Date();
  const ws = wb.addWorksheet((opts.sheetName ?? title).slice(0, 31).replace(/[\\/?*[\]:]/g, " "));
  const lastCol = Math.max(1, columns.length);

  const titleRow = ws.addRow([title]);
  ws.mergeCells(titleRow.number, 1, titleRow.number, lastCol);
  titleRow.font = { bold: true, size: 14 };
  for (const line of [`Exported: ${new Date().toLocaleString()}`, ...subtitles]) {
    const r = ws.addRow([line]);
    ws.mergeCells(r.number, 1, r.number, lastCol);
    r.font = { size: 10, color: { argb: "FF555555" } };
  }
  ws.addRow([]);

  const border = {
    top: { style: "thin" as const, color: { argb: "FFBBBBBB" } },
    left: { style: "thin" as const, color: { argb: "FFBBBBBB" } },
    bottom: { style: "thin" as const, color: { argb: "FFBBBBBB" } },
    right: { style: "thin" as const, color: { argb: "FFBBBBBB" } },
  };

  const head = ws.addRow(columns.map((c) => c.header));
  head.eachCell((cell, i) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0088A9" } };
    cell.alignment = { horizontal: columns[i - 1]?.numeric ? "right" : "left", vertical: "middle" };
    cell.border = border;
  });
  ws.views = [{ state: "frozen", ySplit: head.number }];

  const widths = columns.map((c) => c.header.length);
  const note = (i: number, v: unknown) => {
    widths[i] = Math.max(widths[i], String(v ?? "").length);
  };

  for (const row of rows) {
    const values = columns.map((c) => {
      const v = c.excel ? c.excel(row) : c.cell(row);
      return v == null ? "" : v;
    });
    const r = ws.addRow(values);
    r.eachCell({ includeEmpty: true }, (cell, i) => {
      const col = columns[i - 1];
      cell.border = border;
      if (col?.numeric) {
        cell.alignment = { horizontal: "right" };
        if (typeof cell.value === "number") cell.numFmt = "#,##0.###";
      }
      note(i - 1, cell.value);
    });
  }

  if (footer) {
    const r = ws.addRow(footer);
    r.eachCell({ includeEmpty: true }, (cell, i) => {
      cell.font = { bold: true };
      cell.border = border;
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F4F8" } };
      if (columns[i - 1]?.numeric) {
        cell.alignment = { horizontal: "right" };
        if (typeof cell.value === "number") cell.numFmt = "#,##0.###";
      }
      note(i - 1, cell.value);
    });
  }

  ws.columns.forEach((col, i) => {
    col.width = Math.min(50, Math.max(10, (widths[i] ?? 10) + 3));
  });

  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/**
 * Download a table as an Excel file. Returns an error text to show, or null when it worked.
 */
export async function exportTableToExcel<T>(opts: ExportTableOptions<T>): Promise<string | null> {
  if (opts.rows.length === 0) return "Nothing to export";
  try {
    const blob = await buildTableExcel(opts);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFilename(opts.filename);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return null;
  } catch {
    return "Could not create the Excel file. Please try again.";
  }
}
