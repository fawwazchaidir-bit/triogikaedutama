/**
 * Format & scope nomor invoice. MURNI — alokasi nomor (yang butuh DB lock) ada di
 * src/server/services/numbering.ts.
 *
 * Token format:
 *   {PREFIX}  awalan dari pengaturan           {YYYY} tahun 4 digit   {YY} tahun 2 digit
 *   {MM}      bulan 2 digit                    {SEQ}  urutan tanpa padding   {SEQ:5}  urutan dengan padding 5 digit
 *
 * Contoh:  "{SEQ:5}" → 00434     "INV/TE/{YYYY}/{SEQ:4}" → INV/TE/2026/0001
 *
 * Kebijakan reset (scope):
 *   NEVER   → scope "ALL"      (penomoran berlanjut selamanya, mis. 00434, 00435, …)
 *   YEARLY  → scope "2026"     (urutan kembali ke nomor awal tiap tahun)
 *   MONTHLY → scope "2026-01"  (urutan kembali ke nomor awal tiap bulan)
 * Scope ditentukan oleh TANGGAL INVOICE (tanggal pada dokumen), bukan tanggal tombol Terbitkan ditekan.
 */

export type NumberReset = "NEVER" | "YEARLY" | "MONTHLY";

export const MAX_NUMBER_LENGTH = 40;

const TOKEN_RE = /\{(PREFIX|YYYY|YY|MM|SEQ)(?::(\d{1,2}))?\}/g;
// Karakter literal yang diperbolehkan di luar token: huruf, angka, / - . _ spasi
const SAFE_LITERAL_RE = /^[A-Za-z0-9/\-._ ]*$/;

export interface NumberFormatCheck {
  ok: boolean;
  error?: string;
}

export function validateNumberFormat(format: string, prefix = ""): NumberFormatCheck {
  if (!format || format.length > 60) return { ok: false, error: "Format nomor wajib diisi (maksimal 60 karakter)" };
  const seqTokens = [...format.matchAll(TOKEN_RE)].filter((m) => m[1] === "SEQ");
  if (seqTokens.length !== 1) return { ok: false, error: "Format harus mengandung tepat satu token {SEQ} atau {SEQ:n}" };
  for (const m of format.matchAll(TOKEN_RE)) {
    if (m[2] && m[1] !== "SEQ") return { ok: false, error: `Token {${m[1]}} tidak mendukung padding` };
    if (m[1] === "SEQ" && m[2] && (Number(m[2]) < 1 || Number(m[2]) > 12)) {
      return { ok: false, error: "Padding {SEQ:n} harus 1–12 digit" };
    }
  }
  const literal = format.replace(TOKEN_RE, "");
  if (!SAFE_LITERAL_RE.test(literal)) {
    return { ok: false, error: "Format hanya boleh memuat huruf, angka, spasi, dan karakter / - . _ di luar token" };
  }
  if (/[{}]/.test(literal)) return { ok: false, error: "Token tidak dikenal. Gunakan {PREFIX} {YYYY} {YY} {MM} {SEQ:n}" };
  if (/\.\./.test(format) || /\.\./.test(prefix)) return { ok: false, error: "Format/awalan tidak boleh memuat \"..\"" };
  if (!SAFE_LITERAL_RE.test(prefix) || prefix.length > 20) {
    return { ok: false, error: "Awalan hanya boleh huruf, angka, dan / - . _ (maksimal 20 karakter)" };
  }
  const sample = formatInvoiceNumber({ format, prefix, seq: 999_999, date: "2026-12-31" });
  if (sample.length > MAX_NUMBER_LENGTH) return { ok: false, error: `Nomor terlalu panjang (maksimal ${MAX_NUMBER_LENGTH} karakter)` };
  return { ok: true };
}

export function scopeKeyFor(reset: NumberReset, invoiceDate: string): string {
  const [y, m] = invoiceDate.split("-");
  if (reset === "YEARLY") return `${y}`;
  if (reset === "MONTHLY") return `${y}-${m}`;
  return "ALL";
}

export function formatInvoiceNumber(args: { format: string; prefix?: string; seq: number; date: string }): string {
  const [yyyy = "", mm = ""] = args.date.split("-");
  return args.format.replace(TOKEN_RE, (_, token: string, pad?: string) => {
    switch (token) {
      case "PREFIX":
        return args.prefix ?? "";
      case "YYYY":
        return yyyy;
      case "YY":
        return yyyy.slice(2);
      case "MM":
        return mm;
      default: // SEQ
        return pad ? String(args.seq).padStart(Number(pad), "0") : String(args.seq);
    }
  });
}

/** Nomor → bagian nama file yang aman: "INV/TE/2026/0001" → "INV-TE-2026-0001". */
export function numberForFilename(number: string): string {
  return number.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}
