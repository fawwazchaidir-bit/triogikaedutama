import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, makeProof, type Fixtures } from "../helpers/db";
import { createDraft, issueInvoice } from "@/server/services/invoices";
import { recordPayment, reversePayment } from "@/server/services/payments";
import { createEntry } from "@/server/services/cash-entries";
import { createJournal } from "@/server/services/journals";
import { getBalanceSheet, getTrialBalance } from "@/server/services/finance-ledger";
import { getCorporateTax, getVatSummary, getWithholdingRegister, postCorporateTaxJournal, setWithholdingRef, updateTaxProfile } from "@/server/services/finance-tax";
import { setBooksLock } from "@/server/services/books-lock";
import { listCashAccounts } from "@/server/services/cash-accounts";
import { todayIso } from "@/lib/format";
import { AppError } from "@/server/errors";

/**
 * PAJAK · PUTARAN 3 — BALAPAN & KESALAHAN PENCATATAN PAJAK.
 */
const today = todayIso("Asia/Jakarta");
const YEAR = Number(today.slice(0, 4));
const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as AppError | null;
let fx: Fixtures;
const c = (code: string) => fx.coa[code]!;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures({ finance: true, openingDate: `${YEAR}-01-01` });
});
afterAll(async () => { await prisma.$disconnect(); });
const d = (m: number, day: number) => `${YEAR}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const inv = async (date: string, taxed = false, qty = 7, dp = 0) =>
  issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: date, paymentTermDays: 30, downPayment: dp, lines: [{ ...demiChefInput(fx).lines[0]!, quantity: qty, taxConfigId: taxed ? fx.ppnId : null }] }))).id);
const net = async () => Object.fromEntries((await getTrialBalance(fx.finance, { to: today })).rows.map((r) => [r.code, r.net]));
async function sound(label: string) {
  const tb = await getTrialBalance(fx.finance, { to: today });
  expect(tb.balanced, label).toBe(true);
  expect((await getBalanceSheet(fx.finance, { to: today })).balanced, label).toBe(true);
  const n = Object.fromEntries(tb.rows.map((r) => [r.code, r.net]));
  const accts = await listCashAccounts(fx.finance);
  expect(n["1-1200"] ?? 0, label).toBe(accts.find((a) => a.id === fx.bankAcctId)!.balance);
}

describe("balapan", () => {
  it("6 pembayaran paralel melunasi invoice ber-PPN: semua berhasil dan Σ PPN = PPN invoice persis", async () => {
    const i = await inv(d(1, 13), true);
    const rs = await Promise.all(Array.from({ length: 6 }, () => recordPayment(fx.finance, { invoiceId: i.id, paymentDate: d(2, 1), amount: 2_590_000, method: "Transfer" })));
    expect(rs.reduce((s, p) => s + p.vatAmount, 0)).toBe(1_540_000);
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: i.id } });
    expect(row.paymentStatus).toBe("PAID");
    expect((await net())["2-1210"]).toBe(-1_540_000);
    await sound("paralel");
  });

  it("pembayaran paralel yang melebihi sisa: yang berlebih ditolak, tidak ada PPN berlebih", async () => {
    const i = await inv(d(1, 13), true);
    const rs = await Promise.all(Array.from({ length: 5 }, () => err(recordPayment(fx.finance, { invoiceId: i.id, paymentDate: d(2, 1), amount: 4_000_000, withholdingAmount: 100_000, method: "Transfer" }))));
    expect(rs.filter((e) => e === null)).toHaveLength(3); // 3 × 4,1jt = 12,3jt; ke-4 (16,4jt) > 15,54jt
    const agg = await prisma.payment.aggregate({ where: { invoiceId: i.id }, _sum: { vatAmount: true, withholdingAmount: true, amount: true } });
    expect(Number(agg._sum.vatAmount)).toBeLessThanOrEqual(1_540_000);
    expect(Number(agg._sum.withholdingAmount)).toBe(300_000);
    await sound("lebih");
  });

  it("jurnal PPh badan dari 5 permintaan paralel: tepat satu berhasil (tidak dibukukan ganda)", async () => {
    await updateTaxProfile(fx.admin, { isPkp: true, regime: "GENERAL", rateBps: 2200 });
    const i = await inv(d(2, 1));
    await recordPayment(fx.finance, { invoiceId: i.id, paymentDate: d(2, 2), amount: 13_720_000, withholdingAmount: 280_000, method: "Transfer" });
    const rs = await Promise.all(Array.from({ length: 5 }, () => err(postCorporateTaxJournal(fx.finance, { year: YEAR }))));
    expect(rs.filter((e) => e === null)).toHaveLength(1);
    expect(rs.filter((e) => e?.code === "CONFLICT")).toHaveLength(4);
    const t = await getCorporateTax(fx.finance, { year: YEAR });
    expect(t.booked.taxExpense).toBe(t.estimate.taxDue);
    expect(t.suggestion).toBeNull();
    expect(await prisma.journalEntry.count()).toBe(1);
    await sound("pph paralel");
  });

  it("nomor bukti potong dari 4 permintaan paralel: tepat satu menang", async () => {
    const i = await inv(d(2, 1));
    const p = await recordPayment(fx.finance, { invoiceId: i.id, paymentDate: d(2, 2), amount: 13_720_000, withholdingAmount: 280_000, method: "Transfer" });
    const rs = await Promise.all(["BP-A", "BP-B", "BP-C", "BP-D"].map((ref) => err(setWithholdingRef(fx.finance, p.id, { ref }))));
    expect(rs.filter((e) => e === null)).toHaveLength(1);
    expect(rs.filter((e) => e?.code === "CONFLICT")).toHaveLength(3);
    expect((await getWithholdingRegister(fx.finance, { from: d(1, 1), to: today })).rows[0]!.ref).toMatch(/^BP-[A-D]$/);
  });
});

describe("kesalahan pencatatan pajak yang lazim", () => {
  it("lupa mencatat PPh yang dipotong: balikkan lalu catat ulang → kas, kredit pajak, dan register benar", async () => {
    const i = await inv(d(2, 1));
    const wrong = await recordPayment(fx.staff, { invoiceId: i.id, paymentDate: d(2, 5), amount: 14_000_000, method: "Transfer" }); // seharusnya neto 13,72jt + PPh 0,28jt
    // uang di rekening ternyata hanya 13,72jt
    await reversePayment(fx.finance, wrong.id, { reason: "Pelanggan memotong PPh 23, uang masuk neto" });
    await recordPayment(fx.staff, { invoiceId: i.id, paymentDate: d(2, 5), amount: 13_720_000, withholdingAmount: 280_000, withholdingRef: "BP-77", method: "Transfer" });
    const n = await net();
    expect(n["1-1200"]).toBe(10_000_000 + 13_720_000);
    expect(n["1-1400"]).toBe(280_000);
    expect(n["4-1100"]).toBe(-14_000_000);
    const reg = await getWithholdingRegister(fx.finance, { from: d(1, 1), to: today });
    expect(reg.net).toBe(280_000);
    await sound("lupa PPh");
  });

  it("PPh dicatat pada invoice yang salah: pembalikan memulihkan kedua invoice", async () => {
    const a = await inv(d(2, 1)), b = await inv(d(2, 2));
    const p = await recordPayment(fx.finance, { invoiceId: a.id, paymentDate: d(2, 5), amount: 13_720_000, withholdingAmount: 280_000, method: "Transfer" });
    await reversePayment(fx.finance, p.id, { reason: "Salah invoice" });
    await recordPayment(fx.finance, { invoiceId: b.id, paymentDate: d(2, 5), amount: 13_720_000, withholdingAmount: 280_000, method: "Transfer" });
    const ra = await prisma.invoice.findUniqueOrThrow({ where: { id: a.id } }), rb = await prisma.invoice.findUniqueOrThrow({ where: { id: b.id } });
    expect([ra.paymentStatus, Number(ra.paidAmount)]).toEqual(["UNPAID", 0]);
    expect([rb.paymentStatus, Number(rb.paidAmount)]).toEqual(["PAID", 14_000_000]);
    expect((await net())["1-1400"]).toBe(280_000);
    await sound("salah invoice");
  });

  it("DP pada invoice ber-PPN lalu dibalikkan: PPN, kas, dan pendapatan kembali nol", async () => {
    const i = await inv(d(2, 1), true, 7, 3_108_000);
    const dp = await prisma.payment.findFirstOrThrow({ where: { invoiceId: i.id, isDownPayment: true } });
    await reversePayment(fx.finance, dp.id, { reason: "DP dibatalkan" });
    const n = await net();
    expect(n["2-1210"] ?? 0).toBe(0);
    expect(n["4-1100"] ?? 0).toBe(0);
    expect(n["1-1200"]).toBe(10_000_000);
    await sound("DP dibalik");
  });

  it("periode yang sudah ditutup: rekap PPN bulan lalu tidak berubah oleh koreksi hari ini; backdate ditolak", async () => {
    const i = await inv(d(1, 13), true);
    const p = await recordPayment(fx.finance, { invoiceId: i.id, paymentDate: d(1, 20), amount: 15_540_000, method: "Transfer" });
    const before = await getVatSummary(fx.finance, { from: d(1, 1), to: d(1, 31) });
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    await setBooksLock(fx.finance, { lockedThrough: yesterday, reason: "Tutup untuk uji" });
    // invoice bertanggal di periode tertutup tidak dapat diterbitkan (akan mengubah rekap PPN menurut invoice bulan itu); pembayaran mundur juga ditolak
    const late = await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: d(1, 14), paymentTermDays: 30, lines: [{ ...demiChefInput(fx).lines[0]!, taxConfigId: fx.ppnId }] }));
    expect((await err(issueInvoice(fx.finance, late.id)))?.code).toBe("VALIDATION");
    await expect(prisma.$executeRawUnsafe(`UPDATE invoices SET "status" = 'ISSUED' WHERE id = '${late.id}'`)).rejects.toThrow();
    expect((await err(recordPayment(fx.finance, { invoiceId: i.id, paymentDate: d(1, 21), amount: 1000, method: "Transfer" })))?.code).toBe("VALIDATION");
    await reversePayment(fx.finance, p.id, { reason: "Koreksi setelah tutup" }); // dicatat hari ini
    const after = await getVatSummary(fx.finance, { from: d(1, 1), to: d(1, 31) });
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect((await getVatSummary(fx.finance, { from: d(1, 1), to: today })).liabilityNow).toBe(0);
  });

  it("utang PPN awal (sebelum pembukuan) dimasukkan lewat jurnal saldo awal; pembayaran pra-pembukuan tidak menggandakan", async () => {
    // Invoice lama dibayar sebelum pembukuan dimulai: PPN-nya tidak masuk buku (dianggap sudah termasuk saldo awal) → jurnal saldo awal untuk utang PPN-nya
    const old = await inv(`${YEAR - 1}-12-01`, true);
    await recordPayment(fx.finance, { invoiceId: old.id, paymentDate: `${YEAR - 1}-12-10`, amount: 15_540_000, method: "Transfer" });
    expect((await net())["2-1210"] ?? 0).toBe(0);
    await createJournal(fx.finance, { kind: "OPENING", journalDate: d(1, 1), description: "Utang PPN awal", lines: [{ accountId: c("3-2100"), debit: 1_540_000, credit: 0 }, { accountId: c("2-1210"), debit: 0, credit: 1_540_000 }] });
    expect((await net())["2-1210"]).toBe(-1_540_000);
    // setoran melunasinya
    await createEntry(fx.finance, { entryDate: d(2, 1), cashAccountId: fx.bankAcctId, counterAccountId: c("2-1210"), direction: "OUT", amount: 1_540_000, description: "Setor PPN akhir tahun lalu", proofFileId: await makeProof(fx.finance) });
    expect((await net())["2-1210"] ?? 0).toBe(0);
    await sound("PPN awal");
  });

  it("rekonsiliasi (db:reconcile) mendeteksi PPN pembayaran yang dirusak lewat SQL", async () => {
    const { execFileSync } = await import("node:child_process");
    const run = () => { try { return { code: 0, out: execFileSync("npx", ["tsx", "--conditions=react-server", "scripts/reconcile.ts"], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; } catch (e) { const x = e as { status?: number; stdout?: string; stderr?: string }; return { code: x.status ?? 99, out: `${x.stdout ?? ""}${x.stderr ?? ""}` }; } };
    const i = await inv(d(2, 1), true);
    const p = await recordPayment(fx.finance, { invoiceId: i.id, paymentDate: d(2, 5), amount: 15_000_000, withholdingAmount: 200_000, method: "Transfer" });
    expect(run().code).toBe(0);
    await prisma.$executeRawUnsafe(`ALTER TABLE payments DISABLE TRIGGER USER`);
    try {
      await prisma.$executeRawUnsafe(`UPDATE payments SET "vatAmount" = 15000000 WHERE id = '${p.id}'`);
      const bad = run();
      expect(bad.code, bad.out).toBe(1);
      expect(bad.out).toMatch(/PPN pembayaran melebihi PPN invoice/);
    } finally {
      await prisma.$executeRawUnsafe(`UPDATE payments SET "vatAmount" = ${p.vatAmount} WHERE id = '${p.id}'`);
      await prisma.$executeRawUnsafe(`ALTER TABLE payments ENABLE TRIGGER USER`);
    }
    expect(run().code).toBe(0);
  });
});
