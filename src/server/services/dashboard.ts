import "server-only";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { env } from "../env";
import { assertCan, type Actor } from "../actor";
import { isoToDate } from "../json";
import { parseInput } from "../validate";
import { currentYearMonth, todayIso } from "@/lib/format";
import { isoDate } from "@/lib/validation/common";

/**
 * ═══════════ DEFINISI ANGKA (agar tidak terjadi penghitungan ganda) ═══════════
 *  • NILAI INVOICE  = Σ totalAmount invoice berstatus ISSUED (menurut TANGGAL INVOICE). Draft & batal TIDAK dihitung.
 *                     Ini "penjualan yang ditagihkan", bukan uang masuk.
 *  • PENERIMAAN KAS = Σ ledger pembayaran (PAYMENT positif + REVERSAL negatif) menurut TANGGAL PEMBAYARAN.
 *                     DP juga baris ledger → dihitung SEKALI di sini, dan TIDAK mengurangi "Nilai invoice".
 *  • PIUTANG        = Σ balanceAmount invoice ISSUED (total − Σ ledger) pada saat ini. Invoice lunas = saldo 0.
 *  • OVERDUE        = ISSUED, saldo > 0, jatuh tempo < hari ini (Asia/Jakarta). Diturunkan saat query (tanpa cron).
 *  Dasbor ini BUKAN laporan akuntansi (tanpa jurnal / pengakuan pendapatan).
 */

export const dashboardQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  customerId: z.string().uuid().optional(),
  status: z.enum(["DRAFT", "ISSUED", "CANCELLED"]).optional(),
  paymentStatus: z.enum(["UNPAID", "PARTIALLY_PAID", "PAID", "OVERDUE"]).optional(),
  q: z.string().max(60).optional(),
});

export interface DashboardData {
  period: { from: string; to: string };
  today: string;
  /** KPI kalender (tidak terpengaruh filter periode; terpengaruh filter pelanggan/nomor) */
  monthInvoiced: number;
  yearInvoiced: number;
  /** KPI untuk periode & filter terpilih */
  issuedCount: number;
  invoicedAmount: number;
  receivedAmount: number;
  outstandingAmount: number;
  unpaidCount: number;
  partialCount: number;
  paidCount: number;
  overdueCount: number;
  overdueAmount: number;
  cancelledCount: number;
  draftCount: number;
  /** Tren per bulan pada periode terpilih */
  trend: { month: string; invoiced: number; received: number }[];
}

const n = (v: unknown) => Number(v ?? 0);

export async function getDashboard(actor: Actor, raw: unknown = {}): Promise<DashboardData> {
  assertCan(actor, "dashboard:view");
  const f = parseInput(dashboardQuerySchema, raw);
  const tz = env().APP_TIMEZONE;
  const today = todayIso(tz);
  const ym = currentYearMonth(tz);
  const year = today.slice(0, 4);
  const from = f.from ?? `${year}-01-01`;
  const to = f.to ?? today;

  const base: Prisma.InvoiceWhereInput = {
    ...(f.customerId ? { customerId: f.customerId } : {}),
    ...(f.q ? { number: { contains: f.q, mode: "insensitive" } } : {}),
  };
  const inPeriod: Prisma.InvoiceWhereInput = { ...base, invoiceDate: { gte: isoToDate(from), lte: isoToDate(to) } };
  const pendingFilter = f.paymentStatus === "OVERDUE"
    ? { balanceAmount: { gt: 0n }, dueDate: { lt: isoToDate(today) } }
    : f.paymentStatus ? { paymentStatus: f.paymentStatus } : {};
  const statusFilter = f.status ? { status: f.status } : {};
  const filtered: Prisma.InvoiceWhereInput = { ...inPeriod, ...statusFilter, ...(f.paymentStatus ? { status: f.status ?? "ISSUED" } : {}), ...pendingFilter };
  const issued: Prisma.InvoiceWhereInput = { ...filtered, status: "ISSUED" };
  // Sebaran status pembayaran memakai himpunan invoice terbit pada periode/pelanggan terpilih, TANPA filter
  // status pembayaran — agar tile "Belum dibayar / Sebagian / Lunas / Jatuh tempo" selalu saling konsisten.
  const issuedBase: Prisma.InvoiceWhereInput = { ...inPeriod, status: "ISSUED" };

  const monthStart = isoToDate(`${ym}-01`);
  const yearStart = isoToDate(`${year}-01-01`);

  const customerSql = f.customerId ? Prisma.sql`AND i."customerId" = ${f.customerId}::uuid` : Prisma.empty;
  const qSql = f.q ? Prisma.sql`AND i."number" ILIKE ${"%" + f.q + "%"}` : Prisma.empty;

  const [monthAgg, yearAgg, issuedAgg, unpaid, partial, paid, overdueAgg, cancelled, drafts, cash, invTrend, cashTrend] = await Promise.all([
    prisma.invoice.aggregate({ where: { ...base, status: "ISSUED", invoiceDate: { gte: monthStart } }, _sum: { totalAmount: true } }),
    prisma.invoice.aggregate({ where: { ...base, status: "ISSUED", invoiceDate: { gte: yearStart } }, _sum: { totalAmount: true } }),
    prisma.invoice.aggregate({ where: issued, _sum: { totalAmount: true, balanceAmount: true }, _count: { _all: true } }),
    prisma.invoice.count({ where: { ...issuedBase, paymentStatus: "UNPAID" } }),
    prisma.invoice.count({ where: { ...issuedBase, paymentStatus: "PARTIALLY_PAID" } }),
    prisma.invoice.count({ where: { ...issuedBase, paymentStatus: "PAID" } }),
    prisma.invoice.aggregate({ where: { ...issuedBase, balanceAmount: { gt: 0n }, dueDate: { lt: isoToDate(today) } }, _sum: { balanceAmount: true }, _count: { _all: true } }),
    prisma.invoice.count({ where: { ...inPeriod, status: "CANCELLED" } }),
    prisma.invoice.count({ where: { ...inPeriod, status: "DRAFT" } }),
    prisma.$queryRaw<{ total: bigint | null }[]>`
      SELECT SUM(p."amount") AS total FROM payments p JOIN invoices i ON i."id" = p."invoiceId"
       WHERE p."paymentDate" BETWEEN ${isoToDate(from)} AND ${isoToDate(to)} AND i."status" <> 'DRAFT' ${customerSql} ${qSql}`,
    prisma.$queryRaw<{ m: string; amount: bigint }[]>`
      SELECT to_char(i."invoiceDate", 'YYYY-MM') AS m, SUM(i."totalAmount") AS amount FROM invoices i
       WHERE i."status" = 'ISSUED' AND i."invoiceDate" BETWEEN ${isoToDate(from)} AND ${isoToDate(to)} ${customerSql} ${qSql}
       GROUP BY 1`,
    prisma.$queryRaw<{ m: string; amount: bigint }[]>`
      SELECT to_char(p."paymentDate", 'YYYY-MM') AS m, SUM(p."amount") AS amount FROM payments p JOIN invoices i ON i."id" = p."invoiceId"
       WHERE p."paymentDate" BETWEEN ${isoToDate(from)} AND ${isoToDate(to)} AND i."status" <> 'DRAFT' ${customerSql} ${qSql}
       GROUP BY 1`,
  ]);

  // Deret bulan kontinu (bulan tanpa transaksi tetap tampil sebagai 0).
  const months: string[] = [];
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, (m = 1)) : m++) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    if (months.length > 60) break;
  }
  const inv = new Map(invTrend.map((r) => [r.m, n(r.amount)]));
  const rec = new Map(cashTrend.map((r) => [r.m, n(r.amount)]));

  return {
    period: { from, to }, today,
    monthInvoiced: n(monthAgg._sum.totalAmount), yearInvoiced: n(yearAgg._sum.totalAmount),
    issuedCount: issuedAgg._count._all, invoicedAmount: n(issuedAgg._sum.totalAmount),
    receivedAmount: n(cash[0]?.total), outstandingAmount: n(issuedAgg._sum.balanceAmount),
    unpaidCount: unpaid, partialCount: partial, paidCount: paid,
    overdueCount: overdueAgg._count._all, overdueAmount: n(overdueAgg._sum.balanceAmount),
    cancelledCount: cancelled, draftCount: drafts,
    trend: months.map((m) => ({ month: m, invoiced: inv.get(m) ?? 0, received: rec.get(m) ?? 0 })),
  };
}
