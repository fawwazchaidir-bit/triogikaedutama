import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, makeProof, type Fixtures } from "../helpers/db";
import { createDraft, issueInvoice } from "@/server/services/invoices";
import { recordPayment, reversePayment } from "@/server/services/payments";
import { listCashAccounts } from "@/server/services/cash-accounts";
import { approveEntry, createEntry, createTransfer, rejectEntry, reverseEntry } from "@/server/services/cash-entries";
import { createJournal, listManualJournals, reverseJournal } from "@/server/services/journals";
import { getBalanceSheet, getGeneralLedger, getGlIncomeStatement, getJournalBook, getTrialBalance } from "@/server/services/finance-ledger";
import { getIncomeStatement, runStatement } from "@/server/services/finance-statements";
import { todayIso } from "@/lib/format";
import { AppError } from "@/server/errors";

/**
 * TAHAP 2 · PUTARAN A — INTEGRASI HITUNG-TANGAN.
 * Satu perusahaan fiktif dijalankan lewat SERVICE (bukan SQL): invoice → pembayaran → kas → pengeluaran → jurnal manual.
 * Semua angka di bawah dihitung dengan tangan lebih dulu; laporan harus persis sama, dan neraca harus seimbang.
 */
const today = todayIso("Asia/Jakarta");
const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as AppError | null;

let fx: Fixtures;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures({ finance: true, openingDate: "2026-01-01" });
});
afterAll(async () => { await prisma.$disconnect(); });

const c = (code: string) => fx.coa[code]!;
const lineOf = (rows: { code: string; amount: number }[], code: string) => rows.find((r) => r.code === code)?.amount ?? 0;
const tbRow = (tb: Awaited<ReturnType<typeof getTrialBalance>>, code: string) => tb.rows.find((r) => r.code === code);

async function invoice(opts: { date: string; qty: number }) {
  const d = await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: opts.date, paymentTermDays: 30, lines: [{ ...demiChefInput(fx).lines[0]!, quantity: opts.qty }] }));
  return issueInvoice(fx.finance, d.id);
}

/** Perusahaan fiktif: lihat perhitungan di komentar tiap langkah. */
async function buildCompany() {
  // Saldo awal kas: Bank 10.000.000 (1-1200) + Kas 1.000.000 (1-1100) pada 2026-01-01 → Cr 3-2100 11.000.000
  // A1. Jurnal saldo awal non-kas: Dr 1-2100 6.000.000 / Cr 2-2100 2.000.000 / Cr 3-1100 4.000.000
  await createJournal(fx.finance, {
    kind: "OPENING", journalDate: "2026-01-01", description: "Saldo awal peralatan, utang bank, dan modal",
    lines: [{ accountId: c("1-2100"), debit: 6_000_000, credit: 0 }, { accountId: c("2-2100"), debit: 0, credit: 2_000_000 }, { accountId: c("3-1100"), debit: 0, credit: 4_000_000 }],
  });
  // A2. Invoice 14.000.000: bayar 5.000.000 (Transfer→Bank) dan 2.000.000 (Tunai→Kas)
  const inv = await invoice({ date: "2026-01-13", qty: 7 });
  await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-01-20", amount: 5_000_000, method: "Transfer" });
  await recordPayment(fx.staff, { invoiceId: inv.id, paymentDate: "2026-01-25", amount: 2_000_000, method: "Tunai" });
  // Invoice lama (Des 2025) 2.000.000 dibayar 1.000.000 SEBELUM tanggal mulai pembukuan → sudah termasuk saldo awal, tidak masuk buku
  const old = await invoice({ date: "2025-12-01", qty: 1 });
  await recordPayment(fx.finance, { invoiceId: old.id, paymentDate: "2025-12-20", amount: 1_000_000, method: "Transfer" });
  // A3. Pengeluaran
  await createEntry(fx.finance, { entryDate: "2026-02-02", cashAccountId: fx.bankAcctId, counterAccountId: c("5-1100"), amount: 3_000_000, description: "Honor instruktur", proofFileId: await makeProof(fx.finance) });
  await createEntry(fx.finance, { entryDate: "2026-02-03", cashAccountId: fx.cashAcctId, counterAccountId: c("6-1300"), amount: 400_000, description: "Listrik" });
  const atk = await createEntry(fx.staff, { entryDate: "2026-02-04", cashAccountId: fx.cashAcctId, counterAccountId: c("6-1600"), amount: 200_000, description: "ATK" });
  expect(atk.status).toBe("PENDING");
  const ditolak = await createEntry(fx.staff, { entryDate: "2026-02-04", cashAccountId: fx.cashAcctId, counterAccountId: c("6-1400"), amount: 500_000, description: "Iklan (akan ditolak)" });
  await approveEntry(fx.finance, atk.id);
  await rejectEntry(fx.finance, ditolak.id, { reason: "Tidak sesuai anggaran" });
  // A4–A6. Pendapatan lain, setoran modal, beli peralatan pelatihan
  await createEntry(fx.finance, { entryDate: "2026-02-10", cashAccountId: fx.bankAcctId, counterAccountId: c("4-2200"), direction: "IN", amount: 50_000, description: "Bunga bank" });
  await createEntry(fx.finance, { entryDate: "2026-02-12", cashAccountId: fx.bankAcctId, counterAccountId: c("3-1100"), direction: "IN", amount: 1_000_000, description: "Tambahan modal" });
  await createEntry(fx.finance, { entryDate: "2026-02-15", cashAccountId: fx.bankAcctId, counterAccountId: c("1-2200"), direction: "OUT", amount: 1_500_000, description: "Beli peralatan praktik", proofFileId: await makeProof(fx.finance) });
  // A7. Transfer Bank → Kas 500.000
  await createTransfer(fx.finance, { transferDate: "2026-02-20", fromAccountId: fx.bankAcctId, toAccountId: fx.cashAcctId, amount: 500_000 });
  // A8–A9. Jurnal manual: penyusutan 100.000 dan beban pajak penghasilan yang masih terutang 20.000
  await createJournal(fx.finance, { journalDate: "2026-02-28", description: "Penyusutan Februari", lines: [{ accountId: c("6-2000"), debit: 100_000, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: 100_000 }] });
  await createJournal(fx.finance, { journalDate: "2026-02-28", description: "Pajak penghasilan terutang", lines: [{ accountId: c("7-1100"), debit: 20_000, credit: 0 }, { accountId: c("2-1200"), debit: 0, credit: 20_000 }] });
  // A10. Pembayaran yang tidak dialokasikan ke akun mana pun (tidak ada akun bank default) 3.000.000
  await prisma.cashAccount.update({ where: { id: fx.bankAcctId }, data: { isDefault: false } });
  const p = await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-03-01", amount: 3_000_000, method: "Transfer" });
  expect(p.cashAccountId).toBeNull();
  return { inv, old };
}

describe("skenario perusahaan fiktif: angka dihitung tangan", () => {
  it("neraca saldo 31 Mar 2026: tiap akun dan total cocok", async () => {
    await buildCompany();
    const tb = await getTrialBalance(fx.finance, { to: "2026-03-31" });
    const want: Record<string, number> = {
      "1-1100": 2_900_000, "1-1200": 11_050_000, "1-1450": 3_000_000, "1-2100": 6_000_000, "1-2200": 1_500_000,
      "5-1100": 3_000_000, "6-1300": 400_000, "6-1600": 200_000, "6-2000": 100_000, "7-1100": 20_000,
    };
    const wantCredit: Record<string, number> = {
      "1-2900": 100_000, "2-1200": 20_000, "2-2100": 2_000_000, "3-1100": 5_000_000, "3-2100": 11_000_000, "4-1100": 10_000_000, "4-2200": 50_000,
    };
    for (const [code, v] of Object.entries(want)) expect(tbRow(tb, code), code).toMatchObject({ debit: v, credit: 0 });
    for (const [code, v] of Object.entries(wantCredit)) expect(tbRow(tb, code), code).toMatchObject({ debit: 0, credit: v });
    expect(tb.rows).toHaveLength(Object.keys(want).length + Object.keys(wantCredit).length); // tidak ada akun "hantu" (mis. entri ditolak)
    expect(tb.totalDebit).toBe(28_170_000);
    expect(tb.totalCredit).toBe(28_170_000);
    expect(tb.balanced).toBe(true);
  });

  it("neraca 31 Mar 2026: aset = liabilitas + ekuitas, rincian cocok", async () => {
    await buildCompany();
    const bs = await getBalanceSheet(fx.finance, { to: "2026-03-31" });
    expect(lineOf(bs.currentAssets, "1-1100")).toBe(2_900_000);
    expect(lineOf(bs.currentAssets, "1-1200")).toBe(11_050_000);
    expect(lineOf(bs.currentAssets, "1-1450")).toBe(3_000_000);
    expect(lineOf(bs.fixedAssets, "1-2900")).toBe(-100_000); // akumulasi penyusutan mengurangi aset
    expect(bs.totalAssets).toBe(24_350_000);
    expect(bs.totalLiabilities).toBe(2_020_000);
    expect(lineOf(bs.equity, "3-2100")).toBe(11_000_000);
    expect(lineOf(bs.equity, "3-1100")).toBe(5_000_000);
    expect(bs.retainedEarningsPrior).toBe(0);
    expect(bs.currentYearProfit).toBe(6_330_000);
    expect(bs.totalEquity).toBe(22_330_000);
    expect(bs.balanced).toBe(true);
    expect(bs.difference).toBe(0);
  });

  it("laba rugi GL = hitung tangan; selisih dengan laba rugi tahap-1 persis penyusutan + pajak manual", async () => {
    await buildCompany();
    const gl = await getGlIncomeStatement(fx.finance, { from: "2026-01-01", to: "2026-03-31" });
    expect(gl.totalRevenue).toBe(10_000_000); // 5jt + 2jt + 3jt (tak dialokasikan tetap pendapatan); 1jt pra-pembukuan TIDAK ikut
    expect(gl.totalDirectCosts).toBe(3_000_000);
    expect(gl.grossProfit).toBe(7_000_000);
    expect(gl.totalOperatingCosts).toBe(700_000);
    expect(gl.operatingProfit).toBe(6_300_000);
    expect(gl.totalOtherIncome).toBe(50_000);
    expect(gl.profitBeforeTax).toBe(6_350_000);
    expect(gl.totalIncomeTax).toBe(20_000);
    expect(gl.netProfit).toBe(6_330_000);
    // Tahap 1 (tanpa jurnal manual) = pembanding independen
    const s1 = await getIncomeStatement(fx.finance, { from: "2026-01-01", to: "2026-03-31" });
    expect(s1.revenue).toBe(gl.totalRevenue);
    expect(s1.netProfitBeforeTax - gl.profitBeforeTax).toBe(100_000); // penyusutan manual
    expect(s1.netProfitBeforeTax - gl.netProfit).toBe(100_000 + 20_000); // + pajak penghasilan manual
  });

  it("buku besar akun kas = saldo modul kas; saldo berjalan benar", async () => {
    await buildCompany();
    const accounts = await listCashAccounts(fx.finance);
    const gl = await getGeneralLedger(fx.finance, { accountId: c("1-1200"), from: "2026-01-01", to: "2026-03-31" });
    expect(gl.closing).toBe(accounts.find((a) => a.name === "Bank Mandiri")!.balance);
    expect(gl.closing).toBe(11_050_000);
    expect(gl.opening).toBe(0);
    expect(gl.rows[0]).toMatchObject({ source: "OPENING_CASH", debit: 10_000_000, balance: 10_000_000 });
    // urutan: saldo awal, bayar 5jt, honor, bunga, modal, peralatan, transfer keluar
    expect(gl.rows.map((r) => r.balance)).toEqual([10_000_000, 15_000_000, 12_000_000, 12_050_000, 13_050_000, 11_550_000, 11_050_000]);
    expect(gl.totalDebit - gl.totalCredit).toBe(gl.closing);
    const kas = await getGeneralLedger(fx.finance, { accountId: c("1-1100"), from: "2026-01-01", to: "2026-03-31" });
    expect(kas.closing).toBe(accounts.find((a) => a.name === "Kas Kecil")!.balance);
    // periode terpotong: saldo awal periode = saldo sebelum 1 Feb
    const feb = await getGeneralLedger(fx.finance, { accountId: c("1-1200"), from: "2026-02-01", to: "2026-02-28" });
    expect(feb.opening).toBe(15_000_000);
    expect(feb.closing).toBe(11_050_000);
    expect(feb.rows).toHaveLength(5);
  });

  it("akun penampung 1-1450 pulih saat pembayaran dibalikkan; buku tetap seimbang", async () => {
    const { inv } = await buildCompany();
    const un = await prisma.payment.findFirstOrThrow({ where: { invoiceId: inv.id, cashAccountId: null } });
    await reversePayment(fx.finance, un.id, { reason: "Salah catat penerimaan" });
    const tb = await getTrialBalance(fx.finance, { to: today });
    expect(tbRow(tb, "1-1450")).toBeUndefined(); // 3jt − 3jt = 0 → baris hilang
    expect(tbRow(tb, "4-1100")).toMatchObject({ credit: 7_000_000, debit: 0 }); // 3jt kembali
    expect(tb.balanced).toBe(true);
    expect((await getBalanceSheet(fx.finance, { to: today })).balanced).toBe(true);
  });

  it("pembalikan pembayaran akun kas dan pembalikan entri kas menetralkan buku besar", async () => {
    const { inv } = await buildCompany();
    const pay = await prisma.payment.findFirstOrThrow({ where: { invoiceId: inv.id, amount: 5_000_000n } });
    await reversePayment(fx.finance, pay.id, { reason: "Transfer ternyata gagal" });
    const ent = await prisma.cashEntry.findFirstOrThrow({ where: { description: "Listrik" } });
    await reverseEntry(fx.finance, ent.id, { reason: "Salah nominal" });
    const tb = await getTrialBalance(fx.finance, { to: today });
    expect(tbRow(tb, "1-1200")).toMatchObject({ debit: 11_050_000 - 5_000_000 });
    expect(tbRow(tb, "1-1100")!.debit).toBe(2_900_000 + 400_000);
    expect(tbRow(tb, "6-1300")).toBeUndefined();
    expect(tbRow(tb, "4-1100")!.credit).toBe(10_000_000 - 5_000_000);
    expect(tb.balanced).toBe(true);
    const accounts = await listCashAccounts(fx.finance);
    expect(tbRow(tb, "1-1200")!.debit).toBe(accounts.find((a) => a.name === "Bank Mandiri")!.balance);
    expect(tbRow(tb, "1-1100")!.debit).toBe(accounts.find((a) => a.name === "Kas Kecil")!.balance);
  });

  it("buku jurnal memuat semua sumber, setiap jurnal seimbang, filter sumber bekerja", async () => {
    await buildCompany();
    const all = await getJournalBook(fx.finance, { from: "2026-01-01", to: "2026-03-31", pageSize: 100 });
    for (const j of all.items) expect(j.lines.reduce((s, l) => s + l.debit, 0), j.label).toBe(j.lines.reduce((s, l) => s + l.credit, 0));
    const bySource = (s: string) => all.items.filter((j) => j.source === s).length;
    expect(bySource("OPENING_CASH")).toBe(2);
    expect(bySource("INVOICE_PAYMENT")).toBe(3); // 5jt, 2jt, 3jt (1jt pra-pembukuan dilewati)
    expect(bySource("CASH_ENTRY")).toBe(6); // honor, listrik, ATK, bunga, modal, peralatan (yang ditolak tidak ada)
    expect(bySource("TRANSFER")).toBe(1);
    expect(bySource("MANUAL")).toBe(3); // saldo awal + penyusutan + pajak
    expect(all.total).toBe(15);
    const only = await getJournalBook(fx.finance, { from: "2026-01-01", to: "2026-03-31", source: "MANUAL" });
    expect(only.items.map((j) => j.label).every((l) => l.startsWith("JU-"))).toBe(true);
    expect(only.total).toBe(3);
    // terbaru dulu
    const dates = all.items.map((j) => j.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("laporan resmi (runStatement) konsisten dengan angka service dan memuat penafian", async () => {
    await buildCompany();
    const bs = await runStatement(fx.finance, "balance-sheet", { to: "2026-03-31" });
    expect(bs.disclaimer).toMatch(/bukan laporan keuangan resmi|tidak menggantikan/i);
    const diff = bs.rows.find((r) => /Selisih/.test(String(r.item)));
    expect(diff && "amount" in diff ? diff.amount : null).toBe(0);
    const tb = await runStatement(fx.finance, "trial-balance", { to: "2026-03-31" });
    expect(tb.rows.length).toBeGreaterThan(10);
    const is = await runStatement(fx.finance, "income-statement", { from: "2026-01-01", to: "2026-03-31" });
    const net = is.rows.find((r) => /setelah pajak penghasilan/.test(String(r.item)));
    expect(net && "amount" in net ? net.amount : null).toBe(6_330_000);
    const gl = await runStatement(fx.finance, "general-ledger", { accountId: c("1-1200"), from: "2026-01-01", to: "2026-03-31" });
    expect(gl.rows.length).toBeGreaterThan(5);
  });
});

describe("jurnal manual: aturan & pembalikan", () => {
  it("pembalikan jurnal menetralkan pengaruhnya dan tidak bisa diulang", async () => {
    const j = await createJournal(fx.finance, { journalDate: "2026-02-28", description: "Penyusutan salah nominal", lines: [{ accountId: c("6-2000"), debit: 900_000, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: 900_000 }] });
    const r = await reverseJournal(fx.finance, j.id, { reason: "Nominal seharusnya 90.000" });
    expect(r.entryType).toBe("REVERSAL");
    expect(r.journalDate).toBe(today);
    expect(r.lines.map((l) => [l.code, l.debit, l.credit])).toEqual([["6-2000", 0, 900_000], ["1-2900", 900_000, 0]]);
    const tb = await getTrialBalance(fx.finance, { to: today });
    expect(tbRow(tb, "6-2000")).toBeUndefined();
    expect(tbRow(tb, "1-2900")).toBeUndefined();
    expect((await err(reverseJournal(fx.finance, j.id, { reason: "Sekali lagi" })))?.code).toBe("CONFLICT");
    expect((await err(reverseJournal(fx.finance, r.id, { reason: "Pembalik dibalik" })))?.code).toBe("CONFLICT");
    // jurnal yang benar menggantikannya
    await createJournal(fx.finance, { journalDate: "2026-02-28", description: "Penyusutan Februari", lines: [{ accountId: c("6-2000"), debit: 90_000, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: 90_000 }] });
    expect(tbRow(await getTrialBalance(fx.finance, { to: today }), "6-2000")).toMatchObject({ debit: 90_000 });
    const list = await listManualJournals(fx.finance);
    expect(list.total).toBe(3);
    expect(list.items.find((x) => x.id === j.id)!.reversedByJournalId).toBe(r.id);
  });

  it("laba tahun lalu pindah ke 'saldo laba tahun sebelumnya' dan neraca tetap seimbang di dua tahun", async () => {
    await resetDb();
    fx = await seedFixtures({ finance: true, openingDate: "2025-06-01" });
    // 2025: terima 4.000.000, beban 1.500.000 → laba 2.500.000
    const inv = await invoice({ date: "2025-06-10", qty: 2 }); // 4.000.000
    await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2025-07-01", amount: 4_000_000, method: "Transfer" });
    await createEntry(fx.finance, { entryDate: "2025-08-01", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1200"), amount: 1_500_000, description: "Sewa kantor", proofFileId: await makeProof(fx.finance) });
    // 2026: laba 600.000 (terima 1.000.000, beban 400.000)
    const inv2 = await invoice({ date: "2026-01-05", qty: 1 });
    await recordPayment(fx.finance, { invoiceId: inv2.id, paymentDate: "2026-01-10", amount: 1_000_000, method: "Transfer" });
    await createEntry(fx.finance, { entryDate: "2026-01-15", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1300"), amount: 400_000, description: "Listrik" });

    const end25 = await getBalanceSheet(fx.finance, { to: "2025-12-31" });
    expect(end25.retainedEarningsPrior).toBe(0);
    expect(end25.currentYearProfit).toBe(2_500_000);
    expect(end25.balanced).toBe(true);
    const mid26 = await getBalanceSheet(fx.finance, { to: "2026-01-31" });
    expect(mid26.retainedEarningsPrior).toBe(2_500_000);
    expect(mid26.currentYearProfit).toBe(600_000);
    expect(mid26.totalAssets).toBe(11_000_000 + 2_500_000 + 600_000);
    expect(mid26.balanced).toBe(true);
    // laba rugi hanya periode yang diminta
    expect((await getGlIncomeStatement(fx.finance, { from: "2026-01-01", to: "2026-01-31" })).netProfit).toBe(600_000);
    expect((await getGlIncomeStatement(fx.finance, { from: "2025-01-01", to: "2025-12-31" })).netProfit).toBe(2_500_000);
    expect((await getGlIncomeStatement(fx.finance, { from: "2025-01-01", to: "2026-01-31" })).netProfit).toBe(3_100_000);
  });
});

describe("izin akses lapisan buku besar", () => {
  it("staff tidak dapat melihat/mencatat; finance dan admin dapat; membalikkan jurnal = Finance/Admin", async () => {
    const j = await createJournal(fx.finance, { journalDate: "2026-02-28", description: "Penyusutan", lines: [{ accountId: c("6-2000"), debit: 10_000, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: 10_000 }] });
    for (const f of [() => getTrialBalance(fx.staff), () => getBalanceSheet(fx.staff), () => getGlIncomeStatement(fx.staff), () => getJournalBook(fx.staff), () => listManualJournals(fx.staff), () => getGeneralLedger(fx.staff, { accountId: c("1-1100") })]) {
      expect((await err(f()))?.code).toBe("FORBIDDEN");
    }
    expect((await err(createJournal(fx.staff, { journalDate: "2026-02-28", description: "x x x", lines: [{ accountId: c("6-2000"), debit: 1, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: 1 }] })))?.code).toBe("FORBIDDEN");
    expect((await err(reverseJournal(fx.staff, j.id, { reason: "Coba-coba staff" })))?.code).toBe("FORBIDDEN");
    expect((await err(getTrialBalance(fx.admin)))).toBeNull();
    expect((await err(reverseJournal(fx.admin, j.id, { reason: "Admin membalikkan" })))).toBeNull();
  });
});
