/** Aritmatika bulan untuk penutupan periode — fungsi murni. */
export const MONTH_NAMES = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"] as const;
const pad = (n: number) => String(n).padStart(2, "0");
export const periodKey = (year: number, month: number) => `${year}-${pad(month)}`;
export const periodStart = (year: number, month: number) => `${year}-${pad(month)}-01`;
export const periodEnd = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
export const periodLabel = (year: number, month: number) => `${MONTH_NAMES[month - 1]} ${year}`;
export const prevPeriod = (year: number, month: number): { year: number; month: number } => (month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 });
export const nextPeriod = (year: number, month: number): { year: number; month: number } => (month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 });
/** Bulan hanya boleh ditutup setelah hari terakhirnya lewat (hari terakhir sendiri masih berjalan). */
export const periodHasEnded = (year: number, month: number, today: string) => periodEnd(year, month) < today;
export const periodIndex = (year: number, month: number) => year * 12 + month;
/** Bulan dari `from` s.d. `to` (inklusif) berurutan. */
export function periodsBetween(from: { year: number; month: number }, to: { year: number; month: number }): { year: number; month: number }[] {
  const out: { year: number; month: number }[] = [];
  for (let p = from; periodIndex(p.year, p.month) <= periodIndex(to.year, to.month); p = nextPeriod(p.year, p.month)) out.push(p);
  return out;
}

/** Satu butir daftar periksa penutupan: WAJIB (HARD) menghalangi, PERINGATAN (SOFT) harus diakui. */
export interface CheckItem { id: string; label: string; severity: "HARD" | "SOFT"; ok: boolean; detail: string }

export interface PeriodDto {
  year: number; month: number; key: string; label: string; start: string; end: string;
  state: "CLOSED" | "REOPENED" | "OPEN" | "CURRENT" | "BEFORE_START";
  closedAt: string | null; closedByName: string | null; note: string | null; acknowledged: { id: string; label: string; detail: string }[];
  reopenReason: string | null; reopenedAt: string | null;
  /** Foto penutupan cocok dengan perhitungan ulang sekarang (hanya untuk periode CLOSED). */
  verified: boolean | null;
  snapshot: { totalDebit: number; assets: number; liabilities: number; equity: number; revenue: number; profitBeforeTax: number } | null;
  canClose: boolean; canReopen: boolean;
}
