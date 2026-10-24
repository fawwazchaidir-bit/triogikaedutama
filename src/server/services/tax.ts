import "server-only";
import { z } from "zod";
import type { TaxConfiguration } from "@prisma/client";
import { prisma, transaction } from "../db";
import { Errors } from "../errors";
import { parseInput } from "../validate";
import { assertCan, type Actor } from "../actor";
import { diffFields, writeAudit } from "../audit";
import { optionalText, requiredText } from "@/lib/validation/common";
import type { TaxConfigDto } from "@/lib/types";
import type { TaxRule } from "@/lib/finance/calculate";

export const toTaxDto = (t: TaxConfiguration): TaxConfigDto => ({
  id: t.id, code: t.code, name: t.name, rateBps: t.rateBps, dppNumerator: t.dppNumerator,
  dppDenominator: t.dppDenominator, method: t.method, note: t.note, isActive: t.isActive,
});

/** Konversi konfigurasi DB → aturan murni untuk mesin kalkulasi. */
export const toTaxRule = (t: Pick<TaxConfiguration, "id" | "code" | "name" | "rateBps" | "dppNumerator" | "dppDenominator" | "method">): TaxRule => ({
  key: t.id, code: t.code, name: t.name, rateBps: t.rateBps,
  dppNumerator: t.dppNumerator, dppDenominator: t.dppDenominator, method: t.method,
});

const taxFields = {
  name: requiredText(2, 80, "Nama pajak"),
  /** Persen dengan maksimal 2 desimal, mis. 11 atau 12.5 → disimpan sebagai basis point. */
  ratePercent: z.number().min(0).max(100).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9, "Maksimal 2 desimal"),
  dppNumerator: z.number().int().min(1).max(1000),
  dppDenominator: z.number().int().min(1).max(1000),
  method: z.enum(["EXCLUSIVE", "INCLUSIVE"]),
  note: optionalText(300, "Catatan"),
  isActive: z.boolean(),
};

export const taxCreateSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,20}$/, "Kode 2–20 karakter: huruf, angka, _ atau -"),
  ...taxFields,
  isActive: taxFields.isActive.default(true),
  dppNumerator: taxFields.dppNumerator.default(1),
  dppDenominator: taxFields.dppDenominator.default(1),
  method: taxFields.method.default("EXCLUSIVE"),
});

export const taxUpdateSchema = z.object(taxFields).partial();

export async function listTaxConfigs(actor: Actor, opts: { activeOnly?: boolean } = {}): Promise<TaxConfigDto[]> {
  // Pembuat invoice perlu daftar pajak aktif untuk memilih; konfigurasi lengkap hanya untuk pengelola.
  if (!opts.activeOnly) assertCan(actor, "tax:manage");
  const rows = await prisma.taxConfiguration.findMany({
    where: opts.activeOnly ? { isActive: true } : undefined,
    orderBy: [{ isActive: "desc" }, { code: "asc" }],
  });
  return rows.map(toTaxDto);
}

export async function createTaxConfig(actor: Actor, raw: unknown): Promise<TaxConfigDto> {
  assertCan(actor, "tax:manage");
  const input = parseInput(taxCreateSchema, raw);
  if (await prisma.taxConfiguration.findUnique({ where: { code: input.code } })) {
    throw Errors.conflict("Kode pajak sudah dipakai.", undefined);
  }
  return transaction(async (tx) => {
    const t = await tx.taxConfiguration.create({
      data: {
        code: input.code, name: input.name, rateBps: Math.round(input.ratePercent * 100),
        dppNumerator: input.dppNumerator, dppDenominator: input.dppDenominator,
        method: input.method, note: input.note, isActive: input.isActive,
      },
    });
    await writeAudit(tx, actor, { action: "tax.create", entityType: "TaxConfiguration", entityId: t.id, summary: `Pajak ${t.code} dibuat`, after: toTaxDto(t) });
    return toTaxDto(t);
  });
}

/** Mengubah konfigurasi TIDAK memengaruhi invoice terbit (snapshot), hanya draft & invoice baru. */
export async function updateTaxConfig(actor: Actor, id: string, raw: unknown): Promise<TaxConfigDto> {
  assertCan(actor, "tax:manage");
  const input = parseInput(taxUpdateSchema, raw);
  return transaction(async (tx) => {
    const before = await tx.taxConfiguration.findUnique({ where: { id } });
    if (!before) throw Errors.notFound("Konfigurasi pajak");
    const { ratePercent, ...rest } = input;
    const after = await tx.taxConfiguration.update({
      where: { id },
      data: { ...rest, ...(ratePercent !== undefined ? { rateBps: Math.round(ratePercent * 100) } : {}) },
    });
    const d = diffFields(toTaxDto(before) as unknown as Record<string, unknown>, toTaxDto(after) as unknown as Record<string, unknown>);
    if (d.changed.length) {
      await writeAudit(tx, actor, {
        action: "tax.update", entityType: "TaxConfiguration", entityId: id,
        summary: `Pajak ${after.code} diubah: ${d.changed.join(", ")}`, before: d.before, after: d.after,
      });
    }
    return toTaxDto(after);
  });
}
