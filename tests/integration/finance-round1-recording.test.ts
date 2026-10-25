import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, type Fixtures } from "../helpers/db";
import { issueInvoice, createDraft } from "@/server/services/invoices";
import { recordPayment, reversePayment } from "@/server/services/payments";
import { createCashAccount, listCashAccountOptions, listCashAccounts, updateCashAccount } from "@/server/services/cash-accounts";
import { approveEntry, createEntry, createTransfer, listEntries, reverseEntry, reverseTransfer, rejectEntry, cancelPendingEntry } from "@/server/services/cash-entries";
import { getAccountLedger, getCashFlow, getIncomeStatement, runStatement } from "@/server/services/finance-statements";
import { toCsv, toXlsx } from "@/server/export";
import { todayIso } from "@/lib/format";
import { AppError } from "@/server/errors";

/**
 * PUTARAN 1 — PENCATATAN NORMAL & REKONSILIASI.
 * Skenario bulan Maret 2026 oleh tim operasional; setiap angka dihitung tangan di komentar.
 * Tujuan: membuktikan alur wajar (invoice → pembayaran → pengeluaran → transfer → laporan) menghasilkan angka yang tepat & saling cocok.
 */
let fx: Fixtures;
const today = todayIso("Asia/Jakarta");
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures({ finance: true });
});
const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as AppError;
const bal = async () => Object.fromEntries((await listCashAccounts(fx.finance)).map((a) => [a.name, a.balance]));

/** Invoice Rp14jt (DP Rp4jt via Transfer) bertanggal 2 Maret 2026. */
async function marchInvoice() {
  return issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: "2026-03-02", paymentTermDays: 30, downPayment: 4_000_000 }))).id);
}
const entry = (actor: typeof fx.finance, o: Record<string, unknown>) => createEntry(actor, { entryDate: "2026-03-09", amount: 100_000, description: "Uji", ...o });

describe("alokasi pembayaran invoice ke akun kas/bank", () => {
  it("DP & pembayaran Transfer → bank default; Tunai → kas default; pilihan eksplisit dihormati; pembalikan kembali ke akun asal", async () => {
    const inv = await marchInvoice();
    const dp = await prisma.payment.findFirstOrThrow({ where: { invoiceId: inv.id, isDownPayment: true } });
    expect(dp.cashAccountId).toBe(fx.bankAcctId);

    const p1 = await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-03-05", amount: 5_000_000, method: "Transfer" });
    const p2 = await recordPayment(fx.staff, { invoiceId: inv.id, paymentDate: "2026-03-06", amount: 1_000_000, method: "Tunai" });
    const p3 = await recordPayment(fx.staff, { invoiceId: inv.id, paymentDate: "2026-03-07", amount: 2_000_000, method: "Transfer", cashAccountId: fx.cashAcctId });
    expect([p1.cashAccountName, p2.cashAccountName, p3.cashAccountName]).toEqual(["Bank Mandiri", "Kas Kecil", "Kas Kecil"]);

    const rev = await reversePayment(fx.finance, p1.id, { reason: "Salah rekening" });
    expect(rev.cashAccountId).toBe(fx.bankAcctId); // uang keluar dari akun yang sama
    expect(rev.amount).toBe(-5_000_000);
    // bank: 10jt + 4jt + 5jt − 5jt = 14jt ; kas: 1jt + 1jt + 2jt = 4jt
    expect(await bal()).toEqual({ "Bank Mandiri": 14_000_000, "Kas Kecil": 4_000_000 });
  });

  it("pilihan akun untuk form dapat dibaca pencatat pembayaran & pengeluaran (tanpa saldo)", async () => {
    for (const a of [fx.staff, fx.finance, fx.admin]) {
      const opts = await listCashAccountOptions(a);
      expect(opts.map((o) => o.name).sort()).toEqual(["Bank Mandiri", "Kas Kecil"]);
      expect(Object.keys(opts[0]!).sort()).toEqual(["id", "isDefault", "kind", "name"]);
    }
  });
});

describe("pengeluaran: staff mengajukan, Finance Manager menyetujui", () => {
  it("menunggu persetujuan TIDAK masuk saldo/laporan; setelah disetujui masuk; jejak audit lengkap", async () => {
    const e = await entry(fx.staff, { entryDate: "2026-03-08", cashAccountId: fx.bankAcctId, counterAccountId: fx.coa["5-1100"], amount: 1_200_000, description: "Honor asesor", payee: "Asesor", reference: "KW-1" });
    expect(e).toMatchObject({ status: "PENDING", direction: "OUT", amount: 1_200_000, createdByName: "Staff Uji", counterCode: "5-1100" });
    expect((await bal())["Bank Mandiri"]).toBe(10_000_000);
    expect((await getIncomeStatement(fx.finance, { from: "2026-03-01", to: "2026-03-31" })).totalDirectCosts).toBe(0);

    const ok = await approveEntry(fx.finance, e.id);
    expect(ok).toMatchObject({ status: "APPROVED", approvedByName: "Finance Uji" });
    expect((await bal())["Bank Mandiri"]).toBe(8_800_000);
    expect((await getIncomeStatement(fx.finance, { from: "2026-03-01", to: "2026-03-31" })).totalDirectCosts).toBe(1_200_000);

    const logs = await prisma.auditLog.findMany({ where: { entityId: e.id }, orderBy: { id: "asc" } });
    expect(logs.map((l) => [l.action, l.actorRole])).toEqual([["expense.create", "STAFF"], ["expense.approve", "FINANCE"]]);
  });

  it("pengeluaran Finance Manager/Admin langsung berlaku; ditolak → tidak pernah masuk; dibatalkan pencatat → hilang tanpa jejak saldo", async () => {
    const direct = await entry(fx.finance, { cashAccountId: fx.cashAcctId, counterAccountId: fx.coa["6-1600"], amount: 275_000, description: "ATK" });
    expect(direct.status).toBe("APPROVED");
    const adminDirect = await entry(fx.admin, { cashAccountId: fx.cashAcctId, counterAccountId: fx.coa["6-1600"], amount: 25_000, description: "ATK 2" });
    expect(adminDirect.status).toBe("APPROVED");

    const s1 = await entry(fx.staff, { cashAccountId: fx.cashAcctId, counterAccountId: fx.coa["6-1600"], amount: 40_000, description: "Dibatalkan sendiri" });
    await cancelPendingEntry(fx.staff, s1.id);
    expect(await prisma.cashEntry.count({ where: { id: s1.id } })).toBe(0);
    const s2 = await entry(fx.staff, { cashAccountId: fx.cashAcctId, counterAccountId: fx.coa["6-1600"], amount: 50_000, description: "Akan ditolak" });
    const rej = await rejectEntry(fx.finance, s2.id, { reason: "Bukti tidak ada" });
    expect(rej).toMatchObject({ status: "REJECTED", rejectionReason: "Bukti tidak ada", rejectedByName: "Finance Uji" });
    expect((await bal())["Kas Kecil"]).toBe(1_000_000 - 275_000 - 25_000);
  });

  it("visibilitas: staff hanya melihat pengeluaran sendiri; Finance melihat semua; filter status/jenis/pencarian", async () => {
    const mine = await entry(fx.staff, { cashAccountId: fx.bankAcctId, counterAccountId: fx.coa["6-1300"], description: "Internet bulan Maret" });
    await entry(fx.staff2, { cashAccountId: fx.bankAcctId, counterAccountId: fx.coa["6-1300"], description: "Listrik staff dua" });
    await entry(fx.finance, { cashAccountId: fx.bankAcctId, counterAccountId: fx.coa["4-2200"], direction: "IN", amount: 150_000, description: "Bunga Maret" });
    expect((await listEntries(fx.staff, {})).items.map((i) => i.id)).toEqual([mine.id]);
    expect((await listEntries(fx.finance, {})).total).toBe(3);
    expect((await listEntries(fx.finance, { status: "PENDING" })).total).toBe(2);
    expect((await listEntries(fx.finance, { kind: "OTHER" })).items.map((i) => i.counterCode)).toEqual(["4-2200"]);
    expect((await listEntries(fx.finance, { q: "listrik" })).total).toBe(1);
    expect((await listEntries(fx.finance, { from: "2026-03-09", to: "2026-03-09" })).total).toBe(3);
  });
});

describe("skenario Maret 2026 lengkap — angka dihitung tangan", () => {
  async function runMarch() {
    const inv = await marchInvoice(); // DP 4jt (bank, 2 Mar)
    const p1 = await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-03-05", amount: 5_000_000, method: "Transfer" });
    await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-03-06", amount: 1_000_000, method: "Tunai" });
    await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-03-07", amount: 2_000_000, method: "Transfer", cashAccountId: fx.cashAcctId });
    const exp1 = await entry(fx.staff, { entryDate: "2026-03-08", cashAccountId: fx.bankAcctId, counterAccountId: fx.coa["5-1100"], amount: 1_200_000, description: "Honor asesor" });
    await approveEntry(fx.finance, exp1.id);
    await entry(fx.finance, { entryDate: "2026-03-09", cashAccountId: fx.cashAcctId, counterAccountId: fx.coa["6-1600"], amount: 275_000, description: "ATK" });
    await entry(fx.finance, { entryDate: "2026-03-10", cashAccountId: fx.bankAcctId, counterAccountId: fx.coa["3-1100"], direction: "IN", amount: 5_000_000, description: "Setoran modal" });
    await entry(fx.finance, { entryDate: "2026-03-12", cashAccountId: fx.bankAcctId, counterAccountId: fx.coa["1-2100"], direction: "OUT", amount: 3_000_000, description: "Beli laptop" });
    await createTransfer(fx.finance, { transferDate: "2026-03-15", fromAccountId: fx.bankAcctId, toAccountId: fx.cashAcctId, amount: 500_000, description: "Isi kas" });
    await entry(fx.finance, { entryDate: "2026-03-31", cashAccountId: fx.bankAcctId, counterAccountId: fx.coa["4-2200"], direction: "IN", amount: 150_000, description: "Jasa giro" });
    await reversePayment(fx.finance, p1.id, { reason: "Salah rekening" }); // bertanggal HARI INI (bukan Maret)
    return inv;
  }

  it("saldo akun per hari ini", async () => {
    await runMarch();
    // bank: 10 +4 +5 −5(pembalikan) −1,2 +5 −3 −0,5 +0,15 = 14,45jt ; kas: 1 +1 +2 −0,275 +0,5 = 4,225jt
    expect(await bal()).toEqual({ "Bank Mandiri": 14_450_000, "Kas Kecil": 4_225_000 });
  });

  it("arus kas Maret: operasi 10,675jt; investasi −3jt; pendanaan +5jt; awal 11jt → akhir 23,675jt", async () => {
    await runMarch();
    const r = await getCashFlow(fx.finance, { from: "2026-03-01", to: "2026-03-31" });
    expect(r.operating.invoiceReceipts).toBe(12_000_000); // 4 + 5 + 1 + 2 (pembalikan jatuh di bulan lain)
    expect(r.operating.otherIncome).toEqual([{ code: "4-2200", name: "Pendapatan Bunga & Jasa Giro", amount: 150_000 }]);
    expect(r.operating.expenses.map((l) => [l.code, l.amount])).toEqual([["5-1100", -1_200_000], ["6-1600", -275_000]]);
    expect(r.operating.net).toBe(10_675_000);
    expect(r.investing).toMatchObject({ net: -3_000_000 });
    expect(r.financing).toMatchObject({ net: 5_000_000 });
    expect(r).toMatchObject({ beginning: 11_000_000, newOpening: 0, netChange: 12_675_000, ending: 23_675_000, notInBalances: 0 });
    expect(Object.fromEntries(r.accounts.map((a) => [a.name, a.ending]))).toEqual({ "Bank Mandiri": 19_450_000, "Kas Kecil": 4_225_000 });
  });

  it("laba rugi Maret: pendapatan 12jt, beban langsung 1,2jt, operasional 275rb, lain 150rb → laba 10,675jt = arus operasi", async () => {
    await runMarch();
    const r = await getIncomeStatement(fx.finance, { from: "2026-03-01", to: "2026-03-31" });
    expect(r).toMatchObject({ revenue: 12_000_000, totalDirectCosts: 1_200_000, grossProfit: 10_800_000, totalOperatingCosts: 275_000, operatingProfit: 10_525_000, totalOtherIncome: 150_000, netProfitBeforeTax: 10_675_000 });
    expect(JSON.stringify(r)).not.toMatch(/Laptop|Peralatan|Modal/i); // investasi & modal bukan beban/pendapatan
  });

  it("laba rugi sepanjang tahun memuat pembalikan pembayaran: pendapatan 7jt, laba 5,675jt; periode berbeda dapat dijumlahkan", async () => {
    await runMarch();
    const yr = await getIncomeStatement(fx.finance, { from: "2026-01-01", to: today });
    expect(yr.revenue).toBe(7_000_000); // 12jt − 5jt
    expect(yr.netProfitBeforeTax).toBe(5_675_000);
    const rest = await getIncomeStatement(fx.finance, { from: "2026-04-01", to: today });
    expect(rest.revenue).toBe(-5_000_000);
    const mar = await getIncomeStatement(fx.finance, { from: "2026-03-01", to: "2026-03-31" });
    expect(mar.netProfitBeforeTax + rest.netProfitBeforeTax).toBe(yr.netProfitBeforeTax);
  });

  it("buku kas bank Maret: saldo berjalan & penutup = saldo akhir Maret; sama dengan arus kas", async () => {
    await runMarch();
    const l = await getAccountLedger(fx.finance, { accountId: fx.bankAcctId, from: "2026-03-01", to: "2026-03-31" });
    expect(l.opening).toBe(10_000_000);
    expect(l.rows.map((r) => [r.date, r.signed, r.balance])).toEqual([
      ["2026-03-02", 4_000_000, 14_000_000], ["2026-03-05", 5_000_000, 19_000_000], ["2026-03-08", -1_200_000, 17_800_000],
      ["2026-03-10", 5_000_000, 22_800_000], ["2026-03-12", -3_000_000, 19_800_000], ["2026-03-15", -500_000, 19_300_000], ["2026-03-31", 150_000, 19_450_000],
    ]);
    expect(l.closing).toBe(19_450_000);
    const full = await getAccountLedger(fx.finance, { accountId: fx.bankAcctId, from: "2026-01-01", to: today });
    expect(full.closing).toBe((await bal())["Bank Mandiri"]);
    expect(full.rows.at(-1)!.description).toMatch(/Pembalikan pembayaran/);
  });

  it("sisa tagihan invoice cocok dengan ledger pembayaran (4+5−5+1+2 = 7jt dibayar)", async () => {
    const inv = await runMarch();
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect([Number(row.paidAmount), Number(row.balanceAmount)]).toEqual([7_000_000, 7_000_000]);
  });
});

describe("koreksi: pembalikan entri & transfer", () => {
  it("pembalikan bertanggal hari ini; periode lama utuh; saldo kembali; hanya sekali", async () => {
    const e = await entry(fx.finance, { entryDate: "2026-03-09", cashAccountId: fx.bankAcctId, counterAccountId: fx.coa["6-1300"], amount: 800_000, description: "Internet" });
    const rev = await reverseEntry(fx.finance, e.id, { reason: "Salah input nominal" });
    expect(rev).toMatchObject({ entryType: "REVERSAL", direction: "IN", amount: 800_000, entryDate: today, reversesEntryId: e.id });
    expect((await bal())["Bank Mandiri"]).toBe(10_000_000);
    expect((await getIncomeStatement(fx.finance, { from: "2026-03-01", to: "2026-03-31" })).totalOperatingCosts).toBe(800_000); // Maret tidak berubah diam-diam
    expect((await getIncomeStatement(fx.finance, { from: "2026-01-01", to: today })).totalOperatingCosts).toBe(0); // netto setahun nol
    expect((await err(reverseEntry(fx.finance, e.id, { reason: "Sekali lagi" })))?.code).toBe("CONFLICT");
    expect((await listEntries(fx.finance, {})).items.find((i) => i.id === e.id)!.reversedByEntryId).toBe(rev.id);
  });

  it("transfer & pembaliknya: total kas tidak berubah sama sekali", async () => {
    const t = await createTransfer(fx.finance, { transferDate: "2026-03-15", fromAccountId: fx.bankAcctId, toAccountId: fx.cashAcctId, amount: 2_500_000 });
    expect(await bal()).toEqual({ "Bank Mandiri": 7_500_000, "Kas Kecil": 3_500_000 });
    await reverseTransfer(fx.finance, t.id, { reason: "Salah akun tujuan" });
    expect(await bal()).toEqual({ "Bank Mandiri": 10_000_000, "Kas Kecil": 1_000_000 });
    expect((await getCashFlow(fx.finance, { from: "2026-03-01", to: today })).netChange).toBe(0);
  });
});

describe("akun kas & saldo awal (input manual Administrator)", () => {
  it("membuat akun, default otomatis untuk akun pertama per jenis, nama unik, saldo awal & tanggal tercatat", async () => {
    const b2 = await createCashAccount(fx.admin, { name: "Bank BCA", kind: "BANK", coaAccountId: fx.coa["1-1200"], openingBalance: 7_500_000, openingDate: "2026-02-01" });
    expect(b2).toMatchObject({ kind: "BANK", openingBalance: 7_500_000, openingDate: "2026-02-01", balance: 7_500_000, isDefault: false, hasMovements: false });
    expect((await err(createCashAccount(fx.admin, { name: "Bank BCA", kind: "BANK", coaAccountId: fx.coa["1-1200"], openingBalance: 0, openingDate: "2026-02-01" })))?.code).toBe("CONFLICT");
    // menjadikan default memindahkan status default dari akun lama
    await updateCashAccount(fx.admin, b2.id, { isDefault: true });
    const all = await listCashAccounts(fx.finance);
    expect(all.filter((a) => a.kind === "BANK" && a.isDefault).map((a) => a.name)).toEqual(["Bank BCA"]);
    // pembayaran Transfer berikutnya masuk bank default baru
    const inv = await marchInvoice();
    expect((await prisma.payment.findFirstOrThrow({ where: { invoiceId: inv.id } })).cashAccountId).toBe(b2.id);
  });

  it("saldo awal diubah dengan alasan setelah ada mutasi; dinonaktifkan hanya saat saldo 0 dan tanpa pengajuan menggantung", async () => {
    await entry(fx.finance, { cashAccountId: fx.cashAcctId, counterAccountId: fx.coa["6-1600"], amount: 100_000, description: "ATK" });
    expect((await err(updateCashAccount(fx.admin, fx.cashAcctId, { openingBalance: 1_500_000 })))?.code).toBe("VALIDATION"); // alasan wajib
    const u = await updateCashAccount(fx.admin, fx.cashAcctId, { openingBalance: 1_500_000, reason: "Koreksi hasil opname kas" });
    expect(u).toMatchObject({ openingBalance: 1_500_000, balance: 1_400_000 });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "cash_account.update", entityId: fx.cashAcctId } });
    expect(log.reason).toBe("Koreksi hasil opname kas");
    expect(log.before).toMatchObject({ openingBalance: 1_000_000 });
    expect((await err(updateCashAccount(fx.admin, fx.cashAcctId, { isActive: false })))?.message).toMatch(/masih bersaldo/);
    await createTransfer(fx.finance, { transferDate: "2026-03-01", fromAccountId: fx.cashAcctId, toAccountId: fx.bankAcctId, amount: 1_400_000 });
    expect((await updateCashAccount(fx.admin, fx.cashAcctId, { isActive: false })).isActive).toBe(false);
  });
});

describe("ekspor laporan keuangan", () => {
  it("tabel arus kas & laba rugi; CSV memuat penafian basis kas; XLSX valid", async () => {
    const e = await entry(fx.finance, { cashAccountId: fx.bankAcctId, counterAccountId: fx.coa["6-1300"], amount: 800_000, description: "Internet" });
    void e;
    const cf = await runStatement(fx.finance, "cash-flow", { from: "2026-03-01", to: "2026-03-31" });
    expect(cf.rows.map((r) => r.item)).toContain("Saldo kas & bank akhir periode");
    expect(cf.rows.find((r) => r.item === "Saldo kas & bank akhir periode")!.amount).toBe(10_200_000);
    const csv = toCsv(cf);
    expect(csv).toContain("Laporan Arus Kas");
    expect(csv).toContain("BASIS KAS");
    expect(csv).toContain("PPh 23");
    const pl = await runStatement(fx.finance, "income-statement", { from: "2026-03-01", to: "2026-03-31" });
    expect(pl.rows.find((r) => String(r.item).startsWith("Laba (rugi) bersih"))!.amount).toBe(-800_000);
    expect((await toXlsx(pl)).subarray(0, 2).toString()).toBe("PK");
    expect((await err(runStatement(fx.finance, "neraca", {})))?.code).toBe("NOT_FOUND"); // neraca belum tersedia (tahap berikutnya)
  });
});
