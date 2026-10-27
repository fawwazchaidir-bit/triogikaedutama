import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, type Fixtures } from "../helpers/db";
import { createDraft, issueInvoice } from "@/server/services/invoices";
import { recordPayment, reversePayment } from "@/server/services/payments";
import { createCashAccount, listCashAccounts, updateCashAccount } from "@/server/services/cash-accounts";
import { approveEntry, cancelPendingEntry, createEntry, createTransfer, rejectEntry, reverseEntry, reverseTransfer } from "@/server/services/cash-entries";
import { createCoaAccount } from "@/server/services/finance-coa";
import { createJournal, reverseJournal } from "@/server/services/journals";
import { getBalanceSheet, getTrialBalance } from "@/server/services/finance-ledger";
import { getBooksLock } from "@/server/services/books-lock";
import { lockBooksThrough } from "../helpers/lock";
import { todayIso } from "@/lib/format";
import { AppError } from "@/server/errors";

/**
 * TAHAP 2 · PUTARAN E — PENUTUPAN BUKU.
 * Temuan putaran D: transaksi bertanggal mundur mengubah laporan periode yang sudah dibaca. Penutupan buku (opsional) menutup celah itu
 * di service DAN database; koreksi tetap dimungkinkan lewat pembalikan bertanggal hari ini.
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

const lock = (d: string | null) => lockBooksThrough(d);
const snapshot = async (asOf: string) => JSON.stringify((await getTrialBalance(fx.finance, { to: asOf })).rows.map((r) => [r.code, r.net]));
const jr = (date: string, amount = 10_000) => createJournal(fx.finance, { journalDate: date, description: "Penyusutan", lines: [{ accountId: c("6-2000"), debit: amount, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: amount }] });

async function februaryBooks() {
  const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: "2026-02-02", paymentTermDays: 30 }))).id);
  const pay = await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-02-10", amount: 5_000_000, method: "Transfer" });
  const ent = await createEntry(fx.finance, { entryDate: "2026-02-12", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1300"), amount: 300_000, description: "Listrik" });
  const tr = await createTransfer(fx.finance, { transferDate: "2026-02-15", fromAccountId: fx.bankAcctId, toAccountId: fx.cashAcctId, amount: 500_000 });
  const j = await jr("2026-02-28");
  return { inv, pay, ent, tr, j };
}

describe("tanpa kunci: perilaku lama tidak berubah", () => {
  it("default kosong; transaksi bertanggal mundur dapat dicatat", async () => {
    expect(await getBooksLock()).toBeNull();
    await februaryBooks();
    expect(await err(jr("2026-01-05"))).toBeNull();
  });
});

describe("transaksi pada periode tertutup ditolak (service & SQL), koreksi hari ini tetap bisa", () => {
  it("semua jalur pencatatan menolak tanggal ≤ tanggal tutup, menerima sesudahnya; laporan lama tidak bergerak", async () => {
    const b = await februaryBooks();
    await lock("2026-02-28");
    const frozen = await snapshot("2026-02-28");

    // service
    const inv2 = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: "2026-03-02", paymentTermDays: 30 }))).id);
    const e1 = await err(recordPayment(fx.finance, { invoiceId: inv2.id, paymentDate: "2026-02-28", amount: 1_000_000, method: "Transfer" }));
    const e2 = await err(createEntry(fx.finance, { entryDate: "2026-02-01", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1600"), amount: 1000, description: "ATK mundur" }));
    const e3 = await err(createTransfer(fx.finance, { transferDate: "2026-02-20", fromAccountId: fx.bankAcctId, toAccountId: fx.cashAcctId, amount: 1000 }));
    const e4 = await err(jr("2026-02-28"));
    const e5 = await err(jr("2026-01-15"));
    for (const e of [e1, e2, e3, e4, e5]) { expect(e?.code).toBe("VALIDATION"); expect(e?.message).toMatch(/Buku sudah ditutup sampai/); }

    // SQL langsung
    await expect(sql(`INSERT INTO cash_entries (id,"entryType","entryDate",direction,amount,"cashAccountId","counterAccountId",description,status,"createdById","approvedById","approvedAt")
      VALUES (gen_random_uuid(),'ENTRY','2026-02-20','OUT',100,'${fx.bankAcctId}','${c("6-1300")}','raw','APPROVED','${fx.finance.userId}','${fx.finance.userId}',now())`)).rejects.toThrow(/Buku sudah ditutup/);
    await expect(sql(`INSERT INTO cash_transfers (id,"entryType","transferDate","fromAccountId","toAccountId",amount,"createdById") VALUES (gen_random_uuid(),'ENTRY','2026-02-20','${fx.bankAcctId}','${fx.cashAcctId}',100,'${fx.finance.userId}')`)).rejects.toThrow(/Buku sudah ditutup/);
    await expect(sql(`INSERT INTO payments (id,"invoiceId","entryType","paymentDate",amount,method,"cashAccountId","recordedById") VALUES (gen_random_uuid(),'${inv2.id}','PAYMENT','2026-02-20',100,'Transfer','${fx.bankAcctId}','${fx.finance.userId}')`)).rejects.toThrow(/Buku sudah ditutup/);
    const jid = crypto.randomUUID();
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO journal_entries (id,kind,"entryType","journalDate",description,"createdById") VALUES ('${jid}','GENERAL','ENTRY','2026-02-20','raw','${fx.finance.userId}')`);
      await tx.$executeRawUnsafe(`INSERT INTO journal_lines (id,"journalId","lineNo","accountId",debit,credit) VALUES (gen_random_uuid(),'${jid}',1,'${c("6-2000")}',5,0),(gen_random_uuid(),'${jid}',2,'${c("1-2900")}',0,5)`);
    })).rejects.toThrow(/Buku sudah ditutup/);

    // tanggal pertama periode terbuka diterima
    expect(await err(recordPayment(fx.finance, { invoiceId: inv2.id, paymentDate: "2026-03-01", amount: 1_000_000, method: "Transfer" }))).toBeNull();
    expect(await err(createEntry(fx.finance, { entryDate: "2026-03-01", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1600"), amount: 1000, description: "ATK" }))).toBeNull();
    expect(await err(jr("2026-03-01"))).toBeNull();

    // koreksi atas transaksi periode tertutup: pembalikan bertanggal hari ini
    expect(await err(reversePayment(fx.finance, b.pay.id, { reason: "Dana dikembalikan" }))).toBeNull();
    expect(await err(reverseEntry(fx.finance, b.ent.id, { reason: "Salah nominal" }))).toBeNull();
    expect(await err(reverseTransfer(fx.finance, b.tr.id, { reason: "Salah akun" }))).toBeNull();
    expect(await err(reverseJournal(fx.finance, b.j.id, { reason: "Nominal salah" }))).toBeNull();
    expect(await snapshot("2026-02-28"), "laporan Februari tidak berubah oleh percobaan maupun koreksi").toBe(frozen);
    expect((await getTrialBalance(fx.finance, { to: today })).balanced).toBe(true);
    expect((await getBalanceSheet(fx.finance, { to: today })).balanced).toBe(true);
  });

  it("pengeluaran staff yang menunggu lalu periodenya ditutup: tidak bisa disetujui, bisa ditolak/dibatalkan", async () => {
    const e = await createEntry(fx.staff, { entryDate: "2026-02-20", cashAccountId: fx.cashAcctId, counterAccountId: c("6-1600"), amount: 50_000, description: "ATK staf" });
    const e2 = await createEntry(fx.staff, { entryDate: "2026-02-21", cashAccountId: fx.cashAcctId, counterAccountId: c("6-1600"), amount: 60_000, description: "ATK staf 2" });
    const e3 = await createEntry(fx.staff, { entryDate: "2026-02-22", cashAccountId: fx.cashAcctId, counterAccountId: c("6-1600"), amount: 70_000, description: "ATK staf 3" });
    await lock("2026-02-28");
    const a = await err(approveEntry(fx.finance, e.id));
    expect(a?.code).toBe("VALIDATION");
    expect(a?.message).toMatch(/tidak dapat disetujui/);
    await expect(sql(`UPDATE cash_entries SET status='APPROVED', "approvedById"='${fx.finance.userId}', "approvedAt"=now() WHERE id='${e.id}'`)).rejects.toThrow(/tidak dapat disetujui/);
    expect(await err(rejectEntry(fx.finance, e2.id, { reason: "Periode sudah ditutup" }))).toBeNull();
    expect(await err(cancelPendingEntry(fx.staff, e3.id))).toBeNull();
    // dicatat ulang bertanggal baru → bisa disetujui
    const again = await createEntry(fx.staff, { entryDate: "2026-03-02", cashAccountId: fx.cashAcctId, counterAccountId: c("6-1600"), amount: 50_000, description: "ATK staf (ulang)" });
    expect(await err(approveEntry(fx.finance, again.id))).toBeNull();
  });

  it("akun kas/bank: tidak dapat dibuat/diubah saldo awalnya bila tanggal saldo awal tertutup; ganti nama & default tetap boleh", async () => {
    const wallet = (await createCoaAccount(fx.admin, { code: "1-1110", name: "Bank BCA", type: "ASET", section: "OPERASI", manualEntry: false })).id;
    await lock("2026-02-28");
    expect((await err(createCashAccount(fx.admin, { name: "Bank BCA", kind: "BANK", coaAccountId: wallet, openingBalance: 1_000_000, openingDate: "2026-02-01" })))?.code).toBe("VALIDATION");
    await expect(sql(`INSERT INTO cash_accounts (id,name,kind,"coaAccountId","openingBalance","openingDate","updatedAt") VALUES (gen_random_uuid(),'Mentah','BANK','${wallet}',1,'2026-02-01',now())`)).rejects.toThrow(/Buku sudah ditutup/);
    expect((await err(updateCashAccount(fx.admin, fx.cashAcctId, { openingBalance: 2_000_000, reason: "Koreksi saldo awal" })))?.code).toBe("CONFLICT");
    await expect(sql(`UPDATE cash_accounts SET "openingBalance" = 5 WHERE id = '${fx.cashAcctId}'`)).rejects.toThrow(/Buku sudah ditutup/);
    expect(await err(updateCashAccount(fx.admin, fx.cashAcctId, { name: "Kas Kecil Kantor" }))).toBeNull();
    // akun baru dengan saldo awal sesudah tanggal tutup diterima
    expect(await err(createCashAccount(fx.admin, { name: "Bank BCA", kind: "BANK", coaAccountId: wallet, openingBalance: 1_000_000, openingDate: "2026-03-01" }))).toBeNull();
    expect((await listCashAccounts(fx.finance)).map((a) => a.name).sort()).toEqual(["Bank BCA", "Bank Mandiri", "Kas Kecil Kantor"]);
  });
});

describe("penegakan kunci terhadap transaksi yang sedang berjalan", () => {
  it("pengunci menunggu transaksi pencatatan yang sedang berjalan (tak ada transaksi lolos di sela)", async () => {
    // Pengunci sesungguhnya (penutupan bulan) diuji di periods-*.test.ts; di sini cukup memastikan trigger pencatatan memakai kunci bersama.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const jid = crypto.randomUUID();
    const t1 = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO journal_entries (id,kind,"entryType","journalDate",description,"createdById") VALUES ('${jid}','GENERAL','ENTRY','2026-02-20','Balapan','${fx.finance.userId}')`);
      await tx.$executeRawUnsafe(`INSERT INTO journal_lines (id,"journalId","lineNo","accountId",debit,credit) VALUES (gen_random_uuid(),'${jid}',1,'${c("6-2000")}',5,0),(gen_random_uuid(),'${jid}',2,'${c("1-2900")}',0,5)`);
      await gate;
    }, { timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 300));
    let done = false;
    const t2 = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('books_lock'))`;
      await tx.companySettings.update({ where: { id: 1 }, data: { booksLockedThrough: new Date("2026-02-28T00:00:00Z") } });
    }).then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 500));
    expect(done, "pengunci harus menunggu transaksi yang sedang mencatat").toBe(false);
    release();
    await t1;
    await t2;
    expect(await getBooksLock()).toBe("2026-02-28");
    expect((await err(jr("2026-02-20")))?.code).toBe("VALIDATION"); // jurnal tadi sah (mulai sebelum kunci); sekarang periodenya terkunci
  });
});
