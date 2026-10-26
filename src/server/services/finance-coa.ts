import "server-only";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma, transaction } from "../db";
import { Errors } from "../errors";
import { parseInput } from "../validate";
import { actorCan, assertCan, type Actor } from "../actor";
import { writeAudit } from "../audit";
import { requiredText, uuid } from "@/lib/validation/common";
import { COA_SEED } from "@/lib/accounting/coa-seed";
import type { CoaAccountDto } from "@/lib/finance-types";

/**
 * ═══════════ BAGAN AKUN ═══════════
 * Akun lawan untuk entri kas. Aturan konsistensi (selain trigger DB): digit pertama kode menentukan jenis
 * (1 aset, 2 liabilitas, 3 ekuitas, 4 penghasilan, 5–7 beban) karena pengelompokan laporan memakai kode.
 */
const TYPE_DIGIT: Record<string, string[]> = {
  ASET: ["1"], KEWAJIBAN: ["2"], EKUITAS: ["3"], PENDAPATAN: ["4"], BEBAN: ["5", "6", "7"],
};
const DEFAULT_SECTION: Record<string, "OPERASI" | "INVESTASI" | "PENDANAAN"> = {
  ASET: "OPERASI", KEWAJIBAN: "PENDANAAN", EKUITAS: "PENDANAAN", PENDAPATAN: "OPERASI", BEBAN: "OPERASI",
};

type Client = PrismaClient | Prisma.TransactionClient;

/** Isi bagan akun usulan (idempoten: hanya menambah kode yang belum ada; tidak menimpa nama/pengaturan yang sudah disesuaikan). */
export async function seedCoa(db: Client = prisma): Promise<number> {
  let created = 0;
  for (const a of COA_SEED) {
    const exists = await db.coaAccount.findUnique({ where: { code: a.code }, select: { id: true } });
    if (exists) continue;
    await db.coaAccount.create({ data: { ...a } });
    created++;
  }
  return created;
}

const toDto = (a: Prisma.CoaAccountGetPayload<{ include: { _count: { select: { entries: true; cashAccounts: true } } } }>): CoaAccountDto => ({
  id: a.id, code: a.code, name: a.name, type: a.type, section: a.section, manualEntry: a.manualEntry, isSystem: a.isSystem, isActive: a.isActive,
  inUse: a._count.entries + a._count.cashAccounts > 0,
});
const include = { _count: { select: { entries: true, cashAccounts: true } } } as const;

/** Finance Manager/Admin: seluruh bagan akun. Staff pencatat pengeluaran: hanya akun beban aktif yang boleh dipilih. */
export async function listCoaAccounts(actor: Actor): Promise<CoaAccountDto[]> {
  let where: Prisma.CoaAccountWhereInput;
  if (actorCan(actor, "finance:view")) where = {};
  else if (actorCan(actor, "expense:record")) where = { type: "BEBAN", manualEntry: true, isActive: true };
  else throw Errors.forbidden();
  const rows = await prisma.coaAccount.findMany({ where, include, orderBy: { code: "asc" } });
  return rows.map(toDto);
}

export const coaCreateSchema = z.object({
  code: z.string().trim().regex(/^[0-9]-[0-9]{4}$/, "Kode harus berformat d-dddd, mis. 6-1250"),
  name: requiredText(2, 80, "Nama akun"),
  type: z.enum(["ASET", "KEWAJIBAN", "EKUITAS", "PENDAPATAN", "BEBAN"]),
  section: z.enum(["OPERASI", "INVESTASI", "PENDANAAN"]).optional(),
  manualEntry: z.boolean().default(false),
});

/** Aturan akun lawan manual: beban/pendapatan = operasi; aset = investasi; liabilitas/ekuitas = pendanaan. */
function checkConsistency(code: string, type: string, section: string, manualEntry: boolean): void {
  if (!TYPE_DIGIT[type]!.includes(code[0]!)) {
    throw Errors.validation(`Kode ${code} tidak sesuai jenis ${type} (digit pertama harus ${TYPE_DIGIT[type]!.join("/")}).`, { code: "Digit pertama tidak sesuai jenis akun" });
  }
  const expected = type === "ASET" ? ["INVESTASI", "OPERASI"] : [DEFAULT_SECTION[type]!];
  if (!expected.includes(section)) throw Errors.validation(`Kelompok arus kas ${section} tidak sesuai untuk akun ${type}.`, { section: "Tidak sesuai jenis akun" });
  if (manualEntry && type === "ASET" && section !== "INVESTASI") {
    throw Errors.validation("Akun aset yang dapat dipilih pada entri kas harus berkelompok INVESTASI.", { section: "Harus INVESTASI" });
  }
}

export async function createCoaAccount(actor: Actor, raw: unknown): Promise<CoaAccountDto> {
  assertCan(actor, "finance:manage");
  const input = parseInput(coaCreateSchema, raw);
  const section = input.section ?? DEFAULT_SECTION[input.type]!;
  checkConsistency(input.code, input.type, section, input.manualEntry);
  if (input.manualEntry && input.type === "ASET" && section !== "INVESTASI") throw Errors.validation("Akun aset manual harus INVESTASI.");
  return transaction(async (tx) => {
    if (await tx.coaAccount.findUnique({ where: { code: input.code }, select: { id: true } })) {
      throw Errors.conflict(`Kode akun ${input.code} sudah dipakai.`, undefined);
    }
    const a = await tx.coaAccount.create({ data: { code: input.code, name: input.name, type: input.type, section, manualEntry: input.manualEntry }, include });
    await writeAudit(tx, actor, { action: "coa.create", entityType: "CoaAccount", entityId: a.id, summary: `Akun ${a.code} ${a.name} dibuat`, after: { code: a.code, name: a.name, type: a.type, section, manualEntry: a.manualEntry } });
    return toDto(a);
  });
}

export const coaUpdateSchema = z.object({
  name: requiredText(2, 80, "Nama akun").optional(),
  isActive: z.boolean().optional(),
  manualEntry: z.boolean().optional(),
  code: z.string().trim().regex(/^[0-9]-[0-9]{4}$/, "Kode harus berformat d-dddd").optional(),
  type: z.enum(["ASET", "KEWAJIBAN", "EKUITAS", "PENDAPATAN", "BEBAN"]).optional(),
  section: z.enum(["OPERASI", "INVESTASI", "PENDANAAN"]).optional(),
});

export async function updateCoaAccount(actor: Actor, id: string, raw: unknown): Promise<CoaAccountDto> {
  assertCan(actor, "finance:manage");
  uuid.parse(id);
  const input = parseInput(coaUpdateSchema, raw);
  return transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM coa_accounts WHERE id = ${id}::uuid FOR UPDATE`;
    if (rows.length === 0) throw Errors.notFound("Akun");
    const cur = await tx.coaAccount.findUniqueOrThrow({ where: { id }, include });
    const structural = (input.code && input.code !== cur.code) || (input.type && input.type !== cur.type) || (input.section && input.section !== cur.section);
    if (structural) {
      if (cur.isSystem) throw Errors.conflict("Akun sistem tidak boleh diubah kode/jenisnya.");
      if (cur._count.entries + cur._count.cashAccounts > 0) throw Errors.conflict("Akun sudah dipakai transaksi: kode/jenis tidak dapat diubah. Nonaktifkan lalu buat akun baru.");
      if (await tx.journalLine.findFirst({ where: { accountId: id }, select: { id: true } })) throw Errors.conflict("Akun sudah memiliki jurnal: kode/jenis tidak dapat diubah (laporan lama akan ikut berubah). Nonaktifkan lalu buat akun baru.");
    }
    if (input.manualEntry === true && !cur.manualEntry && cur._count.cashAccounts > 0) throw Errors.conflict("Akun dipetakan ke akun kas/bank dan tidak dapat dipilih pada entri kas manual.");
    if (input.isActive === false) {
      if (cur.isSystem) throw Errors.conflict("Akun sistem tidak dapat dinonaktifkan.");
      if (await tx.cashAccount.findFirst({ where: { coaAccountId: id, isActive: true }, select: { id: true } })) {
        throw Errors.conflict("Akun masih dipetakan ke akun kas/bank yang aktif.");
      }
    }
    if (input.manualEntry !== undefined && cur.isSystem && input.manualEntry) throw Errors.conflict("Akun sistem tidak dapat dipilih pada entri kas manual.");
    const next = {
      code: input.code ?? cur.code, type: input.type ?? cur.type, section: input.section ?? cur.section, manualEntry: input.manualEntry ?? cur.manualEntry,
    };
    checkConsistency(next.code, next.type, next.section, next.manualEntry);
    if (input.code && input.code !== cur.code && (await tx.coaAccount.findUnique({ where: { code: input.code }, select: { id: true } }))) {
      throw Errors.conflict(`Kode akun ${input.code} sudah dipakai.`);
    }
    const a = await tx.coaAccount.update({
      where: { id },
      data: { ...(input.name ? { name: input.name } : {}), ...(input.isActive !== undefined ? { isActive: input.isActive } : {}), ...next },
      include,
    });
    await writeAudit(tx, actor, {
      action: "coa.update", entityType: "CoaAccount", entityId: id, summary: `Akun ${cur.code} diperbarui`,
      before: { code: cur.code, name: cur.name, type: cur.type, section: cur.section, manualEntry: cur.manualEntry, isActive: cur.isActive },
      after: { code: a.code, name: a.name, type: a.type, section: a.section, manualEntry: a.manualEntry, isActive: a.isActive },
    });
    return toDto(a);
  });
}
