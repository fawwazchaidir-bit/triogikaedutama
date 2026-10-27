import { execFileSync } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, type Fixtures } from "../helpers/db";
import { createDraft, issueInvoice } from "@/server/services/invoices";
import { recordPayment } from "@/server/services/payments";
import { createEntry } from "@/server/services/cash-entries";
import { createJournal } from "@/server/services/journals";
import { updateTaxProfile, postCorporateTaxJournal } from "@/server/services/finance-tax";
import { closePeriod, getPeriodChecklist, listPeriods, reopenPeriod } from "@/server/services/periods";
import { autoMatchStatement, createStatement, finalizeStatement } from "@/server/services/bank-reconciliation";
import { getBooksLock } from "@/server/services/books-lock";
import { periodEnd } from "@/lib/accounting/periods";
import { errorResponse } from "@/server/http";
import { AppError } from "@/server/errors";

/**
 * TUTUP BUKU · PUTARAN 2 — ADVERSARIAL: SQL langsung ke tabel periode, perubahan diam-diam pada angka tertutup, balapan, interaksi dengan modul lain.
 */
const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as AppError | null;
const sql = (q: string) => prisma.$executeRawUnsafe(q);
let fx: Fixtures;
const c = (code: string) => fx.coa[code]!;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures({ finance: true, openingDate: "2026-01-01" });
});
afterAll(async () => { await prisma.$disconnect(); });

const close = (month: number, note = "Laporan final direview", actor = fx.finance) => closePeriod(actor, { year: 2026, month, acknowledge: ["bank-recon", "unallocated", "negative-cash", "withholding-ref", "draft-invoices", "pph-badan"], note });
const reopen = (month: number, reason = "Koreksi yang terlewat", actor = fx.finance) => reopenPeriod(actor, { year: 2026, month, reason });
const FAKE = "a".repeat(64);
const rawClosed = (y: number, m: number, hash = FAKE, snapshot = "'{}'") =>
  `INSERT INTO accounting_periods (id,year,month,status,"closedAt","closedById",snapshot,"snapshotHash") VALUES (gen_random_uuid(),${y},${m},'CLOSED',now(),'${fx.finance.userId}',${snapshot},'${hash}')`;
const inv = async (date: string, taxed = false) => issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: date, paymentTermDays: 30, lines: [{ ...demiChefInput(fx).lines[0]!, taxConfigId: taxed ? fx.ppnId : null }] }))).id);
async function januaryBooks() {
  const a = await inv("2026-01-02");
  await recordPayment(fx.finance, { invoiceId: a.id, paymentDate: "2026-01-05", amount: 5_000_000, method: "Transfer" });
  await createEntry(fx.finance, { entryDate: "2026-01-10", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1300"), amount: 400_000, description: "Listrik Januari" });
  return a;
}

describe("tabel periode: SQL langsung tidak bisa melewati aturan", () => {
  it("INSERT: harus CLOSED, hash/foto wajib, berurutan, sudah berakhir, setelah mulai pembukuan, unik", async () => {
    // status OPEN langsung
    await expect(sql(`INSERT INTO accounting_periods (id,year,month,status,"reopenedAt","reopenedById","reopenReason") VALUES (gen_random_uuid(),2026,1,'OPEN',now(),'${fx.finance.userId}','alasan cukup')`)).rejects.toThrow(/harus langsung berstatus CLOSED/);
    // hash tidak sah / foto kosong / bulan di luar rentang
    await expect(sql(rawClosed(2026, 1, "zz"))).rejects.toThrow(/accounting_periods_values|check constraint/i);
    await expect(sql(rawClosed(2026, 1, FAKE, "NULL"))).rejects.toThrow(/accounting_periods_values|check constraint/i);
    await expect(sql(rawClosed(2026, 13))).rejects.toThrow();
    // melompati bulan
    await expect(sql(rawClosed(2026, 3))).rejects.toThrow(/Bulan sebelumnya belum ditutup/);
    // sebelum bulan mulai pembukuan
    await expect(sql(rawClosed(2025, 12))).rejects.toThrow(/mendahului bulan mulai pembukuan/);
    // bulan berjalan / masa depan
    await expect(sql(rawClosed(2099, 1))).rejects.toThrow(/belum berakhir/);
    const nextMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1));
    await expect(sql(rawClosed(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1))).rejects.toThrow(/belum berakhir/);
    expect(await prisma.accountingPeriod.count()).toBe(0);
    // Januari yang sah masuk; ganda ditolak; Februari menyusul
    await sql(rawClosed(2026, 1));
    await expect(sql(rawClosed(2026, 1))).rejects.toThrow(/unique|already exists|23505/i);
    await sql(rawClosed(2026, 2));
    expect(await getBooksLock()).toBe("2026-02-28"); // kunci mengikuti dari trigger, bukan dari service
  });

  it("INSERT tanpa akun kas/bank ditolak (bulan mulai pembukuan belum ada)", async () => {
    await sql(`TRUNCATE TABLE "cash_accounts" CASCADE`);
    await expect(sql(rawClosed(2026, 1))).rejects.toThrow(/Belum ada akun kas\/bank/);
  });

  it("UPDATE/DELETE periode tertutup: tidak bisa dihapus, diubah, dibuka asal-asalan, atau dibuka bila bukan yang terakhir", async () => {
    await januaryBooks();
    await close(1); await close(2);
    const jan = `year = 2026 AND month = 1`, feb = `year = 2026 AND month = 2`;
    await expect(sql(`DELETE FROM accounting_periods WHERE ${feb}`)).rejects.toThrow(/tidak dapat dihapus/);
    await expect(sql(`UPDATE accounting_periods SET note = 'diam-diam' WHERE ${feb}`)).rejects.toThrow(/tidak dapat diubah selain/);
    await expect(sql(`UPDATE accounting_periods SET month = 3 WHERE ${feb}`)).rejects.toThrow(/bulan periode tidak dapat diubah/);
    await expect(sql(`UPDATE accounting_periods SET year = 2025 WHERE ${feb}`)).rejects.toThrow(/bulan periode tidak dapat diubah/);
    // buka Januari padahal Februari masih tertutup
    const reopenSql = (where: string, extra = "") => `UPDATE accounting_periods SET status='OPEN', "reopenedAt"=now(), "reopenedById"='${fx.finance.userId}', "reopenReason"='alasan cukup'${extra} WHERE ${where}`;
    await expect(sql(reopenSql(jan))).rejects.toThrow(/dimulai dari periode terakhir/);
    // buka Februari sambil mengubah foto / hash / waktu tutup
    await expect(sql(reopenSql(feb, `, snapshot = '{"x":1}'`))).rejects.toThrow(/Foto penutupan tidak dapat diubah/);
    await expect(sql(reopenSql(feb, `, "snapshotHash" = '${FAKE}'`))).rejects.toThrow(/Foto penutupan tidak dapat diubah/);
    await expect(sql(reopenSql(feb, `, "closedAt" = now() + interval '1 day'`))).rejects.toThrow(/Foto penutupan tidak dapat diubah/);
    // alasan terlalu pendek / kosong
    await expect(sql(`UPDATE accounting_periods SET status='OPEN', "reopenedAt"=now(), "reopenedById"='${fx.finance.userId}', "reopenReason"='ab' WHERE ${feb}`)).rejects.toThrow(/accounting_periods_values|check constraint/i);
    await expect(sql(`UPDATE accounting_periods SET status='OPEN' WHERE ${feb}`)).rejects.toThrow(/accounting_periods_values|check constraint/i);
    expect(await getBooksLock()).toBe("2026-02-28"); // semua percobaan gagal: kunci tetap
    // jalur SQL yang sah setara dengan service: lalu OPEN→OPEN ditolak
    await sql(reopenSql(feb));
    expect(await getBooksLock()).toBe("2026-01-31");
    await expect(sql(`UPDATE accounting_periods SET "reopenReason" = 'ganti alasan' WHERE ${feb}`)).rejects.toThrow(/tidak dapat diubah selain/);
  });

  it("OPEN → CLOSED lewat SQL tetap melewati aturan urutan/akhir bulan", async () => {
    await januaryBooks();
    await close(1); await close(2);
    await reopen(2); await reopen(1, "Koreksi Januari yang terlewat"); // Januari & Februari kini sama-sama terbuka
    // menutup Februari lebih dulu harus ditolak trigger
    await expect(sql(`UPDATE accounting_periods SET status='CLOSED', "closedAt"=now(), "closedById"='${fx.finance.userId}', snapshot='{}', "snapshotHash"='${FAKE}' WHERE year = 2026 AND month = 2`)).rejects.toThrow(/Bulan sebelumnya belum ditutup/);
    expect(await getBooksLock()).toBeNull();
  });
});

describe("perubahan diam-diam pada angka periode tertutup terdeteksi", () => {
  async function backdatedPaymentBypassingTriggers(invoiceId: string) {
    await sql(`ALTER TABLE payments DISABLE TRIGGER USER`);
    try {
      await sql(`INSERT INTO payments (id,"invoiceId","entryType","paymentDate",amount,method,"cashAccountId","recordedById") VALUES (gen_random_uuid(),'${invoiceId}','PAYMENT','2026-01-20',100000,'Transfer','${fx.bankAcctId}','${fx.finance.userId}')`);
    } finally { await sql(`ALTER TABLE payments ENABLE TRIGGER USER`); }
  }

  it("pembayaran bertanggal Januari disisipkan dengan melewati trigger: foto Januari & Februari 'Berubah', penutupan Maret ditolak", async () => {
    const a = await januaryBooks();
    await close(1); await close(2);
    expect((await listPeriods(fx.finance)).periods.filter((p) => p.state === "CLOSED").every((p) => p.verified === true)).toBe(true);
    await backdatedPaymentBypassingTriggers(a.id);
    const ps = (await listPeriods(fx.finance)).periods;
    expect(ps.find((p) => p.key === "2026-01")!.verified).toBe(false);
    expect(ps.find((p) => p.key === "2026-02")!.verified).toBe(false); // saldo kumulatif ikut berubah
    const list = await getPeriodChecklist(fx.finance, { year: 2026, month: 3 });
    expect(list.checks.find((x) => x.id === "snapshots")).toMatchObject({ severity: "HARD", ok: false });
    expect(list.checks.find((x) => x.id === "snapshots")!.detail).toMatch(/Januari 2026, Februari 2026 berubah sejak ditutup/);
    expect(list.closable).toBe(false);
    const e = await err(close(3));
    expect(e?.code).toBe("CONFLICT");
    expect(e?.message).toMatch(/Foto periode yang sudah ditutup/);
    expect(await prisma.accountingPeriod.count({ where: { status: "CLOSED" } })).toBe(2);
  });

  it("membuka kembali periode yang berubah menghapus alarmnya hanya lewat penutupan ulang (foto baru)", async () => {
    const a = await januaryBooks();
    await close(1);
    await backdatedPaymentBypassingTriggers(a.id);
    expect((await listPeriods(fx.finance)).periods.find((p) => p.key === "2026-01")!.verified).toBe(false);
    await reopen(1, "Selisih ditemukan setelah penutupan");
    const again = await close(1, "Ditutup ulang setelah selisih diperiksa");
    expect(again.verified).toBe(true);
    expect(again.snapshot!.assets).toBe(15_700_000); // bank 10jt+5jt−0,4jt+0,1jt + kas 1jt
  });

  it("kunci buku diubah/ dihapus di luar prosedur: lockConsistent = false; TRUNCATE tabel periode juga terdeteksi", async () => {
    await januaryBooks();
    await close(1); await close(2);
    expect((await listPeriods(fx.finance)).lockConsistent).toBe(true);
    await sql(`UPDATE company_settings SET "booksLockedThrough" = NULL WHERE id = 1`);
    const l1 = await listPeriods(fx.finance);
    expect(l1).toMatchObject({ lockedThrough: null, lockConsistent: false });
    await sql(`UPDATE company_settings SET "booksLockedThrough" = '2026-02-28' WHERE id = 1`);
    expect((await listPeriods(fx.finance)).lockConsistent).toBe(true);
    await sql(`UPDATE company_settings SET "booksLockedThrough" = '2026-01-31' WHERE id = 1`);
    expect((await listPeriods(fx.finance)).lockConsistent).toBe(false);
    await sql(`TRUNCATE TABLE accounting_periods`);
    expect((await listPeriods(fx.finance))).toMatchObject({ lockedThrough: "2026-01-31", lockConsistent: false });
  });
});

describe("balapan", () => {
  it("dua penutupan bulan yang sama bersamaan: tepat satu berhasil", async () => {
    await januaryBooks();
    const rs = await Promise.all([close(1, "Penutup A").then(() => "ok", (e: AppError) => e.code), close(1, "Penutup B", fx.admin).then(() => "ok", (e: AppError) => e.code)]);
    expect(rs.sort()).toEqual(["CONFLICT", "ok"]);
    expect(await prisma.accountingPeriod.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "period.close" } })).toBe(1);
  });

  it("penutupan menunggu transaksi pencatatan yang sedang berjalan, lalu fotonya MEMUATNYA", async () => {
    await januaryBooks();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // transaksi terbuka: pengeluaran 250.000 bertanggal 15 Jan (melewati service; trigger mengambil kunci bersama)
    const t1 = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO cash_entries (id,"entryType","entryDate",direction,amount,"cashAccountId","counterAccountId",description,status,"createdById","approvedById","approvedAt")
        VALUES (gen_random_uuid(),'ENTRY','2026-01-15','OUT',250000,'${fx.bankAcctId}','${c("6-1600")}','Dalam penerbangan','APPROVED','${fx.finance.userId}','${fx.finance.userId}',now())`);
      await gate;
    }, { timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 300));
    let done = false;
    const t2 = close(1).then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 600));
    expect(done, "penutupan harus menunggu transaksi yang sedang mencatat").toBe(false);
    release();
    await t1;
    const closed = await t2;
    // aset = bank 10.000.000+5.000.000−400.000−250.000 + kas 1.000.000 = 15.350.000; beban 650.000
    expect(closed.snapshot).toMatchObject({ assets: 15_350_000, profitBeforeTax: 4_350_000, totalDebit: 16_000_000 });
    expect(closed.verified).toBe(true);
  });

  it("transaksi yang menunggu penutupan berjalan DITOLAK begitu penutupan commit (tidak ada yang lolos di sela)", async () => {
    await januaryBooks();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // penutupan manual (meniru service): ambil kunci eksklusif, sisipkan periode, tahan transaksi
    const t1 = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('books_lock'))`;
      await tx.$executeRawUnsafe(rawClosed(2026, 1));
      await gate;
    }, { timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 300));
    let settled = false;
    const t2 = createEntry(fx.finance, { entryDate: "2026-01-31", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1600"), amount: 1000, description: "Menyusul penutupan" }).then(() => null, (e: unknown) => e).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 600));
    expect(settled, "pencatatan menunggu kunci buku").toBe(false);
    release();
    await t1;
    // service lolos pemeriksaan awal (belum ada penutupan saat itu) → trigger menolak setelah penutupan commit → dipetakan jadi 422 yang ramah
    const e = await t2;
    expect(e).not.toBeNull();
    const res = errorResponse(e);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatchObject({ code: "VALIDATION", message: expect.stringMatching(/^Buku sudah ditutup sampai 2026-01-31: transaksi bertanggal 2026-01-31 ditolak/) });
    expect(await prisma.cashEntry.count({ where: { description: "Menyusul penutupan" } })).toBe(0);
  });

  it("tutup Maret & buka Februari bersamaan: hasil akhir konsisten (kunci = akhir periode tertutup terakhir)", async () => {
    await januaryBooks();
    await close(1); await close(2);
    const rs = await Promise.all([close(3).then(() => "close3", (e: AppError) => e.code), reopen(2).then(() => "reopen2", (e: AppError) => e.code)]);
    const closed = (await prisma.accountingPeriod.findMany({ where: { status: "CLOSED" }, orderBy: [{ year: "asc" }, { month: "asc" }] })).map((p) => p.month);
    const lock = await getBooksLock();
    // urutan A: tutup Maret lalu buka Februari → konflik (Februari bukan terakhir); B: buka Februari lalu tutup Maret → konflik (Februari terbuka)
    expect(rs.filter((r) => r === "CONFLICT")).toHaveLength(1);
    expect(rs.filter((r) => r !== "CONFLICT")).toHaveLength(1);
    expect(lock).toBe(periodEnd(2026, closed.at(-1)!));
    expect((await listPeriods(fx.finance)).lockConsistent).toBe(true);
  });
});

describe("pemeriksaan wajib & peringatan yang hanya bisa dipicu lewat jalur tidak biasa", () => {
  it("saldo buku besar kas ≠ modul kas (jurnal menyentuh akun kas disisipkan dengan melewati trigger) menghalangi penutupan", async () => {
    await januaryBooks();
    expect((await getPeriodChecklist(fx.finance, { year: 2026, month: 1 })).checks.find((x) => x.id === "cash-identity")).toMatchObject({ ok: true, severity: "HARD" });
    const jid = crypto.randomUUID();
    await sql(`ALTER TABLE journal_entries DISABLE TRIGGER USER`); await sql(`ALTER TABLE journal_lines DISABLE TRIGGER USER`);
    try {
      await sql(`INSERT INTO journal_entries (id,kind,"entryType","journalDate",description,"createdById") VALUES ('${jid}','GENERAL','ENTRY','2026-01-15','Menyentuh kas (ilegal)','${fx.finance.userId}')`);
      await sql(`INSERT INTO journal_lines (id,"journalId","lineNo","accountId",debit,credit) VALUES (gen_random_uuid(),'${jid}',1,'${c("1-1200")}',777000,0),(gen_random_uuid(),'${jid}',2,'${c("3-1100")}',0,777000)`);
    } finally { await sql(`ALTER TABLE journal_entries ENABLE TRIGGER USER`); await sql(`ALTER TABLE journal_lines ENABLE TRIGGER USER`); }
    const list = await getPeriodChecklist(fx.finance, { year: 2026, month: 1 });
    expect(list.checks.find((x) => x.id === "cash-identity")).toMatchObject({ ok: false, severity: "HARD" });
    expect(list.checks.find((x) => x.id === "trial-balance")).toMatchObject({ ok: true }); // jurnalnya seimbang; hanya identitas kas yang gagal
    expect(list.closable).toBe(false);
    expect((await err(close(1)))?.message).toMatch(/Saldo buku besar kas\/bank = modul kas/);
  });

  it("rekonsiliasi bank: final sampai tengah bulan TIDAK cukup; final yang melewati akhir bulan cukup", async () => {
    await januaryBooks();
    const recon = async (end: string, lines: { txDate: string; description: string; amount: number }[], opening: number, start: string) => {
      const sum = lines.reduce((a, l) => a + l.amount, 0);
      const st = await createStatement(fx.finance, { cashAccountId: fx.bankAcctId, periodStart: start, periodEnd: end, openingBalance: opening, closingBalance: opening + sum, lines });
      await autoMatchStatement(fx.finance, st.id);
      await finalizeStatement(fx.finance, st.id);
    };
    const status = async () => (await getPeriodChecklist(fx.finance, { year: 2026, month: 1 })).checks.find((x) => x.id === "bank-recon")!;
    // 1–15 Jan final (hanya transaksi ≤ 15 Jan): akhir bulan belum tercakup
    await recon("2026-01-15", [{ txDate: "2026-01-05", description: "TRF MASUK", amount: 5_000_000 }, { txDate: "2026-01-10", description: "PLN", amount: -400_000 }], 10_000_000, "2026-01-01");
    expect(await status()).toMatchObject({ ok: false });
    // 16–28 Feb final → mencakup akhir Januari
    await recon("2026-02-28", [], 14_600_000, "2026-01-16");
    expect(await status()).toMatchObject({ ok: true });
  });
});

describe("interaksi dengan modul lain", () => {
  it("PPh badan final bulanan: peringatan sampai jurnal estimasi dibukukan; setelah bulan ditutup jurnal tidak bisa lagi bertanggal bulan itu", async () => {
    await januaryBooks();
    await updateTaxProfile(fx.admin, { isPkp: false, regime: "FINAL", rateBps: 50 }); // tarif contoh uji, bukan anjuran
    const before = await getPeriodChecklist(fx.finance, { year: 2026, month: 1 });
    expect(before.checks.find((x) => x.id === "pph-badan")).toMatchObject({ severity: "SOFT", ok: false });
    expect((await err(closePeriod(fx.finance, { year: 2026, month: 1, acknowledge: ["bank-recon"], note: "Tanpa pengakuan PPh" })))?.message).toMatch(/Estimasi PPh badan/);
    await postCorporateTaxJournal(fx.finance, { year: 2026, month: 1 });
    const after = await getPeriodChecklist(fx.finance, { year: 2026, month: 1 });
    expect(after.checks.find((x) => x.id === "pph-badan")).toMatchObject({ ok: true });
    await closePeriod(fx.finance, { year: 2026, month: 1, acknowledge: ["bank-recon"], note: "PPh final dibukukan" });
    // sesudah ditutup: membukukan lagi untuk Januari ditolak (tanggal jurnal = akhir bulan = terkunci)
    const e = await err(postCorporateTaxJournal(fx.finance, { year: 2026, month: 1 }));
    expect(e).not.toBeNull();
  });

  it("invoice ber-PPN draft bertanggal bulan tertutup tidak dapat diterbitkan; ubah tanggal ke bulan terbuka → bisa", async () => {
    await januaryBooks();
    const draft = await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: "2026-01-15", paymentTermDays: 30, lines: [{ ...demiChefInput(fx).lines[0]!, taxConfigId: fx.ppnId }] }));
    const list = await getPeriodChecklist(fx.finance, { year: 2026, month: 1 });
    expect(list.checks.find((x) => x.id === "draft-invoices")).toMatchObject({ ok: false });
    expect(list.checks.find((x) => x.id === "draft-invoices")!.detail).toMatch(/ber-PPN/);
    await close(1);
    const e = await err(issueInvoice(fx.finance, draft.id));
    expect(e?.code).toBe("VALIDATION");
    expect(e?.message).toMatch(/Buku sudah ditutup/);
  });

  it("transaksi dengan tanggal di bulan tertutup ditolak untuk semua peran, termasuk Admin", async () => {
    await januaryBooks();
    await close(1);
    for (const actor of [fx.finance, fx.admin]) {
      expect((await err(createEntry(actor, { entryDate: "2026-01-31", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1600"), amount: 1000, description: "Mundur" })))?.code).toBe("VALIDATION");
    }
  });
});

describe("db:reconcile atas penutupan buku", () => {
  const run = () => { try { return { code: 0, out: execFileSync("npx", ["tsx", "--conditions=react-server", "scripts/reconcile.ts"], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; } catch (e) { const x = e as { status?: number; stdout?: string; stderr?: string }; return { code: x.status ?? 99, out: `${x.stdout ?? ""}${x.stderr ?? ""}` }; } };

  it("bersih setelah menutup/membuka; mendeteksi perubahan diam-diam, kunci diubah, celah urutan", async () => {
    const a = await januaryBooks();
    // sertakan jurnal manual, transfer, entri ke akun aset, dan pembayaran dengan PPh dipotong agar oracle SQL teruji lebih luas
    await recordPayment(fx.finance, { invoiceId: a.id, paymentDate: "2026-01-25", amount: 2_000_000, withholdingAmount: 100_000, method: "Transfer" });
    await createEntry(fx.finance, { entryDate: "2026-01-26", cashAccountId: fx.bankAcctId, counterAccountId: c("1-2200"), amount: 300_000, description: "Beli peralatan" });
    await createEntry(fx.finance, { entryDate: "2026-01-27", cashAccountId: fx.bankAcctId, counterAccountId: c("3-1100"), direction: "IN", amount: 700_000, description: "Tambahan modal" });
    await createJournal(fx.finance, { journalDate: "2026-01-31", description: "Penyusutan", lines: [{ accountId: c("6-2000"), debit: 50_000, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: 50_000 }] });
    await close(1); await close(2);
    const clean = run();
    expect(clean.code, clean.out).toBe(0);

    // (1) pembayaran bertanggal Januari disisipkan tanpa trigger → foto ≠ hitung ulang
    await sql(`ALTER TABLE payments DISABLE TRIGGER USER`);
    try {
      await sql(`INSERT INTO payments (id,"invoiceId","entryType","paymentDate",amount,method,"cashAccountId","recordedById") VALUES (gen_random_uuid(),'${a.id}','PAYMENT','2026-01-20',100000,'Transfer','${fx.bankAcctId}','${fx.finance.userId}')`);
      const bad = run();
      expect(bad.code, bad.out).toBe(1);
      expect(bad.out).toMatch(/foto periode tertutup/);
      await sql(`DELETE FROM payments WHERE amount = 100000 AND "paymentDate" = '2026-01-20'`);
    } finally { await sql(`ALTER TABLE payments ENABLE TRIGGER USER`); }
    expect(run().code).toBe(0);

    // (2) kunci buku diubah di luar prosedur
    await sql(`UPDATE company_settings SET "booksLockedThrough" = '2026-01-31' WHERE id = 1`);
    const lockBad = run();
    expect(lockBad.code, lockBad.out).toBe(1);
    expect(lockBad.out).toMatch(/kunci buku/);
    await sql(`UPDATE company_settings SET "booksLockedThrough" = '2026-02-28' WHERE id = 1`);
    expect(run().code).toBe(0);

    // (3) celah urutan: Januari dihapus lewat TRUNCATE+sisip ulang Februari saja
    await sql(`ALTER TABLE accounting_periods DISABLE TRIGGER USER`);
    try {
      await sql(`DELETE FROM accounting_periods WHERE month = 1`);
      const gap = run();
      expect(gap.code, gap.out).toBe(1);
      expect(gap.out).toMatch(/celah urutan/);
    } finally { await sql(`ALTER TABLE accounting_periods ENABLE TRIGGER USER`); }
  }, 180_000);
});
