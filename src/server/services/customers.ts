import "server-only";
import { z } from "zod";
import type { Customer, Prisma } from "@prisma/client";
import { prisma, transaction } from "../db";
import { Errors } from "../errors";
import { parseInput } from "../validate";
import { assertCan, type Actor } from "../actor";
import { diffFields, writeAudit } from "../audit";
import {
  normalizeCity, normalizeName, optionalEmail, optionalNpwp, optionalPhone, optionalText, requiredText,
} from "@/lib/validation/common";
import type { CustomerDto, CustomerSummaryDto, Paged } from "@/lib/types";

export const toCustomerDto = (c: Customer): CustomerDto => ({
  id: c.id, name: c.name, contactName: c.contactName, contactTitle: c.contactTitle, address: c.address, city: c.city,
  phone: c.phone, email: c.email, npwp: c.npwp, internalNote: c.internalNote, isActive: c.isActive, createdAt: c.createdAt.toISOString(),
});

export const customerSchema = z.object({
  name: requiredText(2, 160, "Nama perusahaan/instansi"),
  contactName: optionalText(120, "Nama kontak"),
  contactTitle: optionalText(80, "Jabatan kontak"),
  address: optionalText(400, "Alamat"),
  city: optionalText(80, "Kota"),
  phone: optionalPhone,
  email: optionalEmail,
  npwp: optionalNpwp,
  internalNote: optionalText(1000, "Catatan internal"),
  /** Konfirmasi pengguna bahwa ini memang pelanggan berbeda walau mirip dengan yang sudah ada. */
  confirmDistinct: z.boolean().optional(),
});

const identity = (name: string, city: string | null | undefined) => ({
  normalizedName: normalizeName(name),
  cityKey: normalizeCity(city),
});

/**
 * Pencegahan duplikasi (kombinasi identitas):
 *  1. nama ternormalisasi + kota yang sama → DITOLAK keras (juga dijaga unique index di DB);
 *  2. nama sama di kota berbeda/kosong, NPWP sama, atau email sama → ditolak kecuali `confirmDistinct`.
 */
async function findPossibleDuplicates(
  tx: Prisma.TransactionClient, c: { name: string; city: string | null; npwp: string | null; email: string | null }, excludeId?: string,
) {
  const { normalizedName } = identity(c.name, c.city);
  const or: Prisma.CustomerWhereInput[] = [{ normalizedName }];
  if (c.npwp) or.push({ npwp: c.npwp });
  if (c.email) or.push({ email: c.email });
  return tx.customer.findMany({ where: { OR: or, ...(excludeId ? { id: { not: excludeId } } : {}) }, take: 5 });
}

export async function createCustomer(actor: Actor, raw: unknown): Promise<CustomerDto> {
  assertCan(actor, "customer:create");
  const { confirmDistinct, ...input } = parseInput(customerSchema, raw);
  const id = identity(input.name, input.city);

  return transaction(async (tx) => {
    const dups = await findPossibleDuplicates(tx, input);
    const exact = dups.find((d) => d.cityKey === id.cityKey && d.normalizedName === id.normalizedName);
    if (exact) {
      throw Errors.conflict(`Pelanggan "${exact.name}" sudah ada${exact.isActive ? "" : " (diarsipkan — aktifkan kembali)"}.`, {
        duplicates: [{ id: exact.id, name: exact.name, city: exact.city, isActive: exact.isActive }],
      });
    }
    if (dups.length && !confirmDistinct) {
      throw Errors.conflict("Ada pelanggan dengan identitas mirip. Periksa daftar berikut sebelum menyimpan.", {
        duplicates: dups.map((d) => ({ id: d.id, name: d.name, city: d.city, isActive: d.isActive })),
        needsConfirmation: true,
      });
    }
    const c = await tx.customer.create({ data: { ...input, ...id, createdById: actor.userId } });
    await writeAudit(tx, actor, { action: "customer.create", entityType: "Customer", entityId: c.id, summary: `Pelanggan ${c.name} dibuat`, after: toCustomerDto(c) });
    return toCustomerDto(c);
  });
}

export async function updateCustomer(actor: Actor, idParam: string, raw: unknown): Promise<CustomerDto> {
  assertCan(actor, "customer:update");
  const { confirmDistinct, ...input } = parseInput(customerSchema, raw);
  const key = identity(input.name, input.city);

  return transaction(async (tx) => {
    const before = await tx.customer.findUnique({ where: { id: idParam } });
    if (!before) throw Errors.notFound("Pelanggan");
    const dups = await findPossibleDuplicates(tx, input, idParam);
    const exact = dups.find((d) => d.cityKey === key.cityKey && d.normalizedName === key.normalizedName);
    if (exact) throw Errors.conflict(`Pelanggan "${exact.name}" sudah ada dengan identitas yang sama.`, { duplicates: [{ id: exact.id, name: exact.name, city: exact.city, isActive: exact.isActive }] });
    if (dups.length && !confirmDistinct) {
      throw Errors.conflict("Ada pelanggan dengan identitas mirip. Periksa daftar berikut sebelum menyimpan.", {
        duplicates: dups.map((d) => ({ id: d.id, name: d.name, city: d.city, isActive: d.isActive })), needsConfirmation: true,
      });
    }
    // Hanya master yang berubah. Invoice terbit memegang snapshot-nya sendiri dan TIDAK disentuh di sini.
    const after = await tx.customer.update({ where: { id: idParam }, data: { ...input, ...key } });
    const d = diffFields(toCustomerDto(before) as unknown as Record<string, unknown>, toCustomerDto(after) as unknown as Record<string, unknown>);
    if (d.changed.length) {
      await writeAudit(tx, actor, { action: "customer.update", entityType: "Customer", entityId: idParam, summary: `Pelanggan ${after.name} diperbarui: ${d.changed.join(", ")}`, before: d.before, after: d.after });
    }
    return toCustomerDto(after);
  });
}

export async function setCustomerActive(actor: Actor, id: string, isActive: boolean): Promise<CustomerDto> {
  assertCan(actor, "customer:archive");
  return transaction(async (tx) => {
    const before = await tx.customer.findUnique({ where: { id } });
    if (!before) throw Errors.notFound("Pelanggan");
    const after = await tx.customer.update({ where: { id }, data: { isActive, archivedAt: isActive ? null : new Date() } });
    await writeAudit(tx, actor, {
      action: isActive ? "customer.unarchive" : "customer.archive", entityType: "Customer", entityId: id,
      summary: `Pelanggan ${after.name} ${isActive ? "diaktifkan kembali" : "diarsipkan"}`,
      before: { isActive: before.isActive }, after: { isActive },
    });
    return toCustomerDto(after);
  });
}

export interface CustomerListQuery { q?: string; status?: "active" | "archived" | "all"; page?: number; pageSize?: number }

function pageOf(q: { page?: number; pageSize?: number }) {
  const pageSize = Math.min(Math.max(q.pageSize ?? 20, 1), 100);
  const page = Math.max(q.page ?? 1, 1);
  return { page, pageSize, skip: (page - 1) * pageSize };
}

/** Ringkasan transaksi per pelanggan dari invoice TERBIT (draft & batal tidak dihitung). */
async function summarize(customerIds: string[]) {
  if (customerIds.length === 0) return new Map<string, { count: number; invoiced: number; paid: number; outstanding: number }>();
  const rows = await prisma.invoice.groupBy({
    by: ["customerId"],
    where: { customerId: { in: customerIds }, status: "ISSUED" },
    _count: { _all: true },
    _sum: { totalAmount: true, paidAmount: true, balanceAmount: true },
  });
  return new Map(rows.map((r) => [r.customerId, {
    count: r._count._all,
    invoiced: Number(r._sum.totalAmount ?? 0n),
    paid: Number(r._sum.paidAmount ?? 0n),
    outstanding: Number(r._sum.balanceAmount ?? 0n),
  }]));
}

export async function listCustomers(actor: Actor, query: CustomerListQuery = {}): Promise<Paged<CustomerSummaryDto>> {
  assertCan(actor, "customer:view");
  const { page, pageSize, skip } = pageOf(query);
  const q = query.q?.trim();
  const where: Prisma.CustomerWhereInput = {
    ...(query.status === "archived" ? { isActive: false } : query.status === "all" ? {} : { isActive: true }),
    ...(q ? { OR: [
      { name: { contains: q, mode: "insensitive" } },
      { contactName: { contains: q, mode: "insensitive" } },
      { city: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
      { npwp: { contains: q } },
    ] } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({ where, orderBy: { name: "asc" }, skip, take: pageSize }),
  ]);
  const sums = await summarize(rows.map((r) => r.id));
  return {
    items: rows.map((c) => {
      const s = sums.get(c.id);
      return { ...toCustomerDto(c), invoiceCount: s?.count ?? 0, invoicedAmount: s?.invoiced ?? 0, paidAmount: s?.paid ?? 0, outstandingAmount: s?.outstanding ?? 0 };
    }),
    total, page, pageSize, pageCount: Math.max(Math.ceil(total / pageSize), 1),
  };
}

/** Autocomplete untuk form invoice: pelanggan aktif, cocok sebagian nama. */
export async function searchCustomers(actor: Actor, q: string, limit = 8): Promise<CustomerDto[]> {
  assertCan(actor, "customer:view");
  const term = q.trim();
  const rows = await prisma.customer.findMany({
    where: { isActive: true, ...(term ? { OR: [{ name: { contains: term, mode: "insensitive" } }, { contactName: { contains: term, mode: "insensitive" } }] } : {}) },
    orderBy: { name: "asc" },
    take: Math.min(limit, 20),
  });
  return rows.map(toCustomerDto);
}

export async function getCustomer(actor: Actor, id: string): Promise<CustomerSummaryDto> {
  assertCan(actor, "customer:view");
  const c = await prisma.customer.findUnique({ where: { id } });
  if (!c) throw Errors.notFound("Pelanggan");
  const s = (await summarize([id])).get(id);
  return { ...toCustomerDto(c), invoiceCount: s?.count ?? 0, invoicedAmount: s?.invoiced ?? 0, paidAmount: s?.paid ?? 0, outstandingAmount: s?.outstanding ?? 0 };
}
