import "server-only";
import { Prisma, PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** Klien transaksi interaktif (dipakai oleh seluruh fungsi yang harus atomik). */
export type Tx = Prisma.TransactionClient;

/**
 * Jalankan blok dalam transaksi. Bila blok melempar error, SEMUA perubahan di-rollback
 * (tidak ada data setengah tersimpan). Timeout dinaikkan untuk operasi yang memakai row lock.
 */
export function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { maxWait: 10_000, timeout: 30_000 });
}
