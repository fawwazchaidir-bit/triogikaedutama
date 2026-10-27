import "server-only";
import { z } from "zod";
import { prisma } from "../db";
import { env } from "../env";
import { Errors } from "../errors";
import { parseInput } from "../validate";
import { assertCan, type Actor } from "../actor";
import { dateToIso } from "../json";
import { loadStmtData } from "./finance-data";
import { getBalanceSheet, getGeneralLedger, getGlIncomeStatement, getTrialBalance, loadGl } from "./finance-ledger";
import type { ReportTable } from "../export";
import { trialBalance } from "@/lib/accounting/ledger";
import { comparativeRange, mergeComparative, type BaseRow } from "@/lib/accounting/compare";
import {
  accountBalance, buildAccountLedger, buildCashFlow, buildIncomeStatement,
  type CashFlowReport, type IncomeStatement, type LedgerMovement, type LedgerRow,
} from "@/lib/accounting/statements";
import { formatDateLong, todayIso } from "@/lib/format";
import { isoDate, uuid } from "@/lib/validation/common";

/**
 * ═══════════ LAPORAN KEUANGAN (basis kas) ═══════════
 * Laporan MANAJEMEN dari data sistem — bukan laporan keuangan SAK EMKM yang lengkap (Catatan atas Laporan Keuangan belum tersedia) dan bukan
 * SPT/laporan pajak. PPN keluaran dipisah sebagai utang PPN, PPh dipotong pelanggan sebagai kredit pajak; PPh badan hanya estimasi sampai dibukukan.
 * Laba rugi, neraca, dan arus kas dapat dibandingkan dengan periode sebelumnya / tahun lalu; semuanya dapat diekspor CSV/Excel/PDF.
 */
export const STATEMENT_TYPES = ["cash-flow", "income-statement", "balance-sheet", "trial-balance", "general-ledger"] as const;
export type StatementType = (typeof STATEMENT_TYPES)[number];

export const COMPARE_MODES = ["none", "previous", "year"] as const;
export const statementQuerySchema = z.object({ from: isoDate.optional(), to: isoDate.optional(), accountId: uuid.optional(), compare: z.enum(COMPARE_MODES).default("none") });

export const STATEMENT_DISCLAIMER =
  "Laporan manajemen BASIS KAS dari buku besar sistem (pendapatan diakui saat uang diterima; beban saat dibayar; tanpa piutang/utang usaha). Disusun mengikuti struktur SAK EMKM " +
  "namun BUKAN laporan keuangan resmi lengkap (Catatan atas Laporan Keuangan belum ada) dan bukan SPT/laporan pajak: PPN keluaran dicatat sebagai utang PPN, PPh 23 yang dipotong pelanggan sebagai kredit pajak, " +
  "dan PPh badan hanya muncul bila jurnal estimasinya sudah dibukukan. Tinjau dengan akuntan sebelum dipakai ke pihak eksternal.";

function range(raw: unknown): { from: string; to: string; today: string } {
  const f = parseInput(statementQuerySchema, raw ?? {});
  const today = todayIso(env().APP_TIMEZONE);
  const to = f.to ?? today;
  // Tanpa tanggal awal: 1 Januari pada tahun tanggal akhir (neraca per akhir tahun lalu tidak boleh gagal karena "awal" jatuh di tahun ini).
  const from = f.from ?? `${to.slice(0, 4)}-01-01`;
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

// ───────────────────────────── Kecocokan arus kas ↔ neraca ─────────────────────────────

export interface CashTieOut { asOf: string; cashFlowEnding: number; ledgerCash: number; difference: number; ok: boolean }

/** Saldo kas & bank akhir menurut laporan arus kas harus sama dengan saldo akun kas/bank di buku besar (neraca) pada tanggal yang sama. */
export async function computeCashTieOut(from: string, to: string, db: typeof prisma = prisma): Promise<CashTieOut> {
  const [stmt, gl, accts] = await Promise.all([loadStmtData(to, db), loadGl(to, db), db.cashAccount.findMany({ select: { coaAccountId: true } })]);
  const net = new Map(trialBalance(gl.lines, gl.coa, to).rows.map((r) => [r.accountId, r.net]));
  const ledgerCash = [...new Set(accts.map((a) => a.coaAccountId))].reduce((sum, id) => sum + (net.get(id) ?? 0), 0);
  const cashFlowEnding = buildCashFlow(stmt, from, to).ending;
  return { asOf: to, cashFlowEnding, ledgerCash, difference: cashFlowEnding - ledgerCash, ok: cashFlowEnding === ledgerCash };
}

export async function getCashTieOut(actor: Actor, raw: unknown = {}): Promise<CashTieOut> {
  assertCan(actor, "finance:view");
  const { from, to } = range(raw);
  return computeCashTieOut(from, to);
}

// ───────────────────────────── Tabel untuk ekspor CSV/XLSX/PDF ─────────────────────────────

type Row = Record<string, string | number | null>;
const head = (label: string): Row => ({ item: label, amount: null, kind: "head" });
const line = (label: string, amount: number): Row => ({ item: label, amount, kind: label.startsWith("   ") ? "line" : "total" });
const note = (label: string, amount: number): Row => ({ item: label, amount, kind: "note" });
const lines = (ls: { code: string | null; name: string; amount: number }[], neg = false): Row[] =>
  ls.map((l) => line(`   ${l.code ? `${l.code} ` : ""}${l.name}`, neg ? -l.amount : l.amount));
const tieOutRows = (t: CashTieOut): Row[] => [
  head("Pemeriksaan silang kas"),
  line("   Saldo kas & bank akhir menurut laporan arus kas", t.cashFlowEnding),
  line("   Saldo akun kas/bank menurut buku besar (neraca)", t.ledgerCash),
  line(t.ok ? "Selisih (harus 0) ✓ cocok" : "Selisih (harus 0) — TIDAK COCOK, hubungi Administrator", t.difference),
];

async function buildStatement(actor: Actor, type: StatementType, p: { from: string; to: string; accountId?: string }): Promise<ReportTable> {
  const { from, to, accountId } = p;
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
      ...lines(r.operating.otherOperating),
      line("Kas neto dari aktivitas operasi", r.operating.net),
      head("Arus kas dari aktivitas investasi"), ...lines(r.investing.lines), line("Kas neto dari aktivitas investasi", r.investing.net),
      head("Arus kas dari aktivitas pendanaan"), ...lines(r.financing.lines), line("Kas neto dari aktivitas pendanaan", r.financing.net),
      line("Kenaikan (penurunan) kas neto", r.netChange),
      line("Saldo kas & bank awal periode", r.beginning),
      line("Saldo awal akun yang mulai dicatat dalam periode", r.newOpening),
      line("Saldo kas & bank akhir periode", r.ending),
      ...tieOutRows(await computeCashTieOut(from, to)),
      head("Rincian per akun"),
      ...r.accounts.map((a) => line(`   ${a.name}: awal ${a.beginning + a.newOpening} → akhir`, a.ending)),
    ];
    if (r.notInBalances !== 0) rows.push(note("Catatan: penerimaan invoice yang tidak masuk saldo akun mana pun (belum dialokasikan / sebelum saldo awal)", r.notInBalances));
    return { type, title: "Laporan Arus Kas (Basis Kas)", description: "Arus kas operasi, investasi, pendanaan dan rekonsiliasi saldo kas & bank.", columns, rows, ...base };
  }
  if (type === "income-statement") {
    const r = await getGlIncomeStatement(actor, { from, to });
    const rows: Row[] = [
      head("Pendapatan usaha"), ...lines(r.revenue), line("Jumlah pendapatan usaha", r.totalRevenue),
      head("Beban langsung program"), ...lines(r.directCosts), line("Jumlah beban langsung program", r.totalDirectCosts),
      line("Laba kotor program", r.grossProfit),
      head("Beban operasional"), ...lines(r.operatingCosts), line("Jumlah beban operasional", r.totalOperatingCosts),
      line("Laba (rugi) usaha", r.operatingProfit),
      head("Pendapatan lain-lain"), ...lines(r.otherIncome), line("Jumlah pendapatan lain-lain", r.totalOtherIncome),
      line("Laba (rugi) bersih sebelum pajak penghasilan", r.profitBeforeTax),
    ];
    if (r.incomeTax.length) rows.push(head("Beban pajak penghasilan"), ...lines(r.incomeTax), line("Laba (rugi) bersih setelah pajak penghasilan", r.netProfit));
    const tx = await getIncomeStatement(actor, { from, to });
    if (tx.vatCollected !== 0) rows.push(note("Catatan: PPN yang diterima pada periode ini (dikeluarkan dari pendapatan; utang PPN 2-1210)", tx.vatCollected));
    if (tx.withheldByCustomers !== 0) rows.push(note("Catatan: PPh yang dipotong pelanggan pada periode ini (termasuk pendapatan; kredit pajak 1-1400)", tx.withheldByCustomers));
    return { type, title: "Laporan Laba Rugi (Basis Kas)", description: "Dari buku besar: pendapatan diakui saat uang diterima; beban saat dibayar.", columns, rows, ...base };
  }
  if (type === "balance-sheet") {
    const r = await getBalanceSheet(actor, { to });
    const rows: Row[] = [
      head("ASET"), head("Aset lancar"), ...lines(r.currentAssets), head("Aset tetap"), ...lines(r.fixedAssets), ...(r.otherAssets.length ? [head("Aset lainnya"), ...lines(r.otherAssets)] : []),
      line("Jumlah aset", r.totalAssets),
      head("LIABILITAS"), head("Liabilitas jangka pendek"), ...lines(r.shortTermLiabilities), head("Liabilitas jangka panjang"), ...lines(r.longTermLiabilities), ...(r.otherLiabilities.length ? lines(r.otherLiabilities) : []),
      line("Jumlah liabilitas", r.totalLiabilities),
      head("EKUITAS"), ...lines(r.equity), line("   Saldo laba tahun-tahun sebelumnya (hasil usaha)", r.retainedEarningsPrior), line("   Laba (rugi) tahun berjalan", r.currentYearProfit),
      line("Jumlah ekuitas", r.totalEquity), line("Jumlah liabilitas dan ekuitas", r.totalLiabilities + r.totalEquity),
      line("Selisih (aset − liabilitas − ekuitas); harus 0", r.difference),
      ...tieOutRows(await computeCashTieOut(`${to.slice(0, 4)}-01-01`, to)),
    ];
    return { type, title: "Laporan Posisi Keuangan / Neraca (Basis Kas)", description: `Per ${formatDateLong(to)}`, columns, rows, ...base, periodLabel: `Per ${formatDateLong(to)}` };
  }
  if (type === "trial-balance") {
    const r = await getTrialBalance(actor, { to });
    return {
      type, title: "Neraca Saldo", description: "Saldo seluruh akun; total debit harus sama dengan total kredit.",
      columns: [{ key: "code", label: "Kode", type: "text" as const, width: 10 }, { key: "name", label: "Nama akun", type: "text" as const, width: 52 }, { key: "debit", label: "Debit (Rp)", type: "money" as const, width: 20 }, { key: "credit", label: "Kredit (Rp)", type: "money" as const, width: 20 }],
      rows: r.rows.map((x) => ({ code: x.code, name: x.name, debit: x.debit, credit: x.credit })),
      ...base, periodLabel: `Per ${formatDateLong(to)}`, totals: { code: "TOTAL", name: null, debit: r.totalDebit, credit: r.totalCredit },
    };
  }
  // general-ledger
  if (!accountId) throw Errors.validation("Pilih akun untuk buku besar.", { accountId: "Wajib dipilih" });
  const g = await getGeneralLedger(actor, { accountId, from, to });
  return {
    type, title: `Buku Besar — ${g.account.code} ${g.account.name}`, description: "Mutasi akun dengan saldo berjalan menurut sisi normal akun.",
    columns: [{ key: "date", label: "Tanggal", type: "date" as const, width: 13 }, { key: "ref", label: "Sumber", type: "text" as const, width: 26 }, { key: "desc", label: "Uraian", type: "text" as const, width: 48 }, { key: "debit", label: "Debit (Rp)", type: "money" as const, width: 18 }, { key: "credit", label: "Kredit (Rp)", type: "money" as const, width: 18 }, { key: "balance", label: "Saldo (Rp)", type: "money" as const, width: 18 }],
    rows: [{ date: g.from, ref: "", desc: "Saldo awal periode", debit: null, credit: null, balance: g.opening }, ...g.rows.map((r) => ({ date: r.date, ref: r.sourceLabel, desc: r.description, debit: r.debit || null, credit: r.credit || null, balance: r.balance }))],
    ...base, totals: { date: "TOTAL", ref: null, desc: null, debit: g.totalDebit, credit: g.totalCredit, balance: g.closing },
  };
}

/** Laporan sebagai tabel generik (UI, CSV, Excel, PDF). `compare` menambah kolom pembanding, selisih, dan persen untuk laba rugi, neraca, arus kas. */
export async function runStatement(actor: Actor, type: string, raw: unknown = {}): Promise<ReportTable> {
  assertCan(actor, "finance:view");
  if (!(STATEMENT_TYPES as readonly string[]).includes(type)) throw Errors.notFound("Laporan");
  const { from, to } = range(raw);
  const q = parseInput(statementQuerySchema, raw ?? {});
  const t = type as StatementType;
  const cur = await buildStatement(actor, t, { from, to, accountId: q.accountId });
  const comparable = t === "income-statement" || t === "balance-sheet" || t === "cash-flow";
  if (!comparable || q.compare === "none") return cur;

  const prevRange = comparativeRange(t === "balance-sheet" ? "asof" : "range", from, to, q.compare);
  const prev = await buildStatement(actor, t, prevRange);
  // Rincian per akun (uraian memuat angka) tidak dapat dibandingkan baris demi baris.
  const strip = (rows: Row[]) => { const k = rows.findIndex((r) => r.item === "Rincian per akun"); return k < 0 ? rows : rows.slice(0, k); };
  const asBase = (rows: Row[]): BaseRow[] => rows.map((r) => ({ item: String(r.item), amount: (r.amount as number | null) ?? null, kind: r.kind as BaseRow["kind"] }));
  const merged = mergeComparative(asBase(strip(cur.rows)), asBase(strip(prev.rows)));
  const prevLabel = t === "balance-sheet" ? `Per ${formatDateLong(prevRange.to)}` : `${formatDateLong(prevRange.from)} – ${formatDateLong(prevRange.to)}`;
  return {
    ...cur,
    description: `${cur.description} Dibandingkan dengan ${prevLabel}.`,
    columns: [
      { key: "item", label: "Uraian", type: "text", width: 50 },
      { key: "amount", label: `Periode ini (Rp)`, type: "money", width: 18 },
      { key: "prev", label: `Pembanding (Rp)`, type: "money", width: 18 },
      { key: "change", label: "Selisih (Rp)", type: "money", width: 18 },
      { key: "pct", label: "Perubahan (%)", type: "number", width: 12 },
    ],
    rows: merged.map((r) => ({ item: r.item, kind: r.kind, amount: r.amount, prev: r.prev, change: r.change, pct: r.changeBps === null ? null : r.changeBps / 100 })),
    compareLabel: prevLabel,
  };
}
