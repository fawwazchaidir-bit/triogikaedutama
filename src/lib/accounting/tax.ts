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

// ───────────────────────────── Estimasi PPh badan ─────────────────────────────
/**
 * ESTIMASI — bukan SPT. Tarif, koreksi fiskal, kompensasi rugi, dan fasilitas pajak SEMUANYA masukan pengguna/akuntan; sistem hanya
 * menghitung aritmetika dari pembukuan:
 *   GENERAL : penghasilan kena pajak = max(laba sebelum pajak + koreksi fiskal − kompensasi rugi, 0); pajak = ⌊PKP × tarif⌋ − fasilitas
 *   FINAL   : pajak = ⌊peredaran bruto (di luar PPN) × tarif⌋ − fasilitas; tidak ada kredit PPh 23 / koreksi fiskal
 *   kurang (+) / lebih (−) bayar = pajak terutang − kredit PPh 23 dipotong pelanggan (GENERAL) − angsuran/setoran yang sudah dibayar
 */
export type CorporateTaxRegimeValue = "NONE" | "GENERAL" | "FINAL";
export interface CorporateTaxInput {
  regime: CorporateTaxRegimeValue; rateBps: number | null;
  commercialProfit: number; grossRevenue: number;
  fiscalCorrection: number; lossCompensation: number; facilityReduction: number;
  withholdingCredit: number; installmentsPaid: number;
}
export interface CorporateTaxEstimate {
  regime: CorporateTaxRegimeValue; rateBps: number | null;
  /** GENERAL: penghasilan kena pajak; FINAL: peredaran bruto; NONE: 0. */
  basis: number;
  taxGross: number; facilityReduction: number; taxDue: number;
  credits: number; installments: number;
  /** Positif = kurang bayar (PPh 29 / setoran akhir); negatif = lebih bayar. */
  payable: number;
}
export function corporateTax(i: CorporateTaxInput): CorporateTaxEstimate {
  if (i.regime === "NONE" || i.rateBps === null) {
    return { regime: "NONE", rateBps: i.rateBps, basis: 0, taxGross: 0, facilityReduction: 0, taxDue: 0, credits: 0, installments: i.installmentsPaid, payable: -i.installmentsPaid };
  }
  const basis = i.regime === "GENERAL" ? Math.max(i.commercialProfit + i.fiscalCorrection - i.lossCompensation, 0) : Math.max(i.grossRevenue, 0);
  const taxGross = Number((BigInt(basis) * BigInt(i.rateBps)) / 10_000n);
  const facility = Math.min(Math.max(i.facilityReduction, 0), taxGross);
  const taxDue = taxGross - facility;
  const credits = i.regime === "GENERAL" ? i.withholdingCredit : 0;
  return { regime: i.regime, rateBps: i.rateBps, basis, taxGross, facilityReduction: facility, taxDue, credits, installments: i.installmentsPaid, payable: taxDue - credits - i.installmentsPaid };
}
