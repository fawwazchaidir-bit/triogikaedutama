import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, type Fixtures } from "../helpers/db";
import { createDraft, issueInvoice } from "@/server/services/invoices";
import { recordPayment } from "@/server/services/payments";
import { createEntry, createTransfer } from "@/server/services/cash-entries";
import { autoMatchStatement, createStatement, finalizeStatement, runReconciliationReport } from "@/server/services/bank-reconciliation";
import { getCashTieOut, runStatement } from "@/server/services/finance-statements";
import { runTaxReport } from "@/server/services/finance-tax";
import { renderReportPdf } from "@/server/pdf/render";
import { pdfSafe } from "@/server/pdf/ReportPdf";
import { toCsv, toXlsx, type ReportTable } from "@/server/export";
import { comparativeRange } from "@/lib/accounting/compare";
import { AppError } from "@/server/errors";

/**
 * LAPORAN · PUTARAN 2 — ADVERSARIAL & FUZZ.
 * Fuzz: data acak pada banyak tanggal; untuk rentang & mode pembanding acak, kolom "periode ini"/"pembanding" harus sama dengan laporan biasa
 * pada rentang masing-masing, total pendapatan/beban harus sama dengan oracle SQL mentah, dan kas arus kas harus selalu = buku besar.
 */
const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as AppError | null;
const q = async (sqlText: string) => Number((await prisma.$queryRawUnsafe<{ v: bigint | number | null }[]>(sqlText))[0]!.v ?? 0);
let fx: Fixtures;
const c = (code: string) => fx.coa[code]!;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures({ finance: true, openingDate: "2026-01-01" });
});
afterAll(async () => { await prisma.$disconnect(); });

const tmp = mkdtempSync(path.join(tmpdir(), "rpt2-"));
const pdfText = (buf: Buffer, name: string) => { const f = path.join(tmp, `${name}.pdf`); writeFileSync(f, buf); return execFileSync("pdftotext", ["-layout", f, "-"], { encoding: "utf8" }); };
const pdf = (t: ReportTable) => renderReportPdf(t, { companyName: "TRILOGIKA EDUTAMA", printedBy: "Finance Uji" });

function rng(seed: number) {
  let s = seed;
  const next = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  return { int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T,>(a: readonly T[]) => a[Math.floor(next() * a.length)]! };
}
const dateOf = (offset: number) => new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);

describe("izin & masukan tak sah", () => {
  it("Staff ditolak untuk semua laporan, kecocokan kas, laporan pajak, dan laporan rekonsiliasi", async () => {
    for (const f of [
      () => runStatement(fx.staff, "income-statement", { compare: "previous" }), () => getCashTieOut(fx.staff, {}), () => runTaxReport(fx.staff, "vat-summary", {}),
      () => runReconciliationReport(fx.staff, crypto.randomUUID()),
    ]) expect((await err(f()))?.code).toBe("FORBIDDEN");
  });

  it("masukan aneh: compare tak dikenal, tanggal terbalik/masa depan, akun buku besar tanpa pilihan, laporan tak dikenal, id rekonsiliasi acak", async () => {
    expect((await err(runStatement(fx.finance, "income-statement", { compare: "lalu" })))?.code).toBe("VALIDATION");
    expect((await err(runStatement(fx.finance, "income-statement", { from: "2026-03-01", to: "2026-02-01", compare: "previous" })))?.code).toBe("VALIDATION");
    expect((await err(runStatement(fx.finance, "balance-sheet", { to: "2999-01-01", compare: "year" })))?.code).toBe("VALIDATION");
    expect((await err(runStatement(fx.finance, "general-ledger", { compare: "previous" })))?.code).toBe("VALIDATION");
    expect((await err(runStatement(fx.finance, "cash-flows", {})))?.code).toBe("NOT_FOUND");
    expect((await err(runReconciliationReport(fx.finance, crypto.randomUUID())))?.code).toBe("NOT_FOUND");
    expect(await err(runReconciliationReport(fx.finance, "bukan-uuid"))).not.toBeNull();
  });

  it("pembanding sebelum pembukuan dimulai atau di tahun jauh lalu tidak error dan bernilai nol", async () => {
    for (const mode of ["previous", "year"] as const) {
      for (const type of ["income-statement", "balance-sheet", "cash-flow"] as const) {
        const t = await runStatement(fx.finance, type, { from: "2026-01-01", to: "2026-01-31", compare: mode });
        expect(t.columns).toHaveLength(5);
        expect(t.rows.every((r) => r.prev === null || r.prev === 0 || type === "cash-flow" || type === "balance-sheet")).toBe(true);
      }
    }
  });

  it("deskripsi dengan emoji, aksara non-Latin, rumus (=,+,-,@) dan karakter kontrol: PDF/CSV/Excel tidak error dan aman", async () => {
    const nasty = ["😀 Bensin — ünïcödé 日本語 العربية", "=HYPERLINK(\"http://x\",\"klik\")", "+SUM(A1:A9)", "@cmd|' /C calc'!A0", "-2+3", "Tab\tdan\u0007bel", "<script>alert(1)</script> & \"kutip\" 'tunggal'", "x".repeat(250)];
    for (const [i, d] of nasty.entries()) await createEntry(fx.finance, { entryDate: `2026-02-${String(i + 1).padStart(2, "0")}`, cashAccountId: fx.bankAcctId, counterAccountId: c("6-1600"), amount: 1000 + i, description: d.replace(/[\u0000-\u0008]/g, "") });
    const gl = await runStatement(fx.finance, "general-ledger", { accountId: c("6-1600"), from: "2026-02-01", to: "2026-02-28" });
    const buf = await pdf(gl);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    const text = pdfText(buf, "nasty");
    expect(text).toContain("Bensin");
    expect(text).toContain("<script>alert(1)</script>");
    expect(text).not.toMatch(/[؀-ۿ぀-ヿ一-鿿]/); // aksara yang tak ada di font bawaan dibuang, bukan kotak kosong
    const csv = toCsv(gl);
    expect(csv).toContain("'=HYPERLINK"); // dinetralkan
    expect(csv).toContain("'+SUM");
    expect(csv).toContain("'@cmd");
    expect((await toXlsx(gl)).byteLength).toBeGreaterThan(2000);
  });

  it("pdfSafe: simbol pengganti, aksara dibuang, spasi dirapikan, tidak mengubah teks Latin biasa", () => {
    expect(pdfSafe("Kas → Bank ✓ 5 ≤ 6 − 1")).toBe("Kas -> Bank 5 <= 6 - 1");
    expect(pdfSafe("Jl. Kaliurang Km 7 — Sleman (PT. Éclair) “ok”")).toBe("Jl. Kaliurang Km 7 — Sleman (PT. Éclair) “ok”");
    expect(pdfSafe("日本語 abc")).toBe("abc");
    expect(pdfSafe("")).toBe("");
  });
});

describe("laporan rekonsiliasi & laporan pajak dapat diekspor", () => {
  it("laporan rekonsiliasi: ringkasan, transaksi beredar, mutasi dengan status cocok; PDF/CSV memuat angka sama", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: "2026-01-02", paymentTermDays: 30 }))).id);
    await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-01-05", amount: 5_000_000, method: "Transfer" });
    await createEntry(fx.finance, { entryDate: "2026-01-10", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1300"), amount: 400_000, description: "Listrik Januari" });
    await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-01-31", amount: 1_000_000, method: "Transfer" }); // beredar
    const st = await createStatement(fx.finance, {
      cashAccountId: fx.bankAcctId, periodStart: "2026-01-01", periodEnd: "2026-01-31", openingBalance: 10_000_000, closingBalance: 14_593_000,
      lines: [{ txDate: "2026-01-06", description: "TRF MASUK", amount: 5_000_000 }, { txDate: "2026-01-10", description: "PLN", amount: -400_000 }, { txDate: "2026-01-20", description: "BIAYA TAK DIKENAL", amount: -7_000 }],
    });
    await autoMatchStatement(fx.finance, st.id);
    const t = await runReconciliationReport(fx.finance, st.id);
    const row = (re: RegExp) => t.rows.find((r) => re.test(String(r.item)))!;
    expect(row(/^Saldo akhir menurut rekening koran$/).amount).toBe(14_593_000);
    expect(row(/Transaksi buku beredar \(belum tercermin/).amount).toBe(1_000_000);
    expect(row(/^Saldo bank disesuaikan$/).amount).toBe(15_593_000);
    expect(row(/^Saldo buku akun pada akhir periode$/).amount).toBe(15_600_000);
    expect([row(/^Selisih/).amount, String(row(/^Selisih/).item)]).toEqual([-7_000, "Selisih (harus 0) - BELUM COCOK"]); // biaya 7.000 belum dicatat di buku
    expect(String(row(/BIAYA TAK DIKENAL/).item)).toContain("BELUM COCOK");
    expect(String(row(/TRF MASUK/).item)).not.toContain("BELUM COCOK");
    expect(String(row(/^Status/).item)).toContain("DRAFT");
    const text = pdfText(await pdf(t), "recon");
    expect(text).toContain("Laporan Rekonsiliasi Bank - Bank Mandiri");
    expect(text).toContain("14.593.000");
    expect(text).toContain("BELUM COCOK");
    expect(toCsv(t)).toContain("Saldo bank disesuaikan,15593000");
  });

  it("laporan rekonsiliasi yang selisihnya 0: label 'cocok' dan status FINAL", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: "2026-01-02", paymentTermDays: 30 }))).id);
    await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-01-05", amount: 5_000_000, method: "Transfer" });
    const st = await createStatement(fx.finance, { cashAccountId: fx.bankAcctId, periodStart: "2026-01-01", periodEnd: "2026-01-31", openingBalance: 10_000_000, closingBalance: 15_000_000, lines: [{ txDate: "2026-01-06", description: "TRF MASUK", amount: 5_000_000 }] });
    await autoMatchStatement(fx.finance, st.id);
    await finalizeStatement(fx.finance, st.id);
    const t = await runReconciliationReport(fx.finance, st.id);
    const diff = t.rows.find((r) => /^Selisih/.test(String(r.item)))!;
    expect([diff.amount, String(diff.item)]).toEqual([0, "Selisih (harus 0) - cocok"]);
    expect(String(t.rows.find((r) => /^Status/.test(String(r.item)))!.item)).toBe("Status: FINAL oleh Finance Uji");
  });

  it("laporan pajak (PPN, PPh 23, estimasi PPh badan) menjadi PDF yang valid", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: "2026-02-02", paymentTermDays: 30, lines: [{ ...demiChefInput(fx).lines[0]!, taxConfigId: fx.ppnId }] }))).id);
    await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-02-10", amount: 15_260_000, withholdingAmount: 280_000, method: "Transfer" });
    for (const type of ["vat-summary", "pph23-register"] as const) {
      const t = await runTaxReport(fx.finance, type, { from: "2026-01-01", to: "2026-02-28" });
      const buf = await pdf(t);
      expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdfText(buf, type)).toContain(t.title);
    }
  });
});

describe("fuzz: pembanding vs laporan biasa vs oracle SQL", () => {
  const revenueIn = (from: string, to: string) => q(`SELECT COALESCE(SUM(amount),0)::bigint AS v FROM payments WHERE "paymentDate" BETWEEN '${from}' AND '${to}'`);
  const expenseIn = (from: string, to: string) => q(`SELECT COALESCE(SUM(amount),0)::bigint AS v FROM cash_entries WHERE status = 'APPROVED' AND direction = 'OUT' AND "entryDate" BETWEEN '${from}' AND '${to}'`);

  for (const seed of [11, 22, 33]) {
    it(`benih ${seed}`, async () => {
      const R = rng(seed);
      const big = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: "2026-01-01", paymentTermDays: 30, lines: [{ ...demiChefInput(fx).lines[0]!, quantity: 700 }] }))).id);
      for (let i = 0; i < 60; i++) {
        const d = dateOf(R.int(0, 200)), k = R.int(0, 9);
        if (k < 4) await recordPayment(fx.finance, { invoiceId: big.id, paymentDate: d, amount: R.int(10, 500) * 1000, method: "Transfer" });
        else if (k < 8) await createEntry(fx.finance, { entryDate: d, cashAccountId: R.pick([fx.bankAcctId, fx.cashAcctId]), counterAccountId: c(R.pick(["6-1300", "6-1600", "6-1400", "5-1100"])), amount: R.int(1, 300) * 1000, description: `Beban ${i}` });
        else if (k === 8) await createEntry(fx.finance, { entryDate: d, cashAccountId: fx.bankAcctId, counterAccountId: c("4-2200"), direction: "IN", amount: R.int(1, 50) * 1000, description: `Bunga ${i}` });
        else await createTransfer(fx.finance, { transferDate: d, fromAccountId: fx.bankAcctId, toAccountId: fx.cashAcctId, amount: R.int(1, 100) * 1000 });
      }
      const by = (t: ReportTable) => new Map(t.rows.map((r) => [String(r.item), r.amount]));
      for (let trial = 0; trial < 12; trial++) {
        const monthStart = R.int(0, 6);
        const fullMonths = R.int(0, 1) === 0;
        const from = fullMonths ? new Date(Date.UTC(2026, monthStart, 1)).toISOString().slice(0, 10) : dateOf(R.int(0, 150));
        const to = fullMonths ? new Date(Date.UTC(2026, monthStart + R.int(1, 2), 0)).toISOString().slice(0, 10) : dateOf(Math.min(205, Math.round((Date.parse(`${from}T00:00:00Z`) - Date.UTC(2026, 0, 1)) / 86_400_000) + R.int(0, 40)));
        const mode = R.pick(["previous", "year"] as const);
        const type = R.pick(["income-statement", "cash-flow", "balance-sheet"] as const);
        const label = `${type} ${from}..${to} ${mode}`;
        const cmp = await runStatement(fx.finance, type, { from, to, compare: mode });
        const pr = comparativeRange(type === "balance-sheet" ? "asof" : "range", from, to, mode);
        const cur = by(await runStatement(fx.finance, type, { from, to }));
        const prev = by(await runStatement(fx.finance, type, { from: pr.from, to: pr.to }));
        for (const r of cmp.rows) {
          if (r.kind === "head") continue;
          expect(r.amount, `${label} · periode ini · ${r.item}`).toBe(cur.get(String(r.item)) ?? 0);
          expect(r.prev, `${label} · pembanding · ${r.item}`).toBe(prev.get(String(r.item)) ?? 0);
          expect(r.change, `${label} · selisih · ${r.item}`).toBe((r.amount as number) - (r.prev as number));
        }
        if (type === "income-statement") {
          const rev = await revenueIn(from, to), exp = await expenseIn(from, to);
          const total = (m: Map<string, unknown>, re: RegExp) => [...m].find(([k]) => re.test(k))![1];
          // pendapatan usaha = pembayaran; laba sebelum pajak = pembayaran + pendapatan lain − beban OUT (tanpa transfer)
          expect(total(cur, /^Jumlah pendapatan usaha$/), `${label} oracle pendapatan`).toBe(rev);
          const other = await q(`SELECT COALESCE(SUM(amount),0)::bigint AS v FROM cash_entries WHERE status = 'APPROVED' AND direction = 'IN' AND "entryDate" BETWEEN '${from}' AND '${to}'`);
          expect(total(cur, /sebelum pajak penghasilan/), `${label} oracle laba`).toBe(rev + other - exp);
        }
        const tie = await getCashTieOut(fx.finance, { from, to });
        expect(tie.ok, `${label} kas ${JSON.stringify(tie)}`).toBe(true);
        if (trial % 4 === 0) expect((await pdf(cmp)).subarray(0, 5).toString(), label).toBe("%PDF-");
      }
    }, 300_000);
  }
});
