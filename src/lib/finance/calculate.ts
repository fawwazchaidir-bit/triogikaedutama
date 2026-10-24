/**
 * MESIN KALKULASI INVOICE — satu-satunya sumber kebenaran untuk seluruh nominal.
 *
 * Modul ini MURNI (tanpa DB/IO) sehingga dipakai identik oleh:
 *   • server  → perhitungan otoritatif saat simpan/terbit (nilai dari browser TIDAK pernah dipercaya),
 *   • browser → pratinjau langsung di form.
 *
 * URUTAN PERHITUNGAN (eksplisit, jangan diubah tanpa memperbarui test & dokumentasi):
 *
 *   1. Nilai kotor baris   gross_i = round_half_up(qty_i × harga_i)            [qty hingga 3 desimal]
 *   2. Nilai bersih baris  net_i   = gross_i − diskon_i                        [diskon_i ≤ gross_i]
 *   3. Subtotal            S       = Σ net_i
 *   4. Diskon tambahan     X       ≤ S, dialokasikan PRO-RATA ke tiap baris (metode sisa terbesar,
 *                                  sehingga Σ alokasi == X persis) → base_i = net_i − alokasi_i
 *   5. Pajak per konfigurasi pajak (kelompok baris yang memakai konfigurasi sama):
 *        B = Σ base_i (baris dalam kelompok)
 *        EXCLUSIVE: DPP = round(B × f) ; Pajak = round(B × f × tarif)   ← dibulatkan SEKALI dari nilai eksak
 *        INCLUSIVE: Pajak = round(B × e / (1 + e)), e = f × tarif       ← pajak sudah ada di dalam harga
 *      Pajak EXCLUSIVE ditambahkan ke total; pajak INCLUSIVE hanya informasi (tidak menambah total).
 *   6. Biaya tambahan      T = transport + administrasi
 *   7. TOTAL INVOICE       = S − X + Pajak(EXCLUSIVE) + T
 *   8. DP / pembayaran     TIDAK mengurangi total; hanya mengurangi saldo:
 *      SALDO TAGIHAN       = TOTAL − (DP atau Σ pembayaran yang diterima)
 *
 * Aturan pembulatan: HALF-UP ke Rupiah penuh, hanya pada titik 1 dan 5 (dan alokasi sisa terbesar di 4).
 */

import { MAX_AMOUNT, MoneyError, roundDivHalfUp, toSafeNumber } from "./money";

export type TaxMethod = "EXCLUSIVE" | "INCLUSIVE";

export interface TaxRule {
  /** Kunci stabil (id konfigurasi atau kode) untuk mengelompokkan baris. */
  key: string;
  code: string;
  name: string;
  /** Basis point: 1100 = 11,00%. */
  rateBps: number;
  /** Faktor DPP = dppNumerator / dppDenominator (mis. 11/12 untuk DPP Nilai Lain). */
  dppNumerator: number;
  dppDenominator: number;
  method: TaxMethod;
}

export interface CalcLineInput {
  /** Desimal sebagai string/number, maksimal 3 angka di belakang koma. */
  quantity: string | number;
  unitPrice: number;
  discount?: number;
  tax?: TaxRule | null;
}

export interface CalcInput {
  lines: CalcLineInput[];
  extraDiscount?: number;
  transport?: number;
  admin?: number;
  /** DP yang dinyatakan pada invoice. Dipakai sebagai "diterima" bila `receivedAmount` tidak diberikan. */
  downPayment?: number;
  /** Total pembayaran yang sudah diterima (ledger). Default = downPayment (untuk draft). */
  receivedAmount?: number;
}

export interface CalcLineResult {
  quantityMilli: number;
  grossAmount: number;
  discountAmount: number;
  netAmount: number;
  /** Bagian diskon tambahan yang dialokasikan ke baris ini. */
  extraDiscountShare: number;
  /** netAmount − extraDiscountShare: dasar yang dipakai untuk pajak. */
  baseAmount: number;
}

export interface TaxGroupResult {
  key: string;
  code: string;
  name: string;
  rateBps: number;
  dppNumerator: number;
  dppDenominator: number;
  method: TaxMethod;
  /** Σ dasar baris dalam kelompok (setelah semua diskon). */
  baseAmount: number;
  /** Dasar Pengenaan Pajak. */
  dppAmount: number;
  taxAmount: number;
  /** true bila pajak ini ditambahkan ke total (EXCLUSIVE). */
  addedToTotal: boolean;
}

export interface CalcResult {
  lines: CalcLineResult[];
  /** Nilai bruto transaksi: Σ qty × harga (sebelum diskon). */
  grossAmount: number;
  lineDiscountTotal: number;
  extraDiscountAmount: number;
  /** Total diskon = diskon baris + diskon tambahan. */
  discountAmount: number;
  /** Σ nilai bersih baris (setelah diskon baris, sebelum diskon tambahan). */
  subtotalAmount: number;
  /** Subtotal − diskon tambahan. */
  netAfterDiscount: number;
  taxGroups: TaxGroupResult[];
  /** Σ DPP semua kelompok pajak (informasi pelaporan). */
  taxBaseAmount: number;
  /** Pajak yang DITAMBAHKAN ke total (EXCLUSIVE saja). */
  taxAmount: number;
  /** Pajak yang sudah termasuk di harga (INCLUSIVE; informasi). */
  includedTaxAmount: number;
  transportAmount: number;
  adminAmount: number;
  surchargeAmount: number;
  /** TOTAL INVOICE (Nett Total). */
  totalAmount: number;
  downPaymentAmount: number;
  receivedAmount: number;
  /** Sisa tagihan = total − diterima. */
  balanceAmount: number;
}

export type CalcErrorCode =
  | "NO_LINES"
  | "INVALID_QUANTITY"
  | "INVALID_PRICE"
  | "INVALID_DISCOUNT"
  | "DISCOUNT_EXCEEDS_LINE"
  | "EXTRA_DISCOUNT_EXCEEDS_SUBTOTAL"
  | "INVALID_AMOUNT"
  | "DP_EXCEEDS_TOTAL"
  | "RECEIVED_EXCEEDS_TOTAL"
  | "INVALID_TAX_RULE"
  | "OVERFLOW";

export class CalcError extends Error {
  constructor(
    public readonly code: CalcErrorCode,
    message: string,
    public readonly lineIndex?: number,
  ) {
    super(message);
    this.name = "CalcError";
  }
}

const MAX_QTY_MILLI = 1_000_000_000_000n; // 1 miliar unit (dalam 1/1000)

/** "7" / "7,5" / "7.250" / 7.5 → milli-unit (7000 / 7500 / 7250). Menolak > 3 desimal, ≤ 0, atau bukan angka. */
export function parseQuantityMilli(input: string | number, lineIndex?: number): bigint {
  const bad = (msg: string) => new CalcError("INVALID_QUANTITY", msg, lineIndex);
  let s: string;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw bad("Kuantitas harus berupa angka yang valid");
    s = String(input);
    if (/e/i.test(s)) throw bad("Kuantitas tidak valid");
  } else {
    s = input.trim().replace(",", ".");
  }
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) throw bad("Kuantitas harus berupa angka positif dengan maksimal 3 desimal");
  const milli = BigInt(m[1] as string) * 1000n + BigInt(((m[2] ?? "") + "000").slice(0, 3));
  if (milli <= 0n) throw bad("Kuantitas harus lebih besar dari nol");
  if (milli > MAX_QTY_MILLI) throw bad("Kuantitas terlalu besar");
  return milli;
}

function intField(value: number | undefined, label: string, code: CalcErrorCode, lineIndex?: number): bigint {
  const v = value ?? 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_AMOUNT) {
    throw new CalcError(code, `${label} harus berupa bilangan bulat Rupiah tidak negatif`, lineIndex);
  }
  return BigInt(v);
}

function validateTaxRule(rule: TaxRule, lineIndex: number): void {
  const ok =
    Number.isInteger(rule.rateBps) && rule.rateBps >= 0 && rule.rateBps <= 10_000 &&
    Number.isInteger(rule.dppNumerator) && rule.dppNumerator > 0 &&
    Number.isInteger(rule.dppDenominator) && rule.dppDenominator > 0;
  if (!ok) throw new CalcError("INVALID_TAX_RULE", `Konfigurasi pajak "${rule.code}" tidak valid`, lineIndex);
}

/**
 * Alokasi `total` secara pro-rata terhadap `weights` dengan metode sisa terbesar:
 * Σ hasil == total persis, tanpa selisih pembulatan liar.
 */
export function allocateProRata(total: bigint, weights: bigint[]): bigint[] {
  const sumW = weights.reduce((a, b) => a + b, 0n);
  if (total === 0n || sumW === 0n) return weights.map(() => 0n);
  const shares = weights.map((w) => (total * w) / sumW); // floor
  const remainders = weights.map((w, i) => ({ i, r: (total * w) % sumW }));
  let leftover = total - shares.reduce((a, b) => a + b, 0n);
  // sisa terbesar dahulu; seri dipecah deterministik berdasarkan indeks
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (leftover === 0n) break;
    // jangan alokasikan melebihi bobot baris itu sendiri (diskon baris tidak boleh melebihi nilai baris)
    if ((shares[i] as bigint) < (weights[i] as bigint)) {
      shares[i] = (shares[i] as bigint) + 1n;
      leftover -= 1n;
    }
  }
  return shares;
}

export function calculateInvoice(input: CalcInput): CalcResult {
  if (!input.lines || input.lines.length === 0) {
    throw new CalcError("NO_LINES", "Invoice harus memiliki minimal satu baris rincian");
  }

  // ── 1–2. Baris ──
  const lines = input.lines.map((l, idx) => {
    const qtyMilli = parseQuantityMilli(l.quantity, idx);
    const price = intField(l.unitPrice, "Harga satuan", "INVALID_PRICE", idx);
    const discount = intField(l.discount, "Diskon baris", "INVALID_DISCOUNT", idx);
    const gross = roundDivHalfUp(qtyMilli * price, 1000n);
    if (discount > gross) {
      throw new CalcError("DISCOUNT_EXCEEDS_LINE", "Diskon baris melebihi nilai baris", idx);
    }
    if (l.tax) validateTaxRule(l.tax, idx);
    return { qtyMilli, price, discount, gross, net: gross - discount, tax: l.tax ?? null };
  });

  // ── 3. Subtotal ──
  const grossTotal = lines.reduce((a, l) => a + l.gross, 0n);
  const lineDiscountTotal = lines.reduce((a, l) => a + l.discount, 0n);
  const subtotal = lines.reduce((a, l) => a + l.net, 0n);

  // ── 4. Diskon tambahan (pro-rata) ──
  const extraDiscount = intField(input.extraDiscount, "Diskon tambahan", "INVALID_AMOUNT");
  if (extraDiscount > subtotal) {
    throw new CalcError("EXTRA_DISCOUNT_EXCEEDS_SUBTOTAL", "Diskon tambahan melebihi subtotal");
  }
  const shares = allocateProRata(extraDiscount, lines.map((l) => l.net));
  const bases = lines.map((l, i) => l.net - (shares[i] as bigint));

  // ── 5. Pajak per kelompok ──
  const groupMap = new Map<string, { rule: TaxRule; base: bigint }>();
  lines.forEach((l, i) => {
    if (!l.tax) return;
    const g = groupMap.get(l.tax.key);
    if (g) g.base += bases[i] as bigint;
    else groupMap.set(l.tax.key, { rule: l.tax, base: bases[i] as bigint });
  });

  let taxAdded = 0n;
  let taxIncluded = 0n;
  let dppSum = 0n;
  const taxGroups: TaxGroupResult[] = [];
  for (const { rule, base } of groupMap.values()) {
    const num = BigInt(rule.dppNumerator);
    const den = BigInt(rule.dppDenominator);
    const bps = BigInt(rule.rateBps);
    let dpp: bigint;
    let tax: bigint;
    if (rule.method === "EXCLUSIVE") {
      dpp = roundDivHalfUp(base * num, den);
      tax = roundDivHalfUp(base * num * bps, den * 10_000n); // pembulatan tunggal dari nilai eksak
      taxAdded += tax;
    } else {
      // Harga sudah termasuk pajak: pajak = base × e/(1+e), e = f × tarif
      tax = roundDivHalfUp(base * bps * num, den * 10_000n + bps * num);
      dpp = roundDivHalfUp((base - tax) * num, den);
      taxIncluded += tax;
    }
    dppSum += dpp;
    taxGroups.push({
      key: rule.key,
      code: rule.code,
      name: rule.name,
      rateBps: rule.rateBps,
      dppNumerator: rule.dppNumerator,
      dppDenominator: rule.dppDenominator,
      method: rule.method,
      baseAmount: toSafeNumber(base, "Dasar pajak"),
      dppAmount: toSafeNumber(dpp, "DPP"),
      taxAmount: toSafeNumber(tax, "Pajak"),
      addedToTotal: rule.method === "EXCLUSIVE",
    });
  }

  // ── 6–7. Biaya tambahan & total ──
  const transport = intField(input.transport, "Transport", "INVALID_AMOUNT");
  const admin = intField(input.admin, "Administrasi", "INVALID_AMOUNT");
  const surcharge = transport + admin;
  const netAfterDiscount = subtotal - extraDiscount;
  const total = netAfterDiscount + taxAdded + surcharge;
  if (total > BigInt(MAX_AMOUNT)) throw new CalcError("OVERFLOW", "Total invoice melebihi batas maksimum yang didukung");

  // ── 8. DP / diterima / saldo ──
  const dp = intField(input.downPayment, "Down Payment", "INVALID_AMOUNT");
  if (dp > total) throw new CalcError("DP_EXCEEDS_TOTAL", "Down Payment tidak boleh melebihi total invoice");
  const received = input.receivedAmount === undefined ? dp : intField(input.receivedAmount, "Pembayaran diterima", "INVALID_AMOUNT");
  if (received > total) {
    throw new CalcError("RECEIVED_EXCEEDS_TOTAL", "Pembayaran diterima tidak boleh melebihi total invoice");
  }

  const n = (v: bigint, label: string) => toSafeNumber(v, label);
  return {
    lines: lines.map((l, i) => ({
      quantityMilli: n(l.qtyMilli, "Kuantitas"),
      grossAmount: n(l.gross, "Nilai baris"),
      discountAmount: n(l.discount, "Diskon baris"),
      netAmount: n(l.net, "Nilai bersih baris"),
      extraDiscountShare: n(shares[i] as bigint, "Alokasi diskon"),
      baseAmount: n(bases[i] as bigint, "Dasar baris"),
    })),
    grossAmount: n(grossTotal, "Nilai bruto"),
    lineDiscountTotal: n(lineDiscountTotal, "Diskon baris"),
    extraDiscountAmount: n(extraDiscount, "Diskon tambahan"),
    discountAmount: n(lineDiscountTotal + extraDiscount, "Diskon"),
    subtotalAmount: n(subtotal, "Subtotal"),
    netAfterDiscount: n(netAfterDiscount, "Subtotal setelah diskon"),
    taxGroups,
    taxBaseAmount: n(dppSum, "DPP"),
    taxAmount: n(taxAdded, "Pajak"),
    includedTaxAmount: n(taxIncluded, "Pajak termasuk"),
    transportAmount: n(transport, "Transport"),
    adminAmount: n(admin, "Administrasi"),
    surchargeAmount: n(surcharge, "Biaya tambahan"),
    totalAmount: n(total, "Total"),
    downPaymentAmount: n(dp, "DP"),
    receivedAmount: n(received, "Diterima"),
    balanceAmount: n(total - BigInt(n(received, "Diterima")), "Saldo"),
  };
}

/** Status pembayaran dari total & jumlah diterima (aturan tunggal, dipakai server & UI). */
export function derivePaymentStatus(total: number, received: number): "UNPAID" | "PARTIALLY_PAID" | "PAID" {
  if (received <= 0) return "UNPAID";
  if (received >= total) return "PAID";
  return "PARTIALLY_PAID";
}

export { MoneyError };
