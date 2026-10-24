import "server-only";
import type { Tx } from "../db";
import { Errors } from "../errors";

/**
 * Kunci baris invoice (SELECT … FOR UPDATE) selama transaksi berjalan.
 * Semua operasi yang mengubah invoice/pembayaran (edit draft, terbit, batal, catat/balikkan pembayaran)
 * memanggil ini lebih dulu → operasi pada invoice yang sama berjalan SATU PER SATU, sehingga
 * klik ganda, dua tab, atau dua pengguna tidak dapat menimbulkan penerbitan/pembayaran ganda.
 */
export async function lockInvoice(tx: Tx, id: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM invoices WHERE id = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) throw Errors.notFound("Invoice");
}
