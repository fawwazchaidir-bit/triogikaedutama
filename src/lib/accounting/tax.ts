/**
 * Perhitungan PAJAK pada pembayaran invoice — fungsi MURNI. Tidak ada tarif yang diasumsikan di sini:
 * PPN berasal dari pajak yang sudah tercetak pada invoice (snapshot), PPh yang dipotong pelanggan diinput apa adanya dari bukti potong.
 */
export const CODE_VAT_OUT = "2-1210";
export const CODE_PPH_CREDIT = "1-1400";
export const CODE_PPH_BADAN_PAYABLE = "2-1230";
export const CODE_PPH_BADAN_EXPENSE = "7-1100";

/**
 * Bagian PPN pada satu pembayaran. Kumulatif proporsional terhadap pajak invoice:
 *   target = floor((sudahLunas + nilaiPembayaran) × PPN / total)  (tepat = PPN bila invoice menjadi lunas)
 *   ppn    = target − PPN yang sudah tercatat, dibatasi [0, nilaiPembayaran, sisa PPN]
 * Sehingga Σ PPN semua pembayaran = PPN invoice tepat (selisih pembulatan jatuh pada pembayaran yang melunasi), tanpa pecahan.
 * `settledBefore` = Σ (uang + PPh dipotong) sebelumnya (neto pembalikan); `vatBefore` = Σ PPN sebelumnya.
 */
export function vatForPayment(p: { total: number; vat: number; settledBefore: number; vatBefore: number; settled: number }): number {
  if (p.vat <= 0 || p.total <= 0 || p.settled <= 0) return 0;
  const total = BigInt(p.total), vat = BigInt(p.vat), after = BigInt(p.settledBefore) + BigInt(p.settled);
  const target = after >= total ? vat : (after * vat) / total;
  let v = target - BigInt(p.vatBefore);
  const cap = [BigInt(p.settled), vat - BigInt(p.vatBefore)].reduce((a, b) => (a < b ? a : b));
  if (v > cap) v = cap;
  if (v < 0n) v = 0n;
  return Number(v);
}
