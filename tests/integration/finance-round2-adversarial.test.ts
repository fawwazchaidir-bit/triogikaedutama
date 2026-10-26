import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, makeProof, type Fixtures } from "../helpers/db";
import { createDraft, issueInvoice } from "@/server/services/invoices";
import { recordPayment, reversePayment } from "@/server/services/payments";
import { createCashAccount, listCashAccounts, updateCashAccount, listCashAccountOptions } from "@/server/services/cash-accounts";
import { approveEntry, cancelPendingEntry, createEntry, createTransfer, listEntries, rejectEntry, reverseEntry, reverseTransfer } from "@/server/services/cash-entries";
import { createCoaAccount, listCoaAccounts, updateCoaAccount } from "@/server/services/finance-coa";
import { getAccountLedger, getCashFlow, getFinanceWarnings, getIncomeStatement, runStatement } from "@/server/services/finance-statements";
import { readFileForActor, storeFile } from "@/server/services/files";
import { todayIso } from "@/lib/format";
import { CASH_AMOUNT_MAX } from "@/lib/accounting/limits";
import { AppError } from "@/server/errors";

/**
 * PUTARAN 2 — ADVERSARIAL: mencari celah.
 * Penyerang/pengguna ceroboh mencoba: SQL langsung, input aneh, izin silang, kondisi balapan, batas tanggal & angka.
 * Setiap percobaan HARUS ditolak dengan pesan yang benar dan TIDAK boleh meninggalkan data setengah jadi.
 */
let fx: Fixtures;
const today = todayIso("Asia/Jakarta");
const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures({ finance: true });
});
const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as AppError;
const code = async (p: Promise<unknown>) => (await err(p))?.code;
const sql = (q: string) => prisma.$executeRawUnsafe(q);
const entry = (actor: typeof fx.finance, o: Record<string, unknown> = {}) =>
  createEntry(actor, { entryDate: "2026-03-09", cashAccountId: fx.bankAcctId, counterAccountId: fx.coa["6-1300"], amount: 100_000, description: "Uji celah", ...o });
const bal = async () => Object.fromEntries((await listCashAccounts(fx.finance)).map((a) => [a.name, a.balance]));
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46]);
const TXT = new TextEncoder().encode("ini bukan pdf, hanya teks yang menyamar");

/** INSERT mentah ke cash_entries (melewati service) untuk menguji pagar database. */
const rawEntry = (o: { type?: string; date?: string; dir?: string; amount?: number; acct?: string; counter?: string; status?: string; reverses?: string | null; reason?: string | null; approver?: boolean }) => {
  const { type = "ENTRY", date = "2026-03-09", dir = "OUT", amount = 1000, acct = fx.bankAcctId, counter = fx.coa["6-1300"]!, status = "PENDING", reverses = null, reason = null, approver = false } = o;
  return sql(`INSERT INTO cash_entries (id,"entryType","reversesEntryId","entryDate",direction,amount,"cashAccountId","counterAccountId",description,status,reason,"createdById","approvedById","approvedAt")
    VALUES (gen_random_uuid(),'${type}',${reverses ? `'${reverses}'` : "NULL"},'${date}','${dir}',${amount},'${acct}','${counter}','raw','${status}',${reason ? `'${reason}'` : "NULL"},'${fx.finance.userId}',
    ${approver || status === "APPROVED" ? `'${fx.finance.userId}'` : "NULL"},${approver || status === "APPROVED" ? "now()" : "NULL"})`);
};

describe("pagar database (SQL langsung melewati aplikasi)", () => {
  it("entri berlaku tidak dapat diubah/dihapus; entri menunggu tidak dapat disunting isinya; keputusan tidak dapat dipalsukan", async () => {
    const ok = await entry(fx.finance);
    await expect(sql(`UPDATE cash_entries SET amount = 1 WHERE id = '${ok.id}'`)).rejects.toThrow(/append-only/);
    await expect(sql(`UPDATE cash_entries SET description = 'x' WHERE id = '${ok.id}'`)).rejects.toThrow(/append-only/);
    await expect(sql(`DELETE FROM cash_entries WHERE id = '${ok.id}'`)).rejects.toThrow(/append-only/);

    const pend = await entry(fx.staff);
    await expect(sql(`UPDATE cash_entries SET amount = 1 WHERE id = '${pend.id}'`)).rejects.toThrow(); // status tetap PENDING → tak boleh disunting
    await expect(sql(`UPDATE cash_entries SET status='APPROVED', "approvedById"='${fx.finance.userId}', "approvedAt"=now(), amount=9999999 WHERE id='${pend.id}'`)).rejects.toThrow(/Isi entri kas tidak boleh diubah/);
    await expect(sql(`UPDATE cash_entries SET status='APPROVED' WHERE id='${pend.id}'`)).rejects.toThrow(); // tanpa penyetuju → CHECK
    await expect(sql(`UPDATE cash_entries SET status='REJECTED' WHERE id='${pend.id}'`)).rejects.toThrow(); // tanpa alasan → CHECK
    await rejectEntry(fx.finance, pend.id, { reason: "Tidak sesuai anggaran" });
    await expect(sql(`UPDATE cash_entries SET status='APPROVED', "approvedById"='${fx.finance.userId}', "approvedAt"=now(), "rejectedById"=NULL, "rejectedAt"=NULL, "rejectionReason"=NULL WHERE id='${pend.id}'`)).rejects.toThrow(/append-only/);
    await expect(sql(`DELETE FROM cash_entries WHERE id = '${pend.id}'`)).rejects.toThrow(/append-only/); // yang sudah ditolak pun tersimpan
    expect((await bal())["Bank Mandiri"]).toBe(9_900_000);
  });

  it("INSERT mentah: sebelum saldo awal, arah salah, akun terlarang/nonaktif, nominal ≤ 0 ditolak", async () => {
    await expect(rawEntry({ date: "2025-12-31" })).rejects.toThrow(/mendahului tanggal saldo awal/);
    await expect(rawEntry({ dir: "IN" })).rejects.toThrow(/Beban hanya dapat berupa pengeluaran/);
    await expect(rawEntry({ dir: "OUT", counter: fx.coa["4-2200"]! })).rejects.toThrow(/Pendapatan hanya dapat berupa penerimaan/);
    await expect(rawEntry({ counter: fx.coa["4-1100"]! })).rejects.toThrow(/tidak boleh dipakai pada entri kas manual/); // pendapatan invoice dicadangkan
    await expect(rawEntry({ counter: fx.coa["1-1100"]! })).rejects.toThrow(/tidak boleh dipakai/); // akun kas itu sendiri
    await expect(rawEntry({ counter: fx.coa["1-1300"]! })).rejects.toThrow(/tidak boleh dipakai/); // piutang
    await expect(rawEntry({ amount: 0 })).rejects.toThrow();
    await expect(rawEntry({ amount: -5 })).rejects.toThrow();
    await prisma.cashAccount.update({ where: { id: fx.cashAcctId }, data: { isActive: false, isDefault: false } });
    await expect(rawEntry({ acct: fx.cashAcctId })).rejects.toThrow(/tidak aktif/);
    await prisma.coaAccount.update({ where: { id: fx.coa["6-1300"]! }, data: { isActive: false } });
    await expect(rawEntry({})).rejects.toThrow(/tidak aktif atau tidak boleh/);
    expect(await prisma.cashEntry.count()).toBe(0);
  });

  it("pembalikan mentah harus persis: entri asal berlaku, akun & nominal sama, arah berlawanan, sekali saja", async () => {
    const ok = await entry(fx.finance);
    const pend = await entry(fx.staff);
    const base = { type: "REVERSAL", dir: "IN", status: "APPROVED", reason: "uji" };
    await expect(rawEntry({ ...base, reverses: pend.id })).rejects.toThrow(/sudah disetujui/); // asal masih menunggu
    await expect(rawEntry({ ...base, reverses: ok.id, amount: 99_999 })).rejects.toThrow(/akun & nominal yang sama/);
    await expect(rawEntry({ ...base, reverses: ok.id, amount: 100_000, acct: fx.cashAcctId })).rejects.toThrow(/akun & nominal yang sama/);
    await expect(rawEntry({ ...base, reverses: ok.id, amount: 100_000, dir: "OUT" })).rejects.toThrow(/berlawanan/);
    await expect(rawEntry({ ...base, reverses: ok.id, amount: 100_000, reason: null })).rejects.toThrow(); // alasan wajib (CHECK)
    await expect(rawEntry({ ...base, reverses: ok.id, amount: 100_000, status: "PENDING" })).rejects.toThrow(); // pembalikan wajib APPROVED
    await rawEntry({ ...base, reverses: ok.id, amount: 100_000 });
    await expect(rawEntry({ ...base, reverses: ok.id, amount: 100_000 })).rejects.toThrow(/already exists|23505/); // tidak bisa dua kali
    // pembalikan dari pembalikan
    const rev = await prisma.cashEntry.findFirstOrThrow({ where: { entryType: "REVERSAL" } });
    await expect(rawEntry({ type: "REVERSAL", dir: "OUT", status: "APPROVED", reason: "uji", reverses: rev.id, amount: 100_000 })).rejects.toThrow(/entri ENTRY/);
  });

  it("transfer: append-only, akun berbeda, sebelum saldo awal, pembalik harus menukar akun & nominal persis, sekali saja", async () => {
    const t = await createTransfer(fx.finance, { transferDate: "2026-03-15", fromAccountId: fx.bankAcctId, toAccountId: fx.cashAcctId, amount: 700_000 });
    await expect(sql(`UPDATE cash_transfers SET amount = 1 WHERE id = '${t.id}'`)).rejects.toThrow(/append-only/);
    await expect(sql(`DELETE FROM cash_transfers WHERE id = '${t.id}'`)).rejects.toThrow(/append-only/);
    const ins = (o: { from?: string; to?: string; amt?: number; date?: string; type?: string; rev?: string | null; reason?: string | null }) =>
      sql(`INSERT INTO cash_transfers (id,"entryType","reversesTransferId","transferDate","fromAccountId","toAccountId",amount,reason,"createdById")
        VALUES (gen_random_uuid(),'${o.type ?? "ENTRY"}',${o.rev ? `'${o.rev}'` : "NULL"},'${o.date ?? "2026-03-15"}','${o.from ?? fx.bankAcctId}','${o.to ?? fx.cashAcctId}',${o.amt ?? 1000},${o.reason ? `'${o.reason}'` : "NULL"},'${fx.finance.userId}')`);
    await expect(ins({ to: fx.bankAcctId })).rejects.toThrow(/cash_transfers_distinct|check/i);
    await expect(ins({ date: "2025-12-31" })).rejects.toThrow(/mendahului tanggal saldo awal/);
    await expect(ins({ amt: 0 })).rejects.toThrow();
    await expect(ins({ type: "REVERSAL", rev: t.id, amt: 700_000, reason: "x" })).rejects.toThrow(/menukar akun/); // tidak ditukar
    await expect(ins({ type: "REVERSAL", rev: t.id, from: fx.cashAcctId, to: fx.bankAcctId, amt: 699_999, reason: "x" })).rejects.toThrow(/nominal yang sama/);
    await expect(ins({ type: "REVERSAL", rev: t.id, from: fx.cashAcctId, to: fx.bankAcctId, amt: 700_000 })).rejects.toThrow(); // alasan wajib
    await ins({ type: "REVERSAL", rev: t.id, from: fx.cashAcctId, to: fx.bankAcctId, amt: 700_000, reason: "uji" });
    await expect(ins({ type: "REVERSAL", rev: t.id, from: fx.cashAcctId, to: fx.bankAcctId, amt: 700_000, reason: "lagi" })).rejects.toThrow(/already exists|23505/);
  });

  it("pembayaran invoice: pembalikan harus ke akun asal; pembayaran baru tidak boleh ke akun nonaktif", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: "2026-03-02" }))).id);
    const p = await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-03-05", amount: 1_000_000, method: "Transfer" });
    await expect(prisma.payment.create({ data: { invoiceId: inv.id, entryType: "REVERSAL", reversesPaymentId: p.id, paymentDate: new Date(`${today}T00:00:00Z`), amount: -1_000_000n, method: "Transfer", reason: "uji", cashAccountId: fx.cashAcctId, recordedById: fx.finance.userId } }))
      .rejects.toThrow(/akun kas\/bank yang sama/);
    await expect(prisma.payment.create({ data: { invoiceId: inv.id, entryType: "REVERSAL", reversesPaymentId: p.id, paymentDate: new Date(`${today}T00:00:00Z`), amount: -1_000_000n, method: "Transfer", reason: "uji", cashAccountId: null, recordedById: fx.finance.userId } }))
      .rejects.toThrow(/akun kas\/bank yang sama/);
    await prisma.cashAccount.update({ where: { id: fx.cashAcctId }, data: { isActive: false, isDefault: false } });
    await expect(prisma.payment.create({ data: { invoiceId: inv.id, entryType: "PAYMENT", paymentDate: new Date("2026-03-06T00:00:00Z"), amount: 1_000n, method: "Tunai", cashAccountId: fx.cashAcctId, recordedById: fx.finance.userId } }))
      .rejects.toThrow(/tidak aktif/);
    await expect(sql(`UPDATE payments SET "cashAccountId" = NULL WHERE id = '${p.id}'`)).rejects.toThrow(/append-only/); // alokasi tidak dapat dipindah diam-diam
  });

  it("bagan akun & akun kas: kode/jenis terkunci setelah dipakai; akun sistem tak tersentuh; tak dapat dihapus; default tunggal", async () => {
    await entry(fx.finance);
    await expect(sql(`UPDATE coa_accounts SET type='PENDAPATAN' WHERE id='${fx.coa["6-1300"]}'`)).rejects.toThrow(/sudah dipakai transaksi/);
    await expect(sql(`UPDATE coa_accounts SET code='6-1301' WHERE id='${fx.coa["6-1300"]}'`)).rejects.toThrow(/sudah dipakai transaksi/);
    await expect(sql(`UPDATE coa_accounts SET type='BEBAN' WHERE id='${fx.coa["4-1100"]}'`)).rejects.toThrow(/Akun sistem/);
    await expect(sql(`UPDATE coa_accounts SET "isSystem"=false WHERE id='${fx.coa["4-1100"]}'`)).rejects.toThrow(/tidak boleh diubah/);
    await expect(sql(`DELETE FROM coa_accounts WHERE id='${fx.coa["6-9000"]}'`)).rejects.toThrow(/tidak boleh dihapus/);
    await expect(sql(`UPDATE coa_accounts SET "manualEntry"=true WHERE id='${fx.coa["4-1100"]}'`)).rejects.toThrow(); // sistem tak boleh manual (CHECK)
    await expect(sql(`UPDATE cash_accounts SET "openingDate"='2026-02-01' WHERE id='${fx.bankAcctId}'`)).rejects.toThrow(/sudah memiliki mutasi/);
    await expect(sql(`UPDATE cash_accounts SET kind='KAS' WHERE id='${fx.bankAcctId}'`)).rejects.toThrow(/sudah memiliki mutasi/);
    await expect(sql(`DELETE FROM cash_accounts WHERE id='${fx.cashAcctId}'`)).rejects.toThrow(/tidak boleh dihapus/);
    await expect(sql(`UPDATE cash_accounts SET "coaAccountId"='${fx.coa["6-1300"]}' WHERE id='${fx.cashAcctId}'`)).rejects.toThrow(/berjenis ASET|sudah memiliki/);
    await expect(sql(`UPDATE cash_accounts SET "isDefault"=true WHERE id='${fx.cashAcctId}' AND false`)).resolves.toBe(0);
    // dua default untuk jenis yang sama
    const second = await prisma.cashAccount.create({ data: { name: "Bank Lain", kind: "BANK", coaAccountId: fx.coa["1-1200"]!, openingDate: new Date("2026-01-01T00:00:00Z") } });
    await expect(sql(`UPDATE cash_accounts SET "isDefault"=true WHERE id='${second.id}'`)).rejects.toThrow(/already exists|23505/); // unique index parsial: satu default per jenis
    await prisma.cashAccount.update({ where: { id: second.id }, data: { isActive: false } });
    await expect(sql(`UPDATE cash_accounts SET "isDefault"=true WHERE id='${second.id}'`)).rejects.toThrow(); // default harus aktif
    await expect(sql(`UPDATE cash_accounts SET "openingBalance"=-1 WHERE id='${second.id}'`)).rejects.toThrow();
  });
});

describe("izin silang & pemisahan tugas (service)", () => {
  it("Staff hanya dapat mencatat PENGELUARAN; penerimaan lain/investasi/pendanaan/transfer/persetujuan/koreksi/laporan semuanya ditolak", async () => {
    const base = { cashAccountId: fx.bankAcctId, amount: 50_000, description: "Percobaan staff", entryDate: "2026-03-09" };
    expect(await code(createEntry(fx.staff, { ...base, counterAccountId: fx.coa["4-2200"], direction: "IN" }))).toBe("FORBIDDEN"); // pendapatan lain
    expect(await code(createEntry(fx.staff, { ...base, counterAccountId: fx.coa["1-2100"], direction: "OUT" }))).toBe("FORBIDDEN"); // investasi
    expect(await code(createEntry(fx.staff, { ...base, counterAccountId: fx.coa["3-1100"], direction: "IN" }))).toBe("FORBIDDEN"); // modal
    expect(await code(createEntry(fx.staff, { ...base, counterAccountId: fx.coa["3-1200"], direction: "OUT" }))).toBe("FORBIDDEN"); // prive
    expect(await code(createEntry(fx.staff, { ...base, counterAccountId: fx.coa["6-1300"], direction: "IN" }))).toBe("VALIDATION"); // beban masuk
    expect(await code(createTransfer(fx.staff, { transferDate: "2026-03-09", fromAccountId: fx.bankAcctId, toAccountId: fx.cashAcctId, amount: 1000 }))).toBe("FORBIDDEN");
    const pend = await entry(fx.staff);
    // izin approve harus berdiri sendiri (bukan hanya tertutup aturan "bukan pencatat"): staff LAIN pun tidak boleh menyetujui
    expect(await code(approveEntry(fx.staff2, pend.id))).toBe("FORBIDDEN");
    expect((await prisma.cashEntry.findUniqueOrThrow({ where: { id: pend.id } })).status).toBe("PENDING");
    for (const fn of [
      () => approveEntry(fx.staff, pend.id), () => rejectEntry(fx.staff, pend.id, { reason: "tidak berwenang" }), () => reverseEntry(fx.staff, pend.id, { reason: "tidak berwenang" }),
      () => listCashAccounts(fx.staff), () => getCashFlow(fx.staff, {}), () => getIncomeStatement(fx.staff, {}), () => runStatement(fx.staff, "cash-flow", {}),
      () => getAccountLedger(fx.staff, { accountId: fx.bankAcctId }), () => getFinanceWarnings(fx.staff),
      () => createCoaAccount(fx.staff, { code: "6-5000", name: "Beban Gelap", type: "BEBAN", manualEntry: true }),
      () => createCashAccount(fx.staff, { name: "Kas Gelap", kind: "KAS", coaAccountId: fx.coa["1-1100"], openingBalance: 1, openingDate: "2026-01-01" }),
    ]) expect(await code(fn())).toBe("FORBIDDEN");
    // daftar kategori untuk staff hanya akun beban yang boleh dipilih — tanpa akun sistem/ekuitas/aset
    const cats = await listCoaAccounts(fx.staff);
    expect(cats.length).toBeGreaterThan(5);
    expect(cats.every((c) => c.type === "BEBAN" && c.manualEntry && c.isActive)).toBe(true);
    expect(cats.map((c) => c.code)).not.toContain("7-1100");
  });

  it("Finance Manager mencatat/menyetujui/membalikkan tetapi TIDAK mengelola bagan akun, akun kas, atau saldo awal (hanya Administrator)", async () => {
    expect(await code(createCoaAccount(fx.finance, { code: "6-5000", name: "Beban Baru", type: "BEBAN", manualEntry: true }))).toBe("FORBIDDEN");
    expect(await code(updateCoaAccount(fx.finance, fx.coa["6-1300"]!, { name: "Ganti" }))).toBe("FORBIDDEN");
    expect(await code(updateCashAccount(fx.finance, fx.bankAcctId, { openingBalance: 99 }))).toBe("FORBIDDEN");
    expect(await code(createCashAccount(fx.finance, { name: "X", kind: "KAS", coaAccountId: fx.coa["1-1100"], openingBalance: 1, openingDate: "2026-01-01" }))).toBe("FORBIDDEN");
    const ok = await createCoaAccount(fx.admin, { code: "6-5000", name: "Beban Baru", type: "BEBAN", manualEntry: true });
    expect(ok).toMatchObject({ code: "6-5000", section: "OPERASI", isSystem: false, inUse: false });
  });

  it("maker-checker: pencatat tidak dapat menyetujui entrinya sendiri; staff lain tidak dapat membatalkan/melihat pengajuan orang lain", async () => {
    // Pengajuan menggantung milik Finance (kondisi yang tidak lahir dari service, dibuat langsung) tetap tidak boleh disetujui pembuatnya.
    const raw = await prisma.cashEntry.create({ data: { entryDate: new Date("2026-03-09T00:00:00Z"), direction: "OUT", amount: 1000n, cashAccountId: fx.bankAcctId, counterAccountId: fx.coa["6-1300"]!, description: "menggantung", createdById: fx.finance.userId } });
    expect((await err(approveEntry(fx.finance, raw.id)))?.code).toBe("FORBIDDEN");
    expect((await approveEntry(fx.admin, raw.id)).status).toBe("APPROVED"); // orang lain boleh
    const mine = await entry(fx.staff);
    expect(await code(cancelPendingEntry(fx.staff2, mine.id))).toBe("NOT_FOUND");
    expect(await code(cancelPendingEntry(fx.finance, mine.id))).toBe("NOT_FOUND"); // penyetuju menolak, bukan menghapus
    expect((await listEntries(fx.staff2, {})).total).toBe(0);
    await approveEntry(fx.finance, mine.id);
    expect(await code(cancelPendingEntry(fx.staff, mine.id))).toBe("CONFLICT"); // sudah berlaku
    expect(await code(approveEntry(fx.finance, mine.id))).toBe("CONFLICT"); // tidak dua kali
    expect(await code(rejectEntry(fx.finance, mine.id, { reason: "terlambat menolak" }))).toBe("CONFLICT");
  });

  it("bukti pengeluaran: hanya unggahan sendiri berjenis EXPENSE_PROOF; file palsu ditolak; hak baca terbatas", async () => {
    expect(await code(storeFile(fx.staff, "EXPENSE_PROOF", { name: "nota.pdf", bytes: TXT }))).toBe("VALIDATION"); // magic bytes
    expect(await code(storeFile(fx.staff, "LOGO", { name: "l.png", bytes: PDF }))).toBe("FORBIDDEN");
    const mine = await storeFile(fx.staff, "EXPENSE_PROOF", { name: "../../nota.pdf", bytes: PDF });
    const theirs = await storeFile(fx.staff2, "EXPENSE_PROOF", { name: "nota2.pdf", bytes: PDF });
    const payProof = await storeFile(fx.staff, "PAYMENT_PROOF", { name: "bayar.pdf", bytes: PDF });
    expect(await code(entry(fx.staff, { proofFileId: theirs.id }))).toBe("VALIDATION"); // bukti milik orang lain
    expect(await code(entry(fx.staff, { proofFileId: payProof.id }))).toBe("VALIDATION"); // jenis salah
    expect(await code(entry(fx.staff, { proofFileId: "bukan-uuid" }))).toBe("VALIDATION");
    const e = await entry(fx.staff, { proofFileId: mine.id });
    expect(e.proofFileId).toBe(mine.id);
    expect((await readFileForActor(fx.staff, mine.id)).kind).toBe("EXPENSE_PROOF");
    expect(await code(readFileForActor(fx.staff2, mine.id))).toBe("FORBIDDEN");
    expect((await readFileForActor(fx.finance, mine.id)).kind).toBe("EXPENSE_PROOF");
    expect(await prisma.auditLog.count({ where: { action: "file.view" } })).toBe(2);
  });
});

describe("masukan aneh & batas", () => {
  it("nominal: 0, negatif, pecahan, teks, NaN, melebihi batas wajar semuanya ditolak; batas persis diterima", async () => {
    for (const amount of [0, -1, 1.5, "100000", Number.NaN, null, CASH_AMOUNT_MAX + 1, 1e21]) {
      expect(await code(entry(fx.finance, { amount })), String(amount)).toBe("VALIDATION");
    }
    expect((await entry(fx.finance, { amount: CASH_AMOUNT_MAX, proofFileId: await makeProof(fx.finance) })).amount).toBe(CASH_AMOUNT_MAX);
    expect((await entry(fx.finance, { amount: 1 })).amount).toBe(1);
    expect(await prisma.cashEntry.count()).toBe(2);
  });

  it("tanggal: tidak valid, format lain, masa depan, sebelum saldo awal ditolak; tepat saldo awal & hari ini diterima", async () => {
    for (const entryDate of ["2026-02-31", "31/03/2026", "2026-3-9", "", "bukan tanggal", day(1)]) {
      expect(await code(entry(fx.finance, { entryDate })), entryDate).toBe("VALIDATION");
    }
    expect(await code(entry(fx.finance, { entryDate: "2025-12-31" }))).toBe("VALIDATION");
    expect((await entry(fx.finance, { entryDate: "2026-01-01" })).entryDate).toBe("2026-01-01");
    expect((await entry(fx.finance, { entryDate: today })).entryDate).toBe(today);
    expect(await code(createTransfer(fx.finance, { transferDate: "2025-12-31", fromAccountId: fx.bankAcctId, toAccountId: fx.cashAcctId, amount: 1 }))).toBe("VALIDATION");
    expect(await code(createTransfer(fx.finance, { transferDate: day(1), fromAccountId: fx.bankAcctId, toAccountId: fx.cashAcctId, amount: 1 }))).toBe("VALIDATION");
    expect(await code(createTransfer(fx.finance, { transferDate: "2026-03-01", fromAccountId: fx.bankAcctId, toAccountId: fx.bankAcctId, amount: 1 }))).toBe("VALIDATION");
  });

  it("keterangan/akun: kosong, spasi, terlalu pendek/panjang; akun & kategori tak dikenal/nonaktif/terlarang → error terkendali (bukan 500)", async () => {
    for (const description of ["", "   ", "ab", "x".repeat(301)]) expect(await code(entry(fx.finance, { description })), description).toBe("VALIDATION");
    expect(await code(entry(fx.finance, { payee: "p".repeat(121) }))).toBe("VALIDATION");
    expect(await code(entry(fx.finance, { direction: "SIDEWAYS" }))).toBe("VALIDATION");
    const ghost = "11111111-1111-4111-8111-111111111111";
    expect(["VALIDATION", "NOT_FOUND"]).toContain(await code(entry(fx.finance, { cashAccountId: ghost })));
    expect(await code(entry(fx.finance, { counterAccountId: ghost }))).toBe("VALIDATION");
    expect(await code(entry(fx.finance, { cashAccountId: "x" }))).toBe("VALIDATION");
    for (const c of ["4-1100", "1-1100", "1-1200", "1-1300", "2-1100", "3-2100", "6-2000", "7-1100"]) {
      expect(await code(entry(fx.finance, { counterAccountId: fx.coa[c] })), c).toBe("VALIDATION");
    }
    expect(await prisma.cashEntry.count()).toBe(0);
  });

  it("teks berbahaya tersimpan apa adanya (tidak dieksekusi) dan tidak merusak laporan/ekspor", async () => {
    const evil = `'); DROP TABLE cash_entries; -- <script>alert(1)</script> =HYPERLINK("http://x")`;
    const e = await entry(fx.finance, { description: evil, payee: evil, reference: evil });
    expect(e.description).toBe(evil);
    expect(await prisma.cashEntry.count()).toBe(1);
    const l = await getAccountLedger(fx.finance, { accountId: fx.bankAcctId, from: "2026-01-01", to: today });
    expect(l.rows.at(-1)!.description).toContain("DROP TABLE");
    expect((await runStatement(fx.finance, "cash-flow", { from: "2026-01-01", to: today })).rows.length).toBeGreaterThan(3);
  });

  it("parameter laporan: dari > sampai, masa depan, format salah, jenis tak dikenal", async () => {
    expect(await code(getCashFlow(fx.finance, { from: "2026-03-31", to: "2026-03-01" }))).toBe("VALIDATION");
    expect(await code(getCashFlow(fx.finance, { to: day(5) }))).toBe("VALIDATION");
    expect(await code(getIncomeStatement(fx.finance, { from: "kemarin" }))).toBe("VALIDATION");
    expect(await code(getAccountLedger(fx.finance, { accountId: "bukan-uuid" }))).toBe("VALIDATION");
    expect(await code(getAccountLedger(fx.finance, { accountId: "11111111-1111-4111-8111-111111111111" }))).toBe("NOT_FOUND");
    expect(await code(runStatement(fx.finance, "../../etc/passwd", {}))).toBe("NOT_FOUND");
  });

  it("jumlah sangat besar tetap eksak (5 × 10 triliun): laporan = SUM() SQL", async () => {
    for (let i = 0; i < 5; i++) await entry(fx.finance, { amount: CASH_AMOUNT_MAX, counterAccountId: fx.coa["3-1100"], direction: "IN", description: `Modal besar ${i}` });
    const s = (await prisma.$queryRaw<{ s: bigint }[]>`SELECT SUM(amount) AS s FROM cash_entries`)[0]!.s;
    const r = await getCashFlow(fx.finance, { from: "2026-01-01", to: today });
    expect(r.financing.net).toBe(Number(s));
    expect(r.ending).toBe(11_000_000 + 5 * CASH_AMOUNT_MAX);
    expect(Number.isSafeInteger(r.ending)).toBe(true);
  });
});

describe("akun nonaktif & saldo negatif", () => {
  it("akun dinonaktifkan: pengajuan menggantung tak dapat disetujui; pembayaran default beralih ke 'belum dialokasikan' & dihitung di peringatan; eksplisit ditolak", async () => {
    const pend = await entry(fx.staff, { cashAccountId: fx.cashAcctId, counterAccountId: fx.coa["6-1600"] });
    // tidak dapat dinonaktifkan selama ada pengajuan menggantung
    expect((await err(updateCashAccount(fx.admin, fx.cashAcctId, { isActive: false })))?.message).toMatch(/(masih bersaldo|menunggu persetujuan)/);
    await rejectEntry(fx.finance, pend.id, { reason: "Dibatalkan sebelum nonaktif" });
    await createTransfer(fx.finance, { transferDate: "2026-03-01", fromAccountId: fx.cashAcctId, toAccountId: fx.bankAcctId, amount: 1_000_000 });
    await updateCashAccount(fx.admin, fx.cashAcctId, { isActive: false });
    expect((await listCashAccountOptions(fx.staff)).map((o) => o.name)).toEqual(["Bank Mandiri"]);
    expect(await code(entry(fx.finance, { cashAccountId: fx.cashAcctId }))).toBe("VALIDATION");
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: "2026-03-02" }))).id);
    expect(await code(recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-03-06", amount: 1000, method: "Tunai", cashAccountId: fx.cashAcctId }))).toBe("VALIDATION");
    const p = await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-03-06", amount: 1_000, method: "Tunai" }); // kas default sudah nonaktif → tak teralokasi
    expect(p.cashAccountId).toBeNull();
    const w = await getFinanceWarnings(fx.finance);
    expect(w.unallocatedPayments).toBe(1);
    // pembayaran tak teralokasi: masuk laba rugi, tidak masuk saldo
    const pl = await getIncomeStatement(fx.finance, { from: "2026-03-01", to: "2026-03-31" });
    const cf = await getCashFlow(fx.finance, { from: "2026-03-01", to: "2026-03-31" });
    expect(pl.revenue).toBe(1_000);
    expect(cf.notInBalances).toBe(1_000);
    expect(cf.operating.invoiceReceipts).toBe(0);
  });

  it("saldo negatif tidak diblokir namun ditandai peringatan; pembalikan pembayaran lintas tanggal saldo awal tetap konsisten", async () => {
    await entry(fx.finance, { cashAccountId: fx.cashAcctId, counterAccountId: fx.coa["6-1600"], amount: 1_500_000, description: "Melebihi saldo kas", proofFileId: await makeProof(fx.finance) });
    const w = await getFinanceWarnings(fx.finance);
    expect(w.negativeAccounts).toEqual([{ id: fx.cashAcctId, name: "Kas Kecil", balance: -500_000 }]);
    // pembayaran bertanggal SEBELUM saldo awal (sudah termasuk saldo awal) lalu dibalik hari ini → keluar dari akun
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: "2025-12-20" }))).id);
    const p = await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2025-12-28", amount: 2_000_000, method: "Transfer" });
    expect((await bal())["Bank Mandiri"]).toBe(10_000_000); // belum dihitung (mendahului saldo awal)
    await reversePayment(fx.finance, p.id, { reason: "Salah pelanggan" });
    expect((await bal())["Bank Mandiri"]).toBe(8_000_000); // uang keluar nyata hari ini
  });
});

describe("balapan (concurrency)", () => {
  it("10 persetujuan bersamaan atas satu pengajuan: tepat satu berhasil; saldo berkurang sekali", async () => {
    const pend = await entry(fx.staff, { amount: 1_000_000 });
    const res = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => approveEntry(i % 2 ? fx.finance : fx.admin, pend.id)));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((res.filter((r) => r.status === "rejected") as PromiseRejectedResult[]).every((r) => (r.reason as AppError).code === "CONFLICT")).toBe(true);
    expect((await bal())["Bank Mandiri"]).toBe(9_000_000);
    expect(await prisma.auditLog.count({ where: { action: "expense.approve" } })).toBe(1);
  });

  it("setujui vs batalkan-sendiri berbalapan (20×): hasil akhir selalu konsisten (disetujui XOR terhapus), tak pernah keduanya/tidak satupun", async () => {
    for (let i = 0; i < 20; i++) {
      const pend = await entry(fx.staff, { amount: 10_000, description: `balapan ${i}` });
      const [a, c] = await Promise.allSettled([approveEntry(fx.finance, pend.id), cancelPendingEntry(fx.staff, pend.id)]);
      const row = await prisma.cashEntry.findUnique({ where: { id: pend.id } });
      if (a.status === "fulfilled") { expect(c.status).toBe("rejected"); expect(row?.status).toBe("APPROVED"); }
      else { expect(c.status).toBe("fulfilled"); expect(row).toBeNull(); }
    }
    const approved = await prisma.cashEntry.count({ where: { status: "APPROVED" } });
    expect((await bal())["Bank Mandiri"]).toBe(10_000_000 - approved * 10_000);
  });

  it("pembalikan entri & transfer bersamaan: tepat satu yang berhasil", async () => {
    const e = await entry(fx.finance, { amount: 777_000 });
    const t = await createTransfer(fx.finance, { transferDate: "2026-03-09", fromAccountId: fx.bankAcctId, toAccountId: fx.cashAcctId, amount: 333_000 });
    const [re, rt] = await Promise.all([
      Promise.allSettled(Array.from({ length: 8 }, () => reverseEntry(fx.finance, e.id, { reason: "balapan pembalikan" }))),
      Promise.allSettled(Array.from({ length: 8 }, () => reverseTransfer(fx.finance, t.id, { reason: "balapan pembalikan" }))),
    ]);
    expect(re.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rt.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await bal()).toEqual({ "Bank Mandiri": 10_000_000, "Kas Kecil": 1_000_000 });
  });

  it("30 entri/transfer paralel ke dua akun: saldo = saldo awal + jumlah persis; tak ada yang hilang", async () => {
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i++) jobs.push(entry(fx.finance, { amount: 10_000 + i, cashAccountId: i % 2 ? fx.cashAcctId : fx.bankAcctId }));
    for (let i = 0; i < 8; i++) jobs.push(entry(fx.finance, { amount: 5_000 + i, cashAccountId: fx.bankAcctId, counterAccountId: fx.coa["4-2200"], direction: "IN" }));
    for (let i = 0; i < 10; i++) jobs.push(createTransfer(fx.finance, { transferDate: "2026-03-09", fromAccountId: i % 2 ? fx.bankAcctId : fx.cashAcctId, toAccountId: i % 2 ? fx.cashAcctId : fx.bankAcctId, amount: 1_000 + i }));
    const res = await Promise.allSettled(jobs);
    expect(res.filter((r) => r.status === "rejected")).toEqual([]);
    const outBank = [0, 2, 4, 6, 8, 10].reduce((s, i) => s + 10_000 + i, 0);
    const outKas = [1, 3, 5, 7, 9, 11].reduce((s, i) => s + 10_000 + i, 0);
    const inBank = Array.from({ length: 8 }, (_, i) => 5_000 + i).reduce((a, b) => a + b, 0);
    const toKas = Array.from({ length: 10 }, (_, i) => (i % 2 ? 1_000 + i : -(1_000 + i))).reduce((a, b) => a + b, 0); // bank→kas (+) untuk i ganjil
    expect(await bal()).toEqual({ "Bank Mandiri": 10_000_000 - outBank + inBank - toKas, "Kas Kecil": 1_000_000 - outKas + toKas });
    const r = await getCashFlow(fx.finance, { from: "2026-01-01", to: today });
    expect(r.ending).toBe(11_000_000 - outBank - outKas + inBank);
  });

  it("menonaktifkan akun saat entri masuk bersamaan (15×): akun nonaktif TIDAK PERNAH bersaldo ≠ 0", async () => {
    for (let i = 0; i < 15; i++) {
      await resetDb();
      fx = await seedFixtures({ finance: true });
      await createTransfer(fx.finance, { transferDate: "2026-03-01", fromAccountId: fx.cashAcctId, toAccountId: fx.bankAcctId, amount: 1_000_000 }); // kas bersaldo 0
      await Promise.allSettled([
        updateCashAccount(fx.admin, fx.cashAcctId, { isActive: false }),
        ...Array.from({ length: 4 }, (_, k) => entry(fx.finance, { cashAccountId: fx.cashAcctId, counterAccountId: fx.coa["4-2200"], direction: "IN", amount: 1_000 + k, description: `masuk ${i}-${k}` })),
      ]);
      const acct = (await listCashAccounts(fx.finance)).find((a) => a.id === fx.cashAcctId)!;
      if (!acct.isActive) expect(acct.balance, `iterasi ${i}`).toBe(0);
    }
  });

  it("dua pembuatan akun default bersamaan: tepat satu default per jenis, tanpa error", async () => {
    const mk = (name: string) => createCashAccount(fx.admin, { name, kind: "BANK", coaAccountId: fx.coa["1-1200"], openingBalance: 0, openingDate: "2026-01-01", isDefault: true });
    const res = await Promise.allSettled([mk("Bank A"), mk("Bank B"), mk("Bank C"), mk("Bank D")]);
    expect(res.filter((r) => r.status === "rejected")).toEqual([]);
    expect((await listCashAccounts(fx.finance)).filter((a) => a.kind === "BANK" && a.isDefault)).toHaveLength(1);
  });

  it("pembayaran invoice paralel ke satu akun: saldo akun = saldo awal + Σ pembayaran", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: "2026-03-02" }))).id);
    const res = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => recordPayment(i % 2 ? fx.staff : fx.finance, { invoiceId: inv.id, paymentDate: "2026-03-05", amount: 3_000_000, method: "Transfer" })));
    const ok = res.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(4); // 14jt / 3jt → 4 pembayaran penuh, sisanya ditolak (kelebihan bayar)
    expect((await bal())["Bank Mandiri"]).toBe(10_000_000 + ok * 3_000_000);
  });
});

describe("pembaruan akun: validasi & konsistensi", () => {
  it("bagan akun: kode harus sesuai jenis; duplikat; tidak boleh menonaktifkan akun sistem/akun yang dipetakan; akun sistem tak dapat dijadikan manual", async () => {
    expect(await code(createCoaAccount(fx.admin, { code: "6-1300", name: "Dobel", type: "BEBAN", manualEntry: true }))).toBe("CONFLICT");
    expect(await code(createCoaAccount(fx.admin, { code: "4-9999", name: "Salah jenis", type: "BEBAN" }))).toBe("VALIDATION"); // digit 4 bukan beban
    expect(await code(createCoaAccount(fx.admin, { code: "bukan", name: "Format", type: "BEBAN" }))).toBe("VALIDATION");
    expect(await code(createCoaAccount(fx.admin, { code: "1-9000", name: "Aset manual operasi", type: "ASET", section: "OPERASI", manualEntry: true }))).toBe("VALIDATION");
    expect(await code(updateCoaAccount(fx.admin, fx.coa["4-1100"]!, { isActive: false }))).toBe("CONFLICT");
    expect(await code(updateCoaAccount(fx.admin, fx.coa["4-1100"]!, { manualEntry: true }))).toBe("CONFLICT");
    expect(await code(updateCoaAccount(fx.admin, fx.coa["1-1200"]!, { isActive: false }))).toBe("CONFLICT"); // dipetakan akun kas aktif
    await entry(fx.finance);
    expect(await code(updateCoaAccount(fx.admin, fx.coa["6-1300"]!, { type: "PENDAPATAN", code: "4-3000" }))).toBe("CONFLICT");
    const renamed = await updateCoaAccount(fx.admin, fx.coa["6-1300"]!, { name: "Listrik, Air & Internet" });
    expect(renamed).toMatchObject({ name: "Listrik, Air & Internet", inUse: true });
    // menonaktifkan kategori menutup pencatatan baru tanpa menghapus histori
    await updateCoaAccount(fx.admin, fx.coa["6-1300"]!, { isActive: false });
    expect(await code(entry(fx.finance))).toBe("VALIDATION");
    expect((await getIncomeStatement(fx.finance, { from: "2026-03-01", to: "2026-03-31" })).totalOperatingCosts).toBe(100_000);
  });

  it("akun kas: validasi pembuatan & pembaruan", async () => {
    const mk = (o: Record<string, unknown>) => createCashAccount(fx.admin, { name: "Baru", kind: "BANK", coaAccountId: fx.coa["1-1200"], openingBalance: 0, openingDate: "2026-01-01", ...o });
    expect(await code(mk({ coaAccountId: fx.coa["6-1300"] }))).toBe("VALIDATION"); // bukan aset
    expect(await code(mk({ coaAccountId: fx.coa["1-1200"], openingBalance: -1 }))).toBe("VALIDATION");
    expect(await code(mk({ openingBalance: CASH_AMOUNT_MAX + 1 }))).toBe("VALIDATION");
    expect(await code(mk({ openingDate: day(1) }))).toBe("VALIDATION");
    expect(await code(mk({ openingDate: "2026-13-40" }))).toBe("VALIDATION");
    expect(await code(mk({ name: "" }))).toBe("VALIDATION");
    expect(await code(mk({ name: "Bank Mandiri" }))).toBe("CONFLICT");
    await updateCashAccount(fx.admin, fx.cashAcctId, { name: "Kas Kecil" }); // nama sama dengan dirinya sendiri: boleh
    expect(await code(updateCashAccount(fx.admin, fx.cashAcctId, { name: "Bank Mandiri" }))).toBe("CONFLICT");
    await entry(fx.finance, { cashAccountId: fx.cashAcctId, counterAccountId: fx.coa["6-1600"] });
    expect(await code(updateCashAccount(fx.admin, fx.cashAcctId, { openingDate: "2026-02-01" }))).toBe("CONFLICT");
    const same = await updateCashAccount(fx.admin, fx.cashAcctId, { notes: "Catatan baru" }); // perubahan catatan tidak mengubah saldo awal
    expect(same).toMatchObject({ notes: "Catatan baru", openingBalance: 1_000_000 });
    const keep = await updateCashAccount(fx.admin, fx.cashAcctId, { isActive: true });
    expect(keep.notes).toBe("Catatan baru"); // pembaruan tanpa field catatan tidak menghapusnya
  });
});
