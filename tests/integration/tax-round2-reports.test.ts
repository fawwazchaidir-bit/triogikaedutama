import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, makeProof, type Fixtures } from "../helpers/db";
import { createDraft, issueInvoice } from "@/server/services/invoices";
import { recordPayment, reversePayment } from "@/server/services/payments";
import { createEntry } from "@/server/services/cash-entries";
import { getBalanceSheet, getGlIncomeStatement, getTrialBalance } from "@/server/services/finance-ledger";
import {
  getCorporateTax, getTaxOverview, getTaxProfile, getVatSummary, getWithholdingRegister, listTaxPayments, postCorporateTaxJournal,
  recordTaxPayment, runTaxReport, saveTaxYearInput, setWithholdingRef, updateTaxProfile,
} from "@/server/services/finance-tax";
import { setBooksLock } from "@/server/services/books-lock";
import { toCsv } from "@/server/export";
import { todayIso } from "@/lib/format";
import { AppError } from "@/server/errors";

/**
 * PAJAK · PUTARAN 2 — LAPORAN & PERHITUNGAN (hitung-tangan). Sistem tidak punya tarif bawaan: profil pajak diisi pengguna.
 */
const today = todayIso("Asia/Jakarta");
const YEAR = Number(today.slice(0, 4));
const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as AppError | null;
const sql = (q: string) => prisma.$executeRawUnsafe(q);
let fx: Fixtures;
const c = (code: string) => fx.coa[code]!;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures({ finance: true, openingDate: `${YEAR}-01-01` });
});
afterAll(async () => { await prisma.$disconnect(); });

const d = (m: number, day: number) => `${YEAR}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const inv = async (date: string, opts: { qty?: number; taxed?: boolean } = {}) =>
  issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: date, paymentTermDays: 30, lines: [{ ...demiChefInput(fx).lines[0]!, quantity: opts.qty ?? 7, taxConfigId: opts.taxed ? fx.ppnId : null }] }))).id);
const net = async () => Object.fromEntries((await getTrialBalance(fx.finance, { to: today })).rows.map((r) => [r.code, r.net]));
const profile = (o: Record<string, unknown>) => updateTaxProfile(fx.admin, { isPkp: true, regime: "NONE", rateBps: null, ...o });

describe("profil pajak", () => {
  it("hanya Admin yang mengubah; tarif wajib untuk rezim aktif; batas 0–100%; tercatat di audit", async () => {
    expect(await getTaxProfile(fx.finance)).toEqual({ isPkp: false, regime: "NONE", rateBps: null });
    expect((await err(updateTaxProfile(fx.finance, { isPkp: true, regime: "NONE", rateBps: null })))?.code).toBe("FORBIDDEN");
    expect((await err(profile({ regime: "GENERAL" })))?.code).toBe("VALIDATION");
    expect((await err(profile({ regime: "FINAL", rateBps: 10_001 })))?.code).toBe("VALIDATION");
    expect((await err(profile({ regime: "GENERAL", rateBps: -1 })))?.code).toBe("VALIDATION");
    expect((await err(profile({ regime: "GENERAL", rateBps: 22.5 })))?.code).toBe("VALIDATION");
    expect((await err(profile({ regime: "BEBAS", rateBps: 1 })))?.code).toBe("VALIDATION");
    await sql(`UPDATE company_settings SET "corporateTaxRegime" = 'NONE'`);
    await expect(sql(`UPDATE company_settings SET "corporateTaxRegime" = 'GENERAL', "corporateTaxRateBps" = NULL`)).rejects.toThrow(/company_settings_tax_profile/);
    expect(await profile({ regime: "GENERAL", rateBps: 2200 })).toEqual({ isPkp: true, regime: "GENERAL", rateBps: 2200 });
    expect((await prisma.auditLog.findMany({ where: { action: "tax.profile" } })).length).toBe(1);
    expect((await err(getTaxProfile(fx.staff)))?.code).toBe("FORBIDDEN");
  });
});

describe("rekap PPN", () => {
  it("per bulan: menurut invoice vs penerimaan kas vs setoran; utang akhir bulan; PPN invoice belum dilunasi", async () => {
    const a = await inv(d(1, 13), { taxed: true });
    const b = await inv(d(1, 20), { taxed: true });
    const cInv = await inv(d(2, 5), { taxed: true });
    await inv(d(2, 6)); // tanpa PPN tidak dihitung
    await recordPayment(fx.finance, { invoiceId: a.id, paymentDate: d(1, 25), amount: 15_540_000, method: "Transfer" });
    await recordPayment(fx.finance, { invoiceId: b.id, paymentDate: d(2, 10), amount: 7_770_000, method: "Transfer" });
    await recordTaxPayment(fx.finance, { kind: "PPN", taxPeriod: `${YEAR}-01`, entryDate: d(2, 20), cashAccountId: fx.bankAcctId, amount: 500_000, reference: "NTPN-001" });
    void cInv;
    const v = await getVatSummary(fx.finance, { from: d(1, 1), to: d(2, 28) });
    expect(v.rows.map((r) => r.month)).toEqual([`${YEAR}-01`, `${YEAR}-02`]);
    expect(v.rows[0]).toMatchObject({ invoiceCount: 2, invoiceBase: 28_000_000, invoiceVat: 3_080_000, vatReceived: 1_540_000, vatRemitted: 0, endingLiability: 1_540_000 });
    expect(v.rows[1]).toMatchObject({ invoiceCount: 1, invoiceBase: 14_000_000, invoiceVat: 1_540_000, vatReceived: 770_000, vatRemitted: 500_000, endingLiability: 1_810_000 });
    expect(v.liabilityNow).toBe(1_810_000);
    expect(v.vatOnUnpaidInvoices).toBe(770_000 + 1_540_000);
    expect(v.totals).toMatchObject({ invoiceVat: 4_620_000, vatReceived: 2_310_000, vatRemitted: 500_000 });
    // saldo buku besar 2-1210 = utang PPN
    expect(-(await net())["2-1210"]!).toBe(1_810_000);
    const t = await runTaxReport(fx.finance, "vat-summary", { from: d(1, 1), to: d(2, 28) });
    expect(t.totals).toMatchObject({ month: "TOTAL", invVat: 4_620_000, received: 2_310_000, remitted: 500_000, ending: 1_810_000 });
    expect(toCsv(t)).toContain("Rekap PPN Keluaran");
  });

  it("rentang > 36 bulan, balik, masa depan ditolak; staff ditolak", async () => {
    expect((await err(getVatSummary(fx.finance, { from: "2020-01-01", to: today })))?.code).toBe("VALIDATION");
    expect((await err(getVatSummary(fx.finance, { from: d(3, 1), to: d(2, 1) })))?.code).toBe("VALIDATION");
    expect((await err(getVatSummary(fx.finance, { from: d(1, 1), to: "2999-01-01" })))?.code).toBe("VALIDATION");
    expect((await err(getVatSummary(fx.staff, {})))?.code).toBe("FORBIDDEN");
  });
});

describe("register PPh dipotong pelanggan", () => {
  it("daftar, pembalikan bernilai negatif, nomor bukti potong dilengkapi sekali saja", async () => {
    const i1 = await inv(d(1, 13)), i2 = await inv(d(1, 14));
    const p1 = await recordPayment(fx.finance, { invoiceId: i1.id, paymentDate: d(1, 20), amount: 13_720_000, withholdingAmount: 280_000, method: "Transfer" });
    const p2 = await recordPayment(fx.finance, { invoiceId: i2.id, paymentDate: d(1, 21), amount: 13_720_000, withholdingAmount: 280_000, withholdingRef: "BP-002", method: "Transfer" });
    await recordPayment(fx.finance, { invoiceId: (await inv(d(1, 15))).id, paymentDate: d(1, 22), amount: 14_000_000, method: "Transfer" }); // tanpa PPh → tidak masuk register
    let reg = await getWithholdingRegister(fx.finance, { from: d(1, 1), to: today });
    expect(reg.rows).toHaveLength(2);
    expect(reg.net).toBe(560_000);
    expect(reg.missingRef).toBe(1);
    expect(reg.missingRefAmount).toBe(280_000);

    expect(await err(setWithholdingRef(fx.staff, p1.id, { ref: "BP-001/2026" }))).toBeNull(); // staff boleh melengkapi (punya payment:record)
    expect((await err(setWithholdingRef(fx.finance, p1.id, { ref: "BP-XXX" })))?.code).toBe("CONFLICT"); // sekali saja
    expect((await err(setWithholdingRef(fx.finance, p2.id, { ref: "BP-XXX" })))?.code).toBe("CONFLICT");
    expect((await err(setWithholdingRef(fx.finance, crypto.randomUUID(), { ref: "BP-1" })))?.code).toBe("NOT_FOUND");
    expect((await err(setWithholdingRef(fx.finance, p1.id, { ref: "x" })))?.code).toBe("VALIDATION");
    reg = await getWithholdingRegister(fx.finance, { from: d(1, 1), to: today });
    expect(reg.missingRef).toBe(0);
    expect(reg.rows.find((r) => r.paymentId === p1.id)!.ref).toBe("BP-001/2026");

    await reversePayment(fx.finance, p2.id, { reason: "Salah invoice" });
    reg = await getWithholdingRegister(fx.finance, { from: d(1, 1), to: today });
    expect(reg.rows).toHaveLength(3);
    expect(reg.net).toBe(280_000);
    expect(reg.rows.at(-1)).toMatchObject({ entryType: "REVERSAL", amount: -280_000 });
    // pembayaran tanpa PPh tidak punya nomor bukti potong
    const plainPay = await prisma.payment.findFirstOrThrow({ where: { withholdingAmount: 0n, entryType: "PAYMENT" } });
    expect((await err(setWithholdingRef(fx.finance, plainPay.id, { ref: "BP-9" })))?.code).toBe("CONFLICT");
    const csv = toCsv(await runTaxReport(fx.finance, "pph23-register", { from: d(1, 1), to: today }));
    expect(csv).toContain("BP-001/2026");
  });

  it("SQL langsung: hanya withholdingRef dari kosong yang boleh berubah; kolom lain & penimpaan ditolak", async () => {
    const i1 = await inv(d(1, 13));
    const p = await recordPayment(fx.finance, { invoiceId: i1.id, paymentDate: d(1, 20), amount: 13_720_000, withholdingAmount: 280_000, method: "Transfer" });
    await expect(sql(`UPDATE payments SET amount = amount + 1 WHERE id = '${p.id}'`)).rejects.toThrow(/append-only/);
    await expect(sql(`UPDATE payments SET "withholdingAmount" = 1, "withholdingRef" = 'X-1' WHERE id = '${p.id}'`)).rejects.toThrow(/append-only/);
    await expect(sql(`UPDATE payments SET "withholdingRef" = '   ' WHERE id = '${p.id}'`)).rejects.toThrow();
    await expect(sql(`DELETE FROM payments WHERE id = '${p.id}'`)).rejects.toThrow(/append-only/);
    await sql(`UPDATE payments SET "withholdingRef" = 'BP-SQL-1' WHERE id = '${p.id}'`); // dari kosong: boleh
    await expect(sql(`UPDATE payments SET "withholdingRef" = 'BP-SQL-2' WHERE id = '${p.id}'`)).rejects.toThrow(/append-only/); // timpa: tidak boleh
    await expect(sql(`UPDATE payments SET "withholdingRef" = NULL WHERE id = '${p.id}'`)).rejects.toThrow(/append-only/);
  });
});

describe("estimasi PPh badan", () => {
  /** Pendapatan 50.000.000 (kredit PPh 1.000.000), beban 20.000.000 → laba sebelum pajak 30.000.000. */
  async function books() {
    for (const [i, q] of [7, 7, 7, 4].entries()) {
      const x = await inv(d(2, 1 + i), { qty: q });
      await recordPayment(fx.finance, i === 0
        ? { invoiceId: x.id, paymentDate: d(2, 10), amount: 13_000_000, withholdingAmount: 1_000_000, withholdingRef: "BP-1", method: "Transfer" }
        : { invoiceId: x.id, paymentDate: d(2, 10), amount: q * 2_000_000, method: "Transfer" });
    }
    await createEntry(fx.finance, { entryDate: d(3, 1), cashAccountId: fx.bankAcctId, counterAccountId: c("5-1100"), amount: 12_000_000, description: "Honor", proofFileId: await makeProof(fx.finance) });
    await createEntry(fx.finance, { entryDate: d(3, 2), cashAccountId: fx.bankAcctId, counterAccountId: c("6-1100"), amount: 8_000_000, description: "Gaji", proofFileId: await makeProof(fx.finance) });
  }

  it("GENERAL: PKP = laba + koreksi − kompensasi; jurnal penyesuaian membuat saldo 2-1230 = kurang bayar; idempoten", async () => {
    await books();
    await profile({ regime: "GENERAL", rateBps: 2200 });
    await saveTaxYearInput(fx.finance, { year: YEAR, fiscalCorrection: 2_000_000, lossCompensation: 5_000_000, facilityReduction: 0, note: "Koreksi dari akuntan" });
    await recordTaxPayment(fx.finance, { kind: "PPH_BADAN", taxPeriod: String(YEAR), entryDate: d(4, 15), cashAccountId: fx.bankAcctId, amount: 1_200_000, reference: "ID-BILLING-1", proofFileId: await makeProof(fx.finance) });

    expect((await getCorporateTax(fx.finance, { year: YEAR, month: null })).commercialProfit).toBe(30_000_000); // klien mengirim month=null untuk rezim tahunan
    expect((await err(getCorporateTax(fx.finance, { year: YEAR, month: 13 })))?.code).toBe("VALIDATION");
    let t = await getCorporateTax(fx.finance, { year: YEAR });
    expect(t.commercialProfit).toBe(30_000_000);
    expect(t.estimate).toMatchObject({ basis: 27_000_000, taxGross: 5_940_000, taxDue: 5_940_000, credits: 1_000_000, installments: 1_200_000, payable: 3_740_000 });
    expect(t.suggestion!.lines.map((l) => [l.code, l.debit, l.credit])).toEqual([["1-1400", 0, 1_000_000], ["2-1230", 0, 4_940_000], ["7-1100", 5_940_000, 0]]);

    await postCorporateTaxJournal(fx.finance, { year: YEAR });
    t = await getCorporateTax(fx.finance, { year: YEAR });
    expect(t.suggestion).toBeNull(); // sudah sesuai
    expect((await err(postCorporateTaxJournal(fx.finance, { year: YEAR })))?.code).toBe("CONFLICT");
    const n = await net();
    expect(n["7-1100"]).toBe(5_940_000);
    expect(n["1-1400"] ?? 0).toBe(0); // kredit PPh 23 dipakai
    expect(-(n["2-1230"] ?? 0)).toBe(t.estimate.payable); // saldo utang PPh badan = kurang bayar estimasi
    expect((await getGlIncomeStatement(fx.finance, { from: d(1, 1), to: today })).netProfit).toBe(30_000_000 - 5_940_000);
    expect((await getBalanceSheet(fx.finance, { to: today })).balanced).toBe(true);

    // koreksi fiskal berubah → hanya selisihnya yang dijurnal (inkremental)
    await saveTaxYearInput(fx.finance, { year: YEAR, fiscalCorrection: 3_000_000, lossCompensation: 5_000_000, facilityReduction: 0, note: null });
    t = await getCorporateTax(fx.finance, { year: YEAR });
    expect(t.estimate.taxDue).toBe(6_160_000);
    expect(t.suggestion!.lines.map((l) => [l.code, l.debit, l.credit])).toEqual([["2-1230", 0, 220_000], ["7-1100", 220_000, 0]]);
    await postCorporateTaxJournal(fx.finance, { year: YEAR });
    expect(-((await net())["2-1230"] ?? 0)).toBe(3_960_000);
    // pembayaran kurang bayar (PPh 29) → utang nol
    await recordTaxPayment(fx.finance, { kind: "PPH_BADAN", taxPeriod: String(YEAR), entryDate: d(5, 1), cashAccountId: fx.bankAcctId, amount: 3_960_000, reference: "ID-BILLING-2", proofFileId: await makeProof(fx.finance) });
    expect((await net())["2-1230"] ?? 0).toBe(0);
    expect((await getCorporateTax(fx.finance, { year: YEAR })).estimate.payable).toBe(0);
    const rep = await runTaxReport(fx.finance, "corporate-tax", { year: YEAR });
    expect(rep.rows.find((r) => /PPh terutang/.test(String(r.item)))!.amount).toBe(6_160_000);
  });

  it("FINAL: pajak dari peredaran bruto bulanan; wajib memilih bulan; tanpa kredit PPh 23", async () => {
    await books();
    await profile({ regime: "FINAL", rateBps: 50 });
    expect((await err(getCorporateTax(fx.finance, { year: YEAR })))?.code).toBe("VALIDATION");
    const t = await getCorporateTax(fx.finance, { year: YEAR, month: 2 });
    expect(t.grossRevenue).toBe(50_000_000);
    expect(t.estimate).toMatchObject({ basis: 50_000_000, taxDue: 250_000, credits: 0 });
    expect(t.suggestion!.lines.map((l) => [l.code, l.debit, l.credit])).toEqual([["2-1230", 0, 250_000], ["7-1100", 250_000, 0]]);
    await postCorporateTaxJournal(fx.finance, { year: YEAR, month: 2 });
    expect((await getCorporateTax(fx.finance, { year: YEAR, month: 2 })).suggestion).toBeNull();
    expect((await net())["1-1400"]).toBe(1_000_000); // kredit PPh 23 tidak dipakai pada rezim final
    expect((await getCorporateTax(fx.finance, { year: YEAR, month: 3 })).estimate.taxDue).toBe(0);
  });

  it("NONE: tidak ada estimasi/jurnal; masukan tahunan dibatasi; izin & penutupan buku dihormati", async () => {
    await books();
    const t = await getCorporateTax(fx.finance, { year: YEAR });
    expect(t.estimate.taxDue).toBe(0);
    expect(t.suggestion).toBeNull();
    expect((await err(postCorporateTaxJournal(fx.finance, { year: YEAR })))?.code).toBe("CONFLICT");
    await profile({ regime: "GENERAL", rateBps: 2200 });
    for (const bad of [{ fiscalCorrection: 1.5 }, { lossCompensation: -1 }, { facilityReduction: -1 }, { year: 1999 }, { year: 2300 }, { fiscalCorrection: "x" }]) {
      expect((await err(saveTaxYearInput(fx.finance, { year: YEAR, fiscalCorrection: 0, lossCompensation: 0, facilityReduction: 0, ...bad })))?.code, JSON.stringify(bad)).toBe("VALIDATION");
    }
    expect((await err(saveTaxYearInput(fx.staff, { year: YEAR, fiscalCorrection: 0, lossCompensation: 0, facilityReduction: 0 })))?.code).toBe("FORBIDDEN");
    expect((await err(postCorporateTaxJournal(fx.staff, { year: YEAR })))?.code).toBe("FORBIDDEN");
    expect((await err(getCorporateTax(fx.finance, { year: YEAR + 1 })))?.code).toBe("VALIDATION"); // belum dimulai
    // tanggal jurnal harus di dalam periode, dan buku yang sudah ditutup menolak
    expect((await err(postCorporateTaxJournal(fx.finance, { year: YEAR, date: `${YEAR - 1}-12-31` })))?.code).toBe("VALIDATION");
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    await setBooksLock(fx.finance, { lockedThrough: yesterday, reason: "Tutup untuk uji" });
    expect((await err(postCorporateTaxJournal(fx.finance, { year: YEAR, date: d(3, 3) })))?.code).toBe("VALIDATION");
    expect((await err(recordTaxPayment(fx.finance, { kind: "PPN", taxPeriod: "2026-01", entryDate: d(3, 3), cashAccountId: fx.bankAcctId, amount: 1000, reference: "NTPN" })))?.code).toBe("VALIDATION");
  });
});

describe("setoran pajak & ikhtisar", () => {
  it("hanya yang berwenang kas; daftar setoran; ikhtisar saldo; staff ditolak", async () => {
    const a = await inv(d(1, 13), { taxed: true });
    await recordPayment(fx.finance, { invoiceId: a.id, paymentDate: d(1, 25), amount: 15_260_000, withholdingAmount: 280_000, method: "Transfer" });
    expect((await err(recordTaxPayment(fx.staff, { kind: "PPN", taxPeriod: "2026-01", entryDate: d(2, 1), cashAccountId: fx.bankAcctId, amount: 500_000, reference: "NTPN-1" })))?.code).toBe("FORBIDDEN");
    expect((await err(recordTaxPayment(fx.finance, { kind: "PPN", taxPeriod: "2026-01", entryDate: d(2, 1), cashAccountId: fx.bankAcctId, amount: 1_200_000, reference: "NTPN-1" })))?.code).toBe("VALIDATION"); // > Rp1 juta wajib bukti
    expect((await err(recordTaxPayment(fx.finance, { kind: "PPN", taxPeriod: "2026-01", entryDate: d(2, 1), cashAccountId: fx.bankAcctId, amount: 0, reference: "NTPN-1" })))?.code).toBe("VALIDATION");
    expect((await err(recordTaxPayment(fx.finance, { kind: "PPN", taxPeriod: "2026-01", entryDate: d(2, 1), cashAccountId: fx.bankAcctId, amount: 500, reference: "" })))?.code).toBe("VALIDATION");
    expect((await err(recordTaxPayment(fx.finance, { kind: "PPN", taxPeriod: "2026-01", entryDate: d(2, 1), cashAccountId: fx.bankAcctId, amount: 500, reference: "NTPN-1", extra: 1 } as never)))).toBeNull();
    const list = await listTaxPayments(fx.finance);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "PPN", amount: 500, reference: "NTPN-1" });
    const o = await getTaxOverview(fx.finance);
    expect(o).toMatchObject({ vatLiability: 1_540_000 - 500, pphCredit: 280_000, pphBadanPayable: 0, vatOnUnpaidInvoices: 0, withholdingMissingRef: 1 });
    expect((await err(getTaxOverview(fx.staff)))?.code).toBe("FORBIDDEN");
  });
});
