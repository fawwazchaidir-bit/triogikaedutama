import "server-only";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma, transaction } from "../db";
import { env } from "../env";
import { Errors } from "../errors";
import { parseInput } from "../validate";
import { assertCan, type Actor } from "../actor";
import { writeAudit } from "../audit";
import { dateToIso, isoToDate } from "../json";
import { isValidIsoDate } from "@/lib/finance/due-date";
import { formatDateLong, todayIso } from "@/lib/format";
import { isoDate } from "@/lib/validation/common";

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * ═══════════ PENUTUPAN BUKU ═══════════
 * Setelah laporan sebuah periode dibaca/dilaporkan, transaksi bertanggal mundur tidak boleh mengubahnya diam-diam.
 * Finance Manager/Admin menetapkan "buku ditutup sampai tanggal X" (opsional; kosong = tidak ada penutupan):
 *  • pembayaran, entri kas, transfer, dan jurnal manual bertanggal ≤ X ditolak (service DAN trigger database);
 *  • pengeluaran menunggu yang bertanggal ≤ X tidak dapat disetujui (tolak lalu catat ulang dengan tanggal baru);
 *  • akun kas/bank bertanggal saldo awal ≤ X tidak dapat dibuat atau diubah saldo awalnya;
 *  • koreksi tetap mungkin: pembalikan dicatat bertanggal HARI INI (periode terbuka) sehingga laporan lama tidak berubah.
 * X harus sebelum hari ini. Mengubah/membuka kembali X wajib beralasan dan tercatat di audit.
 */
export interface BooksLockDto { lockedThrough: string | null }

export async function getBooksLock(db: Client = prisma): Promise<string | null> {
  const s = await db.companySettings.findUnique({ where: { id: 1 }, select: { booksLockedThrough: true } });
  return s?.booksLockedThrough ? dateToIso(s.booksLockedThrough) : null;
}

/** Tolak tanggal pada periode tertutup. Dipanggil di dalam transaksi pencatatan; pagar akhirnya tetap trigger database. */
export async function assertBooksOpen(db: Client, date: string, what: string, field: string, verb = "dicatat"): Promise<void> {
  const lock = await getBooksLock(db);
  if (lock && date <= lock) {
    const message = `Buku sudah ditutup sampai ${formatDateLong(lock)}: ${what} bertanggal ${formatDateLong(date)} tidak dapat ${verb}. Gunakan tanggal setelah ${formatDateLong(lock)}, atau minta Finance Manager membuka kembali periode.`;
    throw Errors.validation(message, { [field]: message }); // pesan lengkap tampil tepat di bawah kolom tanggal
  }
}

export async function readBooksLock(actor: Actor): Promise<BooksLockDto> {
  assertCan(actor, "finance:view");
  return { lockedThrough: await getBooksLock() };
}

export const booksLockSchema = z.object({
  lockedThrough: z.union([isoDate.refine(isValidIsoDate, "Tanggal tidak valid"), z.null()]),
  reason: z.string().trim().min(5, "Alasan minimal 5 karakter").max(300),
});

export async function setBooksLock(actor: Actor, raw: unknown): Promise<BooksLockDto> {
  assertCan(actor, "books:lock");
  const input = parseInput(booksLockSchema, raw);
  const today = todayIso(env().APP_TIMEZONE);
  if (input.lockedThrough !== null && input.lockedThrough >= today) {
    throw Errors.validation("Tanggal penutupan harus sebelum hari ini (hari ini masih periode berjalan).", { lockedThrough: "Harus sebelum hari ini" });
  }
  await transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('books_lock'))`; // menunggu transaksi pencatatan yang sedang berjalan
    const cur = await getBooksLock(tx);
    if (cur === input.lockedThrough) throw Errors.conflict("Tanggal penutupan buku tidak berubah.");
    await tx.companySettings.update({ where: { id: 1 }, data: { booksLockedThrough: input.lockedThrough ? isoToDate(input.lockedThrough) : null } });
    const reopened = cur !== null && (input.lockedThrough === null || input.lockedThrough < cur);
    await writeAudit(tx, actor, {
      action: reopened ? "books.reopen" : "books.lock", entityType: "CompanySettings", entityId: "1",
      summary: input.lockedThrough ? `Buku ditutup sampai ${input.lockedThrough}${reopened ? " (periode dibuka kembali)" : ""}` : "Penutupan buku dicabut",
      before: { lockedThrough: cur }, after: { lockedThrough: input.lockedThrough }, reason: input.reason,
    });
  });
  return { lockedThrough: await getBooksLock() };
}
