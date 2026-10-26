import "server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma, transaction } from "../db";
import { env } from "../env";
import { Errors } from "../errors";
import { parseInput } from "../validate";
import { assertCan, type Actor } from "../actor";
import { writeAudit } from "../audit";
import { assertBooksOpen } from "./books-lock";
import { dateToIso, isoToDate } from "../json";
import { CASH_AMOUNT_MAX } from "@/lib/accounting/limits";
import { RESERVED_JOURNAL_CODES } from "@/lib/accounting/ledger";
import { isValidIsoDate } from "@/lib/finance/due-date";
import { formatRupiah } from "@/lib/finance/money";
import { todayIso } from "@/lib/format";
import { isoDate, optionalText, requiredText, uuid } from "@/lib/validation/common";
import type { Paged } from "@/lib/types";

/**
 * ═══════════ JURNAL MANUAL ═══════════
 * Untuk penyesuaian yang tidak lahir dari modul kas: penyusutan, koreksi, pajak, saldo awal akun non-kas (aset tetap, utang, modal).
 *  • Seimbang (Σ debit = Σ kredit), ≥ 2 akun berbeda; tiap baris tepat satu sisi positif.
 *  • Tidak boleh menyentuh akun yang dipetakan ke kas/bank (saldo kas hanya bergerak lewat modul kas) maupun akun cadangan:
 *    4-1100 pendapatan invoice, 1-1450 penampung, 3-2200 laba tahun berjalan (dihitung di neraca).
 *  • Berlaku langsung; setelah itu append-only — koreksi = jurnal pembalik bertanggal hari ini (alasan wajib).
 *  • Jurnal SALDO AWAL (OPENING): hanya akun neraca, tepat pada tanggal mulai pembukuan (saldo awal akun kas tertua).
 */
const RESERVED_CODES = new Set(RESERVED_JOURNAL_CODES);
export const journalLabel = (n: number) => `JU-${String(n).padStart(6, "0")}`;

export const journalInputSchema = z.object({
  kind: z.enum(["GENERAL", "OPENING"]).default("GENERAL"),
  journalDate: isoDate.refine(isValidIsoDate, "Tanggal tidak valid"),
  description: requiredText(3, 300, "Keterangan"),
  reference: optionalText(120, "Referensi"),
  lines: z.array(z.object({
    accountId: uuid,
    debit: z.number({ error: "Debit harus berupa angka" }).int("Debit harus bilangan bulat Rupiah").min(0, "Debit tidak boleh negatif").max(CASH_AMOUNT_MAX, "Nominal melebihi batas wajar"),
    credit: z.number({ error: "Kredit harus berupa angka" }).int("Kredit harus bilangan bulat Rupiah").min(0, "Kredit tidak boleh negatif").max(CASH_AMOUNT_MAX, "Nominal melebihi batas wajar"),
    memo: optionalText(200, "Catatan baris"),
  })).min(2, "Jurnal minimal dua baris").max(40, "Jurnal maksimal 40 baris"),
});

export interface JournalLineDto { accountId: string; code: string; name: string; debit: number; credit: number; memo: string | null }
export interface JournalDto {
  id: string; number: string; kind: "GENERAL" | "OPENING"; entryType: "ENTRY" | "REVERSAL"; reversesJournalId: string | null; reversedByJournalId: string | null;
  journalDate: string; description: string; reference: string | null; reason: string | null; createdByName: string; createdAt: string;
  lines: JournalLineDto[]; total: number;
}

const include = {
  createdBy: { select: { name: true } }, reversal: { select: { id: true } },
  lines: { orderBy: { lineNo: "asc" }, include: { account: { select: { code: true, name: true } } } },
} satisfies Prisma.JournalEntryInclude;
type Row = Prisma.JournalEntryGetPayload<{ include: typeof include }>;

export const toJournalDto = (j: Row): JournalDto => ({
  id: j.id, number: journalLabel(j.numberSeq), kind: j.kind, entryType: j.entryType, reversesJournalId: j.reversesJournalId, reversedByJournalId: j.reversal?.id ?? null,
  journalDate: dateToIso(j.journalDate), description: j.description, reference: j.reference, reason: j.reason, createdByName: j.createdBy.name, createdAt: j.createdAt.toISOString(),
  lines: j.lines.map((l) => ({ accountId: l.accountId, code: l.account.code, name: l.account.name, debit: Number(l.debit), credit: Number(l.credit), memo: l.memo })),
  total: j.lines.reduce((s, l) => s + Number(l.debit), 0),
});

/** Tanggal mulai pembukuan = saldo awal akun kas/bank tertua. */
export async function bookkeepingStart(db: Pick<typeof prisma, "cashAccount"> = prisma): Promise<string | null> {
  const r = await db.cashAccount.aggregate({ _min: { openingDate: true } });
  return r._min.openingDate ? dateToIso(r._min.openingDate) : null;
}

export async function createJournal(actor: Actor, raw: unknown): Promise<JournalDto> {
  assertCan(actor, "journal:record");
  const input = parseInput(journalInputSchema, raw);
  const today = todayIso(env().APP_TIMEZONE);
  if (input.journalDate > today) throw Errors.validation("Tanggal jurnal tidak boleh di masa depan.", { journalDate: "Tidak boleh di masa depan" });

  // Aturan baris & keseimbangan (pesan jelas sebelum menyentuh database).
  input.lines.forEach((l, i) => {
    if ((l.debit > 0) === (l.credit > 0)) throw Errors.validation(`Baris ${i + 1}: isi tepat salah satu — debit atau kredit (lebih dari 0).`, { [`lines.${i}`]: "Isi debit ATAU kredit" });
  });
  const totalDebit = input.lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = input.lines.reduce((s, l) => s + l.credit, 0);
  if (totalDebit !== totalCredit) {
    throw Errors.validation(`Jurnal tidak seimbang: debit ${formatRupiah(totalDebit, "PLAIN")} ≠ kredit ${formatRupiah(totalCredit, "PLAIN")}.`, { lines: "Debit dan kredit harus sama" });
  }
  if (new Set(input.lines.map((l) => l.accountId)).size < 2) throw Errors.validation("Jurnal harus melibatkan minimal dua akun berbeda.", { lines: "Minimal dua akun berbeda" });

  const id = await transaction(async (tx) => {
    const start = await bookkeepingStart(tx);
    if (!start) throw Errors.conflict("Belum ada akun kas/bank. Tambahkan akun beserta saldo awal di Pengaturan → Keuangan sebelum membuat jurnal.");
    await assertBooksOpen(tx, input.journalDate, "jurnal", "journalDate");
    if (input.journalDate < start) throw Errors.validation(`Tanggal mendahului tanggal mulai pembukuan (${start}).`, { journalDate: `Minimal ${start}` });
    if (input.kind === "OPENING" && input.journalDate !== start) throw Errors.validation(`Jurnal saldo awal harus bertanggal tepat pada tanggal mulai pembukuan (${start}).`, { journalDate: `Harus ${start}` });

    const accounts = await tx.coaAccount.findMany({ where: { id: { in: input.lines.map((l) => l.accountId) } } });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const cashCoa = new Set((await tx.cashAccount.findMany({ select: { coaAccountId: true } })).map((c) => c.coaAccountId));
    input.lines.forEach((l, i) => {
      const a = byId.get(l.accountId);
      const key = `lines.${i}.accountId`;
      if (!a || !a.isActive) throw Errors.validation(`Baris ${i + 1}: akun tidak ditemukan atau tidak aktif.`, { [key]: "Pilih akun aktif" });
      if (cashCoa.has(a.id)) throw Errors.validation(`Baris ${i + 1}: akun ${a.code} dipetakan ke kas/bank dan tidak boleh dijurnal manual — gunakan modul Kas & Bank.`, { [key]: "Akun kas/bank: pakai modul kas" });
      if (RESERVED_CODES.has(a.code)) throw Errors.validation(`Baris ${i + 1}: akun ${a.code} dicadangkan (dicatat/dihitung otomatis) dan tidak boleh dijurnal manual.`, { [key]: "Akun dicadangkan" });
      if (input.kind === "OPENING" && (a.type === "PENDAPATAN" || a.type === "BEBAN")) throw Errors.validation(`Baris ${i + 1}: jurnal saldo awal hanya boleh memuat akun neraca (aset, liabilitas, ekuitas).`, { [key]: "Hanya akun neraca" });
    });

    const j = await tx.journalEntry.create({
      data: {
        kind: input.kind, journalDate: isoToDate(input.journalDate), description: input.description, reference: input.reference, createdById: actor.userId,
        lines: { create: input.lines.map((l, i) => ({ lineNo: i + 1, accountId: l.accountId, debit: BigInt(l.debit), credit: BigInt(l.credit), memo: l.memo })) },
      },
    });
    await writeAudit(tx, actor, {
      action: "journal.create", entityType: "JournalEntry", entityId: j.id,
      summary: `Jurnal ${journalLabel(j.numberSeq)}${input.kind === "OPENING" ? " (saldo awal)" : ""}: ${input.description} — ${formatRupiah(totalDebit, "PLAIN")}`,
      after: { number: journalLabel(j.numberSeq), kind: input.kind, date: input.journalDate, total: totalDebit, lines: input.lines.map((l) => ({ account: byId.get(l.accountId)!.code, debit: l.debit, credit: l.credit })) },
    });
    return j.id;
  });
  return toJournalDto(await prisma.journalEntry.findUniqueOrThrow({ where: { id }, include }));
}

export const journalReverseSchema = z.object({ reason: z.string().trim().min(5, "Alasan minimal 5 karakter").max(300) });

/** Koreksi = jurnal pembalik bertanggal hari ini (debit ↔ kredit), sekali saja. */
export async function reverseJournal(actor: Actor, id: string, raw: unknown): Promise<JournalDto> {
  assertCan(actor, "expense:void");
  assertCan(actor, "journal:record");
  uuid.parse(id);
  const { reason } = parseInput(journalReverseSchema, raw);
  const today = todayIso(env().APP_TIMEZONE);
  const newId = await transaction(async (tx) => {
    const lock = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM journal_entries WHERE id = ${id}::uuid FOR UPDATE`;
    if (lock.length === 0) throw Errors.notFound("Jurnal");
    const o = await tx.journalEntry.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
    if (o.entryType !== "ENTRY") throw Errors.conflict("Hanya jurnal asli yang dapat dibalikkan.");
    if (await tx.journalEntry.findUnique({ where: { reversesJournalId: id }, select: { id: true } })) throw Errors.conflict("Jurnal ini sudah pernah dibalikkan.");
    const r = await tx.journalEntry.create({
      data: {
        kind: o.kind, entryType: "REVERSAL", reversesJournalId: o.id, journalDate: isoToDate(today), description: `Pembalikan: ${o.description}`.slice(0, 300),
        reference: o.reference, reason, createdById: actor.userId,
        lines: { create: o.lines.map((l) => ({ lineNo: l.lineNo, accountId: l.accountId, debit: l.credit, credit: l.debit, memo: l.memo })) },
      },
    });
    await writeAudit(tx, actor, {
      action: "journal.reverse", entityType: "JournalEntry", entityId: o.id, summary: `Jurnal ${journalLabel(o.numberSeq)} dibalikkan (${journalLabel(r.numberSeq)})`,
      before: { date: dateToIso(o.journalDate) }, after: { reversalId: r.id, date: today }, reason,
    });
    return r.id;
  });
  return toJournalDto(await prisma.journalEntry.findUniqueOrThrow({ where: { id: newId }, include }));
}

export async function listManualJournals(actor: Actor, query: { from?: string; to?: string; page?: number; pageSize?: number } = {}): Promise<Paged<JournalDto>> {
  assertCan(actor, "finance:view");
  const where: Prisma.JournalEntryWhereInput = query.from || query.to
    ? { journalDate: { ...(query.from ? { gte: isoToDate(query.from) } : {}), ...(query.to ? { lte: isoToDate(query.to) } : {}) } } : {};
  const pageSize = Math.min(Math.max(query.pageSize ?? 25, 1), 100);
  const page = Math.max(query.page ?? 1, 1);
  const [total, rows] = await Promise.all([
    prisma.journalEntry.count({ where }),
    prisma.journalEntry.findMany({ where, include, orderBy: [{ journalDate: "desc" }, { numberSeq: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  return { items: rows.map(toJournalDto), total, page, pageSize, pageCount: Math.max(Math.ceil(total / pageSize), 1) };
}
