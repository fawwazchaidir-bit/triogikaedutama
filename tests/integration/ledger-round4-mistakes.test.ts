import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, makeProof, type Fixtures } from "../helpers/db";
import { cancelInvoice, createDraft, issueInvoice } from "@/server/services/invoices";
import { recordPayment, reversePayment } from "@/server/services/payments";
import { createCashAccount, listCashAccounts, updateCashAccount } from "@/server/services/cash-accounts";
import { createEntry, reverseEntry } from "@/server/services/cash-entries";
import { seedCoa, updateCoaAccount } from "@/server/services/finance-coa";
import { createJournal, reverseJournal } from "@/server/services/journals";
import { getBalanceSheet, getGeneralLedger, getGlIncomeStatement, getTrialBalance } from "@/server/services/finance-ledger";
import { getCashFlow, getFinanceWarnings, getIncomeStatement, runStatement } from "@/server/services/finance-statements";
import { todayIso } from "@/lib/format";
import { AppError } from "@/server/errors";

/**
 * TAHAP 2 · PUTARAN D — KESALAHAN PENCATATAN YANG LAZIM TERJADI.
 * Setiap skenario: lakukan kesalahan seperti staf sungguhan → sistem harus mencegahnya, ATAU menyediakan jalur koreksi yang
 * (a) tertelusur di audit, (b) membuat buku tetap seimbang, (c) menghasilkan angka akhir yang benar.
 */
const today = todayIso("Asia/Jakarta");
const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as AppError | null;
let fx: Fixtures;
const c = (code: string) => fx.coa[code]!;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures({ finance: true, openingDate: "2026-01-01" });
});
afterAll(async () => { await prisma.$disconnect(); });

const net = async (asOf: string = today) => Object.fromEntries((await getTrialBalance(fx.finance, { to: asOf })).rows.map((r) => [r.code, r.net]));
const invoice = async (date: string, qty = 7, over: Record<string, unknown> = {}) =>
  issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: date, paymentTermDays: 30, lines: [{ ...demiChefInput(fx).lines[0]!, quantity: qty }], ...over }))).id);
async function assertBooksSound(label: string) {
  const tb = await getTrialBalance(fx.finance, { to: today });
  expect(tb.balanced, `${label}: neraca saldo seimbang`).toBe(true);
  const bs = await getBalanceSheet(fx.finance, { to: today });
  expect(bs.balanced, `${label}: neraca seimbang (selisih ${bs.difference})`).toBe(true);
  const accts = await listCashAccounts(fx.finance);
  const n = Object.fromEntries(tb.rows.map((r) => [r.code, r.net]));
  expect(n["1-1200"] ?? 0, `${label}: GL bank = modul kas`).toBe(accts.find((a) => a.id === fx.bankAcctId)!.balance);
  expect(n["1-1100"] ?? 0, `${label}: GL kas = modul kas`).toBe(accts.find((a) => a.id === fx.cashAcctId)!.balance);
}

describe("D1–D4 salah catat dan jalur koreksinya", () => {
  it("D1 salah kategori pengeluaran: pembalikan + catat ulang → laba bersih tetap, kategori benar, jejak lengkap", async () => {
    const wrong = await createEntry(fx.finance, { entryDate: "2026-03-05", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1300"), amount: 750_000, description: "Beli kertas (salah kategori)" });
    const before = await getGlIncomeStatement(fx.finance, { from: "2026-01-01", to: today });
    expect(before.operatingCosts.find((x) => x.code === "6-1300")!.amount).toBe(750_000);
    await reverseEntry(fx.finance, wrong.id, { reason: "Salah kategori, seharusnya ATK" });
    await createEntry(fx.finance, { entryDate: "2026-03-05", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1600"), amount: 750_000, description: "Beli kertas" });
    const after = await getGlIncomeStatement(fx.finance, { from: "2026-01-01", to: today });
    expect(after.operatingCosts.find((x) => x.code === "6-1300")).toBeUndefined();
    expect(after.operatingCosts.find((x) => x.code === "6-1600")!.amount).toBe(750_000);
    expect(after.netProfit).toBe(before.netProfit);
    expect((await net())["1-1200"]).toBe(10_000_000 - 750_000);
    const audit = await prisma.auditLog.findMany({ where: { entityType: "CashEntry" }, orderBy: { createdAt: "asc" } });
    expect(audit.map((a) => a.action).filter((a) => a === "cash.entry_reverse")).toHaveLength(1);
    expect(audit.length).toBeGreaterThanOrEqual(3); // catat salah, pembalikan, catat ulang — semuanya tertelusur
    await assertBooksSound("D1");
  });

  it("D2 pembayaran dicatat ganda: yang kedua melebihi sisa ditolak; ganda sebagian dikoreksi lewat pembalikan", async () => {
    const inv = await invoice("2026-01-13"); // 14.000.000
    await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-01-20", amount: 14_000_000, method: "Transfer" });
    expect((await err(recordPayment(fx.staff, { invoiceId: inv.id, paymentDate: "2026-01-20", amount: 14_000_000, method: "Transfer" })))?.code).toBe("CONFLICT"); // sudah lunas
    const inv2 = await invoice("2026-01-14", 7);
    const p1 = await recordPayment(fx.finance, { invoiceId: inv2.id, paymentDate: "2026-01-21", amount: 6_000_000, method: "Transfer" });
    await recordPayment(fx.staff, { invoiceId: inv2.id, paymentDate: "2026-01-21", amount: 6_000_000, method: "Transfer" }); // ganda
    expect((await net())["4-1100"]).toBe(-(14_000_000 + 12_000_000));
    await reversePayment(fx.finance, p1.id, { reason: "Tercatat dua kali" });
    expect((await net())["4-1100"]).toBe(-(14_000_000 + 6_000_000));
    expect((await net())["1-1200"]).toBe(10_000_000 + 14_000_000 + 6_000_000);
    await assertBooksSound("D2");
  });

  it("D3 pembayaran masuk ke akun yang salah: pembalikan + catat ulang; saldo akhir benar, saldo masa lalu TIDAK berubah (koreksi bertanggal hari ini)", async () => {
    const inv = await invoice("2026-01-13");
    const wrong = await recordPayment(fx.staff, { invoiceId: inv.id, paymentDate: "2026-02-10", amount: 5_000_000, method: "Transfer", cashAccountId: fx.cashAcctId });
    const snapshotThen = await net("2026-02-28"); // laporan Februari yang mungkin sudah dibaca
    expect(snapshotThen["1-1100"]).toBe(6_000_000);
    await reversePayment(fx.finance, wrong.id, { reason: "Seharusnya masuk rekening bank" });
    await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-02-10", amount: 5_000_000, method: "Transfer", cashAccountId: fx.bankAcctId });
    const nowNet = await net();
    expect(nowNet["1-1100"]).toBe(1_000_000);
    expect(nowNet["1-1200"]).toBe(15_000_000);
    expect(nowNet["4-1100"]).toBe(-5_000_000);
    // Februari menunjukkan kondisi pada saat itu: pembayaran benar sudah tercatat (tgl 10 Feb) tetapi pembalikan baru terjadi hari ini
    const feb = await net("2026-02-28");
    expect(feb["1-1100"]).toBe(6_000_000); // tidak berubah diam-diam
    expect(feb["1-1200"]).toBe(15_000_000);
    expect(feb["4-1100"]).toBe(-10_000_000); // tercatat dua kali pada Februari; selisih dibereskan oleh pembalikan hari ini
    await assertBooksSound("D3");
  });

  it("D4 jurnal manual salah nominal: koreksi lewat pembalikan; kedua jurnal tampil di buku besar akun", async () => {
    const bad = await createJournal(fx.finance, { journalDate: "2026-03-31", description: "Penyusutan Maret", lines: [{ accountId: c("6-2000"), debit: 900_000, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: 900_000 }] });
    await reverseJournal(fx.finance, bad.id, { reason: "Nominal salah (kelebihan nol)" });
    await createJournal(fx.finance, { journalDate: "2026-03-31", description: "Penyusutan Maret", lines: [{ accountId: c("6-2000"), debit: 90_000, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: 90_000 }] });
    expect((await net())["6-2000"]).toBe(90_000);
    expect((await net())["1-2900"]).toBe(-90_000);
    const gl = await getGeneralLedger(fx.finance, { accountId: c("6-2000"), from: "2026-01-01", to: today });
    expect(gl.rows).toHaveLength(3);
    // urut menurut tanggal: dua jurnal bertanggal 31 Mar lebih dulu, pembalikan (bertanggal hari ini) terakhir
    expect(gl.rows.map((r) => r.balance)).toEqual([900_000, 990_000, 90_000]);
    await assertBooksSound("D4");
  });

  it("D22 jurnal saldo awal salah: dibalikkan lalu dibuat ulang → saldo akhir benar, hanya satu versi aktif", async () => {
    const wrong = await createJournal(fx.finance, { kind: "OPENING", journalDate: "2026-01-01", description: "Saldo awal peralatan", lines: [{ accountId: c("1-2100"), debit: 60_000_000, credit: 0 }, { accountId: c("3-1100"), debit: 0, credit: 60_000_000 }] });
    await reverseJournal(fx.finance, wrong.id, { reason: "Salah ketik: seharusnya 6 juta" });
    await createJournal(fx.finance, { kind: "OPENING", journalDate: "2026-01-01", description: "Saldo awal peralatan", lines: [{ accountId: c("1-2100"), debit: 6_000_000, credit: 0 }, { accountId: c("3-1100"), debit: 0, credit: 6_000_000 }] });
    const n = await net();
    expect(n["1-2100"]).toBe(6_000_000);
    expect(n["3-1100"]).toBe(-6_000_000);
    await assertBooksSound("D22");
  });
});

describe("D5–D8 tanggal, saldo awal, kas negatif, invoice batal", () => {
  it("D5 tanggal mundur/maju: sebelum mulai pembukuan dan masa depan ditolak di semua jalur", async () => {
    const inv = await invoice("2026-01-13");
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    expect((await err(createEntry(fx.finance, { entryDate: "2025-12-31", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1600"), amount: 1000, description: "terlalu lama" })))).not.toBeNull();
    expect((await err(createEntry(fx.finance, { entryDate: tomorrow, cashAccountId: fx.bankAcctId, counterAccountId: c("6-1600"), amount: 1000, description: "besok" })))).not.toBeNull();
    expect((await err(createJournal(fx.finance, { journalDate: "2025-12-31", description: "terlalu lama", lines: [{ accountId: c("6-2000"), debit: 1, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: 1 }] })))?.code).toBe("VALIDATION");
    expect((await err(recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: tomorrow, amount: 1000, method: "Transfer" })))?.code).toBe("VALIDATION");
    expect((await err(getTrialBalance(fx.finance, { to: tomorrow })))?.code).toBe("VALIDATION");
    expect((await err(getGlIncomeStatement(fx.finance, { from: "2026-03-01", to: "2026-02-01" })))?.code).toBe("VALIDATION");
    expect(await prisma.cashEntry.count()).toBe(0);
  });

  it("D6 saldo awal akun kas diubah setelah ada transaksi: wajib alasan, buku tetap seimbang, selisih masuk 3-2100, jejak audit", async () => {
    await createEntry(fx.finance, { entryDate: "2026-02-01", cashAccountId: fx.cashAcctId, counterAccountId: c("6-1600"), amount: 200_000, description: "ATK" });
    expect((await err(updateCashAccount(fx.admin, fx.cashAcctId, { openingBalance: 1_500_000 })))?.code).toBe("VALIDATION"); // tanpa alasan
    await updateCashAccount(fx.admin, fx.cashAcctId, { openingBalance: 1_500_000, reason: "Hasil opname kas awal tahun" });
    const n = await net();
    expect(n["1-1100"]).toBe(1_300_000);
    expect(n["3-2100"]).toBe(-(10_000_000 + 1_500_000));
    await assertBooksSound("D6");
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "cash_account.update" }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(log.before)).toContain("1000000");
    expect(JSON.stringify(log.after)).toContain("1500000");
    expect(log.reason).toMatch(/opname/);
  });

  it("D7 kas minus (pengeluaran melebihi saldo): diizinkan tapi diperingatkan; neraca tetap seimbang dan menampilkan saldo negatif", async () => {
    await createEntry(fx.finance, { entryDate: "2026-02-01", cashAccountId: fx.cashAcctId, counterAccountId: c("6-1600"), amount: 900_000, description: "ATK" });
    await createEntry(fx.finance, { entryDate: "2026-02-02", cashAccountId: fx.cashAcctId, counterAccountId: c("6-1600"), amount: 400_000, description: "ATK lagi" });
    const w = await getFinanceWarnings(fx.finance);
    expect(w.negativeAccounts.map((a) => [a.name, a.balance])).toEqual([["Kas Kecil", -300_000]]);
    const bs = await getBalanceSheet(fx.finance, { to: today });
    expect(bs.currentAssets.find((x) => x.code === "1-1100")!.amount).toBe(-300_000);
    expect(bs.balanced).toBe(true);
    await assertBooksSound("D7");
  });

  it("D8 invoice dibatalkan setelah dibayar: tidak bisa sebelum pembayaran dibalikkan; sesudahnya pendapatan nol", async () => {
    const inv = await invoice("2026-01-13");
    const pay = await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-01-20", amount: 5_000_000, method: "Transfer" });
    expect(await err(cancelInvoice(fx.finance, inv.id, { reason: "Pelanggan batal ikut" }))).not.toBeNull();
    expect((await net())["4-1100"]).toBe(-5_000_000);
    await reversePayment(fx.finance, pay.id, { reason: "Dana dikembalikan ke pelanggan" });
    await cancelInvoice(fx.finance, inv.id, { reason: "Pelanggan batal ikut" });
    const n = await net();
    expect(n["4-1100"] ?? 0).toBe(0);
    expect(n["1-1200"]).toBe(10_000_000);
    await assertBooksSound("D8");
  });
});

describe("D9–D13 kondisi tepi laporan & konfigurasi", () => {
  it("D9 bagan akun belum disiapkan: laporan buku besar memberi pesan jelas (bukan error internal)", async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE journal_lines, journal_entries, cash_entries, cash_transfers, payments, cash_accounts, coa_accounts CASCADE`);
    for (const f of [() => getTrialBalance(fx.finance), () => getBalanceSheet(fx.finance), () => getGlIncomeStatement(fx.finance), () => runStatement(fx.finance, "income-statement", {})]) {
      const e = await err(f());
      expect(e, "harus AppError, bukan Error biasa").toBeInstanceOf(AppError);
      expect(e!.message).toMatch(/bagan akun/i);
    }
    // sesudah disiapkan, laporan berfungsi (kosong)
    await seedCoa(prisma);
    const tb = await getTrialBalance(fx.finance);
    expect(tb.rows).toEqual([]);
    expect(tb.balanced).toBe(true);
  });

  it("D10 akun dinonaktifkan setelah punya saldo: tetap tampil di neraca dan neraca saldo", async () => {
    await createJournal(fx.finance, { kind: "OPENING", journalDate: "2026-01-01", description: "Pinjaman bank", lines: [{ accountId: c("1-2100"), debit: 2_000_000, credit: 0 }, { accountId: c("2-2100"), debit: 0, credit: 2_000_000 }] });
    await updateCoaAccount(fx.admin, c("2-2100"), { isActive: false });
    const bs = await getBalanceSheet(fx.finance, { to: today });
    expect(bs.longTermLiabilities.find((x) => x.code === "2-2100")!.amount).toBe(2_000_000);
    expect(bs.balanced).toBe(true);
    expect((await err(createJournal(fx.finance, { journalDate: "2026-02-01", description: "pakai akun nonaktif", lines: [{ accountId: c("2-2100"), debit: 1, credit: 0 }, { accountId: c("1-2100"), debit: 0, credit: 1 }] })))?.code).toBe("VALIDATION");
    // tetapi pembalikan jurnal lama tetap bisa walau akunnya nonaktif
    const j = await prisma.journalEntry.findFirstOrThrow({});
    expect(await err(reverseJournal(fx.finance, j.id, { reason: "Pinjaman batal dicairkan" }))).toBeNull();
    await assertBooksSound("D10");
  });

  it("D16 posisi sebelum pembukuan dimulai kosong tapi seimbang; D17 hanya tanggal akhir pada tahun lalu tidak error", async () => {
    await resetDb();
    fx = await seedFixtures({ finance: true, openingDate: "2025-06-01" });
    const before = await getBalanceSheet(fx.finance, { to: "2025-05-31" });
    expect(before.totalAssets).toBe(0);
    expect(before.balanced).toBe(true);
    const inv = await invoice("2025-07-01", 1);
    await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2025-07-10", amount: 1_000_000, method: "Transfer" });
    // semua laporan dengan hanya `to` di tahun lalu: dari = 1 Jan tahun tsb (bukan 1 Jan tahun ini)
    expect((await getIncomeStatement(fx.finance, { to: "2025-12-31" })).revenue).toBe(1_000_000);
    expect((await getCashFlow(fx.finance, { to: "2025-12-31" })).operating.invoiceReceipts).toBe(1_000_000);
    expect((await getGlIncomeStatement(fx.finance, { to: "2025-12-31" })).totalRevenue).toBe(1_000_000);
    expect((await runStatement(fx.finance, "balance-sheet", { to: "2025-12-31" })).periodLabel).toMatch(/2025/);
    expect((await runStatement(fx.finance, "trial-balance", { to: "2025-12-31" })).totals).not.toBeNull();
  });

  it("D18 invoice ber-PPN: penerimaan dicatat bruto sebagai pendapatan dan laporan memberi catatan (pajak belum dipisah)", async () => {
    const d = await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: "2026-01-13", paymentTermDays: 30, lines: [{ ...demiChefInput(fx).lines[0]!, quantity: 1, taxConfigId: fx.ppnId }] }));
    const inv = await issueInvoice(fx.finance, d.id);
    expect(inv.amounts.total).toBe(2_220_000); // 2.000.000 + PPN 11% (eksklusif)
    await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-01-20", amount: 2_220_000, method: "Transfer" });
    expect((await net())["4-1100"]).toBe(-2_220_000);
    const stmt = await runStatement(fx.finance, "income-statement", { from: "2026-01-01", to: today });
    expect(stmt.rows.some((r) => /memuat pajak/.test(String(r.item)))).toBe(true);
    expect(stmt.disclaimer).toMatch(/PPN/);
    await assertBooksSound("D18");
  });

  it("D19 akun kas baru dibuka di tengah tahun: saldo awalnya masuk pada tanggalnya, bukan sebelumnya", async () => {
    const wallet = await seedExtraCoa("1-1110", "Bank BCA");
    await createCashAccount(fx.admin, { name: "Bank BCA", kind: "BANK", coaAccountId: wallet, openingBalance: 5_000_000, openingDate: "2026-06-01" });
    const maySheet = await getBalanceSheet(fx.finance, { to: "2026-05-31" });
    const junSheet = await getBalanceSheet(fx.finance, { to: "2026-06-01" });
    expect(maySheet.totalAssets).toBe(11_000_000);
    expect(junSheet.totalAssets).toBe(16_000_000);
    expect(maySheet.balanced && junSheet.balanced).toBe(true);
    // pembayaran ke akun baru sebelum tanggal pembukuannya dianggap sudah termasuk saldo awal (tidak menggandakan)
    const inv = await invoice("2026-01-13");
    const bca = (await listCashAccounts(fx.finance)).find((a) => a.name === "Bank BCA")!;
    await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-05-20", amount: 1_000_000, method: "Transfer", cashAccountId: bca.id });
    expect((await listCashAccounts(fx.finance)).find((a) => a.name === "Bank BCA")!.balance).toBe(5_000_000);
    const n = await net();
    expect(n["1-1110"]).toBe(5_000_000);
    expect(n["4-1100"] ?? 0).toBe(0); // tidak masuk pendapatan periode pembukuan
    await assertBooksSound("D19");
  });
});

async function seedExtraCoa(code: string, name: string): Promise<string> {
  const { createCoaAccount } = await import("@/server/services/finance-coa");
  return (await createCoaAccount(fx.admin, { code, name, type: "ASET", section: "OPERASI", manualEntry: false })).id;
}

describe("D24 rekonsiliasi atas kumpulan skenario campuran", () => {
  it("setelah serangkaian kesalahan + koreksi, db:reconcile bersih", async () => {
    const inv = await invoice("2026-01-13");
    const p = await recordPayment(fx.staff, { invoiceId: inv.id, paymentDate: "2026-02-10", amount: 5_000_000, method: "Transfer", cashAccountId: fx.cashAcctId });
    await reversePayment(fx.finance, p.id, { reason: "Salah akun penerima" });
    await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-02-10", amount: 5_000_000, method: "Transfer" });
    const e = await createEntry(fx.finance, { entryDate: "2026-03-01", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1300"), amount: 300_000, description: "Salah kategori" });
    await reverseEntry(fx.finance, e.id, { reason: "Kategori keliru" });
    const j = await createJournal(fx.finance, { journalDate: "2026-03-31", description: "Penyusutan", lines: [{ accountId: c("6-2000"), debit: 900_000, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: 900_000 }] });
    await reverseJournal(fx.finance, j.id, { reason: "Nominal salah" });
    await createEntry(fx.finance, { entryDate: "2026-03-02", cashAccountId: fx.bankAcctId, counterAccountId: c("1-2200"), direction: "OUT", amount: 2_000_000, description: "Peralatan", proofFileId: await makeProof(fx.finance) });
    const out = (() => {
      try {
        return { code: 0, text: execFileSync("npx", ["tsx", "--conditions=react-server", "scripts/reconcile.ts"], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
      } catch (x) { const y = x as { status?: number; stdout?: string; stderr?: string }; return { code: y.status ?? 99, text: `${y.stdout ?? ""}${y.stderr ?? ""}` }; }
    })();
    expect(out.code, out.text).toBe(0);
    await assertBooksSound("D24");
  });
});
