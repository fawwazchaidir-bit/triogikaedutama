import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../db";
import { Errors } from "../errors";
import { assertCan, type Actor } from "../actor";
import { dateToIso } from "../json";
import { formatDateLong } from "@/lib/format";

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * ═══════════ KUNCI BUKU ═══════════
 * Setelah laporan sebuah bulan dibaca/dilaporkan, transaksi bertanggal mundur tidak boleh mengubahnya diam-diam.
 * Tanggal kunci = akhir bulan periode CLOSED terakhir (halaman Tutup Buku, `periods.ts`); DIPELIHARA TRIGGER database dari tabel periode,
 * sehingga tidak ada dua sumber kebenaran dan tidak dapat diatur bebas. Selama berlaku:
 *  • pembayaran, entri kas, transfer, jurnal manual, dan penerbitan invoice ber-PPN bertanggal ≤ X ditolak (service DAN trigger database);
 *  • pengeluaran menunggu yang bertanggal ≤ X tidak dapat disetujui (tolak lalu catat ulang dengan tanggal baru);
 *  • akun kas/bank bertanggal saldo awal ≤ X tidak dapat dibuat atau diubah saldo awalnya;
 *  • koreksi tetap mungkin: pembalikan dicatat bertanggal HARI INI (periode terbuka) sehingga laporan lama tidak berubah.
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
    const message = `Buku sudah ditutup sampai ${formatDateLong(lock)}: ${what} bertanggal ${formatDateLong(date)} tidak dapat ${verb}. Gunakan tanggal setelah ${formatDateLong(lock)}, atau buka kembali periodenya di halaman Tutup Buku (Finance Manager/Admin).`;
    throw Errors.validation(message, { [field]: message }); // pesan lengkap tampil tepat di bawah kolom tanggal
  }
}

export async function readBooksLock(actor: Actor): Promise<BooksLockDto> {
  assertCan(actor, "finance:view");
  return { lockedThrough: await getBooksLock() };
}
