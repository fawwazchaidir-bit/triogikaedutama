import "server-only";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma, transaction, type Tx } from "../db";
import { env } from "../env";
import { Errors } from "../errors";
import { parseInput } from "../validate";
import { actorCan, assertCan, type Actor } from "../actor";
import { writeAudit } from "../audit";
import { dateToIso, isoToDate } from "../json";
import { shareLockCashAccount } from "./cash-accounts";
import { CASH_AMOUNT_MAX, PROOF_REQUIRED_ABOVE } from "@/lib/accounting/limits";
import { isValidIsoDate } from "@/lib/finance/due-date";
import { formatRupiah } from "@/lib/finance/money";
import { todayIso } from "@/lib/format";
import { isoDate, optionalText, requiredText, rupiah, uuid } from "@/lib/validation/common";
import type { Paged } from "@/lib/types";
import type { CashEntryDto, CashTransferDto } from "@/lib/finance-types";
import { assertBooksOpen } from "./books-lock";

/**
 * ═══════════ ENTRI KAS MANUAL (basis kas) ═══════════
 *  • Pengeluaran (akun lawan BEBAN, arah OUT) dicatat Staff → MENUNGGU persetujuan Finance Manager; dicatat penyetuju → langsung berlaku.
 *  • Penerimaan lain / investasi / pendanaan: hanya penyetuju (`cash:record`), langsung berlaku.
 *  • Hanya entri APPROVED yang masuk saldo & laporan. Setelah berlaku entri TIDAK PERNAH diubah/dihapus (trigger DB);
 *    koreksi = baris REVERSAL bertanggal hari pembalikan (histori & periode lampau tetap utuh).
 *  • Tanggal entri ≥ tanggal saldo awal akun dan tidak boleh di masa depan.
 *  • Saldo negatif TIDAK diblokir (pencatatan bisa terlambat) tetapi ditandai sebagai peringatan di halaman Kas & Bank.
 */

const emptyToNull = (v: unknown) => (v === "" ? null : v ?? null);

const cashAmount = (label: string) => rupiah(label).min(1, `${label} harus lebih dari 0`).max(CASH_AMOUNT_MAX, `${label} melebihi batas wajar`);

export const entryInputSchema = z.object({
  entryDate: isoDate.refine(isValidIsoDate, "Tanggal tidak valid"),
  cashAccountId: uuid,
  counterAccountId: uuid,
  direction: z.enum(["IN", "OUT"]).default("OUT"),
  amount: cashAmount("Nominal"),
  description: requiredText(3, 300, "Keterangan"),
  payee: optionalText(120, "Penerima/pemberi"),
  reference: optionalText(120, "No. bukti"),
  proofFileId: z.preprocess(emptyToNull, uuid.nullable()),
});

const entryInclude = {
  cashAccount: { select: { name: true } },
  counterAccount: { select: { code: true, name: true, type: true } },
  createdBy: { select: { name: true } },
  approvedBy: { select: { name: true } },
  rejectedBy: { select: { name: true } },
  reversal: { select: { id: true } },
} satisfies Prisma.CashEntryInclude;
type EntryRow = Prisma.CashEntryGetPayload<{ include: typeof entryInclude }>;

export const toEntryDto = (e: EntryRow): CashEntryDto => ({
  id: e.id, entryType: e.entryType, reversesEntryId: e.reversesEntryId, reversedByEntryId: e.reversal?.id ?? null,
  entryDate: dateToIso(e.entryDate), direction: e.direction, amount: Number(e.amount),
  cashAccountId: e.cashAccountId, cashAccountName: e.cashAccount.name,
  counterAccountId: e.counterAccountId, counterCode: e.counterAccount.code, counterName: e.counterAccount.name, counterType: e.counterAccount.type,
  description: e.description, payee: e.payee, reference: e.reference, proofFileId: e.proofFileId,
  status: e.status, reason: e.reason, createdById: e.createdById, createdByName: e.createdBy.name, createdAt: e.createdAt.toISOString(),
  approvedByName: e.approvedBy?.name ?? null, approvedAt: e.approvedAt?.toISOString() ?? null,
  rejectedByName: e.rejectedBy?.name ?? null, rejectedAt: e.rejectedAt?.toISOString() ?? null, rejectionReason: e.rejectionReason,
});

async function lockEntry(tx: Tx, id: string): Promise<void> {
  const r = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM cash_entries WHERE id = ${id}::uuid FOR UPDATE`;
  if (r.length === 0) throw Errors.notFound("Entri kas");
}

const rp = (n: number) => formatRupiah(n, "PLAIN");

export async function createEntry(actor: Actor, raw: unknown): Promise<CashEntryDto> {
  if (!actorCan(actor, "expense:record") && !actorCan(actor, "cash:record")) throw Errors.forbidden();
  const input = parseInput(entryInputSchema, raw);
  const today = todayIso(env().APP_TIMEZONE);
  if (input.entryDate > today) throw Errors.validation("Tanggal tidak boleh di masa depan.", { entryDate: "Tidak boleh di masa depan" });

  const id = await transaction(async (tx) => {
    await assertBooksOpen(tx, input.entryDate, "entri kas", "entryDate");
    const counter = await tx.coaAccount.findUnique({ where: { id: input.counterAccountId } });
    if (!counter || !counter.isActive || !counter.manualEntry) {
      throw Errors.validation("Akun kategori tidak tersedia untuk pencatatan manual.", { counterAccountId: "Pilih kategori yang tersedia" });
    }
    if (await tx.cashAccount.findFirst({ where: { coaAccountId: counter.id }, select: { id: true } })) {
      throw Errors.validation("Akun kategori ini dipetakan ke akun kas/bank. Gunakan transfer antar akun.", { counterAccountId: "Pilih kategori yang tersedia" });
    }
    const isExpense = counter.type === "BEBAN";
    // Izin menurut jenis entri (ditegakkan di service, bukan hanya UI).
    assertCan(actor, isExpense ? "expense:record" : "cash:record");
    if (isExpense && input.direction !== "OUT") throw Errors.validation("Pengeluaran harus berarah keluar. Koreksi dilakukan lewat pembalikan.", { direction: "Pengeluaran = keluar" });
    if (counter.type === "PENDAPATAN" && input.direction !== "IN") throw Errors.validation("Pendapatan harus berarah masuk.", { direction: "Pendapatan = masuk" });

    // Bukti transaksi wajib untuk setiap uang KELUAR di atas ambang (pengeluaran, pembelian aset, prive, pembayaran pinjaman).
    if (input.direction === "OUT" && input.amount > PROOF_REQUIRED_ABOVE && !input.proofFileId) {
      throw Errors.validation(`Pengeluaran di atas ${rp(PROOF_REQUIRED_ABOVE)} wajib melampirkan bukti transaksi.`, { proofFileId: `Bukti wajib untuk pengeluaran di atas ${rp(PROOF_REQUIRED_ABOVE)}` });
    }
    await shareLockCashAccount(tx, input.cashAccountId);
    const acct = await tx.cashAccount.findUniqueOrThrow({ where: { id: input.cashAccountId } });
    if (!acct.isActive) throw Errors.validation("Akun kas/bank tidak aktif.", { cashAccountId: "Pilih akun aktif" });
    if (input.entryDate < dateToIso(acct.openingDate)) {
      throw Errors.validation(`Tanggal mendahului saldo awal akun (${dateToIso(acct.openingDate)}).`, { entryDate: `Minimal ${dateToIso(acct.openingDate)}` });
    }
    if (input.proofFileId) {
      const f = await tx.storedFile.findUnique({ where: { id: input.proofFileId }, select: { kind: true, uploadedById: true } });
      if (f?.kind !== "EXPENSE_PROOF" || f.uploadedById !== actor.userId) throw Errors.validation("Bukti tidak valid.", { proofFileId: "File tidak valid" });
    }

    const approvedDirectly = actorCan(actor, "expense:approve");
    const now = new Date();
    const e = await tx.cashEntry.create({
      data: {
        entryDate: isoToDate(input.entryDate), direction: input.direction, amount: BigInt(input.amount),
        cashAccountId: acct.id, counterAccountId: counter.id, description: input.description, payee: input.payee, reference: input.reference,
        proofFileId: input.proofFileId, createdById: actor.userId,
        ...(approvedDirectly ? { status: "APPROVED", approvedById: actor.userId, approvedAt: now } : { status: "PENDING" }),
      },
    });
    await writeAudit(tx, actor, {
      action: isExpense ? "expense.create" : "cash.entry_create", entityType: "CashEntry", entityId: e.id,
      summary: `${isExpense ? "Pengeluaran" : input.direction === "IN" ? "Penerimaan" : "Pengeluaran non-operasional"} ${rp(input.amount)} (${counter.code} ${counter.name}) pada ${acct.name}${approvedDirectly ? "" : " — menunggu persetujuan"}`,
      after: { date: input.entryDate, direction: input.direction, amount: input.amount, account: acct.name, counter: counter.code, status: e.status, payee: input.payee, reference: input.reference },
    });
    return e.id;
  });
  return toEntryDto(await prisma.cashEntry.findUniqueOrThrow({ where: { id }, include: entryInclude }));
}

export async function approveEntry(actor: Actor, id: string): Promise<CashEntryDto> {
  assertCan(actor, "expense:approve");
  uuid.parse(id);
  await transaction(async (tx) => {
    await lockEntry(tx, id);
    const e = await tx.cashEntry.findUniqueOrThrow({ where: { id }, include: { cashAccount: true, counterAccount: true } });
    if (e.entryType !== "ENTRY" || e.status !== "PENDING") throw Errors.conflict(e.status === "APPROVED" ? "Entri ini sudah disetujui." : e.status === "REJECTED" ? "Entri ini sudah ditolak." : "Entri tidak dapat disetujui.");
    if (e.createdById === actor.userId) throw Errors.forbidden("Anda tidak dapat menyetujui entri yang Anda catat sendiri.");
    await assertBooksOpen(tx, dateToIso(e.entryDate), "pengeluaran ini", "entryDate", "disetujui; tolak pengajuan lalu catat ulang dengan tanggal baru");
    await shareLockCashAccount(tx, e.cashAccountId);
    const acct = await tx.cashAccount.findUniqueOrThrow({ where: { id: e.cashAccountId } });
    if (!acct.isActive) throw Errors.conflict("Akun kas/bank sudah dinonaktifkan. Tolak entri ini lalu catat ulang pada akun aktif.");
    if (!e.counterAccount.isActive || !e.counterAccount.manualEntry) throw Errors.conflict("Akun kategori sudah dinonaktifkan. Tolak entri ini lalu catat ulang.");
    await tx.cashEntry.update({ where: { id }, data: { status: "APPROVED", approvedById: actor.userId, approvedAt: new Date() } });
    await writeAudit(tx, actor, {
      action: "expense.approve", entityType: "CashEntry", entityId: id,
      summary: `Pengeluaran ${rp(Number(e.amount))} (${e.counterAccount.code}) disetujui`,
      before: { status: "PENDING" }, after: { status: "APPROVED", amount: Number(e.amount), account: e.cashAccount.name },
    });
  });
  return toEntryDto(await prisma.cashEntry.findUniqueOrThrow({ where: { id }, include: entryInclude }));
}

export const decisionSchema = z.object({ reason: z.string().trim().min(5, "Alasan minimal 5 karakter").max(300) });

export async function rejectEntry(actor: Actor, id: string, raw: unknown): Promise<CashEntryDto> {
  assertCan(actor, "expense:approve");
  uuid.parse(id);
  const { reason } = parseInput(decisionSchema, raw);
  await transaction(async (tx) => {
    await lockEntry(tx, id);
    const e = await tx.cashEntry.findUniqueOrThrow({ where: { id } });
    if (e.entryType !== "ENTRY" || e.status !== "PENDING") throw Errors.conflict("Hanya entri yang menunggu persetujuan yang dapat ditolak.");
    await tx.cashEntry.update({ where: { id }, data: { status: "REJECTED", rejectedById: actor.userId, rejectedAt: new Date(), rejectionReason: reason } });
    await writeAudit(tx, actor, {
      action: "expense.reject", entityType: "CashEntry", entityId: id, summary: `Pengeluaran ${rp(Number(e.amount))} ditolak`,
      before: { status: "PENDING" }, after: { status: "REJECTED" }, reason,
    });
  });
  return toEntryDto(await prisma.cashEntry.findUniqueOrThrow({ where: { id }, include: entryInclude }));
}

/** Pencatat membatalkan pengajuannya sendiri selagi belum diputuskan (satu-satunya penghapusan yang diizinkan). */
export async function cancelPendingEntry(actor: Actor, id: string): Promise<void> {
  assertCan(actor, "expense:record");
  uuid.parse(id);
  await transaction(async (tx) => {
    await lockEntry(tx, id);
    const e = await tx.cashEntry.findUniqueOrThrow({ where: { id } });
    if (e.createdById !== actor.userId) throw Errors.notFound("Entri kas");
    if (e.entryType !== "ENTRY" || e.status !== "PENDING") throw Errors.conflict("Hanya pengajuan yang masih menunggu yang dapat dibatalkan.");
    await tx.cashEntry.delete({ where: { id } });
    await writeAudit(tx, actor, {
      action: "expense.cancel_pending", entityType: "CashEntry", entityId: id, summary: `Pengajuan pengeluaran ${rp(Number(e.amount))} dibatalkan oleh pencatat`,
      before: { date: dateToIso(e.entryDate), amount: Number(e.amount), description: e.description, status: "PENDING" },
    });
  });
}

/** Koreksi entri yang sudah berlaku: baris pembalik bertanggal hari ini (tepat satu kali). */
export async function reverseEntry(actor: Actor, id: string, raw: unknown): Promise<CashEntryDto> {
  assertCan(actor, "expense:void");
  uuid.parse(id);
  const { reason } = parseInput(decisionSchema, raw);
  const today = todayIso(env().APP_TIMEZONE);
  const newId = await transaction(async (tx) => {
    await lockEntry(tx, id);
    const o = await tx.cashEntry.findUniqueOrThrow({ where: { id }, include: { counterAccount: true, cashAccount: true } });
    if (o.entryType !== "ENTRY" || o.status !== "APPROVED") throw Errors.conflict("Hanya entri yang sudah berlaku yang dapat dibalikkan.");
    if (await tx.cashEntry.findUnique({ where: { reversesEntryId: id }, select: { id: true } })) throw Errors.conflict("Entri ini sudah pernah dibalikkan.");
    await shareLockCashAccount(tx, o.cashAccountId);
    const r = await tx.cashEntry.create({
      data: {
        entryType: "REVERSAL", reversesEntryId: o.id, entryDate: isoToDate(today), direction: o.direction === "IN" ? "OUT" : "IN", amount: o.amount,
        cashAccountId: o.cashAccountId, counterAccountId: o.counterAccountId, description: `Pembalikan: ${o.description}`.slice(0, 300), payee: o.payee, reference: o.reference,
        reason, status: "APPROVED", createdById: actor.userId, approvedById: actor.userId, approvedAt: new Date(),
      },
    });
    await writeAudit(tx, actor, {
      action: "cash.entry_reverse", entityType: "CashEntry", entityId: o.id,
      summary: `Entri ${rp(Number(o.amount))} (${o.counterAccount.code}) pada ${o.cashAccount.name} dibalikkan`,
      before: { date: dateToIso(o.entryDate), direction: o.direction, amount: Number(o.amount) }, after: { reversalId: r.id, date: today }, reason,
    });
    return r.id;
  });
  return toEntryDto(await prisma.cashEntry.findUniqueOrThrow({ where: { id: newId }, include: entryInclude }));
}

export interface EntryListQuery {
  status?: "PENDING" | "APPROVED" | "REJECTED"; accountId?: string; counterId?: string; from?: string; to?: string; q?: string;
  kind?: "EXPENSE" | "OTHER"; page?: number; pageSize?: number;
}

export async function listEntries(actor: Actor, query: EntryListQuery = {}): Promise<Paged<CashEntryDto>> {
  let visibility: Prisma.CashEntryWhereInput;
  if (actorCan(actor, "finance:view")) visibility = {};
  else if (actorCan(actor, "expense:view_own")) visibility = { createdById: actor.userId };
  else throw Errors.forbidden();
  const q = query.q?.trim();
  const where: Prisma.CashEntryWhereInput = {
    ...visibility,
    ...(query.status ? { status: query.status } : {}),
    ...(query.accountId ? { cashAccountId: query.accountId } : {}),
    ...(query.counterId ? { counterAccountId: query.counterId } : {}),
    ...(query.kind === "EXPENSE" ? { counterAccount: { type: "BEBAN" } } : query.kind === "OTHER" ? { counterAccount: { type: { not: "BEBAN" } } } : {}),
    ...(query.from || query.to ? { entryDate: { ...(query.from ? { gte: isoToDate(query.from) } : {}), ...(query.to ? { lte: isoToDate(query.to) } : {}) } } : {}),
    ...(q ? { OR: [
      { description: { contains: q, mode: "insensitive" } }, { payee: { contains: q, mode: "insensitive" } }, { reference: { contains: q, mode: "insensitive" } },
    ] } : {}),
  };
  const pageSize = Math.min(Math.max(query.pageSize ?? 25, 1), 100);
  const page = Math.max(query.page ?? 1, 1);
  const [total, rows] = await Promise.all([
    prisma.cashEntry.count({ where }),
    prisma.cashEntry.findMany({ where, include: entryInclude, orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  return { items: rows.map(toEntryDto), total, page, pageSize, pageCount: Math.max(Math.ceil(total / pageSize), 1) };
}

export async function countPendingEntries(actor: Actor): Promise<number> {
  assertCan(actor, "expense:approve");
  return prisma.cashEntry.count({ where: { status: "PENDING" } });
}

// ───────────────────────────── Transfer antar akun ─────────────────────────────

export const transferInputSchema = z.object({
  transferDate: isoDate.refine(isValidIsoDate, "Tanggal tidak valid"),
  fromAccountId: uuid,
  toAccountId: uuid,
  amount: cashAmount("Nominal"),
  description: optionalText(200, "Keterangan"),
  reference: optionalText(120, "Referensi"),
});

const transferInclude = {
  fromAccount: { select: { name: true } }, toAccount: { select: { name: true } }, createdBy: { select: { name: true } }, reversal: { select: { id: true } },
} satisfies Prisma.CashTransferInclude;
const toTransferDto = (t: Prisma.CashTransferGetPayload<{ include: typeof transferInclude }>): CashTransferDto => ({
  id: t.id, entryType: t.entryType, reversesTransferId: t.reversesTransferId, reversedByTransferId: t.reversal?.id ?? null,
  transferDate: dateToIso(t.transferDate), fromAccountId: t.fromAccountId, fromName: t.fromAccount.name, toAccountId: t.toAccountId, toName: t.toAccount.name,
  amount: Number(t.amount), description: t.description, reference: t.reference, reason: t.reason, createdByName: t.createdBy.name, createdAt: t.createdAt.toISOString(),
});

export async function createTransfer(actor: Actor, raw: unknown): Promise<CashTransferDto> {
  assertCan(actor, "cash:record");
  const input = parseInput(transferInputSchema, raw);
  const today = todayIso(env().APP_TIMEZONE);
  if (input.transferDate > today) throw Errors.validation("Tanggal tidak boleh di masa depan.", { transferDate: "Tidak boleh di masa depan" });
  if (input.fromAccountId === input.toAccountId) throw Errors.validation("Akun asal dan tujuan harus berbeda.", { toAccountId: "Harus berbeda dari akun asal" });
  const id = await transaction(async (tx) => {
    await assertBooksOpen(tx, input.transferDate, "transfer", "transferDate");
    for (const aid of [input.fromAccountId, input.toAccountId].sort()) await shareLockCashAccount(tx, aid);
    const [from, to] = await Promise.all([
      tx.cashAccount.findUniqueOrThrow({ where: { id: input.fromAccountId } }), tx.cashAccount.findUniqueOrThrow({ where: { id: input.toAccountId } }),
    ]);
    if (!from.isActive || !to.isActive) throw Errors.validation("Akun kas/bank tidak aktif.", { fromAccountId: "Pilih akun aktif" });
    const floor = [dateToIso(from.openingDate), dateToIso(to.openingDate)].sort().at(-1)!;
    if (input.transferDate < floor) throw Errors.validation(`Tanggal mendahului saldo awal salah satu akun (${floor}).`, { transferDate: `Minimal ${floor}` });
    const t = await tx.cashTransfer.create({
      data: {
        transferDate: isoToDate(input.transferDate), fromAccountId: from.id, toAccountId: to.id, amount: BigInt(input.amount),
        description: input.description, reference: input.reference, createdById: actor.userId,
      },
    });
    await writeAudit(tx, actor, {
      action: "cash.transfer", entityType: "CashTransfer", entityId: t.id, summary: `Transfer ${rp(input.amount)} dari ${from.name} ke ${to.name}`,
      after: { date: input.transferDate, from: from.name, to: to.name, amount: input.amount },
    });
    return t.id;
  });
  return toTransferDto(await prisma.cashTransfer.findUniqueOrThrow({ where: { id }, include: transferInclude }));
}

export async function reverseTransfer(actor: Actor, id: string, raw: unknown): Promise<CashTransferDto> {
  assertCan(actor, "expense:void");
  uuid.parse(id);
  const { reason } = parseInput(decisionSchema, raw);
  const today = todayIso(env().APP_TIMEZONE);
  const newId = await transaction(async (tx) => {
    const lock = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM cash_transfers WHERE id = ${id}::uuid FOR UPDATE`;
    if (lock.length === 0) throw Errors.notFound("Transfer");
    const o = await tx.cashTransfer.findUniqueOrThrow({ where: { id }, include: { fromAccount: true, toAccount: true } });
    if (o.entryType !== "ENTRY") throw Errors.conflict("Hanya transfer asli yang dapat dibalikkan.");
    if (await tx.cashTransfer.findUnique({ where: { reversesTransferId: id }, select: { id: true } })) throw Errors.conflict("Transfer ini sudah pernah dibalikkan.");
    for (const aid of [o.fromAccountId, o.toAccountId].sort()) await shareLockCashAccount(tx, aid);
    const r = await tx.cashTransfer.create({
      data: {
        entryType: "REVERSAL", reversesTransferId: o.id, transferDate: isoToDate(today), fromAccountId: o.toAccountId, toAccountId: o.fromAccountId,
        amount: o.amount, description: `Pembalikan transfer`, reference: o.reference, reason, createdById: actor.userId,
      },
    });
    await writeAudit(tx, actor, {
      action: "cash.transfer_reverse", entityType: "CashTransfer", entityId: o.id, summary: `Transfer ${rp(Number(o.amount))} ${o.fromAccount.name} → ${o.toAccount.name} dibalikkan`,
      before: { date: dateToIso(o.transferDate), amount: Number(o.amount) }, after: { reversalId: r.id, date: today }, reason,
    });
    return r.id;
  });
  return toTransferDto(await prisma.cashTransfer.findUniqueOrThrow({ where: { id: newId }, include: transferInclude }));
}

export async function listTransfers(actor: Actor, query: { from?: string; to?: string; page?: number; pageSize?: number } = {}): Promise<Paged<CashTransferDto>> {
  assertCan(actor, "finance:view");
  const where: Prisma.CashTransferWhereInput = query.from || query.to
    ? { transferDate: { ...(query.from ? { gte: isoToDate(query.from) } : {}), ...(query.to ? { lte: isoToDate(query.to) } : {}) } } : {};
  const pageSize = Math.min(Math.max(query.pageSize ?? 25, 1), 100);
  const page = Math.max(query.page ?? 1, 1);
  const [total, rows] = await Promise.all([
    prisma.cashTransfer.count({ where }),
    prisma.cashTransfer.findMany({ where, include: transferInclude, orderBy: [{ transferDate: "desc" }, { createdAt: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  return { items: rows.map(toTransferDto), total, page, pageSize, pageCount: Math.max(Math.ceil(total / pageSize), 1) };
}
