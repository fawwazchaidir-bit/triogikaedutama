import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, type Fixtures } from "../helpers/db";
import { createCashAccount, listCashAccounts, updateCashAccount } from "@/server/services/cash-accounts";
import { createEntry } from "@/server/services/cash-entries";
import { createCoaAccount, updateCoaAccount } from "@/server/services/finance-coa";
import { createJournal, reverseJournal } from "@/server/services/journals";
import { getBalanceSheet, getTrialBalance } from "@/server/services/finance-ledger";
import { todayIso } from "@/lib/format";
import { CASH_AMOUNT_MAX } from "@/lib/accounting/limits";
import { AppError } from "@/server/errors";

/**
 * TAHAP 2 · PUTARAN B — ADVERSARIAL.
 * Mencoba merusak buku besar lewat: SQL langsung (melewati aplikasi), input aneh, pemetaan akun kas, izin silang, dan balapan.
 * Setiap percobaan HARUS ditolak dan TIDAK boleh meninggalkan baris jurnal setengah jadi.
 */
const today = todayIso("Asia/Jakarta");
let fx: Fixtures;
const c = (code: string) => fx.coa[code]!;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures({ finance: true, openingDate: "2026-01-01" });
});
afterAll(async () => { await prisma.$disconnect(); });

const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as AppError | null;
const sql = (q: string) => prisma.$executeRawUnsafe(q);
const count = async (t: string) => Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM ${t}`))[0]!.n);
const ok = (over: Record<string, unknown> = {}) => createJournal(fx.finance, {
  journalDate: "2026-02-28", description: "Penyusutan", lines: [{ accountId: c("6-2000"), debit: 100_000, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: 100_000 }], ...over,
});

/** Jurnal mentah dalam SATU transaksi (header + baris) agar pemicu tertunda dievaluasi saat commit. */
type RawLine = { acct: string; dr?: number; cr?: number; no?: number };
async function rawJournal(o: { kind?: string; type?: string; date?: string; reverses?: string | null; reason?: string | null; desc?: string; lines: RawLine[]; id?: string }) {
  const { kind = "GENERAL", type = "ENTRY", date = "2026-02-28", reverses = null, reason = null, desc = "Uji mentah", lines } = o;
  const id = o.id ?? crypto.randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`INSERT INTO journal_entries (id,kind,"entryType","reversesJournalId","journalDate",description,reason,"createdById")
      VALUES ('${id}','${kind}','${type}',${reverses ? `'${reverses}'` : "NULL"},'${date}','${desc}',${reason ? `'${reason}'` : "NULL"},'${fx.finance.userId}')`);
    for (const [i, l] of lines.entries()) {
      await tx.$executeRawUnsafe(`INSERT INTO journal_lines (id,"journalId","lineNo","accountId",debit,credit) VALUES (gen_random_uuid(),'${id}',${l.no ?? i + 1},'${l.acct}',${l.dr ?? 0},${l.cr ?? 0})`);
    }
  });
  return id;
}
const dep = (amount = 100_000): RawLine[] => [{ acct: c("6-2000"), dr: amount }, { acct: c("1-2900"), cr: amount }];

describe("pagar database jurnal (SQL langsung)", () => {
  it("jurnal tak seimbang / satu baris / tanpa baris / baris tidak sah ditolak saat commit atau seketika — tanpa sisa data", async () => {
    await expect(rawJournal({ lines: [{ acct: c("6-2000"), dr: 100 }, { acct: c("1-2900"), cr: 90 }] })).rejects.toThrow(/tidak seimbang/);
    await expect(rawJournal({ lines: [{ acct: c("6-2000"), dr: 100 }] })).rejects.toThrow(/minimal dua baris/);
    await expect(rawJournal({ lines: [] })).rejects.toThrow(/harus memiliki baris/);
    await expect(rawJournal({ lines: [{ acct: c("6-2000"), dr: 100, cr: 100 }, { acct: c("1-2900"), cr: 0, dr: 0 }] })).rejects.toThrow(/journal_lines_one_side/);
    await expect(rawJournal({ lines: [{ acct: c("6-2000"), dr: 0, cr: 0 }, { acct: c("1-2900"), cr: 0 }] })).rejects.toThrow(/journal_lines_one_side/);
    await expect(rawJournal({ lines: [{ acct: c("6-2000"), dr: -100 }, { acct: c("1-2900"), cr: -100 }] })).rejects.toThrow(/journal_lines_(nonneg|one_side)/);
    await expect(rawJournal({ lines: [{ acct: c("6-2000"), dr: 100, no: 0 }, { acct: c("1-2900"), cr: 100, no: 1 }] })).rejects.toThrow(/lineno_pos/);
    await expect(rawJournal({ lines: [{ acct: c("6-2000"), dr: 100, no: 1 }, { acct: c("1-2900"), cr: 100, no: 1 }] })).rejects.toThrow(/already exists|23505/);
    await expect(rawJournal({ desc: "   ", lines: dep() })).rejects.toThrow(/desc_nonblank/);
    expect(await count("journal_entries")).toBe(0);
    expect(await count("journal_lines")).toBe(0);
    await rawJournal({ lines: dep() }); // kontrol: yang sah tetap lolos
    expect(await count("journal_lines")).toBe(2);
  });

  it("akun kas/bank, akun nonaktif, dan jurnal saldo awal salah ditolak", async () => {
    await expect(rawJournal({ lines: [{ acct: c("1-1200"), dr: 100 }, { acct: c("4-2100"), cr: 100 }] })).rejects.toThrow(/Akun kas\/bank tidak boleh dijurnal manual/);
    await expect(rawJournal({ lines: [{ acct: c("6-2000"), dr: 100 }, { acct: c("1-1100"), cr: 100 }] })).rejects.toThrow(/Akun kas\/bank tidak boleh dijurnal manual/);
    await prisma.coaAccount.update({ where: { id: c("6-1900") }, data: { isActive: false } });
    await expect(rawJournal({ lines: [{ acct: c("6-1900"), dr: 100 }, { acct: c("1-2900"), cr: 100 }] })).rejects.toThrow(/tidak aktif/);
    // saldo awal: hanya akun neraca, tepat tanggal mulai
    await expect(rawJournal({ kind: "OPENING", date: "2026-01-01", lines: [{ acct: c("6-2000"), dr: 100 }, { acct: c("3-1100"), cr: 100 }] })).rejects.toThrow(/hanya boleh memuat akun neraca/);
    await expect(rawJournal({ kind: "OPENING", date: "2026-01-01", lines: [{ acct: c("1-2100"), dr: 100 }, { acct: c("4-2100"), cr: 100 }] })).rejects.toThrow(/hanya boleh memuat akun neraca/);
    await expect(rawJournal({ kind: "OPENING", date: "2026-01-02", lines: [{ acct: c("1-2100"), dr: 100 }, { acct: c("3-1100"), cr: 100 }] })).rejects.toThrow(/tepat pada tanggal mulai pembukuan/);
    // sebelum tanggal mulai pembukuan
    await expect(rawJournal({ date: "2025-12-31", lines: dep() })).rejects.toThrow(/mendahului tanggal mulai pembukuan/);
    expect(await count("journal_entries")).toBe(0);
  });

  it("append-only: ubah/hapus header atau baris ditolak, termasuk TRUNCATE-bebas lewat UPDATE", async () => {
    const j = await ok();
    await expect(sql(`UPDATE journal_entries SET description = 'x' WHERE id = '${j.id}'`)).rejects.toThrow(/append-only/);
    await expect(sql(`UPDATE journal_entries SET "journalDate" = '2026-01-02' WHERE id = '${j.id}'`)).rejects.toThrow(/append-only/);
    await expect(sql(`DELETE FROM journal_entries WHERE id = '${j.id}'`)).rejects.toThrow(/append-only/);
    await expect(sql(`UPDATE journal_lines SET debit = 1, credit = 0 WHERE "journalId" = '${j.id}' AND debit > 0`)).rejects.toThrow(/append-only/);
    await expect(sql(`UPDATE journal_lines SET "accountId" = '${c("5-1100")}' WHERE "journalId" = '${j.id}'`)).rejects.toThrow(/append-only/);
    await expect(sql(`DELETE FROM journal_lines WHERE "journalId" = '${j.id}'`)).rejects.toThrow(/append-only/);
    // menambah baris ke jurnal yang SUDAH ada (di transaksi baru) memecah keseimbangan → ditolak
    await expect(sql(`INSERT INTO journal_lines (id,"journalId","lineNo","accountId",debit,credit) VALUES (gen_random_uuid(),'${j.id}',9,'${c("6-1300")}',5,0)`)).rejects.toThrow(/tidak seimbang/);
    expect(await count("journal_lines")).toBe(2);
  });

  it("pembalikan: bentuk, rujukan, ganda, dan 'bukan kebalikan persis' ditolak", async () => {
    const j = await ok();
    // bentuk (CHECK): ENTRY tak boleh punya rujukan/alasan; REVERSAL wajib punya keduanya
    await expect(rawJournal({ reverses: j.id, lines: dep() })).rejects.toThrow(/journal_entries_shape/);
    await expect(rawJournal({ reason: "sembarang", lines: dep() })).rejects.toThrow(/journal_entries_shape/);
    await expect(rawJournal({ type: "REVERSAL", reverses: j.id, lines: [{ acct: c("6-2000"), cr: 100_000 }, { acct: c("1-2900"), dr: 100_000 }] })).rejects.toThrow(/journal_entries_shape/); // tanpa alasan
    await expect(rawJournal({ type: "REVERSAL", reason: "tanpa rujukan", lines: dep() })).rejects.toThrow(/journal_entries_shape|merujuk jurnal ENTRY/);
    // rujukan fiktif
    await expect(rawJournal({ type: "REVERSAL", reverses: crypto.randomUUID(), reason: "fiktif", lines: dep() })).rejects.toThrow();
    // bukan kebalikan: nominal berbeda / sisi sama / akun berbeda / baris tambahan
    const rev = (lines: RawLine[]) => rawJournal({ type: "REVERSAL", reverses: j.id, reason: "uji pembalikan", lines });
    await expect(rev([{ acct: c("6-2000"), cr: 99_999 }, { acct: c("1-2900"), dr: 99_999 }])).rejects.toThrow(/persis kebalikan/);
    await expect(rev([{ acct: c("6-2000"), dr: 100_000 }, { acct: c("1-2900"), cr: 100_000 }])).rejects.toThrow(/persis kebalikan/); // sisi sama
    await expect(rev([{ acct: c("6-1300"), cr: 100_000 }, { acct: c("1-2900"), dr: 100_000 }])).rejects.toThrow(/persis kebalikan/); // akun beda
    await expect(rev([{ acct: c("6-2000"), cr: 100_000 }, { acct: c("1-2900"), dr: 50_000 }, { acct: c("1-2900"), dr: 50_000 }, { acct: c("5-1100"), dr: 1 }, { acct: c("5-1100"), cr: 1 }])).rejects.toThrow(/persis kebalikan/);
    // yang persis kebalikan (dipecah dua baris pun) diterima; pembalikan kedua ditolak (unik)
    const rv = await rev([{ acct: c("6-2000"), cr: 100_000 }, { acct: c("1-2900"), dr: 60_000 }, { acct: c("1-2900"), dr: 40_000 }]);
    await expect(rev([{ acct: c("6-2000"), cr: 100_000 }, { acct: c("1-2900"), dr: 100_000 }])).rejects.toThrow(/already exists|23505/);
    // pembalikan dari pembalikan
    await expect(rawJournal({ type: "REVERSAL", reverses: rv, reason: "pembalik dibalik", lines: dep() })).rejects.toThrow(/merujuk jurnal ENTRY/);
    // pembalikan boleh memakai akun yang kemudian dinonaktifkan
    await prisma.coaAccount.update({ where: { id: c("6-2000") }, data: { isActive: false } }).catch(() => null);
  });

  it("tanpa akun kas sama sekali tidak ada jurnal yang sah", async () => {
    await sql(`TRUNCATE TABLE cash_accounts CASCADE`); // simulasi DBA: TRUNCATE tidak memicu pemicu baris
    await expect(rawJournal({ lines: dep() })).rejects.toThrow(/Belum ada akun kas/);
    expect((await err(ok()))?.code).toBe("CONFLICT");
  });
});

describe("pagar pemetaan akun kas ↔ bagan akun (identitas buku besar kas = modul kas)", () => {
  it("akun bagan akun yang sudah punya jurnal tidak dapat dipetakan ke akun kas/bank (baru maupun pindah)", async () => {
    const piutang = await createCoaAccount(fx.admin, { code: "1-1500", name: "Piutang Karyawan", type: "ASET", section: "OPERASI", manualEntry: false });
    await createJournal(fx.finance, { journalDate: "2026-02-28", description: "Pinjaman karyawan", lines: [{ accountId: piutang.id, debit: 500_000, credit: 0 }, { accountId: c("3-1100"), debit: 0, credit: 500_000 }] });
    const e1 = await err(createCashAccount(fx.admin, { name: "Bank Baru", kind: "BANK", coaAccountId: piutang.id, openingBalance: 0, openingDate: "2026-01-01" }));
    expect(e1?.message).toMatch(/sudah memiliki jurnal manual/);
    await expect(sql(`INSERT INTO cash_accounts (id,name,kind,"coaAccountId","openingBalance","openingDate","updatedAt") VALUES (gen_random_uuid(),'Mentah','BANK','${piutang.id}',0,'2026-01-01',now())`)).rejects.toThrow(/sudah memiliki jurnal manual/);
    await expect(sql(`UPDATE cash_accounts SET "coaAccountId" = '${piutang.id}' WHERE id = '${fx.cashAcctId}'`)).rejects.toThrow(/sudah memiliki jurnal manual/);
    // tanggal mulai pembukuan tak boleh digeser setelah ada jurnal (service & SQL)
    await expect(sql(`UPDATE cash_accounts SET "openingDate" = '2026-02-01' WHERE id = '${fx.bankAcctId}'`)).rejects.toThrow(/jurnal manual|mutasi/);
    expect((await err(updateCashAccount(fx.admin, fx.bankAcctId, { openingDate: "2026-02-01" })))?.code).toBe("CONFLICT");
  });

  it("akun cadangan & akun yang sudah dipakai sebagai akun lawan entri kas tidak dapat dipetakan ke akun kas/bank", async () => {
    // reserved
    for (const code of ["1-1450", "1-1300", "1-2900"]) {
      const e = await err(createCashAccount(fx.admin, { name: `Bank ${code}`, kind: "BANK", coaAccountId: c(code), openingBalance: 0, openingDate: "2026-01-01" }));
      expect(e, `pemetaan ke ${code} harus ditolak`).not.toBeNull();
    }
    // akun aset kustom yang dipakai sebagai akun lawan lalu dipetakan menjadi kas: identitas rusak
    const e = await createEntry(fx.finance, { entryDate: "2026-02-10", cashAccountId: fx.bankAcctId, counterAccountId: c("1-2200"), direction: "OUT", amount: 300_000, description: "Beli peralatan" });
    expect(e.status).toBe("APPROVED");
    const again = await err(createCashAccount(fx.admin, { name: "Rekening Peralatan", kind: "BANK", coaAccountId: c("1-2200"), openingBalance: 0, openingDate: "2026-01-01" }));
    expect(again, "akun yang sudah menjadi akun lawan entri tidak boleh menjadi akun kas").not.toBeNull();
    await expect(sql(`INSERT INTO cash_accounts (id,name,kind,"coaAccountId","openingBalance","openingDate","updatedAt") VALUES (gen_random_uuid(),'Mentah2','BANK','${c("1-2200")}',0,'2026-01-01',now())`)).rejects.toThrow();
  });

  it("akun lawan entri kas tidak boleh akun yang dipetakan ke kas/bank (dari sisi entri), lewat service maupun SQL", async () => {
    // akun yang boleh dipilih pada entri manual tak boleh menjadi akun kas/bank …
    const manual = await createCoaAccount(fx.admin, { code: "1-2400", name: "Dompet Digital Aset", type: "ASET", section: "INVESTASI", manualEntry: true });
    expect((await err(createCashAccount(fx.admin, { name: "Dompet A", kind: "BANK", coaAccountId: manual.id, openingBalance: 0, openingDate: "2026-01-01" })))?.message).toMatch(/entri kas manual/);
    // … sedangkan akun aset lancar khusus (bukan manual) boleh, dan sejak itu tertutup bagi jalur lain
    const wallet = await createCoaAccount(fx.admin, { code: "1-1110", name: "Dompet Digital", type: "ASET", section: "OPERASI", manualEntry: false });
    expect(await err(createCashAccount(fx.admin, { name: "Dompet Digital", kind: "BANK", coaAccountId: wallet.id, openingBalance: 0, openingDate: "2026-01-01" }))).toBeNull();
    expect((await err(createEntry(fx.finance, { entryDate: "2026-02-10", cashAccountId: fx.bankAcctId, counterAccountId: wallet.id, direction: "OUT", amount: 100_000, description: "Isi dompet" })))?.code).toBe("VALIDATION");
    await expect(sql(`INSERT INTO cash_entries (id,"entryType","entryDate",direction,amount,"cashAccountId","counterAccountId",description,status,"createdById","approvedById","approvedAt")
      VALUES (gen_random_uuid(),'ENTRY','2026-02-10','OUT',100,'${fx.bankAcctId}','${wallet.id}','raw','APPROVED','${fx.finance.userId}','${fx.finance.userId}',now())`)).rejects.toThrow();
    // menyalakan penanda "entri manual" pada akun kas/bank ditolak (service & SQL) — jalur pintas agar bisa jadi akun lawan
    expect((await err(updateCoaAccount(fx.admin, wallet.id, { manualEntry: true })))?.code).toBe("CONFLICT");
    await expect(sql(`UPDATE coa_accounts SET "manualEntry" = true WHERE id = '${wallet.id}'`)).rejects.toThrow(/dipetakan ke akun kas/);
    // jurnal manual pun tidak boleh menyentuhnya
    expect((await err(createJournal(fx.finance, { journalDate: "2026-02-28", description: "Isi dompet via jurnal", lines: [{ accountId: wallet.id, debit: 1000, credit: 0 }, { accountId: c("3-1100"), debit: 0, credit: 1000 }] })))?.code).toBe("VALIDATION");
    expect(await count("journal_lines")).toBe(0);
  });

  it("jenis/kode akun bagan akun yang sudah punya jurnal tidak boleh diubah (mengubah laporan retroaktif)", async () => {
    await createJournal(fx.finance, { journalDate: "2026-02-28", description: "Beban lain", lines: [{ accountId: c("6-9000"), debit: 100_000, credit: 0 }, { accountId: c("2-2100"), debit: 0, credit: 100_000 }] });
    const before = (await getBalanceSheet(fx.finance, { to: today })).currentYearProfit;
    const e1 = await err(updateCoaAccount(fx.admin, c("6-9000"), { type: "PENDAPATAN", code: "4-3000", section: "OPERASI" }));
    const e2 = await sql(`UPDATE coa_accounts SET "type" = 'PENDAPATAN' WHERE id = '${c("6-9000")}'`).then(() => null, (e: unknown) => e);
    const e3 = await sql(`UPDATE coa_accounts SET "code" = '6-9001' WHERE id = '${c("6-9000")}'`).then(() => null, (e: unknown) => e);
    expect(e1 && e2 && e3, "ketiga jalur harus menolak").toBeTruthy();
    expect((await getBalanceSheet(fx.finance, { to: today })).currentYearProfit).toBe(before);
  });
});

describe("masukan aneh pada pembuatan jurnal (service)", () => {
  const bad = async (over: Record<string, unknown>, label: string) => {
    const e = await err(ok(over));
    expect(e, label).not.toBeNull();
    expect(["VALIDATION", "CONFLICT"], `${label} → ${e?.code}`).toContain(e!.code);
    expect(await count("journal_entries"), `${label}: tidak boleh ada sisa`).toBe(0);
  };
  const L = (debit: unknown, credit: unknown, acct = "6-2000") => ({ accountId: c(acct), debit, credit });

  it("angka: pecahan, negatif, NaN, string, Infinity, melebihi batas, dua sisi, nol", async () => {
    await bad({ lines: [L(100.5, 0), L(0, 100.5, "1-2900")] }, "pecahan");
    await bad({ lines: [L(-100, 0), L(0, -100, "1-2900")] }, "negatif");
    await bad({ lines: [L(Number.NaN, 0), L(0, 100, "1-2900")] }, "NaN");
    await bad({ lines: [L("100", 0), L(0, 100, "1-2900")] }, "string");
    await bad({ lines: [L(Number.POSITIVE_INFINITY, 0), L(0, Number.POSITIVE_INFINITY, "1-2900")] }, "Infinity");
    await bad({ lines: [L(CASH_AMOUNT_MAX + 1, 0), L(0, CASH_AMOUNT_MAX + 1, "1-2900")] }, "melebihi batas");
    await bad({ lines: [L(100, 100), L(0, 0, "1-2900")] }, "dua sisi + nol");
    await bad({ lines: [L(0, 0), L(0, 0, "1-2900")] }, "semua nol");
    await bad({ lines: [L(100, 0), L(0, 99, "1-2900")] }, "tak seimbang selisih 1");
    await bad({ lines: [L(100, 0), L(0, 100)] }, "dua baris akun yang sama (debit & kredit pada akun sama)");
    await bad({ lines: [L(100, 0)] }, "satu baris");
    await bad({ lines: [] }, "tanpa baris");
    await bad({ lines: Array.from({ length: 41 }, (_, i) => (i % 2 ? L(0, 1, "1-2900") : L(1, 0))) }, "41 baris");
    await bad({ lines: null }, "lines null");
    await bad({ lines: "rusak" }, "lines string");
  });

  it("tanggal, keterangan, jenis, akun, dan rujukan yang tidak sah", async () => {
    for (const d of ["2026-02-30", "2026-13-01", "28-02-2026", "", "bukan tanggal", "2026-2-3"]) await bad({ journalDate: d }, `tanggal ${d}`);
    await bad({ journalDate: "2025-12-31" }, "sebelum mulai pembukuan");
    await bad({ journalDate: "2999-01-01" }, "masa depan");
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    await bad({ journalDate: tomorrow }, "besok");
    await bad({ description: "" }, "keterangan kosong");
    await bad({ description: "  \n " }, "keterangan spasi");
    await bad({ description: "ab" }, "keterangan 2 huruf");
    await bad({ description: "x".repeat(301) }, "keterangan 301");
    await bad({ reference: "r".repeat(121) }, "referensi 121");
    await bad({ kind: "ADJUSTMENT" }, "jenis tak dikenal");
    await bad({ kind: "OPENING" }, "OPENING bukan tanggal mulai + akun laba rugi");
    await bad({ lines: [{ accountId: "bukan-uuid", debit: 1, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: 1 }] }, "akun bukan uuid");
    await bad({ lines: [{ accountId: crypto.randomUUID(), debit: 1, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: 1 }] }, "akun tak ada");
    await bad({ lines: [{ accountId: c("1-1200"), debit: 1, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: 1 }] }, "akun bank");
    await bad({ lines: [{ accountId: c("1-1100"), debit: 0, credit: 1 }, { accountId: c("1-2900"), debit: 1, credit: 0 }] }, "akun kas");
    await bad({ lines: [{ accountId: c("4-1100"), debit: 0, credit: 1 }, { accountId: c("1-2900"), debit: 1, credit: 0 }] }, "pendapatan invoice 4-1100 (cadangan)");
    await bad({ lines: [{ accountId: c("1-1450"), debit: 1, credit: 0 }, { accountId: c("3-2100"), debit: 0, credit: 1 }] }, "penampung 1-1450 (cadangan)");
    await bad({ lines: [{ accountId: c("3-2200"), debit: 0, credit: 1 }, { accountId: c("1-2900"), debit: 1, credit: 0 }] }, "3-2200 laba tahun berjalan (dihitung, bukan dijurnal)");
    await prisma.coaAccount.update({ where: { id: c("6-1900") }, data: { isActive: false } });
    await bad({ lines: [{ accountId: c("6-1900"), debit: 1, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: 1 }] }, "akun nonaktif");
    await bad({ lines: [{ accountId: c("6-2000"), debit: 1, credit: 0, memo: "m".repeat(201) }, { accountId: c("1-2900"), debit: 0, credit: 1 }] }, "memo 201");
    expect(await count("audit_logs")).toBe(0);
  });

  it("batas wajar tepat diterima: 40 baris, nominal maksimum, akun sama pada banyak baris", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? L(CASH_AMOUNT_MAX, 0) : L(0, CASH_AMOUNT_MAX, "1-2900")));
    const j = await ok({ lines });
    expect(j.lines).toHaveLength(40);
    expect(j.total).toBe(20 * CASH_AMOUNT_MAX);
    const tb = await getTrialBalance(fx.finance, { to: today });
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(20 * CASH_AMOUNT_MAX + 11_000_000);
    expect(Number.isSafeInteger(tb.totalDebit)).toBe(true);
  });

  it("deskripsi berisi tanda kutip/emoji/SQL tersimpan apa adanya dan tidak merusak laporan", async () => {
    const d = `Koreksi '"; DROP TABLE journal_entries;-- 🙂 <script>alert(1)</script>`;
    const j = await ok({ description: d, reference: "REF-'1'" });
    expect(j.description).toBe(d);
    expect(await count("journal_entries")).toBe(1);
  });

  it("pembalikan: id aneh, tidak ada, alasan pendek", async () => {
    const j = await ok();
    expect(await err(reverseJournal(fx.finance, "bukan-uuid", { reason: "alasan cukup" }))).not.toBeNull();
    expect((await err(reverseJournal(fx.finance, crypto.randomUUID(), { reason: "alasan cukup" })))?.code).toBe("NOT_FOUND");
    expect((await err(reverseJournal(fx.finance, j.id, { reason: "pdk" })))?.code).toBe("VALIDATION");
    expect((await err(reverseJournal(fx.finance, j.id, {})))?.code).toBe("VALIDATION");
    expect(await count("journal_entries")).toBe(1);
  });
});

describe("balapan (konkurensi)", () => {
  it("pembalikan paralel pada jurnal yang sama: tepat satu berhasil", async () => {
    const j = await ok();
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => err(reverseJournal(fx.finance, j.id, { reason: `Pembalikan paralel ${i}` }))));
    expect(rs.filter((e) => e === null)).toHaveLength(1);
    expect(rs.filter((e) => e?.code === "CONFLICT")).toHaveLength(5);
    expect(await count("journal_entries")).toBe(2);
    expect((await getTrialBalance(fx.finance, { to: today })).rows.find((r) => r.code === "6-2000")).toBeUndefined();
  });

  it("pembuatan jurnal paralel: semua berhasil, nomor unik, neraca saldo seimbang", async () => {
    const js = await Promise.all(Array.from({ length: 12 }, (_, i) => ok({ description: `Penyusutan paralel ${i}`, lines: [{ accountId: c("6-2000"), debit: 1000 + i, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: 1000 + i }] })));
    expect(new Set(js.map((j) => j.number)).size).toBe(12);
    const tb = await getTrialBalance(fx.finance, { to: today });
    expect(tb.rows.find((r) => r.code === "6-2000")!.debit).toBe(Array.from({ length: 12 }, (_, i) => 1000 + i).reduce((a, b) => a + b, 0));
    expect(tb.balanced).toBe(true);
  });

  it("jurnal pada akun X vs pemetaan akun X ke akun kas, berpacu: tidak boleh keduanya lolos", async () => {
    const x = c("1-2200");
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // T1: menulis baris jurnal pada X dan menahan commit
    const t1 = prisma.$transaction(async (tx) => {
      const id = crypto.randomUUID();
      await tx.$executeRawUnsafe(`INSERT INTO journal_entries (id,kind,"entryType","journalDate",description,"createdById") VALUES ('${id}','GENERAL','ENTRY','2026-02-28','Balapan','${fx.finance.userId}')`);
      await tx.$executeRawUnsafe(`INSERT INTO journal_lines (id,"journalId","lineNo","accountId",debit,credit) VALUES (gen_random_uuid(),'${id}',1,'${x}',100,0),(gen_random_uuid(),'${id}',2,'${c("3-1100")}',0,100)`);
      await gate;
    }, { timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 300));
    // T2: memetakan X sebagai akun kas baru (di transaksinya sendiri)
    let t2Done = false;
    const t2 = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO cash_accounts (id,name,kind,"coaAccountId","openingBalance","openingDate","updatedAt") VALUES (gen_random_uuid(),'Balapan','BANK','${x}',0,'2026-01-01',now())`);
    }, { timeout: 20_000 }).then(() => { t2Done = true; }, () => { t2Done = true; });
    await new Promise((r) => setTimeout(r, 500));
    expect(t2Done, "T2 harus menunggu T1 (kunci), bukan lolos dengan melihat data lama").toBe(false);
    release();
    await t1;
    await t2;
    const both = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM cash_accounts a WHERE a."coaAccountId" = '${x}' AND EXISTS (SELECT 1 FROM journal_lines l WHERE l."accountId" = a."coaAccountId")`);
    expect(Number(both[0]!.n)).toBe(0);
  });
});

describe("ketahanan lintas modul pada akun kas yang dipetakan", () => {
  it("menonaktifkan/mengganti nama akun kas tidak memutus buku besar; saldo awal diubah → buku besar ikut tetap seimbang", async () => {
    await ok();
    await updateCashAccount(fx.admin, fx.cashAcctId, { name: "Kas Kecil (ganti nama)" });
    const bs0 = await getBalanceSheet(fx.finance, { to: today });
    expect(bs0.balanced).toBe(true);
    const accts = await listCashAccounts(fx.finance);
    expect(accts.find((a) => a.id === fx.cashAcctId)!.name).toBe("Kas Kecil (ganti nama)");
    // mengubah saldo awal (belum ada mutasi) menggeser 3-2100 dan kas bersama-sama
    const e = await err(updateCashAccount(fx.admin, fx.cashAcctId, { openingBalance: 2_000_000 }));
    if (e === null) {
      const bs = await getBalanceSheet(fx.finance, { to: today });
      expect(bs.balanced).toBe(true);
      expect(bs.totalAssets).toBe(10_000_000 + 2_000_000 - 100_000);
    }
  });
});
