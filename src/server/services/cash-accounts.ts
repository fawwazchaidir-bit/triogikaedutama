import "server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma, transaction, type Tx } from "../db";
import { env } from "../env";
import { Errors } from "../errors";
import { parseInput } from "../validate";
import { actorCan, assertCan, type Actor } from "../actor";
import { writeAudit } from "../audit";
import { dateToIso, isoToDate } from "../json";
import { loadStmtData } from "./finance-data";
import { accountBalance } from "@/lib/accounting/statements";
import { isValidIsoDate } from "@/lib/finance/due-date";
import { formatRupiah } from "@/lib/finance/money";
import { todayIso } from "@/lib/format";
import { isoDate, optionalText, requiredText, rupiah, uuid } from "@/lib/validation/common";
import { CASH_AMOUNT_MAX } from "@/lib/accounting/limits";
import { assertBooksOpen, getBooksLock } from "./books-lock";
import type { CashAccountDto, CashAccountOptionDto } from "@/lib/finance-types";

/**
 * ═══════════ AKUN KAS & BANK ═══════════
 * Saldo = saldo awal (diinput manual) + mutasi bertanggal ≥ tanggal saldo awal. Tanggal saldo awal terkunci setelah ada mutasi.
 * Mengubah saldo awal setelah ada mutasi diizinkan hanya dengan alasan (tercatat di audit log).
 */

const include = { coaAccount: { select: { code: true, name: true } } } satisfies Prisma.CashAccountInclude;

/** Kunci baris akun (SELECT … FOR SHARE): pencatat yang bersamaan tidak saling menghalangi, tetapi nonaktivasi/ubah akun menunggu. */
export async function shareLockCashAccount(tx: Tx, id: string): Promise<void> {
  const r = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM cash_accounts WHERE id = ${id}::uuid FOR SHARE`;
  if (r.length === 0) throw Errors.notFound("Akun kas/bank");
}

export async function listCashAccounts(actor: Actor): Promise<CashAccountDto[]> {
  assertCan(actor, "finance:view");
  const today = todayIso(env().APP_TIMEZONE);
  const [rows, data, mv] = await Promise.all([
    prisma.cashAccount.findMany({ include, orderBy: [{ kind: "asc" }, { name: "asc" }] }),
    loadStmtData(today),
    movementIds(),
  ]);
  return rows.map((a) => {
    const acc = data.accounts.find((x) => x.id === a.id)!;
    return {
      id: a.id, name: a.name, kind: a.kind, coaAccountId: a.coaAccountId, coaCode: a.coaAccount.code, coaName: a.coaAccount.name,
      isDefault: a.isDefault, isActive: a.isActive, openingBalance: Number(a.openingBalance), openingDate: dateToIso(a.openingDate), notes: a.notes,
      balance: accountBalance(acc, data, today), hasMovements: mv.has(a.id),
    };
  });
}

/** Id akun yang sudah punya mutasi apa pun (pembayaran, entri, transfer). */
async function movementIds(): Promise<Set<string>> {
  const [p, e, tf, tt] = await Promise.all([
    prisma.payment.findMany({ where: { cashAccountId: { not: null } }, distinct: ["cashAccountId"], select: { cashAccountId: true } }),
    prisma.cashEntry.findMany({ distinct: ["cashAccountId"], select: { cashAccountId: true } }),
    prisma.cashTransfer.findMany({ distinct: ["fromAccountId"], select: { fromAccountId: true } }),
    prisma.cashTransfer.findMany({ distinct: ["toAccountId"], select: { toAccountId: true } }),
  ]);
  return new Set([...p.map((x) => x.cashAccountId!), ...e.map((x) => x.cashAccountId), ...tf.map((x) => x.fromAccountId), ...tt.map((x) => x.toAccountId)]);
}

/** Pilihan akun aktif (tanpa saldo) untuk pencatat pembayaran/pengeluaran. */
export async function listCashAccountOptions(actor: Actor): Promise<CashAccountOptionDto[]> {
  if (!actorCan(actor, "finance:view") && !actorCan(actor, "expense:record") && !actorCan(actor, "payment:record")) throw Errors.forbidden();
  const rows = await prisma.cashAccount.findMany({ where: { isActive: true }, orderBy: [{ kind: "asc" }, { name: "asc" }] });
  return rows.map((a) => ({ id: a.id, name: a.name, kind: a.kind, isDefault: a.isDefault }));
}

export const cashAccountCreateSchema = z.object({
  name: requiredText(2, 60, "Nama akun"),
  kind: z.enum(["KAS", "BANK"]),
  coaAccountId: uuid,
  openingBalance: rupiah("Saldo awal").max(CASH_AMOUNT_MAX, "Saldo awal melebihi batas wajar"),
  openingDate: isoDate.refine(isValidIsoDate, "Tanggal saldo awal tidak valid"),
  isDefault: z.boolean().default(false),
  notes: optionalText(300, "Catatan"),
});

export async function createCashAccount(actor: Actor, raw: unknown): Promise<CashAccountDto> {
  assertCan(actor, "finance:manage");
  const input = parseInput(cashAccountCreateSchema, raw);
  const today = todayIso(env().APP_TIMEZONE);
  if (input.openingDate > today) throw Errors.validation("Tanggal saldo awal tidak boleh di masa depan.", { openingDate: "Tidak boleh di masa depan" });
  const created = await transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('cash_account_defaults'))`; // serialisasi penentuan akun default
    await assertBooksOpen(tx, input.openingDate, "saldo awal akun", "openingDate");
    const coa = await tx.coaAccount.findUnique({ where: { id: input.coaAccountId } });
    if (!coa || !coa.isActive || coa.type !== "ASET") throw Errors.validation("Pilih akun bagan akun berjenis ASET yang aktif.", { coaAccountId: "Harus akun aset aktif" });
    // Saldo akun kas diturunkan dari modul kas; akun bagan akun-nya tidak boleh dipakai jalur lain (jurnal manual, akun lawan entri kas, akun sistem lain).
    if (coa.manualEntry) throw Errors.validation(`Akun ${coa.code} dapat dipilih pada entri kas manual sehingga tidak boleh menjadi akun kas/bank. Buat akun aset lancar baru (mis. 1-11xx).`, { coaAccountId: "Pilih akun kas/bank khusus" });
    if (coa.isSystem && coa.code !== "1-1100" && coa.code !== "1-1200") throw Errors.validation(`Akun sistem ${coa.code} tidak dapat dipetakan ke akun kas/bank.`, { coaAccountId: "Pilih 1-1100, 1-1200, atau akun kas baru" });
    if (await tx.journalLine.findFirst({ where: { accountId: coa.id }, select: { id: true } })) throw Errors.validation(`Akun ${coa.code} sudah memiliki jurnal manual dan tidak dapat menjadi akun kas/bank.`, { coaAccountId: "Sudah ada jurnal manual" });
    if (await tx.cashEntry.findFirst({ where: { counterAccountId: coa.id }, select: { id: true } })) throw Errors.validation(`Akun ${coa.code} sudah dipakai sebagai kategori entri kas dan tidak dapat menjadi akun kas/bank.`, { coaAccountId: "Sudah dipakai sebagai kategori" });
    if (await tx.cashAccount.findUnique({ where: { name: input.name }, select: { id: true } })) throw Errors.conflict(`Akun dengan nama "${input.name}" sudah ada.`);
    const hasDefault = await tx.cashAccount.findFirst({ where: { kind: input.kind, isDefault: true, isActive: true }, select: { id: true } });
    const makeDefault = input.isDefault || !hasDefault;
    if (makeDefault) await tx.cashAccount.updateMany({ where: { kind: input.kind, isDefault: true }, data: { isDefault: false } });
    const a = await tx.cashAccount.create({
      data: {
        name: input.name, kind: input.kind, coaAccountId: coa.id, openingBalance: BigInt(input.openingBalance), openingDate: isoToDate(input.openingDate),
        isDefault: makeDefault, notes: input.notes,
      },
    });
    await writeAudit(tx, actor, {
      action: "cash_account.create", entityType: "CashAccount", entityId: a.id,
      summary: `Akun ${input.kind === "KAS" ? "kas" : "bank"} "${a.name}" dibuat dengan saldo awal ${formatRupiah(input.openingBalance, "PLAIN")} per ${input.openingDate}`,
      after: { name: a.name, kind: a.kind, coa: coa.code, openingBalance: input.openingBalance, openingDate: input.openingDate, isDefault: makeDefault },
    });
    return a.id;
  });
  return (await listCashAccounts(actor)).find((x) => x.id === created)!;
}

export const cashAccountUpdateSchema = z.object({
  name: requiredText(2, 60, "Nama akun").optional(),
  notes: optionalText(300, "Catatan").optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  openingBalance: rupiah("Saldo awal").max(CASH_AMOUNT_MAX, "Saldo awal melebihi batas wajar").optional(),
  openingDate: isoDate.refine(isValidIsoDate, "Tanggal saldo awal tidak valid").optional(),
  /** Wajib bila saldo awal diubah pada akun yang sudah memiliki mutasi. */
  reason: z.string().trim().min(5, "Alasan minimal 5 karakter").max(300).optional(),
});

export async function updateCashAccount(actor: Actor, id: string, raw: unknown): Promise<CashAccountDto> {
  assertCan(actor, "finance:manage");
  uuid.parse(id);
  const input = parseInput(cashAccountUpdateSchema, raw);
  const today = todayIso(env().APP_TIMEZONE);
  await transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('cash_account_defaults'))`;
    const lock = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM cash_accounts WHERE id = ${id}::uuid FOR UPDATE`;
    if (lock.length === 0) throw Errors.notFound("Akun kas/bank");
    const cur = await tx.cashAccount.findUniqueOrThrow({ where: { id } });
    const hasMv = (await movementCount(tx, id)) > 0;

    if (input.name && input.name !== cur.name && (await tx.cashAccount.findUnique({ where: { name: input.name }, select: { id: true } }))) {
      throw Errors.conflict(`Akun dengan nama "${input.name}" sudah ada.`);
    }
    if (input.openingDate && input.openingDate !== dateToIso(cur.openingDate)) {
      if (hasMv) throw Errors.conflict("Akun sudah memiliki mutasi: tanggal saldo awal tidak dapat diubah.");
      if (await tx.journalEntry.findFirst({ select: { id: true } })) throw Errors.conflict("Sudah ada jurnal manual: tanggal mulai pembukuan tidak dapat digeser.");
      if (input.openingDate > today) throw Errors.validation("Tanggal saldo awal tidak boleh di masa depan.", { openingDate: "Tidak boleh di masa depan" });
    }
    const newOpening = input.openingBalance !== undefined ? BigInt(input.openingBalance) : cur.openingBalance;
    if (newOpening !== cur.openingBalance || (input.openingDate && input.openingDate !== dateToIso(cur.openingDate))) {
      const lock = await getBooksLock(tx);
      if (lock && (dateToIso(cur.openingDate) <= lock || (input.openingDate ?? dateToIso(cur.openingDate)) <= lock)) {
        throw Errors.conflict(`Buku sudah ditutup sampai ${lock}: saldo awal akun bertanggal ${dateToIso(cur.openingDate)} tidak dapat diubah. Buka kembali periode lebih dulu.`);
      }
    }
    if (newOpening !== cur.openingBalance && hasMv && !input.reason) {
      throw Errors.validation("Alasan wajib diisi untuk mengubah saldo awal pada akun yang sudah memiliki mutasi.", { reason: "Wajib diisi" });
    }
    let isDefault = input.isDefault ?? cur.isDefault;
    if (input.isActive === false && cur.isActive) {
      const data = await loadStmtData(today, tx);
      const acc = data.accounts.find((x) => x.id === id)!;
      const bal = accountBalance(acc, data, today);
      if (bal !== 0) throw Errors.conflict(`Akun masih bersaldo ${formatRupiah(bal, "PLAIN")}. Pindahkan saldo lewat transfer sebelum menonaktifkan.`);
      if (await tx.cashEntry.findFirst({ where: { cashAccountId: id, status: "PENDING" }, select: { id: true } })) {
        throw Errors.conflict("Masih ada pengeluaran menunggu persetujuan pada akun ini.");
      }
      isDefault = false;
    }
    if (input.isDefault === true && !(input.isActive ?? cur.isActive)) throw Errors.validation("Akun nonaktif tidak dapat menjadi default.");
    if (isDefault && !cur.isDefault) await tx.cashAccount.updateMany({ where: { kind: cur.kind, isDefault: true, NOT: { id } }, data: { isDefault: false } });

    const a = await tx.cashAccount.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name } : {}), ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}), isDefault,
        openingBalance: newOpening, ...(input.openingDate ? { openingDate: isoToDate(input.openingDate) } : {}),
      },
    });
    await writeAudit(tx, actor, {
      action: "cash_account.update", entityType: "CashAccount", entityId: id, summary: `Akun "${cur.name}" diperbarui`,
      before: { name: cur.name, isActive: cur.isActive, isDefault: cur.isDefault, openingBalance: Number(cur.openingBalance), openingDate: dateToIso(cur.openingDate) },
      after: { name: a.name, isActive: a.isActive, isDefault: a.isDefault, openingBalance: Number(a.openingBalance), openingDate: dateToIso(a.openingDate) },
      reason: input.reason ?? null,
    });
  });
  return (await listCashAccounts(actor)).find((x) => x.id === id)!;
}

async function movementCount(tx: Tx, id: string): Promise<number> {
  const [p, e, t] = await Promise.all([
    tx.payment.count({ where: { cashAccountId: id } }),
    tx.cashEntry.count({ where: { cashAccountId: id } }),
    tx.cashTransfer.count({ where: { OR: [{ fromAccountId: id }, { toAccountId: id }] } }),
  ]);
  return p + e + t;
}

/**
 * Tentukan akun kas penerima untuk pembayaran invoice.
 *  • Dipilih pengguna → harus aktif.
 *  • Tidak dipilih → akun default: metode "Tunai" → kas default; selain itu → bank default. Bila belum ada → null (belum dialokasikan).
 * Dipanggil di dalam transaksi pembayaran; akun dikunci FOR SHARE agar tidak dinonaktifkan bersamaan.
 */
export async function resolvePaymentAccount(tx: Tx, method: string, requestedId?: string | null): Promise<string | null> {
  if (requestedId) {
    await shareLockCashAccount(tx, requestedId);
    const a = await tx.cashAccount.findUniqueOrThrow({ where: { id: requestedId } });
    if (!a.isActive) throw Errors.validation("Akun kas/bank penerima tidak aktif.", { cashAccountId: "Pilih akun aktif" });
    return a.id;
  }
  const kind = method.trim().toLowerCase() === "tunai" ? "KAS" : "BANK";
  const def = await tx.cashAccount.findFirst({ where: { kind, isDefault: true, isActive: true }, select: { id: true } });
  if (!def) return null;
  await shareLockCashAccount(tx, def.id);
  const again = await tx.cashAccount.findUnique({ where: { id: def.id }, select: { isActive: true } });
  return again?.isActive ? def.id : null;
}
