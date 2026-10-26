import "server-only";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../db";
import { env } from "../env";
import { Errors } from "../errors";
import { parseInput } from "../validate";
import { assertCan, type Actor } from "../actor";
import { dateToIso, isoToDate } from "../json";
import { journalLabel } from "./journals";
import {
  CODE_OPENING_EQUITY, CODE_REVENUE, CODE_UNALLOCATED, balanceSheet, deriveLines, generalLedger, glIncome, groupJournals, trialBalance,
  type BalanceSheet, type GeneralLedger, type GlAccount, type GlIncome, type GlInput, type GlLine, type JournalView, type TrialBalance,
} from "@/lib/accounting/ledger";
import { todayIso } from "@/lib/format";
import { isoDate, uuid } from "@/lib/validation/common";

type Client = PrismaClient | Prisma.TransactionClient;

/** Muat sumber jurnal (≤ `upTo`) lalu turunkan seluruh baris buku besar. */
export async function loadGl(upTo: string, db: Client = prisma): Promise<{ lines: GlLine[]; coa: GlAccount[]; input: GlInput }> {
  const until = isoToDate(upTo);
  const [coa, accounts, payments, entries, transfers, manual] = await Promise.all([
    db.coaAccount.findMany({ orderBy: { code: "asc" } }),
    db.cashAccount.findMany(),
    db.payment.findMany({ where: { paymentDate: { lte: until } }, select: { id: true, paymentDate: true, createdAt: true, amount: true, cashAccountId: true, invoice: { select: { number: true, customerNameSnapshot: true } } } }),
    db.cashEntry.findMany({ where: { status: "APPROVED", entryDate: { lte: until } }, select: { id: true, entryDate: true, createdAt: true, direction: true, amount: true, cashAccountId: true, counterAccountId: true, description: true, entryType: true } }),
    db.cashTransfer.findMany({ where: { transferDate: { lte: until } }, select: { id: true, transferDate: true, createdAt: true, fromAccountId: true, toAccountId: true, amount: true, description: true } }),
    db.journalEntry.findMany({ where: { journalDate: { lte: until } }, include: { lines: { orderBy: { lineNo: "asc" } } } }),
  ]);
  const missing = [CODE_REVENUE, CODE_OPENING_EQUITY, CODE_UNALLOCATED].filter((code) => !coa.some((a) => a.code === code && a.isActive));
  if (missing.length) {
    throw Errors.conflict(`Bagan akun belum siap (akun sistem ${missing.join(", ")} tidak ada atau nonaktif). Buka Pengaturan → Keuangan lalu terapkan bagan akun usulan.`);
  }
  const input: GlInput = {
    coa: coa.map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type })),
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, openingBalance: Number(a.openingBalance), openingDate: dateToIso(a.openingDate), coaAccountId: a.coaAccountId })),
    payments: payments.map((p) => ({ id: p.id, date: dateToIso(p.paymentDate), createdAt: p.createdAt.toISOString(), amount: Number(p.amount), accountId: p.cashAccountId, label: `invoice ${p.invoice.number ?? "—"} — ${p.invoice.customerNameSnapshot}` })),
    entries: entries.map((e) => ({ id: e.id, date: dateToIso(e.entryDate), createdAt: e.createdAt.toISOString(), direction: e.direction, amount: Number(e.amount), accountId: e.cashAccountId, counterAccountId: e.counterAccountId, description: e.description, entryType: e.entryType })),
    transfers: transfers.map((t) => ({ id: t.id, date: dateToIso(t.transferDate), createdAt: t.createdAt.toISOString(), fromId: t.fromAccountId, toId: t.toAccountId, amount: Number(t.amount), description: t.description ?? "Transfer antar akun" })),
    manual: manual.map((j) => ({ id: j.id, label: journalLabel(j.numberSeq), date: dateToIso(j.journalDate), createdAt: j.createdAt.toISOString(), description: j.description, lines: j.lines.map((l) => ({ accountId: l.accountId, debit: Number(l.debit), credit: Number(l.credit), memo: l.memo })) })),
  };
  return { lines: deriveLines(input), coa: input.coa, input };
}

const dateParams = z.object({ from: isoDate.optional(), to: isoDate.optional() });
function range(raw: unknown): { from: string; to: string; today: string } {
  const f = parseInput(dateParams, raw ?? {});
  const today = todayIso(env().APP_TIMEZONE);
  const to = f.to ?? today;
  // Tanpa tanggal awal: 1 Januari pada tahun tanggal akhir (neraca per akhir tahun lalu tidak boleh gagal karena "awal" jatuh di tahun ini).
  const from = f.from ?? `${to.slice(0, 4)}-01-01`;
  if (from > to) throw Errors.validation("Tanggal awal tidak boleh setelah tanggal akhir.", { from: "Harus ≤ tanggal akhir" });
  if (to > today) throw Errors.validation("Tanggal akhir tidak boleh di masa depan.", { to: "Tidak boleh di masa depan" });
  return { from, to, today };
}

export async function getTrialBalance(actor: Actor, raw: unknown = {}): Promise<TrialBalance> {
  assertCan(actor, "finance:view");
  const { to } = range(raw);
  const { lines, coa } = await loadGl(to);
  return trialBalance(lines, coa, to);
}

export async function getBalanceSheet(actor: Actor, raw: unknown = {}): Promise<BalanceSheet> {
  assertCan(actor, "finance:view");
  const { to } = range(raw);
  const { lines, coa } = await loadGl(to);
  return balanceSheet(lines, coa, to);
}

export async function getGlIncomeStatement(actor: Actor, raw: unknown = {}): Promise<GlIncome> {
  assertCan(actor, "finance:view");
  const { from, to } = range(raw);
  const { lines, coa } = await loadGl(to);
  return glIncome(lines, coa, from, to);
}

export const generalLedgerQuerySchema = dateParams.extend({ accountId: uuid });
export async function getGeneralLedger(actor: Actor, raw: unknown): Promise<GeneralLedger> {
  assertCan(actor, "finance:view");
  const q = parseInput(generalLedgerQuerySchema, raw);
  const { from, to } = range({ from: q.from, to: q.to });
  const { lines, coa } = await loadGl(to);
  const account = coa.find((a) => a.id === q.accountId);
  if (!account) throw Errors.notFound("Akun");
  return generalLedger(lines, account, from, to);
}

export interface JournalBookItem extends JournalView { number: string; lines: (JournalView["lines"][number] & { code: string; name: string })[]; total: number }
export interface JournalBookPage { items: JournalBookItem[]; total: number; page: number; pageSize: number; pageCount: number }

/** Buku Jurnal: seluruh jurnal (otomatis dari kas + manual) menurut tanggal, terbaru dulu. */
export async function getJournalBook(actor: Actor, raw: unknown = {}): Promise<JournalBookPage> {
  assertCan(actor, "finance:view");
  const q = parseInput(dateParams.extend({ source: z.enum(["OPENING_CASH", "INVOICE_PAYMENT", "CASH_ENTRY", "TRANSFER", "MANUAL"]).optional(), page: z.coerce.number().int().min(1).optional(), pageSize: z.coerce.number().int().min(1).max(100).optional() }), raw ?? {});
  const { from, to } = range({ from: q.from, to: q.to });
  const { lines, coa } = await loadGl(to);
  const names = new Map(coa.map((a) => [a.id, a]));
  const journals = groupJournals(lines.filter((l) => l.date >= from)).filter((j) => !q.source || j.source === q.source).reverse();
  const pageSize = q.pageSize ?? 25;
  const page = q.page ?? 1;
  const slice = journals.slice((page - 1) * pageSize, page * pageSize);
  return {
    items: slice.map((j) => ({ ...j, number: j.label, total: j.lines.reduce((s, l) => s + l.debit, 0), lines: j.lines.map((l) => ({ ...l, code: names.get(l.accountId)!.code, name: names.get(l.accountId)!.name })) })),
    total: journals.length, page, pageSize, pageCount: Math.max(Math.ceil(journals.length / pageSize), 1),
  };
}
