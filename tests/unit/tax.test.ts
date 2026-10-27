import { describe, expect, it } from "vitest";
import { vatForPayment } from "@/lib/accounting/tax";
import { deriveLines, trialBalance, type GlAccount, type GlInput } from "@/lib/accounting/ledger";
import { buildIncomeStatement } from "@/lib/accounting/statements";

/** Pajak pada pembayaran invoice: PPN dibekukan per pembayaran (kumulatif proporsional), PPh dipotong pelanggan = kredit pajak tanpa uang. */
describe("vatForPayment (kumulatif proporsional, tanpa pecahan)", () => {
  const inv = { total: 1_110_000, vat: 110_000 };
  it("pembayaran penuh = seluruh PPN", () => {
    expect(vatForPayment({ ...inv, settledBefore: 0, vatBefore: 0, settled: 1_110_000 })).toBe(110_000);
  });
  it("tanpa PPN → 0", () => {
    expect(vatForPayment({ total: 1_000_000, vat: 0, settledBefore: 0, vatBefore: 0, settled: 400_000 })).toBe(0);
  });
  it("cicilan: proporsional, pelunasan menutup selisih pembulatan; Σ = PPN invoice persis", () => {
    const total = 1_000_003, vat = 90_913; // sengaja tidak habis dibagi
    const steps = [123_457, 400_001, 250_000, 226_545]; // Σ = 1.000.003
    let settled = 0, v = 0;
    for (const s of steps) { const x = vatForPayment({ total, vat, settledBefore: settled, vatBefore: v, settled: s }); expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(s); settled += s; v += x; }
    expect(settled).toBe(total);
    expect(v).toBe(vat);
  });
  it("nilai besar tidak meluap (BigInt)", () => {
    const total = 9_000_000_000_000_000, vat = 990_000_000_000_000;
    expect(vatForPayment({ total, vat, settledBefore: 0, vatBefore: 0, settled: total / 3 })).toBe(330_000_000_000_000);
  });
  it("properti 500 acak: Σ PPN = PPN invoice saat lunas, tidak pernah negatif / melebihi nilai pembayaran / melebihi sisa PPN", () => {
    let seed = 7;
    const r = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < 500; i++) {
      const total = 1_000 + Math.floor(r() * 50_000_000), vat = Math.floor(r() * total * 0.2);
      let settled = 0, v = 0;
      while (settled < total) {
        const s = Math.min(total - settled, 1 + Math.floor(r() * total * 0.6));
        const x = vatForPayment({ total, vat, settledBefore: settled, vatBefore: v, settled: s });
        expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(s); expect(v + x).toBeLessThanOrEqual(vat);
        settled += s; v += x;
      }
      expect(v, `total=${total} vat=${vat}`).toBe(vat);
    }
  });
});

const mk = (code: string, type: GlAccount["type"]): GlAccount => ({ id: `a-${code}`, code, name: code, type });
const COA = [mk("1-1100", "ASET"), mk("1-1200", "ASET"), mk("1-1400", "ASET"), mk("1-1450", "ASET"), mk("2-1210", "KEWAJIBAN"), mk("3-2100", "EKUITAS"), mk("4-1100", "PENDAPATAN")];
const input = (payments: GlInput["payments"]): GlInput => ({
  coa: COA, accounts: [{ id: "bank", name: "Bank", kind: "BANK", openingBalance: 0, openingDate: "2026-01-01", coaAccountId: "a-1-1200" }],
  payments, entries: [], transfers: [], manual: [],
});
const net = (inp: GlInput, asOf = "2026-12-31") => Object.fromEntries(trialBalance(deriveLines(inp), COA, asOf).rows.map((r) => [r.code, r.net]));

describe("jurnal pembayaran dengan pajak (hitung tangan)", () => {
  // Invoice 11.100.000: DPP 10.000.000 + PPN 1.100.000. Pelanggan memotong PPh 23 sebesar 200.000 → uang masuk 10.900.000.
  const pay = { id: "p1", date: "2026-02-10", createdAt: "1", amount: 10_900_000, withholding: 200_000, vat: 1_100_000, accountId: "bank", label: "inv 1" };
  it("Dr kas 10,9jt + Dr PPh dibayar dimuka 0,2jt / Cr utang PPN 1,1jt + Cr pendapatan 10jt", () => {
    expect(net(input([pay]))).toEqual({ "1-1200": 10_900_000, "1-1400": 200_000, "2-1210": -1_100_000, "4-1100": -10_000_000 });
  });
  it("pembalikan menetralkan semuanya", () => {
    const rev = { ...pay, id: "p2", createdAt: "2", date: "2026-03-01", amount: -10_900_000, withholding: -200_000, vat: -1_100_000 };
    expect(net(input([pay, rev]))).toEqual({});
  });
  it("tak teralokasi: uang masuk ke 1-1450, PPh & PPN tetap tercatat", () => {
    expect(net(input([{ ...pay, accountId: null }]))).toEqual({ "1-1450": 10_900_000, "1-1400": 200_000, "2-1210": -1_100_000, "4-1100": -10_000_000 });
  });
  it("pra-pembukuan: seluruh jurnal pembayaran dilewati (termasuk PPh & PPN)", () => {
    expect(net(input([{ ...pay, date: "2025-12-01" }]))).toEqual({});
  });
  it("setiap pembayaran seimbang untuk 400 kombinasi acak", () => {
    let seed = 3;
    const r = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < 400; i++) {
      const cash = 1 + Math.floor(r() * 9_000_000), wh = Math.floor(r() * 500_000), vat = Math.floor(r() * (cash + wh));
      const sign = r() < 0.2 ? -1 : 1;
      const tb = trialBalance(deriveLines(input([{ id: "x", date: "2026-02-01", createdAt: "1", amount: sign * cash, withholding: sign * wh, vat: sign * vat, accountId: r() < 0.3 ? null : "bank", label: "i" }])), COA, "2026-12-31");
      expect(tb.balanced).toBe(true);
    }
  });
});

describe("laba rugi tahap 1 (pembanding independen) dengan pajak", () => {
  it("pendapatan = uang + PPh dipotong − PPN; PPN dan PPh dicatat terpisah", () => {
    const d = { accounts: [{ id: "bank", name: "Bank", kind: "BANK" as const, openingBalance: 0, openingDate: "2026-01-01" }], entries: [], transfers: [],
      payments: [{ date: "2026-02-10", amount: 10_900_000, withholding: 200_000, vat: 1_100_000, accountId: "bank" }] };
    const r = buildIncomeStatement(d, "2026-01-01", "2026-12-31");
    expect(r.revenue).toBe(10_000_000);
    expect(r.vatCollected).toBe(1_100_000);
    expect(r.withheldByCustomers).toBe(200_000);
  });
});

import { corporateTax } from "@/lib/accounting/tax";
describe("estimasi PPh badan (aritmetika dari masukan; tarif milik pengguna)", () => {
  const base = { regime: "GENERAL" as const, rateBps: 2200, commercialProfit: 100_000_000, grossRevenue: 0, fiscalCorrection: 5_000_000, lossCompensation: 10_000_000, facilityReduction: 0, withholdingCredit: 3_000_000, installmentsPaid: 12_000_000 };
  it("GENERAL: PKP = laba + koreksi − kompensasi; kurang bayar = pajak − PPh 23 − angsuran", () => {
    const r = corporateTax(base);
    expect(r.basis).toBe(95_000_000);
    expect(r.taxDue).toBe(20_900_000);
    expect(r.payable).toBe(20_900_000 - 3_000_000 - 12_000_000);
  });
  it("rugi fiskal → pajak 0, angsuran menjadi lebih bayar; fasilitas tidak melebihi pajak", () => {
    const r = corporateTax({ ...base, commercialProfit: -50_000_000, fiscalCorrection: 0, lossCompensation: 0, facilityReduction: 999 });
    expect(r.basis).toBe(0);
    expect(r.taxDue).toBe(0);
    expect(r.facilityReduction).toBe(0);
    expect(r.payable).toBe(-3_000_000 - 12_000_000);
    expect(corporateTax({ ...base, facilityReduction: 50_000_000 }).taxDue).toBe(0);
    expect(corporateTax({ ...base, facilityReduction: 900_000 }).taxDue).toBe(20_000_000);
  });
  it("FINAL: pajak dari peredaran bruto, tanpa kredit PPh 23 dan koreksi fiskal", () => {
    const r = corporateTax({ ...base, regime: "FINAL", rateBps: 50, grossRevenue: 400_000_000 });
    expect(r.basis).toBe(400_000_000);
    expect(r.taxDue).toBe(2_000_000);
    expect(r.credits).toBe(0);
    expect(r.payable).toBe(2_000_000 - 12_000_000);
  });
  it("NONE atau tarif kosong → tidak ada estimasi; pembulatan ke bawah; nilai besar aman", () => {
    expect(corporateTax({ ...base, regime: "NONE" }).taxDue).toBe(0);
    expect(corporateTax({ ...base, rateBps: null }).taxDue).toBe(0);
    expect(corporateTax({ ...base, commercialProfit: 1_000_001, fiscalCorrection: 0, lossCompensation: 0, rateBps: 2200 }).taxGross).toBe(220_000); // 220.000,22 → ke bawah
    expect(corporateTax({ ...base, commercialProfit: 9_000_000_000_000_000, fiscalCorrection: 0, lossCompensation: 0, rateBps: 2200 }).taxGross).toBe(1_980_000_000_000_000);
  });
});
