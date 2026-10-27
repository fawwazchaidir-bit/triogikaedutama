import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, type Fixtures } from "../helpers/db";
import { createDraft, issueInvoice } from "@/server/services/invoices";
import { recordPayment } from "@/server/services/payments";
import { createEntry, createTransfer } from "@/server/services/cash-entries";
import { accountBalance } from "@/lib/accounting/statements";
import { loadStmtData } from "@/server/services/finance-data";
import {
  autoMatchStatement, createEntryForLine, createStatement, deleteStatement, finalizeStatement, getReconOverview, getStatementWorkspace,
  listStatements, matchLine, previewStatementCsv, reopenStatement, unmatchLine,
} from "@/server/services/bank-reconciliation";
import { todayIso } from "@/lib/format";
import { AppError } from "@/server/errors";

/**
 * REKONSILIASI BANK · PUTARAN 1 — SKENARIO HITUNG-TANGAN (Januari + Februari).
 */
const today = todayIso("Asia/Jakarta");
const YEAR = Number(today.slice(0, 4));
const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as AppError | null;
let fx: Fixtures;
const c = (code: string) => fx.coa[code]!;
const d = (m: number, day: number) => `${YEAR}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures({ finance: true, openingDate: d(1, 1) });
});
afterAll(async () => { await prisma.$disconnect(); });

const inv = async (date: string, qty = 7) => issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: date, paymentTermDays: 30, lines: [{ ...demiChefInput(fx).lines[0]!, quantity: qty }] }))).id);

/** Buku Januari pada Bank Mandiri (saldo awal 10.000.000): lihat komentar untuk saldo akhir 17.850.000. */
async function januaryBooks() {
  const a = await inv(d(1, 2)); // 14jt
  const pA = await recordPayment(fx.finance, { invoiceId: a.id, paymentDate: d(1, 5), amount: 5_000_000, method: "Transfer", reference: "TRF-A" });
  const pB = await recordPayment(fx.finance, { invoiceId: a.id, paymentDate: d(1, 12), amount: 3_000_000, method: "Transfer" });
  const eListrik = await createEntry(fx.finance, { entryDate: d(1, 10), cashAccountId: fx.bankAcctId, counterAccountId: c("6-1300"), amount: 400_000, description: "Listrik Januari" });
  const tr = await createTransfer(fx.finance, { transferDate: d(1, 20), fromAccountId: fx.bankAcctId, toAccountId: fx.cashAcctId, amount: 500_000 });
  const eAtk = await createEntry(fx.finance, { entryDate: d(1, 30), cashAccountId: fx.bankAcctId, counterAccountId: c("6-1600"), amount: 250_000, description: "ATK cek beredar" });
  const pC = await recordPayment(fx.finance, { invoiceId: a.id, paymentDate: d(1, 31), amount: 1_000_000, method: "Transfer" });
  return { a, pA, pB, eListrik, tr, eAtk, pC };
}
const csvJan = (invNo: string) => `Tanggal;Keterangan;Referensi;Debet;Kredit
06/01/${YEAR};TRF MASUK PT Bima INV ${invNo};TRF-A;;5.000.000
13/01/${YEAR};SETORAN;;;3.000.000
10/01/${YEAR};PLN BAYAR TAGIHAN;;400.000;
21/01/${YEAR};TRANSFER KE KAS;;500.000;
31/01/${YEAR};BIAYA ADM;;15.000;
31/01/${YEAR};BUNGA TABUNGAN;;;25.000
`;

describe("Januari: dari impor CSV sampai difinalisasi", () => {
  it("pratinjau, impor, pencocokan otomatis, catat biaya & bunga dari mutasi, selisih 0, finalisasi", async () => {
    const b = await januaryBooks();
    const bookNow = accountBalance((await loadStmtData(d(1, 31))).accounts.find((x) => x.id === fx.bankAcctId)!, await loadStmtData(d(1, 31)), d(1, 31));
    expect(bookNow).toBe(17_850_000);

    const pv = await previewStatementCsv(fx.finance, { text: csvJan(b.a.number!) });
    expect(pv).toMatchObject({ delimiter: ";", lineCount: 6, sum: 7_110_000, errors: [], firstDate: d(1, 6), lastDate: d(1, 31) });
    expect(pv.mapping).toMatchObject({ hasHeader: true, debit: 3, credit: 4 });

    const st = await createStatement(fx.finance, { cashAccountId: fx.bankAcctId, periodStart: d(1, 1), periodEnd: d(1, 31), openingBalance: 10_000_000, closingBalance: 17_110_000, label: "Mandiri Jan", csv: { text: csvJan(b.a.number!) } });
    expect(st).toMatchObject({ status: "DRAFT", lineCount: 6, unmatchedLines: 6 });

    const auto = await autoMatchStatement(fx.finance, st.id);
    expect(auto.matched).toBe(4); // A, B, listrik, transfer; biaya & bunga tidak ada di buku
    let ws = await getStatementWorkspace(fx.finance, st.id);
    expect(ws.outstanding.map((i) => [i.label.split(" ")[0], i.amount]).sort()).toEqual([["ATK", -250_000], ["Pembayaran", 1_000_000]].sort());
    expect(ws.summary).toMatchObject({ closing: 17_110_000, outstandingNet: 750_000, adjustedBank: 17_860_000, bookBalance: 17_850_000, difference: 10_000, unmatchedLines: 2, canFinalize: false });
    expect((await err(finalizeStatement(fx.finance, st.id)))?.code).toBe("CONFLICT");

    // biaya admin & bunga belum ada di buku → catat dari mutasi
    const fee = ws.lines.find((l) => l.description === "BIAYA ADM")!, interest = ws.lines.find((l) => l.description === "BUNGA TABUNGAN")!;
    await createEntryForLine(fx.finance, fee.id, { counterAccountId: c("6-1800") });
    await createEntryForLine(fx.finance, interest.id, { counterAccountId: c("4-2200") });
    ws = await getStatementWorkspace(fx.finance, st.id);
    expect(ws.summary).toMatchObject({ bookBalance: 17_860_000, difference: 0, unmatchedLines: 0, canFinalize: true, problems: [] });
    const feeEntry = await prisma.cashEntry.findFirstOrThrow({ where: { amount: 15_000n } });
    expect([feeEntry.direction, feeEntry.status, feeEntry.entryDate.toISOString().slice(0, 10)]).toEqual(["OUT", "APPROVED", d(1, 31)]);

    const fin = await finalizeStatement(fx.finance, st.id);
    expect(fin.statement.status).toBe("FINALIZED");
    expect(fin.statement.finalizedByName).toBe("Finance Uji");
    // setelah final: tidak ada perubahan apa pun
    expect((await err(unmatchLine(fx.finance, ws.lines[0]!.id)))?.code).toBe("CONFLICT");
    expect((await err(autoMatchStatement(fx.finance, st.id)))?.code).toBe("CONFLICT");
    expect((await err(deleteStatement(fx.finance, st.id)))?.code).toBe("CONFLICT");
    expect((await err(finalizeStatement(fx.finance, st.id)))?.code).toBe("CONFLICT");
    // audit
    const actions = (await prisma.auditLog.findMany({ where: { action: { startsWith: "bank." } }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(["bank.statement_create", "bank.auto_match", "bank.match", "bank.match", "bank.finalize"]);
  });

  it("Februari: saldo awal harus menyambung; transaksi yang beredar di Januari dicocokkan di Februari; buka kembali hanya yang terakhir", async () => {
    const b = await januaryBooks();
    const jan = await createStatement(fx.finance, { cashAccountId: fx.bankAcctId, periodStart: d(1, 1), periodEnd: d(1, 31), openingBalance: 10_000_000, closingBalance: 17_110_000, csv: { text: csvJan(b.a.number!) } });
    await autoMatchStatement(fx.finance, jan.id);
    const wsJ = await getStatementWorkspace(fx.finance, jan.id);
    await createEntryForLine(fx.finance, wsJ.lines.find((l) => l.description === "BIAYA ADM")!.id, { counterAccountId: c("6-1800") });
    await createEntryForLine(fx.finance, wsJ.lines.find((l) => l.description === "BUNGA TABUNGAN")!.id, { counterAccountId: c("4-2200") });
    await finalizeStatement(fx.finance, jan.id);

    const febLines = [{ txDate: d(2, 1), description: "SETORAN TUNAI", amount: 1_000_000 }, { txDate: d(2, 2), description: "CLEARING CEK", amount: -250_000 }];
    const base = { cashAccountId: fx.bankAcctId, periodStart: d(2, 1), periodEnd: d(2, 28), lines: febLines };
    expect((await err(createStatement(fx.finance, { ...base, openingBalance: 17_000_000, closingBalance: 17_750_000 })))?.code).toBe("VALIDATION"); // tidak menyambung
    expect((await err(createStatement(fx.finance, { ...base, openingBalance: 17_110_000, closingBalance: 17_000_000 })))?.message).toMatch(/Mutasi tidak cocok/);
    expect((await err(createStatement(fx.finance, { ...base, periodStart: d(1, 15), openingBalance: 17_110_000, closingBalance: 17_860_000 })))?.code).toBe("CONFLICT"); // tumpang tindih
    const feb = await createStatement(fx.finance, { ...base, openingBalance: 17_110_000, closingBalance: 17_860_000 });
    expect((await autoMatchStatement(fx.finance, feb.id)).matched).toBe(2); // pC (31 Jan) ↔ 1 Feb; eAtk (30 Jan) ↔ 2 Feb (selisih ≤ 5 hari)
    const wsF = await getStatementWorkspace(fx.finance, feb.id);
    expect(wsF.summary).toMatchObject({ bookBalance: 17_860_000, outstandingNet: 0, difference: 0, canFinalize: true });
    expect(b.pC.id).toBeDefined();
    await finalizeStatement(fx.finance, feb.id);

    expect((await err(reopenStatement(fx.finance, jan.id, { reason: "Salah cocok" })))?.code).toBe("CONFLICT"); // ada Februari yang final
    expect((await err(reopenStatement(fx.finance, feb.id, { reason: "x" })))?.code).toBe("VALIDATION");
    const re = await reopenStatement(fx.finance, feb.id, { reason: "Salah mencocokkan setoran" });
    expect(re.statement).toMatchObject({ status: "DRAFT", reopenReason: "Salah mencocokkan setoran" });
    await unmatchLine(fx.finance, re.lines[0]!.id);
    expect((await getStatementWorkspace(fx.finance, feb.id)).summary).toMatchObject({ unmatchedLines: 1, canFinalize: false });
    // Januari tetap utuh
    expect((await getStatementWorkspace(fx.finance, jan.id)).statement.status).toBe("FINALIZED");

    const ov = (await getReconOverview(fx.finance)).find((x) => x.accountId === fx.bankAcctId)!;
    expect(ov).toMatchObject({ lastFinalizedEnd: d(1, 31), lastClosing: 17_110_000, draftCount: 1, nextStart: d(3, 1), suggestedOpening: 17_860_000 });
    expect((await listStatements(fx.finance, { cashAccountId: fx.bankAcctId })).map((s) => s.status)).toEqual(["DRAFT", "FINALIZED"]);
  });
});

describe("pencocokan manual", () => {
  it("setoran gabungan: satu baris = beberapa pembayaran; jumlah harus persis; transaksi hanya sekali", async () => {
    const a = await inv(d(1, 2)), b = await inv(d(1, 3));
    const p1 = await recordPayment(fx.finance, { invoiceId: a.id, paymentDate: d(1, 5), amount: 4_000_000, method: "Transfer" });
    const p2 = await recordPayment(fx.finance, { invoiceId: b.id, paymentDate: d(1, 6), amount: 6_000_000, method: "Transfer" });
    const p3 = await recordPayment(fx.finance, { invoiceId: b.id, paymentDate: d(1, 7), amount: 1_000_000, method: "Transfer" });
    const st = await createStatement(fx.finance, { cashAccountId: fx.bankAcctId, periodStart: d(1, 1), periodEnd: d(1, 31), openingBalance: 10_000_000, closingBalance: 20_000_000, lines: [{ txDate: d(1, 8), description: "SETORAN KLIRING GABUNGAN", amount: 10_000_000 }] });
    const line = (await getStatementWorkspace(fx.finance, st.id)).lines[0]!;
    expect((await err(matchLine(fx.finance, line.id, { items: [{ type: "PAYMENT", id: p1.id }] })))?.code).toBe("VALIDATION"); // 4jt ≠ 10jt
    expect((await err(matchLine(fx.finance, line.id, { items: [{ type: "PAYMENT", id: p1.id }, { type: "PAYMENT", id: p1.id }] })))?.code).toBe("VALIDATION"); // ganda
    expect((await err(matchLine(fx.finance, line.id, { items: [{ type: "PAYMENT", id: crypto.randomUUID() }] })))?.code).toBe("CONFLICT");
    await matchLine(fx.finance, line.id, { items: [{ type: "PAYMENT", id: p1.id }, { type: "PAYMENT", id: p2.id }] });
    const ws = await getStatementWorkspace(fx.finance, st.id);
    expect(ws.lines[0]).toMatchObject({ matched: 10_000_000 });
    expect(ws.lines[0]!.matches).toHaveLength(2);
    expect(ws.outstanding.map((i) => i.id)).toEqual([p3.id]);
    expect((await err(matchLine(fx.finance, line.id, { items: [{ type: "PAYMENT", id: p3.id }] })))?.code).toBe("VALIDATION"); // sisa 0
    // lepas lalu cocokkan ulang
    await unmatchLine(fx.finance, line.id);
    expect((await err(unmatchLine(fx.finance, line.id)))?.code).toBe("CONFLICT");
    expect((await getStatementWorkspace(fx.finance, st.id)).outstanding).toHaveLength(3);
    // bank 20jt + p3 beredar 1jt = buku 21jt → selisih 0 selagi baris dicocokkan; setelah dilepas, tiga transaksi beredar (11jt) → selisih 10jt
    expect(ws.summary.difference).toBe(0);
    expect((await getStatementWorkspace(fx.finance, st.id)).summary.difference).toBe(10_000_000);
  });
});

describe("selisih yang tidak terlihat dari baris", () => {
  it("saldo awal bank salah (semua baris cocok tetapi selisih −1jt): tidak dapat difinalisasi; setelah rekening koran diperbaiki, bisa", async () => {
    const i = await inv(d(1, 2));
    await recordPayment(fx.finance, { invoiceId: i.id, paymentDate: d(1, 5), amount: 5_000_000, method: "Transfer" });
    const lines = [{ txDate: d(1, 5), description: "TRF MASUK", amount: 5_000_000 }];
    const bad = await createStatement(fx.finance, { cashAccountId: fx.bankAcctId, periodStart: d(1, 1), periodEnd: d(1, 31), openingBalance: 9_000_000, closingBalance: 14_000_000, lines });
    await autoMatchStatement(fx.finance, bad.id);
    const ws = await getStatementWorkspace(fx.finance, bad.id);
    expect(ws.summary).toMatchObject({ unmatchedLines: 0, difference: -1_000_000, canFinalize: false });
    expect(ws.summary.problems.join(" ")).toMatch(/Selisih rekonsiliasi/);
    const e = await err(finalizeStatement(fx.finance, bad.id));
    expect(e?.code).toBe("CONFLICT");
    expect(e?.message).toMatch(/Selisih rekonsiliasi/);
    await deleteStatement(fx.finance, bad.id);
    const good = await createStatement(fx.finance, { cashAccountId: fx.bankAcctId, periodStart: d(1, 1), periodEnd: d(1, 31), openingBalance: 10_000_000, closingBalance: 15_000_000, lines });
    await autoMatchStatement(fx.finance, good.id);
    expect((await finalizeStatement(fx.finance, good.id)).statement.status).toBe("FINALIZED");
  });
});

describe("pratinjau & impor: kesalahan umum", () => {
  it("mutasi tidak cocok saldo, tanggal di luar periode, baris rusak, akun/periode tidak sah", async () => {
    const base = { cashAccountId: fx.bankAcctId, periodStart: d(1, 1), periodEnd: d(1, 31), openingBalance: 10_000_000, closingBalance: 10_100_000 };
    const ok = [{ txDate: d(1, 5), description: "SETORAN", amount: 100_000 }];
    expect((await err(createStatement(fx.finance, { ...base, lines: [{ ...ok[0]!, txDate: d(2, 5) }] })))?.message).toMatch(/di luar periode/);
    expect((await err(createStatement(fx.finance, { ...base, closingBalance: 10_100_001, lines: ok })))?.message).toMatch(/selisih Rp\s?1\b/);
    expect((await err(createStatement(fx.finance, { ...base, csv: { text: "Tanggal;Keterangan;Debet;Kredit\n32/01/2026;X;;100.000" } })))?.message).toMatch(/Tanggal tidak valid/);
    expect((await err(createStatement(fx.finance, { ...base, lines: ok, csv: { text: "a" } })))?.code).toBe("VALIDATION"); // keduanya
    expect((await err(createStatement(fx.finance, base)))?.code).toBe("VALIDATION"); // tak ada isi
    expect((await err(createStatement(fx.finance, { ...base, lines: ok, cashAccountId: crypto.randomUUID() })))?.code).toBe("NOT_FOUND");
    expect((await err(createStatement(fx.finance, { ...base, lines: ok, periodStart: `${YEAR - 1}-12-01` })))?.code).toBe("VALIDATION"); // sebelum saldo awal akun
    expect((await err(createStatement(fx.finance, { ...base, lines: ok, periodEnd: "2999-01-01" })))?.code).toBe("VALIDATION");
    expect((await err(createStatement(fx.finance, { ...base, lines: ok, periodStart: d(2, 1), periodEnd: d(1, 1) })))?.code).toBe("VALIDATION");
    expect((await err(createStatement(fx.finance, { ...base, lines: [{ txDate: d(1, 5), description: "X", amount: 0 }] })))?.code).toBe("VALIDATION");
    expect((await err(previewStatementCsv(fx.finance, { text: "" })))?.code).toBe("VALIDATION");
    expect((await err(previewStatementCsv(fx.finance, { text: "x".repeat(1_000_001) })))?.code).toBe("VALIDATION");
    expect(await prisma.bankStatement.count()).toBe(0);
    const okSt = await createStatement(fx.finance, { ...base, lines: ok });
    expect(okSt.lineCount).toBe(1);
  });
});
