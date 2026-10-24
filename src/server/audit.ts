import "server-only";
import type { Tx } from "./db";
import { prisma } from "./db";
import type { Actor } from "./actor";
import { toJson } from "./json";

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/**
 * Tulis audit log. Panggil dengan `tx` dari transaksi yang sama dengan perubahan datanya,
 * sehingga perubahan dan jejaknya selalu atomik: tidak ada perubahan tanpa jejak, dan sebaliknya.
 */
export async function writeAudit(tx: Tx | typeof prisma, actor: Actor | null, entry: AuditEntry): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId: actor?.userId ?? null,
      actorEmail: actor?.email ?? null,
      actorRole: actor?.role ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      summary: entry.summary ?? null,
      before: entry.before === undefined ? undefined : toJson(entry.before),
      after: entry.after === undefined ? undefined : toJson(entry.after),
      reason: entry.reason ?? null,
      ip: actor?.ip ?? null,
      userAgent: actor?.userAgent?.slice(0, 300) ?? null,
    },
  });
}

/** Bandingkan dua objek datar; kembalikan hanya field yang berubah (before/after) untuk audit yang ringkas. */
export function diffFields<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    const nv = after[key];
    const ov = before[key];
    if (JSON.stringify(ov) !== JSON.stringify(nv)) {
      b[key] = ov;
      a[key] = nv;
    }
  }
  return { before: b, after: a, changed: Object.keys(a) };
}
