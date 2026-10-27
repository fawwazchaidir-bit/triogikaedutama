import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, makeProof, type Fixtures } from "../helpers/db";
import { cancelInvoice, createDraft, issueInvoice } from "@/server/services/invoices";
import { recordPayment, reversePayment, listPaymentsForInvoice } from "@/server/services/payments";
import { createEntry } from "@/server/services/cash-entries";
import { getBalanceSheet, getGlIncomeStatement, getTrialBalance } from "@/server/services/finance-ledger";
import { getCashFlow, getIncomeStatement } from "@/server/services/finance-statements";
import { listCashAccounts } from "@/server/services/cash-accounts";
import { getDashboard } from "@/server/services/dashboard";
import { todayIso } from "@/lib/format";
import { AppError } from "@/server/errors";

/**
 * PAJAK · PUTARAN 1 — PENCATATAN HITUNG-TANGAN.
 * PPN keluaran dikeluarkan dari pendapatan pada tiap pembayaran (kumulatif proporsional); PPh yang dipotong pelanggan
 * melunasi invoice tanpa uang dan menjadi kredit pajak (1-1400). Tidak ada tarif yang diasumsikan oleh sistem.
 */
const today = todayIso("Asia/Jakarta");
const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as AppError | null;
const sql = (q: string) => prisma.$executeRawUnsafe(q);
let fx: Fixtures;
const c = (code: string) => fx.coa[code]!;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures({ finance: true, openingDate: "2026-01-01" });
});
afterAll(async () => { await prisma.$disconnect(); });

const net = async (asOf = today) => Object.fromEntries((await getTrialBalance(fx.finance, { to: asOf })).rows.map((r) => [r.code, r.net]));
/** Invoice 7 Pax × 2.000.000 = DPP 14.000.000; dengan PPN 11% eksklusif = 1.540.000 → total 15.540.000. */
async function taxedInvoice(opts: { downPayment?: number; date?: string } = {}) {
  const d = await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: opts.date ?? "2026-01-13", paymentTermDays: 30, downPayment: opts.downPayment ?? 0, lines: [{ ...demiChefInput(fx).lines[0]!, taxConfigId: fx.ppnId }] }));
  return issueInvoice(fx.finance, d.id);
}
const plain = async () => issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: "2026-01-13", paymentTermDays: 30 }))).id);
async function sound(label: string) {
  const tb = await getTrialBalance(fx.finance, { to: today });
  expect(tb.balanced, `${label}: neraca saldo`).toBe(true);
  expect((await getBalanceSheet(fx.finance, { to: today })).balanced, `${label}: neraca`).toBe(true);
  const accts = await listCashAccounts(fx.finance);
  const n = Object.fromEntries(tb.rows.map((r) => [r.code, r.net]));
  expect(n["1-1200"] ?? 0, `${label}: bank`).toBe(accts.find((a) => a.id === fx.bankAcctId)!.balance);
  expect(n["1-1100"] ?? 0, `${label}: kas`).toBe(accts.find((a) => a.id === fx.cashAcctId)!.balance);
}

describe("PPN keluaran per pembayaran", () => {
  it("invoice 15.540.000 dicicil 3×: PPN kumulatif proporsional, Σ = 1.540.000 tepat; pendapatan = 14.000.000", async () => {
    const inv = await taxedInvoice();
    expect(inv.amounts.total).toBe(15_540_000);
    expect(inv.amounts.tax).toBe(1_540_000);
    const p1 = await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-01-20", amount: 5_000_000, method: "Transfer" });
    const p2 = await recordPayment(fx.staff, { invoiceId: inv.id, paymentDate: "2026-02-10", amount: 6_000_000, method: "Transfer" });
    const p3 = await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-03-10", amount: 4_540_000, method: "Transfer" });
    expect(p1.vatAmount).toBe(495_495); // floor(5.000.000 × 1.540.000 / 15.540.000)
    expect(p2.vatAmount).toBe(1_090_090 - 495_495); // kumulatif 11.000.000 → 1.090.090
    expect(p3.vatAmount).toBe(1_540_000 - 1_090_090); // pelunasan menutup selisih pembulatan
    expect([p1, p2, p3].reduce((s, p) => s + p.vatAmount, 0)).toBe(1_540_000);
    const n = await net();
    expect(n["1-1200"]).toBe(10_000_000 + 15_540_000);
    expect(n["2-1210"]).toBe(-1_540_000);
    expect(n["4-1100"]).toBe(-14_000_000);
    // laba rugi memuat DPP saja; pembanding tahap 1 sama
    expect((await getGlIncomeStatement(fx.finance, { from: "2026-01-01", to: today })).totalRevenue).toBe(14_000_000);
    const s1 = await getIncomeStatement(fx.finance, { from: "2026-01-01", to: today });
    expect(s1.revenue).toBe(14_000_000);
    expect(s1.vatCollected).toBe(1_540_000);
    // arus kas: penerimaan dari pelanggan = uang masuk (termasuk PPN)
    expect((await getCashFlow(fx.finance, { from: "2026-01-01", to: today })).operating.invoiceReceipts).toBe(15_540_000);
    await sound("PPN cicil");
  });

  it("pembalikan mencerminkan PPN; pembayaran ulang memulihkan Σ PPN = PPN invoice", async () => {
    const inv = await taxedInvoice();
    const p1 = await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-01-20", amount: 7_770_000, method: "Transfer" });
    expect(p1.vatAmount).toBe(770_000);
    const rev = await reversePayment(fx.finance, p1.id, { reason: "Transfer gagal" });
    expect(rev.vatAmount).toBe(-770_000);
    expect(rev.amount).toBe(-7_770_000);
    expect((await net())["2-1210"] ?? 0).toBe(0);
    expect((await net())["4-1100"] ?? 0).toBe(0);
    const again = await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-02-01", amount: 15_540_000, method: "Transfer" });
    expect(again.vatAmount).toBe(1_540_000);
    expect((await net())["2-1210"]).toBe(-1_540_000);
    await sound("pembalikan PPN");
  });

  it("DP pada saat terbit ikut membawa PPN; invoice tanpa pajak tidak pernah menghasilkan PPN", async () => {
    const inv = await taxedInvoice({ downPayment: 3_108_000 }); // 20% dari 15.540.000
    const pays = await listPaymentsForInvoice(fx.finance, inv.id);
    expect(pays).toHaveLength(1);
    expect(pays[0]!.isDownPayment).toBe(true);
    expect(pays[0]!.vatAmount).toBe(308_000); // 3.108.000 × 1.540.000 / 15.540.000
    const plainInv = await plain();
    const p = await recordPayment(fx.finance, { invoiceId: plainInv.id, paymentDate: "2026-02-01", amount: 14_000_000, method: "Transfer" });
    expect(p.vatAmount).toBe(0);
    await sound("DP PPN");
  });
});

describe("PPh dipotong pelanggan (kredit pajak)", () => {
  it("pelanggan membayar neto: invoice lunas, uang masuk lebih kecil, kredit pajak 1-1400 bertambah, pendapatan penuh", async () => {
    const inv = await plain(); // 14.000.000 tanpa PPN
    const p = await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-02-10", amount: 13_720_000, withholdingAmount: 280_000, withholdingRef: "BP-0001/2026", method: "Transfer" });
    expect(p.withholdingAmount).toBe(280_000);
    expect(p.withholdingRef).toBe("BP-0001/2026");
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(row.paymentStatus).toBe("PAID");
    expect(Number(row.paidAmount)).toBe(14_000_000);
    expect(Number(row.balanceAmount)).toBe(0);
    const n = await net();
    expect(n["1-1200"]).toBe(10_000_000 + 13_720_000); // hanya uang yang benar-benar masuk
    expect(n["1-1400"]).toBe(280_000);
    expect(n["4-1100"]).toBe(-14_000_000);
    expect((await listCashAccounts(fx.finance)).find((a) => a.id === fx.bankAcctId)!.balance).toBe(23_720_000);
    // dashboard "uang diterima" = uang (bukan nilai pelunasan)
    expect((await getDashboard(fx.finance, { from: "2026-01-01", to: today })).receivedAmount).toBe(13_720_000);
    expect((await getIncomeStatement(fx.finance, { from: "2026-01-01", to: today })).withheldByCustomers).toBe(280_000);
    await sound("PPh 23");
  });

  it("PPN + PPh sekaligus: kas 15.260.000, kredit pajak 280.000, utang PPN 1.540.000, pendapatan 14.000.000; pembalikan menetralkan", async () => {
    const inv = await taxedInvoice();
    const p = await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-02-10", amount: 15_260_000, withholdingAmount: 280_000, method: "Transfer" });
    expect(p.vatAmount).toBe(1_540_000);
    expect(await net()).toMatchObject({ "1-1200": 25_260_000, "1-1400": 280_000, "2-1210": -1_540_000, "4-1100": -14_000_000 });
    await reversePayment(fx.finance, p.id, { reason: "Bukti potong ternyata salah" });
    const n = await net();
    expect(n["1-1400"] ?? 0).toBe(0);
    expect(n["2-1210"] ?? 0).toBe(0);
    expect(n["1-1200"]).toBe(10_000_000);
    expect(Number((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).paidAmount)).toBe(0);
    await sound("PPN+PPh");
  });

  it("validasi: melebihi sisa, melebihi DPP, bukti potong tanpa PPh, angka tidak sah — semuanya ditolak tanpa sisa data", async () => {
    const inv = await plain();
    const pay = (o: Record<string, unknown>) => recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-02-10", amount: 1_000_000, method: "Transfer", ...o });
    expect((await err(pay({ amount: 13_900_000, withholdingAmount: 200_000 })))?.code).toBe("VALIDATION"); // uang + PPh > sisa
    expect((await err(pay({ amount: 1_000_000, withholdingAmount: 14_000_001 })))?.code).toBe("VALIDATION"); // > nilai invoice
    expect((await err(pay({ withholdingRef: "BP-1" })))?.code).toBe("VALIDATION"); // nomor tanpa PPh
    expect((await err(pay({ withholdingAmount: -5 })))?.code).toBe("VALIDATION");
    expect((await err(pay({ withholdingAmount: 100.5 })))?.code).toBe("VALIDATION");
    expect((await err(pay({ withholdingAmount: "abc" })))?.code).toBe("VALIDATION");
    expect(await prisma.payment.count()).toBe(0);
    // total pemotongan pada satu invoice tidak boleh melebihi nilai sebelum PPN (14.000.000)
    await pay({ amount: 1_000_000, withholdingAmount: 9_000_000 });
    expect((await err(pay({ amount: 1_000_000, withholdingAmount: 5_000_001 })))?.code).toBe("VALIDATION");
    expect(await err(pay({ amount: 1_000_000, withholdingAmount: 3_000_000 }))).toBeNull();
    expect(await prisma.payment.count()).toBe(2);
  });

  it("invoice batal hanya setelah seluruh pembayaran (uang + PPh) dibalikkan", async () => {
    const inv = await taxedInvoice();
    const p = await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-02-10", amount: 15_260_000, withholdingAmount: 280_000, method: "Transfer" });
    expect(await err(cancelInvoice(fx.finance, inv.id, { reason: "Salah terbit" }))).not.toBeNull();
    await reversePayment(fx.finance, p.id, { reason: "Dana dikembalikan" });
    expect(await err(cancelInvoice(fx.finance, inv.id, { reason: "Salah terbit" }))).toBeNull();
    const n = await net();
    expect(n["2-1210"] ?? 0).toBe(0);
    expect(n["1-1400"] ?? 0).toBe(0);
    await sound("batal");
  });
});

describe("setoran pajak (kas keluar, utang pajak berkurang)", () => {
  it("setor PPN sebagian: utang 2-1210 turun, masuk arus kas operasi, tidak masuk laba rugi", async () => {
    const inv = await taxedInvoice();
    await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-02-10", amount: 15_540_000, method: "Transfer" });
    const e = await err(createEntry(fx.finance, { entryDate: "2026-02-28", cashAccountId: fx.bankAcctId, counterAccountId: c("2-1210"), direction: "OUT", amount: 1_200_000, description: "Setor PPN Januari", reference: "NTPN-123" }));
    expect(e?.code).toBe("VALIDATION"); // di atas Rp1 juta wajib berbukti (billing/NTPN)
    const ok = await createEntry(fx.finance, { entryDate: "2026-02-28", cashAccountId: fx.bankAcctId, counterAccountId: c("2-1210"), direction: "OUT", amount: 1_200_000, description: "Setor PPN Januari", reference: "NTPN-123", proofFileId: await makeProof(fx.finance) });
    expect(ok.status).toBe("APPROVED");
    expect((await net())["2-1210"]).toBe(-340_000);
    const cf = await getCashFlow(fx.finance, { from: "2026-01-01", to: today });
    expect(cf.operating.otherOperating.map((l) => [l.code, l.amount])).toEqual([["2-1210", -1_200_000]]);
    expect(cf.investing.net + cf.financing.net).toBe(0);
    expect(cf.ending).toBe(10_000_000 + 1_000_000 + 15_540_000 - 1_200_000);
    expect((await getGlIncomeStatement(fx.finance, { from: "2026-01-01", to: today })).netProfit).toBe(14_000_000); // setoran bukan beban
    // staff tidak dapat mencatat setoran pajak (hanya kategori beban)
    expect(await err(createEntry(fx.staff, { entryDate: "2026-03-01", cashAccountId: fx.bankAcctId, counterAccountId: c("2-1210"), direction: "OUT", amount: 1000, description: "coba" }))).not.toBeNull();
    await sound("setor PPN");
  });
});

describe("pagar database untuk kolom pajak (SQL langsung)", () => {
  const ins = (o: { type?: string; amount: number; wh?: number; vat?: number; ref?: string | null; reverses?: string | null; inv: string; reason?: string }) =>
    sql(`INSERT INTO payments (id,"invoiceId","entryType","reversesPaymentId","paymentDate",amount,"withholdingAmount","withholdingRef","vatAmount",method,reason,"cashAccountId","recordedById")
      VALUES (gen_random_uuid(),'${o.inv}','${o.type ?? "PAYMENT"}',${o.reverses ? `'${o.reverses}'` : "NULL"},'2026-02-10',${o.amount},${o.wh ?? 0},${o.ref ? `'${o.ref}'` : "NULL"},${o.vat ?? 0},'Transfer',${o.reason ? `'${o.reason}'` : "NULL"},'${fx.bankAcctId}','${fx.finance.userId}')`);

  it("PPN > nilai pembayaran, tanda salah, nomor bukti potong tanpa PPh, pembalikan bukan cermin — semuanya ditolak", async () => {
    const inv = await taxedInvoice();
    await expect(ins({ inv: inv.id, amount: 1000, wh: 0, vat: 1001 })).rejects.toThrow(/payments_entry_shape/);
    await expect(ins({ inv: inv.id, amount: 1000, wh: -1 })).rejects.toThrow(/payments_entry_shape/);
    await expect(ins({ inv: inv.id, amount: 1000, vat: -1 })).rejects.toThrow(/payments_entry_shape/);
    await expect(ins({ inv: inv.id, amount: 1000, ref: "BP-1" })).rejects.toThrow(/payments_withholding_ref/);
    await expect(ins({ inv: inv.id, amount: 1000, wh: 100, vat: 1100 })).resolves.toBeDefined(); // vat ≤ amount + wh (batas atas diizinkan DB; service yang membatasi proporsi)
    const orig = await prisma.payment.findFirstOrThrow({ where: { invoiceId: inv.id } });
    const rev = (o: { amount: number; wh: number; vat: number }) => ins({ type: "REVERSAL", inv: inv.id, reverses: orig.id, reason: "uji", ...o });
    await expect(rev({ amount: -1000, wh: -100, vat: -1000 })).rejects.toThrow(/sama persis|cermin/i);
    await expect(rev({ amount: -1000, wh: 0, vat: -1100 })).rejects.toThrow(/sama persis|cermin/i);
    await expect(rev({ amount: -1000, wh: -100, vat: -1100 })).resolves.toBeDefined();
    await expect(sql(`UPDATE payments SET "vatAmount" = 0 WHERE id = '${orig.id}'`)).rejects.toThrow(/append-only/);
  });

  it("akun sistem selain 2-1210/2-1230 tidak dapat dibuat 'boleh dipilih pada entri kas' (CHECK database)", async () => {
    await expect(sql(`UPDATE coa_accounts SET "manualEntry" = true WHERE code = '1-1400'`)).rejects.toThrow(/coa_system_not_manual/);
    await expect(sql(`UPDATE coa_accounts SET "manualEntry" = true WHERE code = '4-1100'`)).rejects.toThrow(/coa_system_not_manual/);
  });
});
