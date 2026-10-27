import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, makeProof, type Fixtures } from "../helpers/db";
import { createDraft, issueInvoice } from "@/server/services/invoices";
import { recordPayment, reversePayment } from "@/server/services/payments";
import { approveEntry, createEntry, createTransfer, reverseTransfer } from "@/server/services/cash-entries";
import { updateCashAccount } from "@/server/services/cash-accounts";
import { setBooksLock } from "@/server/services/books-lock";
import {
  autoMatchStatement, createEntryForLine, createStatement, deleteStatement, finalizeStatement, getReconOverview, getStatementWorkspace,
  listStatements, matchLine, reopenStatement, unmatchLine,
} from "@/server/services/bank-reconciliation";
import { todayIso } from "@/lib/format";
import { AppError } from "@/server/errors";

/**
 * REKONSILIASI BANK · PUTARAN 2 — ADVERSARIAL (SQL langsung, izin, balapan, kondisi tepi).
 */
const today = todayIso("Asia/Jakarta");
const YEAR = Number(today.slice(0, 4));
const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as AppError | null;
const sql = (q: string) => prisma.$executeRawUnsafe(q);
let fx: Fixtures;
const c = (code: string) => fx.coa[code]!;
const d = (m: number, day: number) => `${YEAR}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures({ finance: true, openingDate: d(1, 1) });
});
afterAll(async () => { await prisma.$disconnect(); });

const inv = async (date: string, qty = 7) => issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: date, paymentTermDays: 30, lines: [{ ...demiChefInput(fx).lines[0]!, quantity: qty }] }))).id);
type L = { txDate: string; description: string; amount: number; reference?: string | null };
const stmt = (lines: L[], over: Record<string, unknown> = {}) => {
  const sum = lines.reduce((s, l) => s + l.amount, 0);
  return createStatement(fx.finance, { cashAccountId: fx.bankAcctId, periodStart: d(1, 1), periodEnd: d(1, 31), openingBalance: 10_000_000, closingBalance: 10_000_000 + sum, lines, ...over });
};
const oneMatchedStatement = async () => {
  const i = await inv(d(1, 2));
  const p = await recordPayment(fx.finance, { invoiceId: i.id, paymentDate: d(1, 5), amount: 5_000_000, method: "Transfer" });
  const st = await stmt([{ txDate: d(1, 5), description: "TRF MASUK", amount: 5_000_000 }]);
  await autoMatchStatement(fx.finance, st.id);
  return { i, p, st };
};
const rawLine = (stId: string, o: { date?: string; amount?: number; desc?: string; no?: number }) =>
  sql(`INSERT INTO bank_statement_lines (id,"statementId","lineNo","txDate",description,amount) VALUES (gen_random_uuid(),'${stId}',${o.no ?? 99},'${o.date ?? d(1, 10)}','${o.desc ?? "raw"}',${o.amount ?? 100})`);
const rawMatch = (o: { st: string; line: string; acct?: string; type: string; id: string; amount: number }) =>
  sql(`INSERT INTO bank_matches (id,"statementId","lineId","cashAccountId","sourceType","sourceId",amount,method,"matchedById") VALUES (gen_random_uuid(),'${o.st}','${o.line}','${o.acct ?? fx.bankAcctId}','${o.type}','${o.id}',${o.amount},'MANUAL','${fx.finance.userId}')`);

describe("pagar database rekening koran (SQL langsung)", () => {
  it("rekening koran baru: tumpang tindih, sebelum saldo awal akun, masa depan, tak menyambung, status curang, periode terbalik ditolak", async () => {
    const first = await stmt([{ txDate: d(1, 5), description: "A", amount: 100 }], { closingBalance: 10_000_100 });
    const ins = (o: { start: string; end: string; open?: number; close?: number; status?: string }) => sql(`INSERT INTO bank_statements (id,"cashAccountId","periodStart","periodEnd","openingBalance","closingBalance",status,"createdById","finalizedAt","finalizedById")
      VALUES (gen_random_uuid(),'${fx.bankAcctId}','${o.start}','${o.end}',${o.open ?? 0},${o.close ?? 0},'${o.status ?? "DRAFT"}','${fx.finance.userId}',${o.status === "FINALIZED" ? `now(),'${fx.finance.userId}'` : "NULL,NULL"})`);
    await expect(ins({ start: d(1, 15), end: d(2, 15) })).rejects.toThrow(/tumpang tindih/);
    await expect(ins({ start: `${YEAR - 1}-12-01`, end: `${YEAR - 1}-12-31` })).rejects.toThrow(/mendahului tanggal saldo awal/);
    await expect(ins({ start: d(2, 1), end: "2999-01-01" })).rejects.toThrow(/masa depan/);
    await expect(ins({ start: d(2, 1), end: d(2, 28), open: 1 })).rejects.toThrow(/harus sama dengan saldo akhir/);
    await expect(ins({ start: d(2, 1), end: d(2, 28), open: 10_000_100, close: 10_000_100, status: "FINALIZED" })).rejects.toThrow(/harus berstatus DRAFT/);
    await expect(ins({ start: d(2, 28), end: d(2, 1), open: 10_000_100 })).rejects.toThrow(/bank_statements_values/);
    await ins({ start: d(2, 1), end: d(2, 28), open: 10_000_100, close: 10_000_100 }); // kontrol: yang sah lolos
    expect(first.id).toBeDefined();
  });

  it("baris mutasi: di luar periode, nol, uraian kosong, ditambah/dihapus/diubah setelah final — semua ditolak", async () => {
    const { st } = await oneMatchedStatement();
    await expect(rawLine(st.id, { date: d(2, 1) })).rejects.toThrow(/di luar periode/);
    await expect(rawLine(st.id, { amount: 0 })).rejects.toThrow(/bank_statement_lines_values/);
    await expect(rawLine(st.id, { desc: "  " })).rejects.toThrow(/bank_statement_lines_values/);
    await expect(sql(`UPDATE bank_statement_lines SET amount = 1 WHERE "statementId" = '${st.id}'`)).rejects.toThrow(/tidak dapat diubah/);
    await finalizeStatement(fx.finance, st.id);
    await expect(rawLine(st.id, {})).rejects.toThrow(/sudah difinalisasi/);
    await expect(sql(`DELETE FROM bank_statement_lines WHERE "statementId" = '${st.id}'`)).rejects.toThrow(/sudah difinalisasi/);
    expect(await prisma.bankStatementLine.count()).toBe(1);
  });

  it("pencocokan: nilai salah, akun lain, entri belum disetujui, setelah akhir periode, ganda, baris milik statement lain, pada statement final — ditolak", async () => {
    const i = await inv(d(1, 2));
    const pay = await recordPayment(fx.finance, { invoiceId: i.id, paymentDate: d(1, 5), amount: 5_000_000, method: "Transfer" });
    const late = await recordPayment(fx.finance, { invoiceId: i.id, paymentDate: d(2, 5), amount: 1_000_000, method: "Transfer" });
    const kasPay = await recordPayment(fx.finance, { invoiceId: i.id, paymentDate: d(1, 6), amount: 1_000_000, method: "Tunai" }); // akun Kas Kecil
    const pending = await createEntry(fx.staff, { entryDate: d(1, 7), cashAccountId: fx.bankAcctId, counterAccountId: c("6-1600"), amount: 50_000, description: "ATK staf menunggu" });
    const st = await stmt([{ txDate: d(1, 5), description: "TRF", amount: 5_000_000 }, { txDate: d(1, 7), description: "ATK", amount: -50_000 }]);
    const [l1, l2] = (await getStatementWorkspace(fx.finance, st.id)).lines;
    const m = (o: Partial<Parameters<typeof rawMatch>[0]> & { type: string; id: string; amount: number }) => rawMatch({ st: st.id, line: l1!.id, ...o });
    await expect(m({ type: "PAYMENT", id: pay.id, amount: 4_999_999 })).rejects.toThrow(/sama persis/);
    await expect(m({ type: "PAYMENT", id: kasPay.id, amount: 1_000_000 })).rejects.toThrow(/tidak ditemukan pada akun ini/);
    await expect(m({ type: "PAYMENT", id: late.id, amount: 1_000_000 })).rejects.toThrow(/setelah akhir periode/);
    await expect(m({ type: "CASH_ENTRY", id: pending.id, amount: -50_000, line: l2!.id })).rejects.toThrow(/sudah disetujui/);
    await expect(m({ type: "PAYMENT", id: crypto.randomUUID(), amount: 1 })).rejects.toThrow();
    await expect(m({ type: "TRANSFER", id: crypto.randomUUID(), amount: 1 })).rejects.toThrow(/Transfer tidak ditemukan/);
    await expect(m({ type: "PAYMENT", id: pay.id, amount: 5_000_000, acct: fx.cashAcctId })).rejects.toThrow(/sama dengan akun rekening koran/);
    await expect(m({ type: "PAYMENT", id: pay.id, amount: 0 })).rejects.toThrow(/bank_matches_values|sama persis/);
    await m({ type: "PAYMENT", id: pay.id, amount: 5_000_000 }); // sah
    await expect(m({ type: "PAYMENT", id: pay.id, amount: 5_000_000, line: l2!.id })).rejects.toThrow(/already exists|23505/); // transaksi hanya sekali
    // baris dari rekening koran lain
    const other = await createStatement(fx.finance, { cashAccountId: fx.cashAcctId, periodStart: d(1, 1), periodEnd: d(1, 31), openingBalance: 1_000_000, closingBalance: 2_000_000, lines: [{ txDate: d(1, 6), description: "SETOR", amount: 1_000_000 }] });
    const ol = (await getStatementWorkspace(fx.finance, other.id)).lines[0]!;
    await expect(m({ type: "PAYMENT", id: kasPay.id, amount: 1_000_000, line: ol.id })).rejects.toThrow(/bukan milik rekening koran ini/);
    // UPDATE/DELETE pencocokan
    await expect(sql(`UPDATE bank_matches SET amount = 1 WHERE "statementId" = '${st.id}'`)).rejects.toThrow(/tidak dapat diubah/);
    // setelah final
    await approveEntry(fx.finance, pending.id);
    await matchLine(fx.finance, l2!.id, { items: [{ type: "CASH_ENTRY", id: pending.id }] });
    await finalizeStatement(fx.finance, st.id).catch(() => null);
    const fin = await prisma.bankStatement.findUniqueOrThrow({ where: { id: st.id } });
    if (fin.status === "FINALIZED") {
      await expect(sql(`DELETE FROM bank_matches WHERE "statementId" = '${st.id}'`)).rejects.toThrow(/sudah difinalisasi/);
    }
  });

  it("finalisasi lewat SQL: baris belum cocok, mutasi ≠ saldo, ubah isi sambil final, hapus/ubah setelah final, buka kembali tanpa alasan — ditolak", async () => {
    const { st } = await oneMatchedStatement();
    // statement lain dengan baris belum cocok
    const open = await createStatement(fx.finance, { cashAccountId: fx.cashAcctId, periodStart: d(1, 1), periodEnd: d(1, 31), openingBalance: 1_000_000, closingBalance: 1_100_000, lines: [{ txDate: d(1, 6), description: "BELUM", amount: 100_000 }] });
    await expect(sql(`UPDATE bank_statements SET status='FINALIZED', "finalizedAt"=now(), "finalizedById"='${fx.finance.userId}' WHERE id='${open.id}'`)).rejects.toThrow(/belum dicocokkan penuh/);
    // mutasi ≠ saldo (statement mentah dengan baris tak sesuai)
    const bad = crypto.randomUUID();
    await sql(`INSERT INTO bank_statements (id,"cashAccountId","periodStart","periodEnd","openingBalance","closingBalance","createdById") VALUES ('${bad}','${fx.cashAcctId}','${d(2, 1)}','${d(2, 28)}',1100000,5000000,'${fx.finance.userId}')`);
    await expect(sql(`UPDATE bank_statements SET status='FINALIZED', "finalizedAt"=now(), "finalizedById"='${fx.finance.userId}' WHERE id='${bad}'`)).rejects.toThrow(/Mutasi .* tidak sama/);
    // ubah isi sambil final
    await expect(sql(`UPDATE bank_statements SET status='FINALIZED', "finalizedAt"=now(), "finalizedById"='${fx.finance.userId}', "closingBalance"=999 WHERE id='${st.id}'`)).rejects.toThrow(/Finalisasi tidak boleh/);
    await expect(sql(`UPDATE bank_statements SET status='FINALIZED' WHERE id='${st.id}'`)).rejects.toThrow(/bank_statements_values/); // tanpa penyetuju
    await finalizeStatement(fx.finance, st.id);
    await expect(sql(`UPDATE bank_statements SET label='x' WHERE id='${st.id}'`)).rejects.toThrow(/tidak dapat diubah/);
    await expect(sql(`DELETE FROM bank_statements WHERE id='${st.id}'`)).rejects.toThrow(/tidak dapat dihapus/);
    await expect(sql(`UPDATE bank_statements SET "periodEnd"='${d(1, 30)}' WHERE id='${open.id}'`)).rejects.toThrow(/tidak dapat diubah/);
    await expect(sql(`UPDATE bank_statements SET status='DRAFT', "finalizedAt"=NULL, "finalizedById"=NULL WHERE id='${st.id}'`)).rejects.toThrow(/tidak dapat diubah/); // tanpa alasan
    await expect(sql(`UPDATE bank_statements SET status='DRAFT', "finalizedAt"=NULL, "finalizedById"=NULL, "reopenReason"='ok?' WHERE id='${st.id}'`)).rejects.toThrow(); // alasan < 5
    await sql(`UPDATE bank_statements SET status='DRAFT', "finalizedAt"=NULL, "finalizedById"=NULL, "reopenReason"='Salah cocok' WHERE id='${st.id}'`); // sah
  });

  it("akun kas: tanggal saldo awal terkunci setelah ada rekening koran; saldo awal terkunci setelah final", async () => {
    // akun Kas Kecil belum punya mutasi → satu-satunya penghalang adalah rekening koran
    await createStatement(fx.finance, { cashAccountId: fx.cashAcctId, periodStart: d(1, 1), periodEnd: d(1, 31), openingBalance: 1_000_000, closingBalance: 1_000_000, lines: [] });
    await expect(sql(`UPDATE cash_accounts SET "openingDate"='${d(1, 2)}' WHERE id='${fx.cashAcctId}'`)).rejects.toThrow(/sudah memiliki rekening koran/);
    const { st } = await oneMatchedStatement();
    await finalizeStatement(fx.finance, st.id);
    await expect(sql(`UPDATE cash_accounts SET "openingBalance"=1 WHERE id='${fx.bankAcctId}'`)).rejects.toThrow(/sudah difinalisasi/);
    expect(await err(updateCashAccount(fx.admin, fx.bankAcctId, { name: "Bank Mandiri (ganti nama)" }))).toBeNull(); // perubahan lain tetap boleh
  });
});

describe("izin & balapan", () => {
  it("staff tidak dapat melihat maupun bertindak; finance & admin dapat", async () => {
    const { st } = await oneMatchedStatement();
    const line = (await getStatementWorkspace(fx.finance, st.id)).lines[0]!;
    for (const f of [() => listStatements(fx.staff), () => getStatementWorkspace(fx.staff, st.id), () => getReconOverview(fx.staff)]) expect((await err(f()))?.code).toBe("FORBIDDEN");
    for (const f of [
      (a: typeof fx.staff) => createStatement(a, {}), (a: typeof fx.staff) => autoMatchStatement(a, st.id), (a: typeof fx.staff) => unmatchLine(a, line.id),
      (a: typeof fx.staff) => matchLine(a, line.id, { items: [] }), (a: typeof fx.staff) => finalizeStatement(a, st.id), (a: typeof fx.staff) => deleteStatement(a, st.id),
      (a: typeof fx.staff) => reopenStatement(a, st.id, { reason: "coba-coba" }), (a: typeof fx.staff) => createEntryForLine(a, line.id, { counterAccountId: c("6-1800") }),
    ]) expect((await err(f(fx.staff)))?.code).toBe("FORBIDDEN");
    expect((await getReconOverview(fx.admin)).length).toBe(2);
    expect(await err(finalizeStatement(fx.admin, st.id))).toBeNull();
  });

  it("finalisasi paralel ×4: tepat satu berhasil; pencocokan otomatis paralel ×3: tidak ada pencocokan ganda", async () => {
    const i = await inv(d(1, 2));
    await recordPayment(fx.finance, { invoiceId: i.id, paymentDate: d(1, 5), amount: 5_000_000, method: "Transfer" });
    await recordPayment(fx.finance, { invoiceId: i.id, paymentDate: d(1, 9), amount: 3_000_000, method: "Transfer" });
    const st = await stmt([{ txDate: d(1, 5), description: "A", amount: 5_000_000 }, { txDate: d(1, 9), description: "B", amount: 3_000_000 }]);
    const autos = await Promise.all([1, 2, 3].map(() => autoMatchStatement(fx.finance, st.id)));
    expect(autos.reduce((s, a) => s + a.matched, 0)).toBe(2);
    expect(await prisma.bankMatch.count()).toBe(2);
    const fins = await Promise.all([1, 2, 3, 4].map(() => err(finalizeStatement(fx.finance, st.id))));
    expect(fins.filter((e) => e === null)).toHaveLength(1);
    expect(fins.filter((e) => e?.code === "CONFLICT")).toHaveLength(3);
  });

  it("dua baris berebut satu transaksi lewat pencocokan manual paralel: satu menang, tidak ada pencocokan ganda", async () => {
    const i = await inv(d(1, 2));
    const p = await recordPayment(fx.finance, { invoiceId: i.id, paymentDate: d(1, 5), amount: 700_000, method: "Transfer" });
    const st = await stmt([{ txDate: d(1, 5), description: "X", amount: 700_000 }, { txDate: d(1, 6), description: "Y", amount: 700_000 }]);
    const [a, b] = (await getStatementWorkspace(fx.finance, st.id)).lines;
    const rs = await Promise.all([a!, b!].map((l) => err(matchLine(fx.finance, l.id, { items: [{ type: "PAYMENT", id: p.id }] }))));
    expect(rs.filter((e) => e === null)).toHaveLength(1);
    expect(rs.filter((e) => e?.code === "CONFLICT")).toHaveLength(1);
    expect(await prisma.bankMatch.count()).toBe(1);
  });
});

describe("catat entri dari mutasi & kondisi tepi buku", () => {
  it("validasi gagal tidak meninggalkan entri setengah jadi; arah mengikuti tanda; bukti wajib di atas Rp1 juta; periode tertutup menolak", async () => {
    const st = await stmt([
      { txDate: d(1, 10), description: "BIAYA ADM", amount: -15_000 }, { txDate: d(1, 11), description: "BUNGA", amount: 25_000 },
      { txDate: d(1, 12), description: "BAYAR VENDOR BESAR", amount: -1_500_000 },
    ]);
    const [fee, interest, big] = (await getStatementWorkspace(fx.finance, st.id)).lines;
    // pendapatan tidak boleh untuk uang keluar; beban tidak boleh untuk uang masuk; akun kas tidak boleh jadi lawan
    expect((await err(createEntryForLine(fx.finance, fee!.id, { counterAccountId: c("4-2200") })))?.code).toBe("VALIDATION");
    expect((await err(createEntryForLine(fx.finance, interest!.id, { counterAccountId: c("6-1800") })))?.code).toBe("VALIDATION");
    expect((await err(createEntryForLine(fx.finance, fee!.id, { counterAccountId: c("1-1100") })))?.code).toBe("VALIDATION");
    expect((await err(createEntryForLine(fx.finance, big!.id, { counterAccountId: c("5-1100") })))?.code).toBe("VALIDATION"); // > Rp1 juta wajib bukti
    expect(await prisma.cashEntry.count()).toBe(0);
    await createEntryForLine(fx.finance, big!.id, { counterAccountId: c("5-1100"), description: "Honor instruktur", proofFileId: await makeProof(fx.finance) });
    await createEntryForLine(fx.finance, fee!.id, { counterAccountId: c("6-1800") });
    expect((await err(createEntryForLine(fx.finance, fee!.id, { counterAccountId: c("6-1800") })))?.code).toBe("CONFLICT"); // sudah cocok
    const entries = await prisma.cashEntry.findMany({ orderBy: { amount: "asc" } });
    expect(entries.map((e) => [e.direction, Number(e.amount), e.entryDate.toISOString().slice(0, 10)])).toEqual([["OUT", 15_000, d(1, 10)], ["OUT", 1_500_000, d(1, 12)]]);
    // periode tertutup: pencatatan dari mutasi ditolak tanpa sisa
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    await setBooksLock(fx.finance, { lockedThrough: yesterday, reason: "Tutup untuk uji" });
    expect((await err(createEntryForLine(fx.finance, interest!.id, { counterAccountId: c("4-2200") })))?.code).toBe("VALIDATION");
    expect(await prisma.cashEntry.count()).toBe(2);
  });

  it("pembalikan pembayaran & transfer menjadi transaksi buku bernilai kebalikan yang dapat dicocokkan; pengeluaran staf baru muncul setelah disetujui", async () => {
    const i = await inv(d(1, 2));
    const p = await recordPayment(fx.finance, { invoiceId: i.id, paymentDate: d(1, 5), amount: 2_000_000, method: "Transfer" });
    await reversePayment(fx.finance, p.id, { reason: "Dana dikembalikan" }); // dibukukan HARI INI
    const tr = await createTransfer(fx.finance, { transferDate: d(1, 6), fromAccountId: fx.bankAcctId, toAccountId: fx.cashAcctId, amount: 300_000 });
    await reverseTransfer(fx.finance, tr.id, { reason: "Salah akun" });
    const pend = await createEntry(fx.staff, { entryDate: d(1, 7), cashAccountId: fx.bankAcctId, counterAccountId: c("6-1600"), amount: 80_000, description: "ATK staf" });
    const st = await createStatement(fx.finance, { cashAccountId: fx.bankAcctId, periodStart: d(1, 1), periodEnd: today, openingBalance: 10_000_000, closingBalance: 10_000_000, lines: [
      { txDate: d(1, 5), description: "MASUK", amount: 2_000_000 }, { txDate: today, description: "KELUAR PENGEMBALIAN", amount: -2_000_000 },
      { txDate: d(1, 6), description: "KE KAS", amount: -300_000 }, { txDate: today, description: "DARI KAS", amount: 300_000 },
    ] });
    const ws0 = await getStatementWorkspace(fx.finance, st.id);
    expect(ws0.outstanding.map((o) => o.id)).not.toContain(pend.id); // masih menunggu → bukan transaksi buku
    expect((await autoMatchStatement(fx.finance, st.id, { windowDays: 14 })).matched).toBe(4);
    expect((await getStatementWorkspace(fx.finance, st.id)).summary).toMatchObject({ difference: 0, canFinalize: true });
    await approveEntry(fx.finance, pend.id);
    const ws1 = await getStatementWorkspace(fx.finance, st.id);
    expect(ws1.outstanding.map((o) => o.id)).toContain(pend.id); // sekarang beredar (belum ada di bank)
    expect(ws1.summary).toMatchObject({ difference: 0, outstandingNet: -80_000, canFinalize: true });
  });
});
