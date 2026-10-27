import "server-only";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma, transaction, type Tx } from "../db";
import { env } from "../env";
import { Errors } from "../errors";
import { parseInput } from "../validate";
import { assertCan, type Actor } from "../actor";
import { writeAudit } from "../audit";
import { dateToIso, isoToDate } from "../json";
import { createEntry } from "./cash-entries";
import {
  CSV_MAX_CHARS, detectMapping, parseCsv, parseStatementLines, type CsvMapping, type ParsedLine,
} from "@/lib/accounting/bank-csv";
import { itemKey, reconSummary, suggestMatches, type BookItem, type ReconSummary } from "@/lib/accounting/bank-match";
import { CASH_AMOUNT_MAX } from "@/lib/accounting/limits";
import { formatRupiah } from "@/lib/finance/money";
import { isValidIsoDate } from "@/lib/finance/due-date";
import { todayIso } from "@/lib/format";
import { isoDate, optionalText, requiredText, uuid } from "@/lib/validation/common";

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * ═══════════ REKONSILIASI BANK ═══════════
 * Rekening koran (impor CSV) dicocokkan dengan transaksi buku akun kas/bank yang sama:
 *   selisih = saldo akhir bank + transaksi buku yang belum cocok (≤ akhir periode) − saldo buku pada akhir periode  → harus 0 untuk difinalisasi.
 *  • Pencocokan 1 baris ↔ n transaksi (setoran gabungan); satu transaksi hanya dapat dicocokkan SEKALI per akun (unik di DB).
 *  • Baris yang tidak ada di buku (biaya admin, bunga, penerimaan belum dicatat) dicatat sebagai entri kas LALU dicocokkan.
 *  • Rekening koran FINALIZED tidak dapat diubah; hanya yang terakhir pada akun itu yang dapat dibuka kembali (alasan wajib).
 */

// ───────────────────────────── Tipe ─────────────────────────────
export interface BookItemDto extends BookItem { matchedIn: "THIS" | "EARLIER" | "LATER" | null }
export interface StatementLineDto {
  id: string; lineNo: number; txDate: string; description: string; reference: string | null; amount: number; matched: number;
  matches: { id: string; itemKey: string; label: string; amount: number; method: "AUTO" | "MANUAL" }[];
}
export interface StatementSummaryDto {
  id: string; cashAccountId: string; accountName: string; periodStart: string; periodEnd: string; openingBalance: number; closingBalance: number;
  label: string | null; status: "DRAFT" | "FINALIZED"; lineCount: number; unmatchedLines: number; finalizedAt: string | null; finalizedByName: string | null; reopenReason: string | null; createdAt: string;
}
export interface StatementWorkspace {
  statement: StatementSummaryDto;
  lines: StatementLineDto[];
  /** Transaksi buku (≤ akhir periode) yang belum dicocokkan pada rekening koran ini maupun sebelumnya. */
  outstanding: BookItemDto[];
  summary: ReconSummary & { unmatchedLines: number; canFinalize: boolean; problems: string[] };
}

// ───────────────────────────── Transaksi buku sebuah akun ─────────────────────────────
interface AccountBook { account: { id: string; name: string; openingBalance: number; openingDate: string; kind: "KAS" | "BANK"; isActive: boolean }; items: BookItem[] }

export async function loadAccountBook(db: Client, accountId: string, upTo: string): Promise<AccountBook> {
  const acct = await db.cashAccount.findUnique({ where: { id: accountId } });
  if (!acct) throw Errors.notFound("Akun kas/bank");
  const lo = acct.openingDate, hi = isoToDate(upTo);
  const [payments, entries, transfers] = await Promise.all([
    db.payment.findMany({ where: { cashAccountId: accountId, paymentDate: { gte: lo, lte: hi } }, select: { id: true, paymentDate: true, createdAt: true, amount: true, reference: true, entryType: true, invoice: { select: { number: true, customerNameSnapshot: true } } } }),
    db.cashEntry.findMany({ where: { cashAccountId: accountId, status: "APPROVED", entryDate: { gte: lo, lte: hi } }, select: { id: true, entryDate: true, createdAt: true, direction: true, amount: true, description: true, reference: true, payee: true, entryType: true } }),
    db.cashTransfer.findMany({ where: { OR: [{ fromAccountId: accountId }, { toAccountId: accountId }], transferDate: { gte: lo, lte: hi } }, select: { id: true, transferDate: true, createdAt: true, amount: true, fromAccountId: true, description: true, reference: true, entryType: true, fromAccount: { select: { name: true } }, toAccount: { select: { name: true } } } }),
  ]);
  const items: BookItem[] = [
    ...payments.map((p): BookItem => ({
      type: "PAYMENT", id: p.id, date: dateToIso(p.paymentDate), createdAt: p.createdAt.toISOString(), amount: Number(p.amount),
      label: `${p.entryType === "REVERSAL" ? "Pembalikan pembayaran" : "Pembayaran"} invoice ${p.invoice.number ?? "—"} — ${p.invoice.customerNameSnapshot}`,
      hint: `${p.invoice.number ?? ""} ${p.invoice.customerNameSnapshot} ${p.reference ?? ""}`,
    })),
    ...entries.map((e): BookItem => ({
      type: "CASH_ENTRY", id: e.id, date: dateToIso(e.entryDate), createdAt: e.createdAt.toISOString(), amount: (e.direction === "IN" ? 1 : -1) * Number(e.amount),
      label: e.description, hint: `${e.description} ${e.reference ?? ""} ${e.payee ?? ""}`,
    })),
    ...transfers.map((t): BookItem => ({
      type: "TRANSFER", id: t.id, date: dateToIso(t.transferDate), createdAt: t.createdAt.toISOString(), amount: (t.fromAccountId === accountId ? -1 : 1) * Number(t.amount),
      label: `${t.entryType === "REVERSAL" ? "Pembalikan transfer" : "Transfer"} ${t.fromAccount.name} → ${t.toAccount.name}`, hint: `${t.description ?? ""} ${t.reference ?? ""}`,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  return { account: { id: acct.id, name: acct.name, openingBalance: Number(acct.openingBalance), openingDate: dateToIso(acct.openingDate), kind: acct.kind, isActive: acct.isActive }, items };
}
export const bookBalance = (b: AccountBook, upTo: string) => b.account.openingBalance + b.items.filter((i) => i.date <= upTo).reduce((s, i) => s + i.amount, 0);

// ───────────────────────────── Impor CSV ─────────────────────────────
const mappingSchema = z.object({
  hasHeader: z.boolean(),
  date: z.number().int().min(0).max(50), description: z.number().int().min(0).max(50), reference: z.number().int().min(0).max(50).nullable(),
  amount: z.number().int().min(0).max(50).nullable(), debit: z.number().int().min(0).max(50).nullable(), credit: z.number().int().min(0).max(50).nullable(),
  dateFormat: z.enum(["DMY", "YMD", "MDY"]), numberFormat: z.enum(["ID", "EN"]),
}).refine((m) => m.amount !== null || (m.debit !== null && m.credit !== null), "Pilih kolom jumlah, atau kolom debit dan kredit");

const csvInputSchema = z.object({ text: z.string().min(1, "Berkas kosong").max(CSV_MAX_CHARS, "Berkas terlalu besar (maksimal 1 MB)"), mapping: mappingSchema.optional() });
export interface CsvPreview { delimiter: string; headers: string[]; mapping: CsvMapping; sample: ParsedLine[]; lineCount: number; sum: number; errors: { row: number; message: string }[]; firstDate: string | null; lastDate: string | null }

export async function previewStatementCsv(actor: Actor, raw: unknown): Promise<CsvPreview> {
  assertCan(actor, "bank:reconcile");
  const input = parseInput(csvInputSchema, raw);
  const { delimiter, rows } = parseCsv(input.text);
  if (rows.length === 0) throw Errors.validation("Berkas tidak berisi baris data.", { text: "Kosong" });
  const mapping = input.mapping ?? detectMapping(rows);
  const parsed = parseStatementLines(rows, mapping);
  const dates = parsed.lines.map((l) => l.txDate).sort();
  return {
    delimiter, headers: (mapping.hasHeader ? rows[0] : rows[0]?.map((_, i) => `Kolom ${i + 1}`)) ?? [], mapping, sample: parsed.lines.slice(0, 15), lineCount: parsed.lines.length,
    sum: parsed.lines.reduce((s, l) => s + l.amount, 0), errors: parsed.errors.slice(0, 20), firstDate: dates[0] ?? null, lastDate: dates.at(-1) ?? null,
  };
}

// ───────────────────────────── Rekening koran ─────────────────────────────
const money = (label: string) => z.number({ error: `${label} harus berupa angka` }).int(`${label} harus bilangan bulat Rupiah`).min(-CASH_AMOUNT_MAX * 100).max(CASH_AMOUNT_MAX * 100);
export const statementCreateSchema = z.object({
  cashAccountId: uuid,
  periodStart: isoDate.refine(isValidIsoDate, "Tanggal tidak valid"),
  periodEnd: isoDate.refine(isValidIsoDate, "Tanggal tidak valid"),
  openingBalance: money("Saldo awal bank"),
  closingBalance: money("Saldo akhir bank"),
  label: optionalText(80, "Label"),
  csv: csvInputSchema.optional(),
  lines: z.array(z.object({
    txDate: isoDate.refine(isValidIsoDate, "Tanggal tidak valid"), description: requiredText(1, 300, "Uraian"), reference: optionalText(120, "Referensi"),
    amount: z.number().int().refine((n) => n !== 0 && Math.abs(n) <= CASH_AMOUNT_MAX, "Nominal tidak sah"),
  })).max(5000).optional(),
});

function toSummary(s: Prisma.BankStatementGetPayload<{ include: { cashAccount: { select: { name: true } }; finalizedBy: { select: { name: true } }; lines: { select: { id: true; amount: true } } } }>, matchedByLine: Map<string, number>): StatementSummaryDto {
  return {
    id: s.id, cashAccountId: s.cashAccountId, accountName: s.cashAccount.name, periodStart: dateToIso(s.periodStart), periodEnd: dateToIso(s.periodEnd),
    openingBalance: Number(s.openingBalance), closingBalance: Number(s.closingBalance), label: s.label, status: s.status, lineCount: s.lines.length,
    unmatchedLines: s.lines.filter((l) => (matchedByLine.get(l.id) ?? 0) !== Number(l.amount)).length,
    finalizedAt: s.finalizedAt?.toISOString() ?? null, finalizedByName: s.finalizedBy?.name ?? null, reopenReason: s.reopenReason, createdAt: s.createdAt.toISOString(),
  };
}
const summaryInclude = { cashAccount: { select: { name: true } }, finalizedBy: { select: { name: true } }, lines: { select: { id: true, amount: true } } } as const;

async function matchedSums(db: Client, statementIds: string[]): Promise<Map<string, number>> {
  const ms = await db.bankMatch.groupBy({ by: ["lineId"], where: { statementId: { in: statementIds } }, _sum: { amount: true } });
  return new Map(ms.map((m) => [m.lineId, Number(m._sum.amount ?? 0n)]));
}

export async function listStatements(actor: Actor, query: { cashAccountId?: string } = {}): Promise<StatementSummaryDto[]> {
  assertCan(actor, "finance:view");
  const rows = await prisma.bankStatement.findMany({ where: query.cashAccountId ? { cashAccountId: query.cashAccountId } : {}, include: summaryInclude, orderBy: [{ periodEnd: "desc" }, { createdAt: "desc" }], take: 200 });
  const sums = await matchedSums(prisma, rows.map((r) => r.id));
  return rows.map((r) => toSummary(r, sums));
}

export interface AccountReconOverview {
  accountId: string; name: string; kind: "KAS" | "BANK"; isActive: boolean; openingDate: string;
  lastFinalizedEnd: string | null; lastClosing: number | null; draftCount: number;
  /** Awal periode berikutnya yang disarankan & saldo awal bank yang disarankan (= saldo akhir terakhir). */
  nextStart: string; suggestedOpening: number | null;
}
export async function getReconOverview(actor: Actor): Promise<AccountReconOverview[]> {
  assertCan(actor, "finance:view");
  const accounts = await prisma.cashAccount.findMany({ where: { isActive: true }, orderBy: [{ kind: "asc" }, { name: "asc" }] });
  const sts = await prisma.bankStatement.findMany({ select: { cashAccountId: true, status: true, periodStart: true, periodEnd: true, closingBalance: true }, orderBy: { periodEnd: "asc" } });
  const addDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return accounts.map((a) => {
    const mine = sts.filter((s) => s.cashAccountId === a.id);
    const fin = mine.filter((s) => s.status === "FINALIZED");
    const last = mine.at(-1);
    return {
      accountId: a.id, name: a.name, kind: a.kind, isActive: a.isActive, openingDate: dateToIso(a.openingDate),
      lastFinalizedEnd: fin.at(-1) ? dateToIso(fin.at(-1)!.periodEnd) : null, lastClosing: fin.at(-1) ? Number(fin.at(-1)!.closingBalance) : null,
      draftCount: mine.filter((s) => s.status === "DRAFT").length,
      nextStart: last ? addDay(dateToIso(last.periodEnd)) : dateToIso(a.openingDate), suggestedOpening: last ? Number(last.closingBalance) : null,
    };
  });
}

export async function createStatement(actor: Actor, raw: unknown): Promise<StatementSummaryDto> {
  assertCan(actor, "bank:reconcile");
  const input = parseInput(statementCreateSchema, raw);
  const today = todayIso(env().APP_TIMEZONE);
  if (input.periodStart > input.periodEnd) throw Errors.validation("Awal periode tidak boleh setelah akhir periode.", { periodStart: "Harus ≤ akhir periode" });
  if (input.periodEnd > today) throw Errors.validation("Akhir periode tidak boleh di masa depan.", { periodEnd: "Tidak boleh di masa depan" });
  if (!!input.csv === !!input.lines) throw Errors.validation("Isi mutasi lewat berkas CSV ATAU daftar baris (salah satu).", { csv: "Pilih salah satu" });

  let lines: ParsedLine[];
  if (input.csv) {
    const { rows } = parseCsv(input.csv.text);
    const parsed = parseStatementLines(rows, input.csv.mapping ?? detectMapping(rows));
    if (parsed.errors.length) {
      const e = parsed.errors.slice(0, 3).map((x) => `baris ${x.row}: ${x.message}`).join("; ");
      throw Errors.validation(`Berkas CSV bermasalah (${parsed.errors.length} baris) — ${e}${parsed.errors.length > 3 ? "; …" : ""}`, { csv: "Periksa pemetaan kolom & format" });
    }
    lines = parsed.lines;
  } else {
    lines = input.lines!.map((l, i) => ({ lineNo: i + 1, txDate: l.txDate, description: l.description, reference: l.reference, amount: l.amount }));
  }
  const out = lines.filter((l) => l.txDate < input.periodStart || l.txDate > input.periodEnd);
  if (out.length) throw Errors.validation(`${out.length} baris bertanggal di luar periode ${input.periodStart} s.d. ${input.periodEnd} (mis. ${out[0]!.txDate}).`, { csv: "Tanggal di luar periode" });
  const sum = lines.reduce((s, l) => s + l.amount, 0);
  if (input.openingBalance + sum !== input.closingBalance) {
    throw Errors.validation(`Mutasi tidak cocok dengan saldo: saldo awal ${formatRupiah(input.openingBalance, "PLAIN")} + mutasi ${formatRupiah(sum, "PLAIN")} = ${formatRupiah(input.openingBalance + sum, "PLAIN")}, bukan saldo akhir ${formatRupiah(input.closingBalance, "PLAIN")} (selisih ${formatRupiah(input.closingBalance - input.openingBalance - sum, "PLAIN")}). Periksa berkas lengkap/pemetaan kolom.`, { closingBalance: "Tidak cocok dengan mutasi" });
  }

  const id = await transaction(async (tx) => {
    const acct = await tx.cashAccount.findUnique({ where: { id: input.cashAccountId } });
    if (!acct) throw Errors.notFound("Akun kas/bank");
    if (input.periodStart < dateToIso(acct.openingDate)) throw Errors.validation(`Periode mendahului tanggal saldo awal akun (${dateToIso(acct.openingDate)}).`, { periodStart: `Minimal ${dateToIso(acct.openingDate)}` });
    const overlap = await tx.bankStatement.findFirst({ where: { cashAccountId: acct.id, periodStart: { lte: isoToDate(input.periodEnd) }, periodEnd: { gte: isoToDate(input.periodStart) } } });
    if (overlap) throw Errors.conflict(`Periode tumpang tindih dengan rekening koran ${dateToIso(overlap.periodStart)} s.d. ${dateToIso(overlap.periodEnd)}.`);
    const prev = await tx.bankStatement.findFirst({ where: { cashAccountId: acct.id, periodEnd: isoToDate(new Date(Date.parse(`${input.periodStart}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)) } });
    if (prev && Number(prev.closingBalance) !== input.openingBalance) {
      throw Errors.validation(`Saldo awal harus sama dengan saldo akhir rekening koran sebelumnya (${formatRupiah(Number(prev.closingBalance), "PLAIN")}).`, { openingBalance: "Tidak menyambung dengan periode sebelumnya" });
    }
    const s = await tx.bankStatement.create({
      data: {
        cashAccountId: acct.id, periodStart: isoToDate(input.periodStart), periodEnd: isoToDate(input.periodEnd), openingBalance: BigInt(input.openingBalance), closingBalance: BigInt(input.closingBalance),
        label: input.label, createdById: actor.userId,
        lines: { create: lines.map((l) => ({ lineNo: l.lineNo, txDate: isoToDate(l.txDate), description: l.description, reference: l.reference, amount: BigInt(l.amount) })) },
      },
    });
    await writeAudit(tx, actor, {
      action: "bank.statement_create", entityType: "BankStatement", entityId: s.id,
      summary: `Rekening koran ${acct.name} ${input.periodStart} s.d. ${input.periodEnd} diimpor (${lines.length} baris)`,
      after: { account: acct.name, periodStart: input.periodStart, periodEnd: input.periodEnd, opening: input.openingBalance, closing: input.closingBalance, lines: lines.length, source: input.csv ? "CSV" : "MANUAL" },
    });
    return s.id;
  });
  return (await listStatements(actor)).find((x) => x.id === id)!;
}

// ───────────────────────────── Ruang kerja ─────────────────────────────
async function buildWorkspace(db: Client, id: string): Promise<StatementWorkspace> {
  const s = await db.bankStatement.findUnique({ where: { id }, include: { ...summaryInclude, lines: { orderBy: { lineNo: "asc" }, include: { matches: true } } } });
  if (!s) throw Errors.notFound("Rekening koran");
  const end = dateToIso(s.periodEnd), start = dateToIso(s.periodStart);
  const book = await loadAccountBook(db, s.cashAccountId, end);
  const all = await db.bankMatch.findMany({ where: { cashAccountId: s.cashAccountId }, include: { statement: { select: { periodStart: true } } } });
  const byKey = new Map(all.map((m) => [`${m.sourceType}:${m.sourceId}`, m]));
  const itemByKey = new Map(book.items.map((i) => [itemKey(i), i]));
  const lines: StatementLineDto[] = s.lines.map((l) => ({
    id: l.id, lineNo: l.lineNo, txDate: dateToIso(l.txDate), description: l.description, reference: l.reference, amount: Number(l.amount), matched: l.matches.reduce((a, m) => a + Number(m.amount), 0),
    matches: l.matches.map((m) => ({ id: m.id, itemKey: `${m.sourceType}:${m.sourceId}`, label: itemByKey.get(`${m.sourceType}:${m.sourceId}`)?.label ?? "(transaksi)", amount: Number(m.amount), method: m.method })),
  }));
  const outstanding: BookItemDto[] = [];
  for (const it of book.items) {
    const m = byKey.get(itemKey(it));
    const where = !m ? null : m.statementId === s.id ? "THIS" : m.statement.periodStart < s.periodStart ? "EARLIER" : "LATER";
    if (where === null || where === "LATER") outstanding.push({ ...it, matchedIn: where });
  }
  const sum = reconSummary(Number(s.closingBalance), bookBalance(book, end), outstanding);
  const unmatchedLines = lines.filter((l) => l.matched !== l.amount).length;
  const problems: string[] = [];
  if (unmatchedLines > 0) problems.push(`${unmatchedLines} baris mutasi belum dicocokkan`);
  if (sum.difference !== 0) problems.push(`Selisih rekonsiliasi ${formatRupiah(sum.difference, "PLAIN")}`);
  if (Number(s.openingBalance) + lines.reduce((a, l) => a + l.amount, 0) !== Number(s.closingBalance)) problems.push("Mutasi tidak cocok dengan saldo awal/akhir");
  void start;
  return {
    statement: toSummary(s, new Map(lines.map((l) => [l.id, l.matched]))),
    lines, outstanding, summary: { ...sum, unmatchedLines, canFinalize: s.status === "DRAFT" && problems.length === 0, problems },
  };
}
export async function getStatementWorkspace(actor: Actor, id: string): Promise<StatementWorkspace> {
  assertCan(actor, "finance:view");
  uuid.parse(id);
  return buildWorkspace(prisma, id);
}

async function lockStatement(tx: Tx, id: string): Promise<{ status: "DRAFT" | "FINALIZED"; cashAccountId: string }> {
  const r = await tx.$queryRaw<{ status: "DRAFT" | "FINALIZED"; cashAccountId: string }[]>`SELECT "status", "cashAccountId" FROM bank_statements WHERE id = ${id}::uuid FOR UPDATE`;
  if (r.length === 0) throw Errors.notFound("Rekening koran");
  return r[0]!;
}
const requireDraft = (st: { status: string }) => { if (st.status !== "DRAFT") throw Errors.conflict("Rekening koran sudah difinalisasi. Buka kembali (alasan wajib) untuk mengubah pencocokan."); };

// ───────────────────────────── Pencocokan ─────────────────────────────
export const autoMatchSchema = z.object({ windowDays: z.number().int().min(0).max(14).default(5) });
export async function autoMatchStatement(actor: Actor, id: string, raw: unknown = {}): Promise<{ matched: number; unmatchedLines: number }> {
  assertCan(actor, "bank:reconcile");
  uuid.parse(id);
  const { windowDays } = parseInput(autoMatchSchema, raw ?? {});
  return transaction(async (tx) => {
    requireDraft(await lockStatement(tx, id));
    const ws = await buildWorkspace(tx, id);
    const suggestions = suggestMatches(
      ws.lines.map((l) => ({ id: l.id, date: l.txDate, amount: l.amount, description: l.description, reference: l.reference, matched: l.matched })),
      ws.outstanding.filter((i) => i.matchedIn === null), windowDays,
    );
    for (const sug of suggestions) {
      await tx.bankMatch.create({ data: { statementId: id, lineId: sug.lineId, cashAccountId: ws.statement.cashAccountId, sourceType: sug.item.type, sourceId: sug.item.id, amount: BigInt(sug.item.amount), method: "AUTO", matchedById: actor.userId } });
    }
    await writeAudit(tx, actor, { action: "bank.auto_match", entityType: "BankStatement", entityId: id, summary: `Pencocokan otomatis: ${suggestions.length} baris dicocokkan`, after: { matched: suggestions.length, windowDays } });
    return { matched: suggestions.length, unmatchedLines: ws.summary.unmatchedLines - suggestions.length };
  });
}

export const matchLineSchema = z.object({ items: z.array(z.object({ type: z.enum(["PAYMENT", "CASH_ENTRY", "TRANSFER"]), id: uuid })).min(1, "Pilih minimal satu transaksi").max(50) });
export async function matchLine(actor: Actor, lineId: string, raw: unknown): Promise<void> {
  assertCan(actor, "bank:reconcile");
  uuid.parse(lineId);
  const { items } = parseInput(matchLineSchema, raw);
  await transaction(async (tx) => {
    const line = await tx.bankStatementLine.findUnique({ where: { id: lineId } });
    if (!line) throw Errors.notFound("Baris mutasi");
    requireDraft(await lockStatement(tx, line.statementId));
    const ws = await buildWorkspace(tx, line.statementId);
    const l = ws.lines.find((x) => x.id === lineId)!;
    const free = new Map(ws.outstanding.filter((i) => i.matchedIn === null).map((i) => [itemKey(i), i]));
    if (new Set(items.map((i) => itemKey(i))).size !== items.length) throw Errors.validation("Transaksi dipilih ganda.", { items: "Ada transaksi ganda" });
    const picked = items.map((i) => {
      const it = free.get(itemKey(i));
      if (!it) throw Errors.conflict("Transaksi tidak tersedia: sudah dicocokkan, bukan milik akun ini, atau bertanggal setelah akhir periode.");
      return it;
    });
    const total = picked.reduce((s, i) => s + i.amount, 0);
    const remaining = l.amount - l.matched;
    if (total !== remaining) {
      throw Errors.validation(`Jumlah transaksi (${formatRupiah(total, "PLAIN")}) harus sama dengan sisa nilai baris (${formatRupiah(remaining, "PLAIN")}).`, { items: "Jumlah tidak sama dengan sisa baris" });
    }
    for (const it of picked) {
      await tx.bankMatch.create({ data: { statementId: line.statementId, lineId, cashAccountId: ws.statement.cashAccountId, sourceType: it.type, sourceId: it.id, amount: BigInt(it.amount), method: "MANUAL", matchedById: actor.userId } });
    }
    await writeAudit(tx, actor, { action: "bank.match", entityType: "BankStatement", entityId: line.statementId, summary: `Baris ${l.lineNo} (${formatRupiah(l.amount, "PLAIN")}) dicocokkan dengan ${picked.length} transaksi`, after: { lineId, items: picked.map((i) => itemKey(i)) } });
  });
}

export async function unmatchLine(actor: Actor, lineId: string): Promise<void> {
  assertCan(actor, "bank:reconcile");
  uuid.parse(lineId);
  await transaction(async (tx) => {
    const line = await tx.bankStatementLine.findUnique({ where: { id: lineId } });
    if (!line) throw Errors.notFound("Baris mutasi");
    requireDraft(await lockStatement(tx, line.statementId));
    const del = await tx.bankMatch.deleteMany({ where: { lineId } });
    if (del.count === 0) throw Errors.conflict("Baris ini belum dicocokkan.");
    await writeAudit(tx, actor, { action: "bank.unmatch", entityType: "BankStatement", entityId: line.statementId, summary: `Pencocokan baris ${line.lineNo} dilepas (${del.count} transaksi)`, after: { lineId } });
  });
}

export const entryForLineSchema = z.object({ counterAccountId: uuid, description: optionalText(300, "Uraian"), proofFileId: z.preprocess((v) => (v === "" ? undefined : v ?? undefined), uuid.optional()) });
/** Baris yang tidak ada di buku (biaya admin, bunga, penerimaan/pengeluaran belum dicatat) → entri kas (tanggal & nominal = baris) lalu dicocokkan. */
export async function createEntryForLine(actor: Actor, lineId: string, raw: unknown): Promise<void> {
  assertCan(actor, "bank:reconcile");
  uuid.parse(lineId);
  const input = parseInput(entryForLineSchema, raw);
  const line = await prisma.bankStatementLine.findUnique({ where: { id: lineId }, include: { statement: true, matches: true } });
  if (!line) throw Errors.notFound("Baris mutasi");
  requireDraft(line.statement);
  const remaining = Number(line.amount) - line.matches.reduce((s, m) => s + Number(m.amount), 0);
  if (remaining === 0) throw Errors.conflict("Baris ini sudah dicocokkan penuh.");
  const description = input.description ?? line.description;
  const entry = await createEntry(actor, {
    entryDate: dateToIso(line.txDate), cashAccountId: line.statement.cashAccountId, counterAccountId: input.counterAccountId, direction: remaining > 0 ? "IN" : "OUT",
    amount: Math.abs(remaining), description: description.length >= 3 ? description : `${description} (mutasi bank)`, reference: line.reference ?? undefined, proofFileId: input.proofFileId,
  });
  if (entry.status !== "APPROVED") throw Errors.conflict("Entri menunggu persetujuan dan belum dapat dicocokkan.");
  await matchLine(actor, lineId, { items: [{ type: "CASH_ENTRY", id: entry.id }] });
}

// ───────────────────────────── Siklus hidup ─────────────────────────────
export async function deleteStatement(actor: Actor, id: string): Promise<void> {
  assertCan(actor, "bank:reconcile");
  uuid.parse(id);
  await transaction(async (tx) => {
    requireDraft(await lockStatement(tx, id));
    const s = await tx.bankStatement.findUniqueOrThrow({ where: { id }, include: { cashAccount: { select: { name: true } } } });
    await tx.bankStatement.delete({ where: { id } });
    await writeAudit(tx, actor, { action: "bank.statement_delete", entityType: "BankStatement", entityId: id, summary: `Rekening koran DRAFT ${s.cashAccount.name} ${dateToIso(s.periodStart)} s.d. ${dateToIso(s.periodEnd)} dihapus` });
  });
}

export async function finalizeStatement(actor: Actor, id: string): Promise<StatementWorkspace> {
  assertCan(actor, "bank:reconcile");
  uuid.parse(id);
  await transaction(async (tx) => {
    requireDraft(await lockStatement(tx, id));
    const ws = await buildWorkspace(tx, id);
    if (!ws.summary.canFinalize) throw Errors.conflict(`Belum dapat difinalisasi: ${ws.summary.problems.join("; ")}.`);
    await tx.bankStatement.update({ where: { id }, data: { status: "FINALIZED", finalizedAt: new Date(), finalizedById: actor.userId } });
    await writeAudit(tx, actor, {
      action: "bank.finalize", entityType: "BankStatement", entityId: id,
      summary: `Rekonsiliasi ${ws.statement.accountName} ${ws.statement.periodStart} s.d. ${ws.statement.periodEnd} difinalisasi (saldo bank ${formatRupiah(ws.summary.closing, "PLAIN")}, saldo buku ${formatRupiah(ws.summary.bookBalance, "PLAIN")})`,
      after: { closing: ws.summary.closing, bookBalance: ws.summary.bookBalance, outstandingNet: ws.summary.outstandingNet, outstandingItems: ws.outstanding.length },
    });
  });
  return buildWorkspace(prisma, id);
}

export const reopenSchema = z.object({ reason: z.string().trim().min(5, "Alasan minimal 5 karakter").max(300) });
export async function reopenStatement(actor: Actor, id: string, raw: unknown): Promise<StatementWorkspace> {
  assertCan(actor, "bank:reconcile");
  uuid.parse(id);
  const { reason } = parseInput(reopenSchema, raw);
  await transaction(async (tx) => {
    const st = await lockStatement(tx, id);
    if (st.status !== "FINALIZED") throw Errors.conflict("Rekening koran belum difinalisasi.");
    const later = await tx.bankStatement.findFirst({ where: { cashAccountId: st.cashAccountId, status: "FINALIZED", periodStart: { gt: (await tx.bankStatement.findUniqueOrThrow({ where: { id } })).periodEnd } } });
    if (later) throw Errors.conflict("Sudah ada rekening koran berikutnya yang difinalisasi: buka kembali yang terakhir lebih dulu.");
    await tx.bankStatement.update({ where: { id }, data: { status: "DRAFT", finalizedAt: null, finalizedById: null, reopenReason: reason } });
    await writeAudit(tx, actor, { action: "bank.reopen", entityType: "BankStatement", entityId: id, summary: "Rekonsiliasi dibuka kembali", reason });
  });
  return buildWorkspace(prisma, id);
}
