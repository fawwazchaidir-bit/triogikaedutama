import { describe, expect, it } from "vitest";
import {
  allocateProRata,
  CalcError,
  calculateInvoice,
  derivePaymentStatus,
  parseQuantityMilli,
  type TaxRule,
} from "@/lib/finance/calculate";

const PPN11: TaxRule = {
  key: "ppn11", code: "PPN11", name: "PPN 11%", rateBps: 1100, dppNumerator: 1, dppDenominator: 1, method: "EXCLUSIVE",
};
const PPN12_DPP_NL: TaxRule = {
  key: "ppn12", code: "PPN12", name: "PPN 12% (DPP 11/12)", rateBps: 1200, dppNumerator: 11, dppDenominator: 12, method: "EXCLUSIVE",
};
const PPN11_INCL: TaxRule = { ...PPN11, key: "ppn11i", code: "PPN11I", method: "INCLUSIVE" };

describe("calculateInvoice — skenario acuan brief", () => {
  it("CV Bima Satria Jaya: 7 Pax × Rp2.000.000, semua biaya lain 0", () => {
    const r = calculateInvoice({ lines: [{ quantity: 7, unitPrice: 2_000_000 }] });
    expect(r.subtotalAmount).toBe(14_000_000);
    expect(r.totalAmount).toBe(14_000_000);
    expect(r.taxAmount).toBe(0);
    expect(r.surchargeAmount).toBe(0);
    expect(r.downPaymentAmount).toBe(0);
    expect(r.balanceAmount).toBe(14_000_000);
    expect(derivePaymentStatus(r.totalAmount, r.receivedAmount)).toBe("UNPAID");
  });

  it("beberapa item dijumlahkan", () => {
    const r = calculateInvoice({
      lines: [
        { quantity: 7, unitPrice: 2_000_000 },
        { quantity: 3, unitPrice: 1_500_000 },
      ],
    });
    expect(r.lines.map((l) => l.netAmount)).toEqual([14_000_000, 4_500_000]);
    expect(r.subtotalAmount).toBe(18_500_000);
    expect(r.totalAmount).toBe(18_500_000);
  });
});

describe("kuantitas", () => {
  it("menerima desimal sampai 3 digit (koma atau titik)", () => {
    expect(parseQuantityMilli("1,5")).toBe(1500n);
    expect(parseQuantityMilli("2.250")).toBe(2250n);
    expect(parseQuantityMilli(7)).toBe(7000n);
  });
  it("menolak nol, negatif, >3 desimal, bukan angka, dan notasi ilmiah", () => {
    for (const bad of ["0", "-1", "1.2345", "abc", "", " ", "1e3", Number.NaN, 1e21, 0.30000000000000004]) {
      expect(() => parseQuantityMilli(bad as never)).toThrow(CalcError);
    }
  });
  it("qty desimal × harga dibulatkan half-up sekali", () => {
    // 1,5 × 333 = 499,5 → 500
    const r = calculateInvoice({ lines: [{ quantity: "1.5", unitPrice: 333 }] });
    expect(r.lines[0]?.grossAmount).toBe(500);
    // 0,001 × 499 = 0,499 → 0
    expect(calculateInvoice({ lines: [{ quantity: "0.001", unitPrice: 499 }] }).totalAmount).toBe(0);
  });
});

describe("validasi input", () => {
  it("menolak tanpa baris", () => {
    expect(() => calculateInvoice({ lines: [] })).toThrowError(/minimal satu baris/);
  });
  it("menolak harga negatif / pecahan / melebihi batas", () => {
    for (const unitPrice of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e16]) {
      expect(() => calculateInvoice({ lines: [{ quantity: 1, unitPrice }] })).toThrow(CalcError);
    }
  });
  it("menolak diskon baris melebihi nilai baris", () => {
    expect(() => calculateInvoice({ lines: [{ quantity: 1, unitPrice: 100, discount: 101 }] })).toThrowError(/Diskon baris melebihi/);
  });
  it("menolak diskon tambahan melebihi subtotal", () => {
    expect(() => calculateInvoice({ lines: [{ quantity: 1, unitPrice: 100 }], extraDiscount: 101 })).toThrowError(/Diskon tambahan melebihi/);
  });
  it("menolak DP melebihi total", () => {
    expect(() => calculateInvoice({ lines: [{ quantity: 1, unitPrice: 100 }], downPayment: 101 })).toThrowError(/Down Payment/);
  });
  it("menolak transport/administrasi negatif", () => {
    expect(() => calculateInvoice({ lines: [{ quantity: 1, unitPrice: 100 }], transport: -5 })).toThrow(CalcError);
    expect(() => calculateInvoice({ lines: [{ quantity: 1, unitPrice: 100 }], admin: -5 })).toThrow(CalcError);
  });
  it("menolak total di atas batas maksimum", () => {
    expect(() => calculateInvoice({ lines: [{ quantity: 1000, unitPrice: 999_999_999_999_999 }] })).toThrow(CalcError);
  });
});

describe("diskon", () => {
  it("diskon baris mengurangi nilai bersih baris", () => {
    const r = calculateInvoice({ lines: [{ quantity: 2, unitPrice: 1_000_000, discount: 250_000 }] });
    expect(r.grossAmount).toBe(2_000_000);
    expect(r.lineDiscountTotal).toBe(250_000);
    expect(r.subtotalAmount).toBe(1_750_000);
    expect(r.totalAmount).toBe(1_750_000);
  });

  it("diskon tambahan mengurangi total dan dialokasikan pro-rata tanpa sisa", () => {
    const r = calculateInvoice({
      lines: [
        { quantity: 1, unitPrice: 1_000_000 },
        { quantity: 1, unitPrice: 2_000_000 },
        { quantity: 1, unitPrice: 3_000_000 },
      ],
      extraDiscount: 100_000,
    });
    expect(r.subtotalAmount).toBe(6_000_000);
    expect(r.netAfterDiscount).toBe(5_900_000);
    expect(r.totalAmount).toBe(5_900_000);
    expect(r.lines.reduce((a, l) => a + l.extraDiscountShare, 0)).toBe(100_000);
    expect(r.discountAmount).toBe(100_000);
  });

  it("alokasi pro-rata selalu menjumlah persis ke total (property sweep)", () => {
    for (let total = 0; total <= 40; total++) {
      for (const weights of [[1n, 1n, 1n], [7n, 3n], [1n, 99n, 100n, 3n], [5n]]) {
        const sumW = weights.reduce((a, b) => a + b, 0n);
        if (BigInt(total) > sumW) continue;
        const out = allocateProRata(BigInt(total), weights);
        expect(out.reduce((a, b) => a + b, 0n)).toBe(BigInt(total));
        out.forEach((v, i) => expect(v <= (weights[i] as bigint)).toBe(true));
      }
    }
  });
});

describe("pajak", () => {
  it("EXCLUSIVE 11% ditambahkan ke total", () => {
    const r = calculateInvoice({ lines: [{ quantity: 1, unitPrice: 10_000_000, tax: PPN11 }] });
    expect(r.taxAmount).toBe(1_100_000);
    expect(r.taxBaseAmount).toBe(10_000_000);
    expect(r.totalAmount).toBe(11_100_000);
    expect(r.taxGroups).toHaveLength(1);
  });

  it("DPP Nilai Lain 11/12 dengan tarif 12% → efektif 11% tanpa pembulatan ganda", () => {
    const r = calculateInvoice({ lines: [{ quantity: 1, unitPrice: 10_000_000, tax: PPN12_DPP_NL }] });
    expect(r.taxBaseAmount).toBe(9_166_667); // DPP = 10.000.000 × 11/12 (dibulatkan)
    expect(r.taxAmount).toBe(1_100_000); // 10.000.000 × 11/12 × 12% = 1.100.000 persis
    expect(r.totalAmount).toBe(11_100_000);
  });

  it("pembulatan pajak dilakukan SEKALI per kelompok (bukan per baris)", () => {
    // 3 baris × Rp 1.005 @ 11%: per-baris = 3 × round(110,55)=3×111=333 ; per-kelompok = round(331,65)=332
    const lines = [1, 2, 3].map(() => ({ quantity: 1, unitPrice: 1_005, tax: PPN11 }));
    const r = calculateInvoice({ lines });
    expect(r.taxAmount).toBe(332);
    expect(r.totalAmount).toBe(3_015 + 332);
  });

  it("baris tanpa pajak tidak ikut dasar pajak (pajak per transaksi bisa berbeda)", () => {
    const r = calculateInvoice({
      lines: [
        { quantity: 1, unitPrice: 1_000_000, tax: PPN11 },
        { quantity: 1, unitPrice: 4_000_000, tax: null },
      ],
    });
    expect(r.taxBaseAmount).toBe(1_000_000);
    expect(r.taxAmount).toBe(110_000);
    expect(r.totalAmount).toBe(5_110_000);
  });

  it("diskon tambahan mengurangi dasar pajak secara pro-rata", () => {
    const r = calculateInvoice({
      lines: [
        { quantity: 1, unitPrice: 1_000_000, tax: PPN11 },
        { quantity: 1, unitPrice: 1_000_000, tax: null },
      ],
      extraDiscount: 200_000,
    });
    // diskon 200rb → 100rb ke tiap baris; dasar pajak = 900rb; pajak = 99rb
    expect(r.taxBaseAmount).toBe(900_000);
    expect(r.taxAmount).toBe(99_000);
    expect(r.totalAmount).toBe(2_000_000 - 200_000 + 99_000);
  });

  it("INCLUSIVE: pajak diekstrak dari harga dan TIDAK menambah total", () => {
    const r = calculateInvoice({ lines: [{ quantity: 1, unitPrice: 1_110_000, tax: PPN11_INCL }] });
    expect(r.taxAmount).toBe(0); // tidak ditambahkan
    expect(r.includedTaxAmount).toBe(110_000);
    expect(r.taxBaseAmount).toBe(1_000_000);
    expect(r.totalAmount).toBe(1_110_000);
  });

  it("kelompok pajak berbeda dihitung terpisah", () => {
    const other: TaxRule = { ...PPN11, key: "x", code: "X", rateBps: 200 };
    const r = calculateInvoice({
      lines: [
        { quantity: 1, unitPrice: 1_000_000, tax: PPN11 },
        { quantity: 1, unitPrice: 1_000_000, tax: other },
      ],
    });
    expect(r.taxGroups.map((g) => g.taxAmount).sort((a, b) => a - b)).toEqual([20_000, 110_000]);
    expect(r.taxAmount).toBe(130_000);
  });

  it("menolak konfigurasi pajak tidak valid", () => {
    expect(() =>
      calculateInvoice({ lines: [{ quantity: 1, unitPrice: 1, tax: { ...PPN11, dppDenominator: 0 } }] }),
    ).toThrowError(/tidak valid/);
  });
});

describe("biaya tambahan, DP, dan saldo", () => {
  it("transport + administrasi menambah total", () => {
    const r = calculateInvoice({
      lines: [{ quantity: 1, unitPrice: 1_000_000 }],
      transport: 150_000,
      admin: 50_000,
    });
    expect(r.surchargeAmount).toBe(200_000);
    expect(r.totalAmount).toBe(1_200_000);
  });

  it("DP TIDAK mengurangi total — hanya mengurangi saldo (tidak dihitung dua kali)", () => {
    const r = calculateInvoice({ lines: [{ quantity: 7, unitPrice: 2_000_000 }], downPayment: 5_000_000 });
    expect(r.totalAmount).toBe(14_000_000);
    expect(r.downPaymentAmount).toBe(5_000_000);
    expect(r.balanceAmount).toBe(9_000_000);
    expect(derivePaymentStatus(r.totalAmount, r.receivedAmount)).toBe("PARTIALLY_PAID");
  });

  it("pembayaran dari ledger menggantikan DP sebagai 'diterima'", () => {
    const r = calculateInvoice({
      lines: [{ quantity: 7, unitPrice: 2_000_000 }],
      downPayment: 5_000_000,
      receivedAmount: 14_000_000, // 5 jt (DP) + 9 jt, sudah termasuk DP — tidak ditambah lagi
    });
    expect(r.balanceAmount).toBe(0);
    expect(derivePaymentStatus(r.totalAmount, r.receivedAmount)).toBe("PAID");
  });

  it("menolak diterima melebihi total", () => {
    expect(() =>
      calculateInvoice({ lines: [{ quantity: 1, unitPrice: 100 }], receivedAmount: 101 }),
    ).toThrowError(/melebihi total/);
  });

  it("identitas: total = subtotal − diskon tambahan + pajak + transport + admin", () => {
    const r = calculateInvoice({
      lines: [
        { quantity: 3, unitPrice: 1_234_567, discount: 12_345, tax: PPN11 },
        { quantity: "2.5", unitPrice: 777_777, tax: PPN12_DPP_NL },
        { quantity: 1, unitPrice: 50_000 },
      ],
      extraDiscount: 99_999,
      transport: 25_000,
      admin: 10_000,
      downPayment: 1_000_000,
    });
    expect(r.totalAmount).toBe(r.subtotalAmount - r.extraDiscountAmount + r.taxAmount + r.surchargeAmount);
    expect(r.grossAmount - r.discountAmount).toBe(r.subtotalAmount - r.extraDiscountAmount);
    expect(r.balanceAmount).toBe(r.totalAmount - 1_000_000);
  });
});

describe("derivePaymentStatus", () => {
  it("UNPAID / PARTIALLY_PAID / PAID", () => {
    expect(derivePaymentStatus(100, 0)).toBe("UNPAID");
    expect(derivePaymentStatus(100, 1)).toBe("PARTIALLY_PAID");
    expect(derivePaymentStatus(100, 99)).toBe("PARTIALLY_PAID");
    expect(derivePaymentStatus(100, 100)).toBe("PAID");
  });
});
