/**
 * Parser rekening koran CSV — fungsi MURNI. Format tiap bank berbeda, jadi pemetaan kolom dapat dideteksi dari judul kolom dan diubah pengguna.
 * Aturan: nominal bulat Rupiah (sen non-nol ditolak), tanggal valid, Σ debit/kredit → nilai BERTANDA (+ masuk, − keluar).
 */
export type DateFormat = "DMY" | "YMD" | "MDY";
export type NumberFormat = "ID" | "EN";
export interface CsvMapping {
  hasHeader: boolean;
  date: number; description: number; reference: number | null;
  /** Salah satu: kolom `amount` bertanda ATAU pasangan `debit` (keluar) + `credit` (masuk). */
  amount: number | null; debit: number | null; credit: number | null;
  dateFormat: DateFormat; numberFormat: NumberFormat;
}
export interface ParsedLine { lineNo: number; txDate: string; description: string; reference: string | null; amount: number }
export interface ParseResult { lines: ParsedLine[]; errors: { row: number; message: string }[] }

export const CSV_MAX_ROWS = 5000;
export const CSV_MAX_CHARS = 1_000_000;

/** Pecah teks CSV (pembatas otomatis , ; atau TAB; kutip ganda; baris baru di dalam kutip). */
export function parseCsv(text: string): { delimiter: string; rows: string[][] } {
  const src = text.replace(/^﻿/, "");
  const first = src.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  const count = (ch: string) => first.split(ch).length - 1;
  const ranked = [";", "\t", ","].map((d) => ({ d, n: count(d) })).sort((a, b) => b.n - a.n);
  const delimiter = ranked[0]!.n > 0 ? ranked[0]!.d : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return { delimiter, rows: rows.map((r) => r.map((c) => c.trim())) };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const find = (headers: string[], names: string[]): number | null => {
  const hs = headers.map(norm);
  for (const n of names) { const i = hs.findIndex((h) => h === n || h.includes(n)); if (i >= 0) return i; }
  return null;
};

/** Tebak pemetaan dari baris judul; bila tak ada judul dikenali, pakai urutan umum (tanggal, uraian, debit, kredit). */
export function detectMapping(rows: string[][]): CsvMapping {
  const head = rows[0] ?? [];
  const date = find(head, ["tanggal", "tgl", "date", "postingdate", "transactiondate"]);
  const desc = find(head, ["keterangan", "uraian", "deskripsi", "description", "remark", "narasi", "berita"]);
  const ref = find(head, ["referensi", "reference", "noref", "ref", "nomorreferensi"]);
  const debit = find(head, ["debet", "debit", "mutasidebet", "keluar", "withdrawal"]);
  const credit = find(head, ["kredit", "credit", "mutasikredit", "masuk", "deposit"]);
  const amount = find(head, ["jumlah", "amount", "nominal", "mutasi"]);
  const hasHeader = date !== null && desc !== null;
  const sample = rows[hasHeader ? 1 : 0]?.[date ?? 0] ?? "";
  const dateFormat: DateFormat = /^\d{4}[-/]/.test(sample) ? "YMD" : "DMY";
  const sampleNums = rows.slice(hasHeader ? 1 : 0, 6).flatMap((r) => r.filter((c) => /\d[.,]\d/.test(c)));
  const numberFormat: NumberFormat = sampleNums.some((c) => /\d,\d{2}\b/.test(c) && !/\d\.\d{2}\b/.test(c)) || sampleNums.some((c) => /\d\.\d{3},/.test(c)) ? "ID" : sampleNums.some((c) => /\d,\d{3}\./.test(c) || /\d\.\d{2}\b/.test(c)) ? "EN" : "ID";
  if (hasHeader) {
    return { hasHeader, date: date!, description: desc!, reference: ref, amount: debit !== null && credit !== null ? null : amount, debit: debit !== null && credit !== null ? debit : null, credit: debit !== null && credit !== null ? credit : null, dateFormat, numberFormat };
  }
  return { hasHeader: false, date: 0, description: 1, reference: null, amount: null, debit: 2, credit: 3, dateFormat, numberFormat };
}

const MONTHS: Record<string, number> = {
  jan: 1, januari: 1, january: 1, feb: 2, februari: 2, february: 2, mar: 3, maret: 3, march: 3, apr: 4, april: 4, mei: 5, may: 5, jun: 6, juni: 6, june: 6,
  jul: 7, juli: 7, july: 7, agu: 8, agt: 8, agustus: 8, aug: 8, august: 8, sep: 9, sept: 9, september: 9, okt: 10, oktober: 10, oct: 10, october: 10,
  nov: 11, november: 11, des: 12, desember: 12, dec: 12, december: 12,
};

export function parseDate(raw: string, fmt: DateFormat): string | null {
  const s = raw.trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?.*$/, ""); // buang jam
  let y: number, m: number, d: number;
  const r = /^(\d{1,4})[-/. ](\d{1,2}|[A-Za-z]+)[-/. ](\d{1,4})$/.exec(s);
  if (!r) return null;
  const a = r[1]!, b = r[2]!, c = r[3]!;
  const monthName = /[A-Za-z]/.test(b) ? MONTHS[b.toLowerCase()] : undefined;
  if (/[A-Za-z]/.test(b) && monthName === undefined) return null;
  if (monthName !== undefined) { d = Number(a); m = monthName; y = Number(c); }
  else if (a.length === 4) { y = Number(a); m = Number(b); d = Number(c); }
  else if (fmt === "MDY") { m = Number(a); d = Number(b); y = Number(c); }
  else { d = Number(a); m = Number(b); y = Number(c); }
  if (y < 100) y += 2000;
  if (!(y >= 2000 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const back = new Date(`${iso}T00:00:00Z`);
  return back.getUTCFullYear() === y && back.getUTCMonth() + 1 === m && back.getUTCDate() === d ? iso : null;
}

/** Nominal → bilangan bulat BERTANDA. Menerima "Rp", spasi, (1.000) negatif, akhiran CR/DB/D/K, tanda minus di depan/belakang. Sen non-nol → galat (null + alasan). */
export function parseAmount(raw: string, fmt: NumberFormat): { value: number } | { error: string } | null {
  let s = raw.trim();
  if (s === "" || s === "-") return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  const suffix = /\s*(CR|DB|DR|D|K)$/i.exec(s);
  if (suffix) { sign *= /^(DB|DR|D)$/i.test(suffix[1]!) ? -1 : 1; s = s.slice(0, suffix.index); }
  s = s.replace(/^rp\.?\s*/i, "").replace(/\s/g, "");
  if (s.startsWith("-")) { sign *= -1; s = s.slice(1); } else if (s.startsWith("+")) s = s.slice(1);
  if (s.endsWith("-")) { sign *= -1; s = s.slice(0, -1); }
  const thousands = fmt === "ID" ? "." : ",", decimal = fmt === "ID" ? "," : ".";
  const parts = s.split(decimal);
  if (parts.length > 2) return { error: `Format angka tidak dikenali: "${raw}"` };
  const rawInt = parts[0]!;
  if (rawInt.includes(thousands) && !new RegExp(`^\\d{1,3}(\\${thousands}\\d{3})+$`).test(rawInt)) return { error: `Format angka tidak dikenali: "${raw}"` };
  const intPart = rawInt.split(thousands).join("");
  const frac = parts[1] ?? "";
  if (!/^\d+$/.test(intPart) || (frac !== "" && !/^\d+$/.test(frac))) return { error: `Format angka tidak dikenali: "${raw}"` };
  if (/[1-9]/.test(frac)) return { error: `Nominal berpecahan sen tidak didukung: "${raw}"` };
  if (intPart.length > 14) return { error: `Nominal terlalu besar: "${raw}"` };
  const value = sign * Number(intPart);
  return { value: value === 0 ? 0 : value };
}

export function parseStatementLines(rows: string[][], map: CsvMapping): ParseResult {
  const lines: ParsedLine[] = [];
  const errors: ParseResult["errors"] = [];
  const body = map.hasHeader ? rows.slice(1) : rows;
  if (body.length > CSV_MAX_ROWS) return { lines, errors: [{ row: 0, message: `Maksimal ${CSV_MAX_ROWS} baris per rekening koran.` }] };
  const cell = (r: string[], i: number | null) => (i === null ? "" : (r[i] ?? "").trim());
  body.forEach((r, idx) => {
    const row = idx + 1 + (map.hasHeader ? 1 : 0);
    const date = parseDate(cell(r, map.date), map.dateFormat);
    if (!date) { errors.push({ row, message: `Tanggal tidak valid: "${cell(r, map.date)}"` }); return; }
    const description = cell(r, map.description);
    if (!description) { errors.push({ row, message: "Uraian kosong" }); return; }
    let amount: number;
    if (map.amount !== null) {
      const a = parseAmount(cell(r, map.amount), map.numberFormat);
      if (a === null) { errors.push({ row, message: "Nominal kosong" }); return; }
      if ("error" in a) { errors.push({ row, message: a.error }); return; }
      amount = a.value;
    } else {
      const d = parseAmount(cell(r, map.debit), map.numberFormat), c = parseAmount(cell(r, map.credit), map.numberFormat);
      if (d && "error" in d) { errors.push({ row, message: d.error }); return; }
      if (c && "error" in c) { errors.push({ row, message: c.error }); return; }
      const dv = d && "value" in d ? Math.abs(d.value) : 0, cv = c && "value" in c ? Math.abs(c.value) : 0;
      if (dv !== 0 && cv !== 0) { errors.push({ row, message: "Debit dan kredit terisi bersamaan" }); return; }
      amount = cv - dv;
    }
    if (amount === 0) return; // baris tanpa mutasi (mis. "saldo awal") dilewati
    lines.push({ lineNo: lines.length + 1, txDate: date, description: description.slice(0, 300), reference: cell(r, map.reference) || null, amount });
  });
  return { lines, errors };
}
