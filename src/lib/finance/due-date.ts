/**
 * Perhitungan tanggal jatuh tempo. Semua tanggal adalah string "YYYY-MM-DD" (tanpa jam & zona waktu)
 * sehingga tidak ada pergeseran hari akibat timezone.
 *
 * ATURAN DEFAULT (dapat diubah di Pengaturan → Pembayaran):
 *   • CALENDAR_DAYS : jatuh tempo = tanggal invoice + N hari kalender.
 *       Contoh: 13 Jan 2026 + 4 hari = 17 Jan 2026 (sesuai invoice contoh).
 *   • BUSINESS_DAYS : jatuh tempo = N hari kerja (Senin–Jumat) setelah tanggal invoice.
 *       Hari libur nasional BELUM dikecualikan kecuali daftar `holidays` diberikan.
 *   • N = 0 → jatuh tempo = tanggal invoice.
 */

export type DueDateBasis = "CALENDAR_DAYS" | "BUSINESS_DAYS";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(value: string): Date {
  const m = ISO_DATE.exec(value);
  if (!m) throw new RangeError(`Tanggal tidak valid: ${value}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // tolak 2026-02-31 dsb. (JS akan menggulung ke bulan berikutnya)
  if (d.toISOString().slice(0, 10) !== value) throw new RangeError(`Tanggal tidak valid: ${value}`);
  return d;
}

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    parseIsoDate(value);
    return true;
  } catch {
    return false;
  }
}

export function addCalendarDays(date: string, days: number): string {
  const d = parseIsoDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

function isBusinessDay(d: Date, holidays: ReadonlySet<string>): boolean {
  const dow = d.getUTCDay(); // 0 = Minggu, 6 = Sabtu
  return dow !== 0 && dow !== 6 && !holidays.has(toIsoDate(d));
}

export function addBusinessDays(date: string, days: number, holidays: readonly string[] = []): string {
  const set = new Set(holidays);
  const d = parseIsoDate(date);
  let remaining = days;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isBusinessDay(d, set)) remaining -= 1;
  }
  return toIsoDate(d);
}

export function computeDueDate(
  invoiceDate: string,
  termDays: number,
  basis: DueDateBasis = "CALENDAR_DAYS",
  holidays: readonly string[] = [],
): string {
  if (!Number.isInteger(termDays) || termDays < 0 || termDays > 3650) {
    throw new RangeError("Jangka waktu pembayaran harus berupa hari bulat 0–3650");
  }
  return basis === "BUSINESS_DAYS"
    ? addBusinessDays(invoiceDate, termDays, holidays)
    : addCalendarDays(invoiceDate, termDays);
}

/** Selisih hari kalender (b − a). */
export function diffDays(a: string, b: string): number {
  return Math.round((parseIsoDate(b).getTime() - parseIsoDate(a).getTime()) / 86_400_000);
}
