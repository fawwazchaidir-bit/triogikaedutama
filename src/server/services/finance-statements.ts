import "server-only";
import { z } from "zod";
import { prisma } from "../db";
import { env } from "../env";
import { Errors } from "../errors";
import { parseInput } from "../validate";
import { assertCan, type Actor } from "../actor";
import { dateToIso } from "../json";
import { loadStmtData } from "./finance-data";
import type { ReportTable } from "../export";
import {
  accountBalance, buildAccountLedger, buildCashFlow, buildIncomeStatement,
  type CashFlowReport, type IncomeStatement, type LedgerMovement, type LedgerRow,
} from "@/lib/accounting/statements";
import { formatDateLong, todayIso } from "@/lib/format";
import { isoDate, uuid } from "@/lib/validation/common";

/**
 * ═══════════ LAPORAN KEUANGAN (basis kas) ═══════════
 * Laporan MANAJEMEN dari data sistem — bukan laporan keuangan SAK EMKM yang lengkap (Laporan Posisi Keuangan/Neraca dan
 * Catatan belum tersedia) dan bukan SPT/laporan pajak. Pajak (PPN, PPh 23 dipotong pelanggan, PPh badan) belum dipisah.
 */
export const STATEMENT_TYPES = ["cash-flow", "income-statement"] as const;
export type StatementType = (typeof STATEMENT_TYPES)[number];

export const statementQuerySchema = z.object({ from: isoDate.optional(), to: isoDate.optional() });

export const STATEMENT_DISCLAIMER =
  "Laporan manajemen BASIS KAS dari data sistem (pendapatan diakui saat uang diterima; beban saat dibayar). Bukan laporan keuangan SAK EMKM lengkap " +
  "(Laporan Posisi Keuangan belum tersedia) dan bukan laporan pajak: PPN, PPh 23 yang dipotong pelanggan, dan PPh badan belum dipisahkan. Tinjau dengan akuntan sebelum dipakai ke pihak eksternal.";

function range(raw: unknown): { from: string; to: string; today: string } {
  const f = parseInput(statementQuerySchema, raw ?? {});
  const today = todayIso(env().APP_TIMEZONE);
  const from = f.from ?? `${today.slice(0, 4)}-01-01`;
  const to = f.to ?? today;
  if (from > to) throw Errors.validation("Tanggal awal tidak boleh setelah tanggal akhir.", { from: "Harus ≤ tanggal akhir" });
  if (to > today) throw Errors.validation("Tanggal akhir tidak boleh di masa depan.", { to: "Tidak boleh di masa depan" });
  return { from, to, today };
}

export interface FinanceWarnings { negativeAccounts: { id: string; name: string; balance: number }[]; unallocatedPayments: number; pendingExpenses: number }

/** Peringatan integritas data kas (ditampilkan di halaman Kas & Bank dan Laporan Keuangan). */
export async function getFinanceWarnings(actor: Actor): Promise<FinanceWarnings> {
  assertCan(actor, "finance:view");
  const today = todayIso(env().APP_TIMEZONE);
  const [data, unallocated, pending] = await Promise.all([
    loadStmtData(today),
    prisma.payment.count({ where: { cashAccountId: null, entryType: "PAYMENT" } }),
    prisma.cashEntry.count({ where: { status: "PENDING" } }),
  ]);
  const negativeAccounts = data.accounts
    .map((a) => ({ id: a.id, name: a.name, balance: accountBalance(a, data, today) }))
    .filter((a) => a.balance < 0);
  return { negativeAccounts, unallocatedPayments: unallocated, pendingExpenses: pending };
}

export async function getCashFlow(actor: Actor, raw: unknown = {}): Promise<CashFlowReport> {
  assertCan(actor, "finance:view");
  const { from, to } = range(raw);
  return buildCashFlow(await loadStmtData(to), from, to);
}

export async function getIncomeStatement(actor: Actor, raw: unknown = {}): Promise<IncomeStatement> {
  assertCan(actor, "finance:view");
  const { from, to } = range(raw);
  return buildIncomeStatement(await loadStmtData(to), from, to);
}

export const ledgerQuerySchema = z.object({ accountId: uuid, from: isoDate.optional(), to: isoDate.optional() });

export interface AccountLedgerDto { account: { id: string; name: string; kind: "KAS" | "BANK"; openingBalance: number; openingDate: string }; from: string; to: string; opening: number; rows: LedgerRow[]; closing: number }

/** Buku kas satu akun: seluruh mutasi (pembayaran invoice, entri disetujui, transfer) dengan saldo berjalan. */
export async function getAccountLedger(actor: Actor, raw: unknown): Promise<AccountLedgerDto> {
  assertCan(actor, "finance:view");
  const q = parseInput(ledgerQuerySchema, raw);
  const today = todayIso(env().APP_TIMEZONE);
  const from = q.from ?? `${today.slice(0, 4)}-01-01`;
  const to = q.to ?? today;
  if (from > to) throw Errors.validation("Tanggal awal tidak boleh setelah tanggal akhir.", { from: "Harus ≤ tanggal akhir" });
  const acc = await prisma.cashAccount.findUnique({ where: { id: q.accountId } });
  if (!acc) throw Errors.notFound("Akun kas/bank");
  const [payments, entries, transfers] = await Promise.all([
    prisma.payment.findMany({ where: { cashAccountId: acc.id }, include: { invoice: { select: { number: true, customerNameSnapshot: true } } } }),
    prisma.cashEntry.findMany({ where: { cashAccountId: acc.id, status: "APPROVED" }, include: { counterAccount: { select: { code: true, name: true } } } }),
    prisma.cashTransfer.findMany({ where: { OR: [{ fromAccountId: acc.id }, { toAccountId: acc.id }] }, include: { fromAccount: { select: { name: true } }, toAccount: { select: { name: true } } } }),
  ]);
  const movements: LedgerMovement[] = [
    ...payments.map((p): LedgerMovement => ({
      date: dateToIso(p.paymentDate), order: `${p.createdAt.toISOString()}${p.id}`, kind: "INVOICE_PAYMENT", signed: Number(p.amount), ref: p.invoiceId,
      description: `${p.entryType === "REVERSAL" ? "Pembalikan pembayaran" : "Pembayaran invoice"} ${p.invoice.number ?? ""} — ${p.invoice.customerNameSnapshot}`.trim(),
    })),
    ...entries.map((e): LedgerMovement => ({
      date: dateToIso(e.entryDate), order: `${e.createdAt.toISOString()}${e.id}`, kind: "ENTRY", signed: e.direction === "IN" ? Number(e.amount) : -Number(e.amount), ref: e.id,
      description: `${e.counterAccount.code} ${e.counterAccount.name} — ${e.description}`,
    })),
    ...transfers.map((t): LedgerMovement => {
      const incoming = t.toAccountId === acc.id;
      return {
        date: dateToIso(t.transferDate), order: `${t.createdAt.toISOString()}${t.id}`, kind: incoming ? "TRANSFER_IN" : "TRANSFER_OUT", ref: t.id,
        signed: incoming ? Number(t.amount) : -Number(t.amount),
        description: incoming ? `Transfer dari ${t.fromAccount.name}${t.description ? ` — ${t.description}` : ""}` : `Transfer ke ${t.toAccount.name}${t.description ? ` — ${t.description}` : ""}`,
      };
    }),
  ];
  const stmtAcc = { id: acc.id, name: acc.name, kind: acc.kind, openingBalance: Number(acc.openingBalance), openingDate: dateToIso(acc.openingDate) };
  const l = buildAccountLedger(stmtAcc, movements, from, to);
  return { account: stmtAcc, from, to, opening: l.opening, rows: l.rows, closing: l.closing };
}

// ───────────────────────────── Tabel untuk ekspor CSV/XLSX ─────────────────────────────

type Row = Record<string, string | number | null>;
const head = (label: string): Row => ({ item: label, amount: null });
const line = (label: string, amount: number): Row => ({ item: label, amount });
const lines = (ls: { code: string | null; name: string; amount: number }[], neg = false): Row[] =>
  ls.map((l) => line(`   ${l.code ? `${l.code} ` : ""}${l.name}`, neg ? -l.amount : l.amount));

export async function runStatement(actor: Actor, type: string, raw: unknown = {}): Promise<ReportTable> {
  assertCan(actor, "finance:view");
  if (!(STATEMENT_TYPES as readonly string[]).includes(type)) throw Errors.notFound("Laporan");
  const { from, to } = range(raw);
  const periodLabel = `${formatDateLong(from)} – ${formatDateLong(to)}`;
  const base = { disclaimer: STATEMENT_DISCLAIMER, periodLabel, generatedAt: new Date().toISOString(), totals: null };
  const columns = [{ key: "item", label: "Uraian", type: "text" as const, width: 58 }, { key: "amount", label: "Jumlah (Rp)", type: "money" as const, width: 22 }];

  if (type === "cash-flow") {
    const r = buildCashFlow(await loadStmtData(to), from, to);
    const rows: Row[] = [
      head("Arus kas dari aktivitas operasi"),
      line("   Penerimaan dari invoice (pembayaran pelanggan, neto pembalikan)", r.operating.invoiceReceipts),
      ...lines(r.operating.otherIncome),
      ...lines(r.operating.expenses),
      line("Kas neto dari aktivitas operasi", r.operating.net),
      head("Arus kas dari aktivitas investasi"), ...lines(r.investing.lines), line("Kas neto dari aktivitas investasi", r.investing.net),
      head("Arus kas dari aktivitas pendanaan"), ...lines(r.financing.lines), line("Kas neto dari aktivitas pendanaan", r.financing.net),
      line("Kenaikan (penurunan) kas neto", r.netChange),
      line("Saldo kas & bank awal periode", r.beginning),
      line("Saldo awal akun yang mulai dicatat dalam periode", r.newOpening),
      line("Saldo kas & bank akhir periode", r.ending),
      head("Rincian per akun"),
      ...r.accounts.map((a) => line(`   ${a.name}: awal ${a.beginning + a.newOpening} → akhir`, a.ending)),
    ];
    if (r.notInBalances !== 0) rows.push(line("Catatan: penerimaan invoice yang tidak masuk saldo akun mana pun (belum dialokasikan / sebelum saldo awal)", r.notInBalances));
    return { type, title: "Laporan Arus Kas (Basis Kas)", description: "Arus kas operasi, investasi, pendanaan dan rekonsiliasi saldo kas & bank.", columns, rows, ...base };
  }
  const r = buildIncomeStatement(await loadStmtData(to), from, to);
  const rows: Row[] = [
    line("Pendapatan usaha (penerimaan invoice, neto pembalikan)", r.revenue),
    head("Beban langsung program"), ...lines(r.directCosts), line("Jumlah beban langsung program", r.totalDirectCosts),
    line("Laba kotor program", r.grossProfit),
    head("Beban operasional"), ...lines(r.operatingCosts), line("Jumlah beban operasional", r.totalOperatingCosts),
    line("Laba (rugi) usaha", r.operatingProfit),
    head("Pendapatan lain-lain"), ...lines(r.otherIncome), line("Jumlah pendapatan lain-lain", r.totalOtherIncome),
    line("Laba (rugi) bersih sebelum pajak penghasilan", r.netProfitBeforeTax),
  ];
  if (r.receiptsOnTaxedInvoices !== 0) rows.push(line("Catatan: penerimaan atas invoice yang memuat pajak (belum dipisah dari pendapatan)", r.receiptsOnTaxedInvoices));
  return { type, title: "Laporan Laba Rugi (Basis Kas)", description: "Pendapatan diakui saat uang diterima; beban saat dibayar.", columns, rows, ...base };
}
