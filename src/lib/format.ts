/** Format tampilan tanggal & util waktu bisnis (zona waktu Asia/Jakarta). */

const MONTHS_ID = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];
const MONTHS_ID_SHORT = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

export const DEFAULT_TIMEZONE = "Asia/Jakarta";

/** "2026-01-13" → "13/01/2026" (gaya invoice referensi). */
export function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return "-";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

/** "2026-01-13" → "13 Januari 2026". */
export function formatDateLong(iso: string | null | undefined): string {
  if (!iso) return "-";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${Number(d)} ${MONTHS_ID[Number(m) - 1] ?? m} ${y}`;
}

export function monthLabel(ym: string, short = false): string {
  const [y, m] = ym.split("-");
  const names = short ? MONTHS_ID_SHORT : MONTHS_ID;
  return `${names[Number(m) - 1] ?? m} ${y}`;
}

/** Tanggal hari ini (YYYY-MM-DD) di zona waktu bisnis. Pakai ini — bukan `new Date().toISOString()`. */
export function todayIso(timeZone: string = DEFAULT_TIMEZONE, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Timestamp → "13/01/2026 14:05" di zona waktu bisnis. */
export function formatDateTime(value: Date | string | null | undefined, timeZone: string = DEFAULT_TIMEZONE): string {
  if (!value) return "-";
  const d = typeof value === "string" ? new Date(value) : value;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

export function currentYearMonth(timeZone: string = DEFAULT_TIMEZONE, now: Date = new Date()): string {
  return todayIso(timeZone, now).slice(0, 7);
}
