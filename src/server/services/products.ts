import "server-only";
import { z } from "zod";
import type { Prisma, Product } from "@prisma/client";
import { prisma, transaction } from "../db";
import { Errors } from "../errors";
import { parseInput } from "../validate";
import { assertCan, type Actor } from "../actor";
import { diffFields, writeAudit } from "../audit";
import { optionalText, requiredText, rupiah, uuid } from "@/lib/validation/common";
import { DEFAULT_DESCRIPTION_TEMPLATE, findUnknownPlaceholders, renderDescription } from "@/lib/finance/description-template";
import type { Paged, ProductDto } from "@/lib/types";

export function renderProductDescription(p: Pick<Product, "name" | "code" | "category" | "fieldOfTraining" | "schemeName" | "unit" | "descriptionTemplate">): string {
  return renderDescription(p.descriptionTemplate, {
    name: p.name, code: p.code, category: p.category, field: p.fieldOfTraining, scheme: p.schemeName, unit: p.unit,
  });
}

export const toProductDto = (p: Product): ProductDto => ({
  id: p.id, code: p.code, name: p.name, category: p.category, fieldOfTraining: p.fieldOfTraining, schemeName: p.schemeName,
  descriptionTemplate: p.descriptionTemplate, description: renderProductDescription(p), unit: p.unit,
  defaultPrice: Number(p.defaultPrice), taxConfigId: p.taxConfigId, isActive: p.isActive,
});

export const productSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_.-]{1,29}$/, "Kode 2–30 karakter: huruf, angka, titik, _ atau -"),
  name: requiredText(2, 160, "Nama produk"),
  category: optionalText(80, "Kategori"),
  fieldOfTraining: optionalText(120, "Bidang"),
  schemeName: optionalText(120, "Skema"),
  descriptionTemplate: z.string().trim().min(1, "Template deskripsi wajib diisi").max(600).default(DEFAULT_DESCRIPTION_TEMPLATE),
  unit: requiredText(1, 20, "Satuan"),
  defaultPrice: rupiah("Harga default"),
  taxConfigId: z.preprocess((v) => (v === "" ? null : v ?? null), uuid.nullable()),
  isActive: z.boolean().default(true),
});

async function validateRefs(tx: Prisma.TransactionClient, input: z.infer<typeof productSchema>) {
  const unknown = findUnknownPlaceholders(input.descriptionTemplate);
  if (unknown.length) {
    throw Errors.validation(`Placeholder tidak dikenal: ${unknown.map((u) => `{${u}}`).join(", ")}`, {
      descriptionTemplate: `Placeholder tidak dikenal: ${unknown.map((u) => `{${u}}`).join(", ")}. Gunakan {name} {code} {category} {field} {scheme} {unit}`,
    });
  }
  if (input.taxConfigId) {
    const t = await tx.taxConfiguration.findUnique({ where: { id: input.taxConfigId } });
    if (!t || !t.isActive) throw Errors.validation("Konfigurasi pajak tidak ditemukan atau tidak aktif.", { taxConfigId: "Pilih konfigurasi pajak yang aktif" });
  }
}

export async function createProduct(actor: Actor, raw: unknown): Promise<ProductDto> {
  assertCan(actor, "product:manage");
  const input = parseInput(productSchema, raw);
  return transaction(async (tx) => {
    await validateRefs(tx, input);
    if (await tx.product.findUnique({ where: { code: input.code } })) {
      throw Errors.conflict("Kode produk sudah dipakai.");
    }
    const p = await tx.product.create({ data: { ...input, defaultPrice: BigInt(input.defaultPrice), archivedAt: input.isActive ? null : new Date() } });
    await writeAudit(tx, actor, { action: "product.create", entityType: "Product", entityId: p.id, summary: `Produk ${p.code} dibuat`, after: toProductDto(p) });
    return toProductDto(p);
  });
}

/** Mengubah harga/deskripsi master TIDAK mengubah invoice lama: invoice menyimpan snapshot barisnya sendiri. */
export async function updateProduct(actor: Actor, id: string, raw: unknown): Promise<ProductDto> {
  assertCan(actor, "product:manage");
  const input = parseInput(productSchema, raw);
  return transaction(async (tx) => {
    const before = await tx.product.findUnique({ where: { id } });
    if (!before) throw Errors.notFound("Produk");
    await validateRefs(tx, input);
    if (input.code !== before.code && (await tx.product.findUnique({ where: { code: input.code } }))) {
      throw Errors.conflict("Kode produk sudah dipakai.");
    }
    const after = await tx.product.update({
      where: { id },
      data: { ...input, defaultPrice: BigInt(input.defaultPrice), archivedAt: input.isActive ? null : (before.archivedAt ?? new Date()) },
    });
    const d = diffFields(toProductDto(before) as unknown as Record<string, unknown>, toProductDto(after) as unknown as Record<string, unknown>);
    if (d.changed.length) {
      await writeAudit(tx, actor, { action: "product.update", entityType: "Product", entityId: id, summary: `Produk ${after.code} diperbarui: ${d.changed.join(", ")}`, before: d.before, after: d.after });
    }
    return toProductDto(after);
  });
}

export interface ProductListQuery { q?: string; status?: "active" | "archived" | "all"; page?: number; pageSize?: number }

export async function listProducts(actor: Actor, query: ProductListQuery = {}): Promise<Paged<ProductDto>> {
  assertCan(actor, "product:view");
  const pageSize = Math.min(Math.max(query.pageSize ?? 20, 1), 100);
  const page = Math.max(query.page ?? 1, 1);
  const q = query.q?.trim();
  const where: Prisma.ProductWhereInput = {
    ...(query.status === "archived" ? { isActive: false } : query.status === "all" ? {} : { isActive: true }),
    ...(q ? { OR: [
      { name: { contains: q, mode: "insensitive" } }, { code: { contains: q, mode: "insensitive" } },
      { schemeName: { contains: q, mode: "insensitive" } }, { fieldOfTraining: { contains: q, mode: "insensitive" } },
      { category: { contains: q, mode: "insensitive" } },
    ] } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({ where, orderBy: [{ name: "asc" }, { code: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  return { items: rows.map(toProductDto), total, page, pageSize, pageCount: Math.max(Math.ceil(total / pageSize), 1) };
}

export async function searchProducts(actor: Actor, q: string, limit = 10): Promise<ProductDto[]> {
  assertCan(actor, "product:view");
  const term = q.trim();
  const rows = await prisma.product.findMany({
    where: { isActive: true, ...(term ? { OR: [
      { name: { contains: term, mode: "insensitive" } }, { code: { contains: term, mode: "insensitive" } },
      { schemeName: { contains: term, mode: "insensitive" } }, { fieldOfTraining: { contains: term, mode: "insensitive" } },
    ] } : {}) },
    orderBy: [{ name: "asc" }],
    take: Math.min(limit, 30),
  });
  return rows.map(toProductDto);
}
