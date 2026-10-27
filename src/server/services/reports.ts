import "server-only";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { env } from "../env";
import { Errors } from "../errors";
import { assertCan, type Actor } from "../actor";
import { isoToDate } from "../json";
import { parseInput } from "../validate";
import type { ReportColumn, ReportTable } from "../export";
import { diffDays } from "@/lib/finance/due-date";
import { formatDateLong, monthLabel, todayIso } from "@/lib/format";
import { isoDate } from "@/lib/validation/common";

export const REPORT_TYPES = [
  "invoices", "by-customer", "by-product", "payments", "receivables", "overdue", "paid", "cancelled", "monthly",
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_META: Record<ReportType, { title: string; description: string; kind: "penerbitan" | "kas" | "piutang" }> = {
  invoices: { title: "Daftar Invoice", kind: "penerbitan", description: "Seluruh invoice terbit & batal menurut tanggal invoice (penerbitan, bukan uang masuk)." },
  "by-customer": { title: "Rekap per Pelanggan", kind: "penerbitan", description: "Nilai invoice terbit per pelanggan beserta jumlah yang sudah dibayar dan sisanya." },
  "by-product": { title: "Rekap per Produk / Skema", kind: "penerbitan", description: "Nilai bersih baris invoice terbit per produk & skema pelatihan (sebelum diskon tambahan dan pajak)." },
  payments: { title: "Rekap Pembayaran Masuk", kind: "kas", description: "Penerimaan kas menurut tanggal pembayaran, termasuk pembalikan (negatif). Berbeda dari nilai invoice." },
  receivables: { title: "Daftar Piutang", kind: "piutang", description: "Invoice terbit dengan sisa tagihan > 0 per hari ini, beserta umur piutang." },
  overdue: { title: "Invoice Jatuh Tempo", kind: "piutang", description: "Invoice terbit yang melewati jatuh tempo dan belum lunas per hari ini." },
  paid: { title: "Invoice Lunas", kind: "penerbitan", description: "Invoice terbit yang sudah lunas, menurut tanggal invoice." },
  cancelled: { title: "Invoice Dibatalkan", kind: "penerbitan", description: "Invoice yang dibatalkan beserta alasan dan pelakunya (nomor tetap tercatat)." },
  monthly: { title: "Rekap Bulanan & Tahunan", kind: "kas", description: "Nilai invoice terbit vs penerimaan kas per bulan dan total per tahun." },
};

const DISCLAIMER =
  "Laporan operasional penagihan dari data sistem invoice — BUKAN laporan akuntansi (tidak memuat jurnal, pengakuan pendapatan, atau penyesuaian). " +
  "Nilai invoice (penerbitan) dan penerimaan kas dilaporkan terpisah dan tidak boleh dijumlahkan.";

export const reportQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  customerId: z.string().uuid().optional(),
});
export type ReportFilters = z.infer<typeof reportQuerySchema>;

const money = (key: string, label: string, width = 18): ReportColumn => ({ key, label, type: "money", width });
const text = (key: string, label: string, width = 28): ReportColumn => ({ key, label, type: "text", width });
const date = (key: string, label: string): ReportColumn => ({ key, label, type: "date", width: 13 });
const num = (key: string, label: string): ReportColumn => ({ key, label, type: "number", width: 12 });
const n = (v: unknown) => Number(v ?? 0);
const d = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 10) : null);
const sum = (rows: Record<string, string | number | null>[], key: string) => rows.reduce((a, r) => a + n(r[key]), 0);

export async function runReport(actor: Actor, type: string, raw: unknown = {}): Promise<ReportTable> {
  assertCan(actor, "report:view");
  if (!(REPORT_TYPES as readonly string[]).includes(type)) throw Errors.notFound("Laporan");
  const t = type as ReportType;
  const f = parseInput(reportQuerySchema, raw);
  const tz = env().APP_TIMEZONE;
  const today = todayIso(tz);
  const year = today.slice(0, 4);
  const from = f.from ?? `${year}-01-01`;
  const to = f.to ?? today;
  if (from > to) throw Errors.validation("Tanggal awal tidak boleh setelah tanggal akhir.", { from: "Harus ≤ tanggal akhir" });
  const asOf = t === "receivables" || t === "overdue";
  const periodLabel = asOf ? `Per ${formatDateLong(today)}` : `${formatDateLong(from)} – ${formatDateLong(to)}`;

  const customer = f.customerId ? Prisma.sql`AND i."customerId" = ${f.customerId}::uuid` : Prisma.empty;
  const range = Prisma.sql`i."invoiceDate" BETWEEN ${isoToDate(from)} AND ${isoToDate(to)}`;
  const pDate = isoToDate(today);

  let columns: ReportColumn[] = [];
  let rows: Record<string, string | number | null>[] = [];
  let totals: Record<string, string | number | null> | null = null;

  switch (t) {
    case "invoices": {
      const r = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT i."number", i."invoiceDate", i."customerNameSnapshot" AS customer, i."totalAmount", i."paidAmount", i."balanceAmount",
               i."dueDate", i."status", i."paymentStatus", u."name" AS creator
          FROM invoices i JOIN users u ON u."id" = i."createdById"
         WHERE i."status" NOT IN ('DRAFT','SUBMITTED') AND ${range} ${customer}
         ORDER BY i."invoiceDate", i."numberSeq" NULLS LAST`;
      columns = [text("number", "Nomor", 14), date("invoiceDate", "Tanggal"), text("customer", "Pelanggan"), money("total", "Total Invoice"), money("paid", "Dibayar"), money("balance", "Sisa Tagihan"),
        date("dueDate", "Jatuh Tempo"), text("status", "Status Invoice", 14), text("paymentStatus", "Status Pembayaran", 18), text("creator", "Pembuat", 20)];
      rows = r.map((x) => {
        const cancelled = x.status === "CANCELLED";
        const overdue = x.status === "ISSUED" && n(x.balanceAmount) > 0 && d(x.dueDate as Date)! < today;
        return {
          number: x.number as string, invoiceDate: d(x.invoiceDate as Date), customer: x.customer as string,
          total: n(x.totalAmount), paid: n(x.paidAmount), balance: cancelled ? 0 : n(x.balanceAmount), dueDate: d(x.dueDate as Date),
          status: cancelled ? "Dibatalkan" : "Diterbitkan",
          paymentStatus: cancelled ? "-" : overdue ? "Jatuh Tempo" : ({ UNPAID: "Belum Dibayar", PARTIALLY_PAID: "Dibayar Sebagian", PAID: "Lunas" } as Record<string, string>)[x.paymentStatus as string] ?? "",
          creator: x.creator as string,
        };
      });
      // Total hanya dari invoice TERBIT: invoice batal tidak boleh ikut dijumlahkan.
      const live = rows.filter((x) => x.status === "Diterbitkan");
      totals = { number: "TOTAL (invoice terbit)", total: sum(live, "total"), paid: sum(live, "paid"), balance: sum(live, "balance") };
      break;
    }
    case "by-customer": {
      const r = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT c."name" AS customer, COUNT(*)::int AS cnt, SUM(i."totalAmount") AS total, SUM(i."paidAmount") AS paid, SUM(i."balanceAmount") AS balance
          FROM invoices i JOIN customers c ON c."id" = i."customerId"
         WHERE i."status" = 'ISSUED' AND ${range} ${customer}
         GROUP BY c."id", c."name" ORDER BY SUM(i."totalAmount") DESC, c."name"`;
      columns = [text("customer", "Pelanggan", 36), num("count", "Jumlah Invoice"), money("total", "Nilai Invoice"), money("paid", "Dibayar"), money("balance", "Sisa Tagihan")];
      rows = r.map((x) => ({ customer: x.customer as string, count: n(x.cnt), total: n(x.total), paid: n(x.paid), balance: n(x.balance) }));
      totals = { customer: "TOTAL", count: sum(rows, "count"), total: sum(rows, "total"), paid: sum(rows, "paid"), balance: sum(rows, "balance") };
      break;
    }
    case "by-product": {
      const r = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT COALESCE(p."code", it."productCode", '-') AS code,
               COALESCE(p."name", split_part(MIN(it."description"), E'\\n', 1)) AS name,
               p."fieldOfTraining" AS field, p."schemeName" AS scheme,
               COUNT(DISTINCT i."id")::int AS invoices, SUM(it."quantity") AS qty, SUM(it."netAmount") AS net
          FROM invoice_items it JOIN invoices i ON i."id" = it."invoiceId" LEFT JOIN products p ON p."id" = it."productId"
         WHERE i."status" = 'ISSUED' AND ${range} ${customer}
         GROUP BY p."id", p."code", it."productCode", p."name", p."fieldOfTraining", p."schemeName"
         ORDER BY SUM(it."netAmount") DESC`;
      columns = [text("code", "Kode", 14), text("name", "Produk / Layanan", 34), text("field", "Bidang", 20), text("scheme", "Skema", 20), num("invoices", "Jumlah Invoice"), num("qty", "Kuantitas"), money("net", "Nilai Bersih Baris")];
      rows = r.map((x) => ({ code: x.code as string, name: x.name as string, field: (x.field as string) ?? null, scheme: (x.scheme as string) ?? null, invoices: n(x.invoices), qty: n(x.qty), net: n(x.net) }));
      totals = { code: "TOTAL", net: sum(rows, "net") };
      break;
    }
    case "payments": {
      const r = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT p."paymentDate", i."number", i."customerNameSnapshot" AS customer, p."entryType", p."isDownPayment" AS dp, p."method", p."reference",
               p."amount", p."withholdingAmount" AS wh, p."vatAmount" AS vat, p."reason", u."name" AS recorder
          FROM payments p JOIN invoices i ON i."id" = p."invoiceId" JOIN users u ON u."id" = p."recordedById"
         WHERE p."paymentDate" BETWEEN ${isoToDate(from)} AND ${isoToDate(to)} AND i."status" NOT IN ('DRAFT','SUBMITTED') ${customer}
         ORDER BY p."paymentDate", p."createdAt"`;
      columns = [date("date", "Tanggal Bayar"), text("number", "Invoice", 14), text("customer", "Pelanggan"), text("type", "Jenis", 16), text("method", "Metode", 14), text("reference", "Referensi", 22), money("amount", "Uang Diterima"), money("wh", "PPh Dipotong Pelanggan"), money("vat", "PPN dalam Pembayaran"), text("note", "Keterangan", 28), text("recorder", "Dicatat Oleh", 18)];
      rows = r.map((x) => ({
        date: d(x.paymentDate as Date), number: x.number as string, customer: x.customer as string,
        type: x.entryType === "REVERSAL" ? "Pembalikan" : x.dp ? "Down Payment" : "Pembayaran", method: x.method as string,
        reference: (x.reference as string) ?? null, amount: n(x.amount), wh: n(x.wh), vat: n(x.vat), note: (x.reason as string) ?? null, recorder: x.recorder as string,
      }));
      totals = { date: "PENERIMAAN KAS BERSIH", amount: sum(rows, "amount"), wh: sum(rows, "wh"), vat: sum(rows, "vat") };
      break;
    }
    case "receivables":
    case "overdue": {
      const onlyOverdue = t === "overdue" ? Prisma.sql`AND i."dueDate" < ${pDate}` : Prisma.empty;
      const r = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT i."number", i."customerNameSnapshot" AS customer, i."invoiceDate", i."dueDate", i."totalAmount", i."paidAmount", i."balanceAmount"
          FROM invoices i
         WHERE i."status" = 'ISSUED' AND i."balanceAmount" > 0 ${onlyOverdue} ${customer}
         ORDER BY i."dueDate", i."numberSeq"`;
      columns = [text("number", "Nomor", 14), text("customer", "Pelanggan", 32), date("invoiceDate", "Tanggal"), date("dueDate", "Jatuh Tempo"), money("total", "Total Invoice"), money("paid", "Dibayar"), money("balance", "Sisa Tagihan"), num("daysOverdue", "Hari Terlambat"), text("aging", "Umur Piutang", 20)];
      rows = r.map((x) => {
        const late = Math.max(0, diffDays(d(x.dueDate as Date)!, today));
        return {
          number: x.number as string, customer: x.customer as string, invoiceDate: d(x.invoiceDate as Date), dueDate: d(x.dueDate as Date),
          total: n(x.totalAmount), paid: n(x.paidAmount), balance: n(x.balanceAmount), daysOverdue: late,
          aging: late === 0 ? "Belum jatuh tempo" : late <= 30 ? "1–30 hari" : late <= 60 ? "31–60 hari" : late <= 90 ? "61–90 hari" : "> 90 hari",
        };
      });
      totals = { number: "TOTAL PIUTANG", total: sum(rows, "total"), paid: sum(rows, "paid"), balance: sum(rows, "balance") };
      break;
    }
    case "paid": {
      const r = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT i."number", i."customerNameSnapshot" AS customer, i."invoiceDate", i."totalAmount",
               (SELECT MAX(p."paymentDate") FROM payments p WHERE p."invoiceId" = i."id") AS last_paid
          FROM invoices i WHERE i."status" = 'ISSUED' AND i."paymentStatus" = 'PAID' AND ${range} ${customer}
         ORDER BY i."invoiceDate", i."numberSeq"`;
      columns = [text("number", "Nomor", 14), text("customer", "Pelanggan", 34), date("invoiceDate", "Tanggal Invoice"), money("total", "Total Invoice"), date("lastPaid", "Pembayaran Terakhir")];
      rows = r.map((x) => ({ number: x.number as string, customer: x.customer as string, invoiceDate: d(x.invoiceDate as Date), total: n(x.totalAmount), lastPaid: d(x.last_paid as Date) }));
      totals = { number: "TOTAL", total: sum(rows, "total") };
      break;
    }
    case "cancelled": {
      const r = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT i."number", i."customerNameSnapshot" AS customer, i."invoiceDate", i."totalAmount", i."cancelledAt", i."cancelReason", u."name" AS who
          FROM invoices i LEFT JOIN users u ON u."id" = i."cancelledById"
         WHERE i."status" = 'CANCELLED' AND ${range} ${customer} ORDER BY i."invoiceDate", i."numberSeq"`;
      columns = [text("number", "Nomor", 14), text("customer", "Pelanggan", 32), date("invoiceDate", "Tanggal Invoice"), money("total", "Nilai (tidak ditagih)"), { key: "cancelledAt", label: "Dibatalkan Pada", type: "datetime", width: 18 }, text("who", "Dibatalkan Oleh", 20), text("reason", "Alasan", 40)];
      rows = r.map((x) => ({ number: x.number as string, customer: x.customer as string, invoiceDate: d(x.invoiceDate as Date), total: n(x.totalAmount), cancelledAt: (x.cancelledAt as Date)?.toISOString() ?? null, who: (x.who as string) ?? null, reason: (x.cancelReason as string) ?? null }));
      totals = { number: "TOTAL", total: sum(rows, "total") };
      break;
    }
    case "monthly": {
      const [inv, cash, canc] = await Promise.all([
        prisma.$queryRaw<{ m: string; cnt: number; amount: bigint }[]>`
          SELECT to_char(i."invoiceDate",'YYYY-MM') AS m, COUNT(*)::int AS cnt, SUM(i."totalAmount") AS amount FROM invoices i
           WHERE i."status" = 'ISSUED' AND ${range} ${customer} GROUP BY 1`,
        prisma.$queryRaw<{ m: string; amount: bigint }[]>`
          SELECT to_char(p."paymentDate",'YYYY-MM') AS m, SUM(p."amount") AS amount FROM payments p JOIN invoices i ON i."id" = p."invoiceId"
           WHERE p."paymentDate" BETWEEN ${isoToDate(from)} AND ${isoToDate(to)} AND i."status" NOT IN ('DRAFT','SUBMITTED') ${customer} GROUP BY 1`,
        prisma.$queryRaw<{ m: string; cnt: number }[]>`
          SELECT to_char(i."invoiceDate",'YYYY-MM') AS m, COUNT(*)::int AS cnt FROM invoices i
           WHERE i."status" = 'CANCELLED' AND ${range} ${customer} GROUP BY 1`,
      ]);
      const months = new Set([...inv.map((x) => x.m), ...cash.map((x) => x.m), ...canc.map((x) => x.m)]);
      const ordered = [...months].sort();
      const im = new Map(inv.map((x) => [x.m, x])); const cm = new Map(cash.map((x) => [x.m, n(x.amount)])); const xm = new Map(canc.map((x) => [x.m, x.cnt]));
      columns = [text("period", "Periode", 22), num("count", "Invoice Terbit"), money("invoiced", "Nilai Invoice Terbit"), num("cancelled", "Invoice Batal"), money("received", "Penerimaan Kas"), money("gap", "Selisih (Invoice − Kas)")];
      const mk = (label: string, c: number, a: number, x: number, k: number) => ({ period: label, count: c, invoiced: a, cancelled: x, received: k, gap: a - k });
      const years = new Map<string, { c: number; a: number; x: number; k: number }>();
      for (const m of ordered) {
        const c = im.get(m)?.cnt ?? 0, a = n(im.get(m)?.amount), x = xm.get(m) ?? 0, k = cm.get(m) ?? 0;
        rows.push(mk(monthLabel(m), c, a, x, k));
        const y = m.slice(0, 4), cur = years.get(y) ?? { c: 0, a: 0, x: 0, k: 0 };
        years.set(y, { c: cur.c + c, a: cur.a + a, x: cur.x + x, k: cur.k + k });
      }
      for (const [y, v] of years) rows.push(mk(`TOTAL TAHUN ${y}`, v.c, v.a, v.x, v.k));
      totals = null;
      break;
    }
  }

  return {
    type: t, title: REPORT_META[t].title, description: REPORT_META[t].description, disclaimer: DISCLAIMER, periodLabel,
    generatedAt: new Date().toISOString(), columns, rows, totals,
  };
}
