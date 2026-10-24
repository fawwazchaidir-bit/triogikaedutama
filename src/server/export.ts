import "server-only";
import ExcelJS from "exceljs";

export type ColumnType = "text" | "money" | "date" | "number" | "datetime";

export interface ReportColumn { key: string; label: string; type: ColumnType; width?: number }

export interface ReportTable {
  type: string;
  title: string;
  description: string;
  /** Teks pembatas yang selalu menyertai laporan (bukan laporan akuntansi lengkap). */
  disclaimer: string;
  periodLabel: string;
  generatedAt: string;
  columns: ReportColumn[];
  rows: Record<string, string | number | null>[];
  /** Baris total (kunci = key kolom). */
  totals: Record<string, string | number | null> | null;
}

/**
 * CSV/Excel injection: sel yang diawali = + - @ TAB CR akan dieksekusi sebagai formula oleh Excel.
 * Nama pelanggan/deskripsi berasal dari input pengguna, jadi SEMUA sel teks dinetralkan dengan awalan apostrof.
 */
export function neutralize(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function csvCell(v: string | number | null, type: ColumnType): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? String(v) : type === "text" ? neutralize(v) : v;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV UTF-8 dengan BOM (agar Excel membaca Unicode), CRLF, nominal sebagai angka murni (bisa dijumlah). */
export function toCsv(t: ReportTable): string {
  const lines: string[] = [];
  lines.push(csvCell(t.title, "text"));
  lines.push(csvCell(`Periode: ${t.periodLabel}`, "text"));
  lines.push(csvCell(t.disclaimer, "text"));
  lines.push("");
  lines.push(t.columns.map((c) => csvCell(c.label, "text")).join(","));
  for (const r of t.rows) lines.push(t.columns.map((c) => csvCell(r[c.key] ?? null, c.type)).join(","));
  if (t.totals) lines.push(t.columns.map((c, i) => csvCell(i === 0 && t.totals![c.key] == null ? "TOTAL" : (t.totals![c.key] ?? null), c.type)).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export async function toXlsx(t: ReportTable): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Trilogika Invoice System";
  wb.created = new Date();
  const ws = wb.addWorksheet(t.title.slice(0, 28).replace(/[\\/?*[\]:]/g, " "), { views: [{ state: "frozen", ySplit: 5 }] });

  ws.addRow([t.title]).font = { bold: true, size: 14 };
  ws.addRow([`Periode: ${t.periodLabel}`]);
  const note = ws.addRow([t.disclaimer]);
  note.font = { italic: true, color: { argb: "FF6B6760" }, size: 9 };
  ws.addRow([]);
  const head = ws.addRow(t.columns.map((c) => c.label));
  head.font = { bold: true };
  head.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDEAE4" } };
    cell.border = { bottom: { style: "thin" } };
  });

  const put = (r: Record<string, string | number | null>, isTotal = false) => {
    const row = ws.addRow(
      t.columns.map((c, i) => {
        const v = isTotal && i === 0 && r[c.key] == null ? "TOTAL" : (r[c.key] ?? null);
        if (v === null) return null;
        if (c.type === "text") return typeof v === "string" ? v : String(v); // string biasa → tidak pernah dievaluasi sebagai formula
        if (c.type === "date" && typeof v === "string") return new Date(`${v.slice(0, 10)}T00:00:00Z`);
        if (c.type === "datetime" && typeof v === "string") return new Date(v);
        return v;
      }),
    );
    t.columns.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      if (c.type === "money") cell.numFmt = '#,##0;[Red]-#,##0';
      if (c.type === "number") cell.numFmt = "#,##0.###";
      if (c.type === "date") cell.numFmt = "dd/mm/yyyy";
      if (c.type === "datetime") cell.numFmt = "dd/mm/yyyy hh:mm";
    });
    if (isTotal) row.font = { bold: true };
  };
  t.rows.forEach((r) => put(r));
  if (t.totals) put(t.totals, true);

  t.columns.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width ?? (c.type === "money" ? 18 : c.type === "date" ? 13 : c.type === "text" ? 30 : 14);
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function exportFilename(type: string, ext: "csv" | "xlsx", periodLabel: string): string {
  const p = periodLabel.replace(/[^0-9A-Za-z]+/g, "_").replace(/^_+|_+$/g, "");
  return `Laporan_${type}_${p}.${ext}`;
}
