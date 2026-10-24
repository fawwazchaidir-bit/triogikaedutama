import "server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { Errors } from "../errors";
import { actorCan, assertCan, type Actor } from "../actor";
import { isoToDate } from "../json";
import { parseInput } from "../validate";
import { isoDate } from "@/lib/validation/common";
import type { Paged } from "@/lib/types";

export interface AuditLogDto {
  id: string;
  createdAt: string;
  actorName: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  ip: string | null;
}

type Row = Prisma.AuditLogGetPayload<{ include: { actor: { select: { name: true } } } }>;

const toDto = (r: Row): AuditLogDto => ({
  id: r.id.toString(), createdAt: r.createdAt.toISOString(), actorName: r.actor?.name ?? null, actorEmail: r.actorEmail,
  actorRole: r.actorRole, action: r.action, entityType: r.entityType, entityId: r.entityId, summary: r.summary,
  before: r.before, after: r.after, reason: r.reason, ip: r.ip,
});

export const auditQuerySchema = z.object({
  q: z.string().max(100).optional(),
  action: z.string().max(60).optional(),
  entityType: z.string().max(40).optional(),
  entityId: z.string().max(80).optional(),
  actorId: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export async function listAuditLogs(actor: Actor, raw: unknown = {}): Promise<Paged<AuditLogDto>> {
  assertCan(actor, "audit:view");
  const f = parseInput(auditQuerySchema, raw);
  const pageSize = f.pageSize ?? 30;
  const page = f.page ?? 1;
  const where: Prisma.AuditLogWhereInput = {
    ...(f.action ? { action: { startsWith: f.action } } : {}),
    ...(f.entityType ? { entityType: f.entityType } : {}),
    ...(f.entityId ? { entityId: f.entityId } : {}),
    ...(f.actorId ? { actorId: f.actorId } : {}),
    ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: new Date(`${f.from}T00:00:00+07:00`) } : {}), ...(f.to ? { lt: new Date(new Date(`${f.to}T00:00:00+07:00`).getTime() + 86_400_000) } : {}) } } : {}),
    ...(f.q ? { OR: [{ summary: { contains: f.q, mode: "insensitive" } }, { actorEmail: { contains: f.q, mode: "insensitive" } }, { reason: { contains: f.q, mode: "insensitive" } }] } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, include: { actor: { select: { name: true } } }, orderBy: { id: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  return { items: rows.map(toDto), total, page, pageSize, pageCount: Math.max(Math.ceil(total / pageSize), 1) };
}

/** Riwayat satu invoice (pembuatan, perubahan draft, terbit, pembayaran, pembatalan, unduhan PDF). */
export async function getInvoiceHistory(actor: Actor, invoiceId: string): Promise<AuditLogDto[]> {
  if (!actorCan(actor, "invoice:history")) throw Errors.forbidden();
  const rows = await prisma.auditLog.findMany({
    where: { entityType: "Invoice", entityId: invoiceId },
    include: { actor: { select: { name: true } } },
    orderBy: { id: "asc" },
    take: 500,
  });
  return rows.map(toDto);
}

export { isoToDate };
