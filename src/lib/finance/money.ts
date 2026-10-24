/**
 * Utilitas uang. SELURUH nilai uang di sistem ini adalah bilangan bulat Rupiah.
 *
 *  - Di database: BigInt.
 *  - Di aplikasi: `number` yang dijamin safe-integer (≤ MAX_AMOUNT), atau `bigint` di dalam kalkulasi.
 *  - Tidak ada floating-point untuk nominal. Pembagian selalu lewat `roundDivHalfUp` (aturan pembulatan tunggal).
 */

/** Batas atas nominal tunggal (~ Rp 1 kuadriliun). Jauh di bawah 2^53 sehingga aman sebagai `number`. */
export const MAX_AMOUNT = 999_999_999_999_999;

export type RupiahStyle = "REFERENCE" | "PLAIN" | "DECIMAL";

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/**
 * Pembagian bilangan bulat dengan pembulatan half-up (0,5 naik). Hanya untuk n ≥ 0 dan d > 0.
 * Ini SATU-SATUNYA aturan pembulatan yang dipakai di kalkulasi invoice.
 */
export function roundDivHalfUp(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new MoneyError("Pembagi harus positif");
  if (n < 0n) throw new MoneyError("Pembulatan hanya untuk nilai non-negatif");
  return (2n * n + d) / (2n * d);
}

/** Konversi bigint → number dengan jaminan aman (tidak kehilangan presisi). */
export function toSafeNumber(value: bigint, label = "Nominal"): number {
  if (value > BigInt(MAX_AMOUNT) || value < -BigInt(MAX_AMOUNT)) {
    throw new MoneyError(`${label} melebihi batas maksimum yang didukung`);
  }
  return Number(value);
}

/** Pastikan `value` adalah bilangan bulat Rupiah yang valid dan tidak negatif. */
export function assertRupiah(value: unknown, label = "Nominal"): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new MoneyError(`${label} harus berupa bilangan bulat Rupiah`);
  }
  if (value < 0) throw new MoneyError(`${label} tidak boleh negatif`);
  if (value > MAX_AMOUNT) throw new MoneyError(`${label} melebihi batas maksimum yang didukung`);
}

/**
 * Parse input pengguna menjadi Rupiah bulat. Menerima: 14000000, "14000000", "14.000.000",
 * "Rp 14.000.000", "Rp. 14.000.000,-", "14.000.000,00".
 * Mengembalikan null bila tidak valid (mis. pecahan sen yang tidak nol, atau huruf).
 */
export function parseRupiahInput(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= 0 && raw <= MAX_AMOUNT ? raw : null;
  }
  if (typeof raw !== "string") return null;
  let s = raw.trim().replace(/^rp\.?\s*/i, "").replace(/\s+/g, "");
  if (s === "") return null;
  // ",-" dan ",00" (desimal nol) diperbolehkan; pecahan lain ditolak.
  s = s.replace(/,-$/, "").replace(/,0{1,2}$/, "");
  if (!/^\d{1,3}(\.\d{3})*$|^\d+$/.test(s)) return null;
  const n = Number(s.replace(/\./g, ""));
  return Number.isSafeInteger(n) && n <= MAX_AMOUNT ? n : null;
}

/** 14000000 → "14.000.000" (pemisah ribuan titik; deterministik, tidak bergantung ICU). */
export function formatNumberId(value: number | bigint): string {
  const neg = value < 0;
  const digits = (neg ? -BigInt(value) : BigInt(value)).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return neg ? `-${grouped}` : grouped;
}

/**
 * Format Rupiah sesuai gaya yang dikonfigurasi:
 *  REFERENCE → "Rp. 14.000.000,-" (gaya invoice contoh Trilogika)
 *  PLAIN     → "Rp 14.000.000"
 *  DECIMAL   → "Rp 14.000.000,00"
 */
export function formatRupiah(value: number | bigint, style: RupiahStyle = "PLAIN"): string {
  const neg = value < 0;
  const abs = neg ? -BigInt(value) : BigInt(value);
  const body = formatNumberId(abs);
  const sign = neg ? "-" : "";
  switch (style) {
    case "REFERENCE":
      return `${sign}Rp. ${body},-`;
    case "DECIMAL":
      return `${sign}Rp ${body},00`;
    default:
      return `${sign}Rp ${body}`;
  }
}
