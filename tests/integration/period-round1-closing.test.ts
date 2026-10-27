import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, makeProof, type Fixtures } from "../helpers/db";
import { createDraft, issueInvoice } from "@/server/services/invoices";
import { recordPayment } from "@/server/services/payments";
import { approveEntry, createEntry, createTransfer, rejectEntry } from "@/server/services/cash-entries";
import { createJournal } from "@/server/services/journals";
import { autoMatchStatement, createStatement, finalizeStatement } from "@/server/services/bank-reconciliation";
import { closePeriod, getPeriodChecklist, listPeriods, reopenPeriod } from "@/server/services/periods";
import { getBooksLock, readBooksLock } from "@/server/services/books-lock";
import { AppError } from "@/server/errors";

/**
 * TUTUP BUKU · PUTARAN 1 — SKENARIO HITUNG-TANGAN.
 * Buku: saldo awal 1 Jan 2026 Bank 10.000.000 + Kas 1.000.000 (ekuitas awal 11.000.000).
 * Januari: terima 5.000.000 (bank, 5 Jan) · listrik 400.000 (bank, 10 Jan) · transfer bank→kas 500.000 (20 Jan)
 *   bank 14.100.000 + kas 1.500.000 = aset 15.600.000; pendapatan 5.000.000, beban 400.000, laba 4.600.000; ΣDr = ΣCr = 16.000.000
 * Februari: terima 3.000.000 (10 Feb) · ATK 200.000 (12 Feb)
 *   aset 18.400.000; pendapatan bulan 3.000.000, laba bulan 2.800.000; ΣDr = ΣCr = 19.000.000
 * Seluruh tanggal tetap di 2026 (bulan-bulan itu sudah berakhir pada hari uji).
 */
const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as AppError | null;
let fx: Fixtures;
const c = (code: string) => fx.coa[code]!;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures({ finance: true, openingDate: "2026-01-01" });
});
afterAll(async () => { await prisma.$disconnect(); });

const close = (month: number, ack: string[] = [], note = "Laporan final direview", actor = fx.finance, year = 2026) => closePeriod(actor, { year, month, acknowledge: ack, note });
const row = async (month: number) => (await listPeriods(fx.finance)).periods.find((p) => p.year === 2026 && p.month === month)!;
const inv = async (date: string) => issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: date, paymentTermDays: 30 }))).id);

async function januaryBooks() {
  const a = await inv("2026-01-02");
  await recordPayment(fx.finance, { invoiceId: a.id, paymentDate: "2026-01-05", amount: 5_000_000, method: "Transfer" });
  await createEntry(fx.finance, { entryDate: "2026-01-10", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1300"), amount: 400_000, description: "Listrik Januari" });
  await createTransfer(fx.finance, { transferDate: "2026-01-20", fromAccountId: fx.bankAcctId, toAccountId: fx.cashAcctId, amount: 500_000 });
  return a;
}
async function februaryBooks(invoiceId: string) {
  await recordPayment(fx.finance, { invoiceId, paymentDate: "2026-02-10", amount: 3_000_000, method: "Transfer" });
  await createEntry(fx.finance, { entryDate: "2026-02-12", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1600"), amount: 200_000, description: "ATK Februari" });
}

describe("Januari: dari daftar periksa sampai ditutup", () => {
  it("daftar periode awal, daftar periksa, peringatan harus diakui, foto sesuai hitungan tangan, kunci buku mengikuti", async () => {
    await januaryBooks();
    const before = await listPeriods(fx.finance);
    expect(before.lockedThrough).toBeNull();
    expect(before.periods.length).toBeGreaterThanOrEqual(10); // Jan 2026 … bulan berjalan
    const jan = await row(1), feb = await row(2);
    expect(jan).toMatchObject({ key: "2026-01", label: "Januari 2026", start: "2026-01-01", end: "2026-01-31", state: "OPEN", canClose: true, canReopen: false, verified: null, snapshot: null });
    expect(feb).toMatchObject({ state: "OPEN", canClose: false }); // Januari belum ditutup
    expect(before.periods[0]!.state).toBe("CURRENT"); // bulan berjalan di paling atas
    expect(before.periods[0]!.canClose).toBe(false);

    const list = await getPeriodChecklist(fx.finance, { year: 2026, month: 1 });
    expect(list.closable).toBe(true);
    const byId = Object.fromEntries(list.checks.map((x) => [x.id, x]));
    for (const id of ["ended", "previous", "trial-balance", "balance-sheet", "cash-identity", "pending-expenses"]) expect(byId[id], id).toMatchObject({ severity: "HARD", ok: true });
    expect(byId["trial-balance"]!.detail).toBe("Debit = kredit = Rp 16.000.000");
    expect(byId["previous"]!.detail).toBe("Bulan pertama pembukuan");
    expect(byId["bank-recon"]).toMatchObject({ severity: "SOFT", ok: false });
    expect(byId["bank-recon"]!.detail).toContain("Bank Mandiri");
    for (const id of ["unallocated", "negative-cash", "withholding-ref", "draft-invoices"]) expect(byId[id], id).toMatchObject({ severity: "SOFT", ok: true });

    // peringatan tanpa pengakuan → ditolak; catatan terlalu pendek → ditolak
    const noAck = await err(close(1));
    expect(noAck?.code).toBe("VALIDATION");
    expect(noAck?.message).toMatch(/Rekonsiliasi bank/);
    expect((await err(close(1, ["bank-recon"], "ok")))?.code).toBe("VALIDATION");
    expect(await getBooksLock()).toBeNull();

    const closed = await close(1, ["bank-recon"], "Laporan Januari direview; rekonsiliasi menyusul");
    expect(closed).toMatchObject({
      state: "CLOSED", closedByName: "Finance Uji", note: "Laporan Januari direview; rekonsiliasi menyusul", verified: true, canClose: false, canReopen: true,
      snapshot: { totalDebit: 16_000_000, assets: 15_600_000, liabilities: 0, equity: 15_600_000, revenue: 5_000_000, profitBeforeTax: 4_600_000 },
    });
    expect(closed.acknowledged.map((a) => a.id)).toEqual(["bank-recon"]);
    expect(closed.acknowledged[0]!.detail).toContain("Bank Mandiri");
    expect((await readBooksLock(fx.finance)).lockedThrough).toBe("2026-01-31");
    const db = await prisma.accountingPeriod.findUniqueOrThrow({ where: { year_month: { year: 2026, month: 1 } } });
    expect(db.status).toBe("CLOSED");
    expect(db.snapshotHash).toMatch(/^[0-9a-f]{64}$/);

    // menutup lagi → konflik; Februari kini dapat ditutup
    expect((await err(close(1, ["bank-recon"])))?.code).toBe("CONFLICT");
    expect(await row(2)).toMatchObject({ canClose: true });
  });

  it("transaksi bertanggal ≤ 31 Jan ditolak setelah ditutup; 1 Feb diterima; pembalikan hari ini tetap bisa", async () => {
    const a = await januaryBooks();
    await close(1, ["bank-recon"]);
    const e1 = await err(createEntry(fx.finance, { entryDate: "2026-01-31", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1600"), amount: 1000, description: "ATK mundur" }));
    expect(e1?.code).toBe("VALIDATION");
    expect(e1?.message).toMatch(/Buku sudah ditutup sampai 31 Januari 2026/);
    expect(e1?.message).toMatch(/Tutup Buku/);
    expect((await err(recordPayment(fx.finance, { invoiceId: a.id, paymentDate: "2026-01-31", amount: 1000, method: "Transfer" })))?.code).toBe("VALIDATION");
    expect((await err(createJournal(fx.finance, { journalDate: "2026-01-01", description: "Mundur", lines: [{ accountId: c("6-2000"), debit: 10, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: 10 }] })))?.code).toBe("VALIDATION");
    expect(await err(createEntry(fx.finance, { entryDate: "2026-02-01", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1600"), amount: 1000, description: "ATK" }))).toBeNull();
  });

  it("rantai penuh Januari–September; bulan berjalan tidak dapat ditutup; kunci buku berpindah ke akhir September", async () => {
    await januaryBooks();
    for (let m = 1; m <= 9; m++) await close(m, ["bank-recon"], `Tutup bulan ke-${m}`);
    expect(await getBooksLock()).toBe("2026-09-30");
    const ps = (await listPeriods(fx.finance)).periods;
    expect(ps.filter((p) => p.state === "CLOSED").map((p) => p.key).sort()).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
    expect(ps.filter((p) => p.state === "CLOSED").every((p) => p.verified === true)).toBe(true);
    // bulan tanpa transaksi membawa neraca yang sama (semua aset 15.600.000 sejak Januari)
    expect((await row(9)).snapshot).toMatchObject({ assets: 15_600_000, totalDebit: 16_000_000, revenue: 0, profitBeforeTax: 0 });
    // Oktober masih berjalan pada hari uji
    const oct = await getPeriodChecklist(fx.finance, { year: 2026, month: 10 });
    expect(oct.checks.find((x) => x.id === "ended")).toMatchObject({ ok: false, severity: "HARD" });
    expect(oct.closable).toBe(false);
    const e = await err(close(10));
    expect(e?.code).toBe("CONFLICT");
    expect(e?.message).toMatch(/Bulan sudah berakhir/);
  });
});

describe("urutan penutupan", () => {
  it("Maret tidak bisa ditutup sebelum Februari; sebelum bulan mulai pembukuan ditolak; masukan tak sah ditolak", async () => {
    await januaryBooks();
    const e = await err(close(3, ["bank-recon"]));
    expect(e?.code).toBe("CONFLICT");
    expect(e?.message).toMatch(/Februari 2026 belum ditutup/);
    expect((await err(close(12, [], "Tutup Desember", fx.finance, 2025)))?.code).toBe("CONFLICT");
    for (const bad of [{ year: 1999, month: 1 }, { year: 2026, month: 0 }, { year: 2026, month: 13 }, { year: "abc", month: 1 }, { year: 2026.5, month: 1 }, {}]) {
      expect((await err(closePeriod(fx.finance, { ...bad, acknowledge: [], note: "Catatan cukup" })))?.code, JSON.stringify(bad)).toBe("VALIDATION");
    }
    expect(await getBooksLock()).toBeNull();
    expect(await prisma.accountingPeriod.count()).toBe(0);
  });

  it("tanpa akun kas/bank (belum ada bulan mulai pembukuan): tidak ada periode, tidak bisa ditutup", async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "cash_accounts" CASCADE`); // pemasangan baru: bagan akun ada, akun kas belum
    expect((await listPeriods(fx.finance)).periods).toEqual([]);
    expect((await err(close(1)))?.code).toBe("CONFLICT");
  });
});

describe("buka kembali", () => {
  it("hanya periode terakhir; alasan wajib; kunci mundur; transaksi bulan itu diterima lagi; tutup ulang membuat foto baru; audit lengkap", async () => {
    const a = await januaryBooks();
    await februaryBooks(a.id);
    await close(1, ["bank-recon"], "Tutup Januari");
    const febClosed = await close(2, ["bank-recon"], "Tutup Februari");
    expect(febClosed.snapshot).toMatchObject({ totalDebit: 19_000_000, assets: 18_400_000, equity: 18_400_000, revenue: 3_000_000, profitBeforeTax: 2_800_000 });
    expect(await getBooksLock()).toBe("2026-02-28");
    const hash1 = (await prisma.accountingPeriod.findUniqueOrThrow({ where: { year_month: { year: 2026, month: 2 } } })).snapshotHash;

    expect((await err(reopenPeriod(fx.finance, { year: 2026, month: 1, reason: "Koreksi Januari" })))?.code).toBe("CONFLICT"); // Februari masih tertutup
    expect((await err(reopenPeriod(fx.finance, { year: 2026, month: 3, reason: "Koreksi Maret" })))?.code).toBe("CONFLICT"); // belum pernah ditutup
    expect((await err(reopenPeriod(fx.finance, { year: 2026, month: 2, reason: "x" })))?.code).toBe("VALIDATION");
    expect(await getBooksLock()).toBe("2026-02-28");

    const re = await reopenPeriod(fx.finance, { year: 2026, month: 2, reason: "ATK Februari terlewat dicatat" });
    expect(re).toMatchObject({ state: "REOPENED", reopenReason: "ATK Februari terlewat dicatat", canClose: true, canReopen: false });
    expect(await getBooksLock()).toBe("2026-01-31");
    expect((await row(1)).canReopen).toBe(true); // Januari kini periode terakhir yang tertutup

    // transaksi Februari diterima lagi; Januari tetap terkunci
    expect(await err(createEntry(fx.finance, { entryDate: "2026-02-20", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1600"), amount: 300_000, description: "ATK terlewat" }))).toBeNull();
    expect((await err(createEntry(fx.finance, { entryDate: "2026-01-31", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1600"), amount: 300_000, description: "ATK mundur" })))?.code).toBe("VALIDATION");

    // tutup ulang: foto baru mencerminkan beban tambahan 300.000
    const again = await close(2, ["bank-recon"], "Tutup ulang Februari");
    expect(again.snapshot).toMatchObject({ totalDebit: 19_000_000, assets: 18_100_000, equity: 18_100_000, revenue: 3_000_000, profitBeforeTax: 2_500_000 });
    const hash2 = (await prisma.accountingPeriod.findUniqueOrThrow({ where: { year_month: { year: 2026, month: 2 } } })).snapshotHash;
    expect(hash2).not.toBe(hash1);
    expect(again.verified).toBe(true);
    expect(await getBooksLock()).toBe("2026-02-28");

    const log = await prisma.auditLog.findMany({ where: { action: { startsWith: "period." } }, orderBy: { createdAt: "asc" } });
    expect(log.map((l) => [l.action, l.entityId])).toEqual([["period.close", "2026-01"], ["period.close", "2026-02"], ["period.reopen", "2026-02"], ["period.close", "2026-02"]]);
    expect(log.map((l) => l.reason)).toEqual(["Tutup Januari", "Tutup Februari", "ATK Februari terlewat dicatat", "Tutup ulang Februari"]);
  });
});

describe("pemeriksaan WAJIB", () => {
  it("pengeluaran staf menunggu persetujuan menghalangi penutupan bulannya saja; setelah diputuskan lolos", async () => {
    await januaryBooks();
    const jan = await createEntry(fx.staff, { entryDate: "2026-01-20", cashAccountId: fx.cashAcctId, counterAccountId: c("6-1600"), amount: 50_000, description: "ATK staf Jan" });
    const feb = await createEntry(fx.staff, { entryDate: "2026-02-05", cashAccountId: fx.cashAcctId, counterAccountId: c("6-1600"), amount: 60_000, description: "ATK staf Feb" });
    const list = await getPeriodChecklist(fx.finance, { year: 2026, month: 1 });
    expect(list.closable).toBe(false);
    expect(list.checks.find((x) => x.id === "pending-expenses")).toMatchObject({ ok: false, severity: "HARD" });
    const e = await err(close(1, ["bank-recon"]));
    expect(e?.code).toBe("CONFLICT");
    expect(e?.message).toMatch(/1 pengeluaran bertanggal ≤ 2026-01-31 menunggu persetujuan/);
    expect(await getBooksLock()).toBeNull();

    await rejectEntry(fx.finance, jan.id, { reason: "Tidak sesuai anggaran" });
    expect((await getPeriodChecklist(fx.finance, { year: 2026, month: 1 })).closable).toBe(true);
    await close(1, ["bank-recon"]);
    // pengeluaran Februari yang menunggu menghalangi Februari, bukan Januari
    expect((await err(close(2, ["bank-recon"])))?.code).toBe("CONFLICT");
    await approveEntry(fx.finance, feb.id);
    expect(await err(close(2, ["bank-recon"]))).toBeNull();
  });
});

describe("pemeriksaan PERINGATAN", () => {
  it("draft invoice, bukti potong kosong, kas negatif, penerimaan tak teralokasi: tampil, harus diakui satu per satu, tersimpan di periode", async () => {
    const a = await januaryBooks();
    // draft bertanggal Januari
    await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: "2026-01-15" }));
    // PPh dipotong tanpa nomor bukti potong (invoice 14.000.000: terima 4.000.000 + potong 280.000... sisa invoice menyesuaikan)
    await recordPayment(fx.finance, { invoiceId: a.id, paymentDate: "2026-01-25", amount: 2_000_000, withholdingAmount: 100_000, method: "Transfer" });
    // kas kecil: saldo 1.500.000 setelah transfer → keluar 1.600.000 → −100.000
    await createEntry(fx.finance, { entryDate: "2026-01-28", cashAccountId: fx.cashAcctId, counterAccountId: c("6-1600"), amount: 1_600_000, description: "Belanja besar", proofFileId: await makeProof(fx.finance) });
    // penerimaan tak teralokasi: tidak ada bank default
    await prisma.cashAccount.update({ where: { id: fx.bankAcctId }, data: { isDefault: false } });
    await recordPayment(fx.finance, { invoiceId: a.id, paymentDate: "2026-01-29", amount: 700_000, method: "Transfer" });

    const list = await getPeriodChecklist(fx.finance, { year: 2026, month: 1 });
    const failing = list.checks.filter((x) => !x.ok).map((x) => x.id).sort();
    expect(failing).toContain("negative-cash");
    expect(list.checks.find((x) => x.id === "negative-cash")!.detail).toContain("Kas Kecil");
    expect(failing).toContain("draft-invoices");
    expect(failing).toContain("withholding-ref");
    expect(failing).toContain("unallocated");
    expect(list.checks.find((x) => x.id === "unallocated")!.detail).toContain("700.000");
    expect(list.checks.find((x) => x.id === "withholding-ref")!.detail).toMatch(/1 pembayaran/);
    expect(list.closable).toBe(true); // peringatan tidak menghalangi

    // satu peringatan tak diakui → ditolak dan pesan menyebut yang tertinggal
    const some = failing.filter((id) => id !== "unallocated");
    const e = await err(close(1, some));
    expect(e?.code).toBe("VALIDATION");
    expect(e?.message).toMatch(/penerimaan invoice yang belum dialokasikan/);
    const done = await close(1, failing, "Semua peringatan ditinjau");
    expect(done.acknowledged.map((x) => x.id).sort()).toEqual(failing);
    // mengakui id yang tidak relevan tidak menambah apa-apa
    expect(done.state).toBe("CLOSED");
  });

  it("rekonsiliasi bank final sampai akhir bulan menghilangkan peringatan; bank tanpa mutasi bulan itu tidak diperiksa", async () => {
    const a = await januaryBooks();
    expect((await getPeriodChecklist(fx.finance, { year: 2026, month: 1 })).checks.find((x) => x.id === "bank-recon")!.ok).toBe(false);
    const st = await createStatement(fx.finance, {
      cashAccountId: fx.bankAcctId, periodStart: "2026-01-01", periodEnd: "2026-01-31", openingBalance: 10_000_000, closingBalance: 14_100_000,
      lines: [{ txDate: "2026-01-05", description: "TRF MASUK", amount: 5_000_000 }, { txDate: "2026-01-10", description: "PLN", amount: -400_000 }, { txDate: "2026-01-20", description: "TRF KE KAS", amount: -500_000 }],
    });
    expect((await autoMatchStatement(fx.finance, st.id)).matched).toBe(3);
    // draft belum final → peringatan masih ada
    expect((await getPeriodChecklist(fx.finance, { year: 2026, month: 1 })).checks.find((x) => x.id === "bank-recon")!.ok).toBe(false);
    await finalizeStatement(fx.finance, st.id);
    const list = await getPeriodChecklist(fx.finance, { year: 2026, month: 1 });
    expect(list.checks.find((x) => x.id === "bank-recon")).toMatchObject({ ok: true });
    const done = await close(1, [], "Rekonsiliasi final");
    expect(done.acknowledged).toEqual([]);
    // Februari tanpa mutasi bank → tidak diwajibkan rekonsiliasi
    expect((await getPeriodChecklist(fx.finance, { year: 2026, month: 2 })).checks.find((x) => x.id === "bank-recon")!.ok).toBe(true);
    expect(a.id).toBeDefined();
  });
});

describe("izin", () => {
  it("Finance & Admin boleh menutup/membuka; Staff tidak boleh melihat maupun mengubah", async () => {
    await januaryBooks();
    expect((await err(close(1, ["bank-recon"], "Tutup oleh staf", fx.staff)))?.code).toBe("FORBIDDEN");
    expect((await err(listPeriods(fx.staff)))?.code).toBe("FORBIDDEN");
    expect((await err(getPeriodChecklist(fx.staff, { year: 2026, month: 1 })))?.code).toBe("FORBIDDEN");
    expect(await err(close(1, ["bank-recon"], "Tutup oleh admin", fx.admin))).toBeNull();
    expect((await err(reopenPeriod(fx.staff, { year: 2026, month: 1, reason: "Staf iseng" })))?.code).toBe("FORBIDDEN");
    expect(await err(reopenPeriod(fx.admin, { year: 2026, month: 1, reason: "Admin membuka kembali" }))).toBeNull();
    expect((await listPeriods(fx.finance)).periods.find((p) => p.key === "2026-01")!.closedByName).toBe("Admin Uji");
  });
});
