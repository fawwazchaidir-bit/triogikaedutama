import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "../db";

export interface LimitConfig {
  max: number;
  windowMs: number;
  blockMs: number;
}

export function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** Sisa detik pemblokiran, atau 0 bila tidak diblokir. */
export async function blockedSeconds(key: string): Promise<number> {
  const b = await prisma.rateLimitBucket.findUnique({ where: { key } });
  if (!b?.blockedUntil) return 0;
  const ms = b.blockedUntil.getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

/**
 * Catat satu kegagalan secara atomik (INSERT … ON CONFLICT DO UPDATE → aman untuk request paralel).
 * Jendela direset bila sudah lewat; mencapai `max` memicu pemblokiran selama `blockMs`.
 */
export async function recordFailure(key: string, cfg: LimitConfig): Promise<{ count: number; blocked: boolean }> {
  const windowSec = Math.ceil(cfg.windowMs / 1000);
  const blockSec = Math.ceil(cfg.blockMs / 1000);
  const rows = await prisma.$queryRaw<{ count: number; blocked: boolean }[]>`
    INSERT INTO rate_limit_buckets ("key", "count", "windowStart", "blockedUntil")
    VALUES (${key}, 1, now(), CASE WHEN 1 >= ${cfg.max} THEN now() + make_interval(secs => ${blockSec}) ELSE NULL END)
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN rate_limit_buckets."windowStart" < now() - make_interval(secs => ${windowSec})
                     THEN 1 ELSE rate_limit_buckets."count" + 1 END,
      "windowStart" = CASE WHEN rate_limit_buckets."windowStart" < now() - make_interval(secs => ${windowSec})
                           THEN now() ELSE rate_limit_buckets."windowStart" END,
      "blockedUntil" = CASE
        WHEN (CASE WHEN rate_limit_buckets."windowStart" < now() - make_interval(secs => ${windowSec})
                   THEN 1 ELSE rate_limit_buckets."count" + 1 END) >= ${cfg.max}
        THEN now() + make_interval(secs => ${blockSec})
        ELSE NULL END
    RETURNING "count", ("blockedUntil" IS NOT NULL AND "blockedUntil" > now()) AS blocked`;
  const row = rows[0];
  return { count: Number(row?.count ?? 1), blocked: Boolean(row?.blocked) };
}

export async function resetBucket(key: string): Promise<void> {
  await prisma.rateLimitBucket.deleteMany({ where: { key } });
}
