/** Batas wajar per entri/saldo awal (10 triliun): menjaga jumlah agregat tetap di bawah 2^53 sehingga penjumlahan laporan selalu eksak. */
export const CASH_AMOUNT_MAX = 10_000_000_000_000;

/**
 * Pengeluaran (arah keluar) DI ATAS nominal ini WAJIB melampirkan bukti transaksi (tepat Rp1.000.000 masih boleh tanpa bukti).
 * Pagar yang sama ada di trigger database (`trg_cash_entries_insert_check`); mengubah angka ini berarti membuat migrasi baru.
 */
export const PROOF_REQUIRED_ABOVE = 1_000_000;
