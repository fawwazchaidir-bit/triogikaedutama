import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, makeProof, type Fixtures } from "../helpers/db";
import { createDraft, issueInvoice } from "@/server/services/invoices";
import { recordPayment, reversePayment } from "@/server/services/payments";
import { listCashAccounts } from "@/server/services/cash-accounts";
import { approveEntry, cancelPendingEntry, createEntry, createTransfer, rejectEntry, reverseEntry, reverseTransfer } from "@/server/services/cash-entries";
import { createJournal, reverseJournal } from "@/server/services/journals";
import { getBalanceSheet, getGeneralLedger, getGlIncomeStatement, getJournalBook, getTrialBalance } from "@/server/services/finance-ledger";
import { todayIso } from "@/lib/format";
import { AppError } from "@/server/errors";

/**
 * TAHAP 2 · PUTARAN C — FUZZ BERBASIS MODEL, TIGA PEMBANDING INDEPENDEN.
 *   (1) buku bayangan di dalam tes (diposting sendiri per operasi, tanpa memakai kode aplikasi),
 *   (2) oracle SQL murni (menyusun ulang semua posting langsung dari tabel),
 *   (3) mesin buku besar aplikasi (service).
 * Ketiganya harus identik untuk neraca saldo di banyak tanggal, laba rugi di banyak periode, neraca, dan buku besar per akun.
 */
const today = todayIso("Asia/Jakarta");
const OPEN = "2025-01-01";
const dayMs = 86_400_000;
const isoPlus = (base: string, n: number) => new Date(Date.parse(`${base}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);
const span = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${OPEN}T00:00:00Z`)) / dayMs);
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

let fx: Fixtures;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures({ finance: true, openingDate: OPEN });
});
afterAll(async () => { await prisma.$disconnect(); });

// ───────────────────────── buku bayangan ─────────────────────────
interface Post { date: string; code: string; dr: number; cr: number }
const cov: Record<string, number> = {};
const allCov: Record<string, number> = {};
const hit = (k: string) => { cov[k] = (cov[k] ?? 0) + 1; allCov[k] = (allCov[k] ?? 0) + 1; };

const NON_CASH_ELIGIBLE = ["1-1300", "1-1400", "1-2100", "1-2200", "1-2300", "1-2900", "2-1100", "2-1200", "2-2100", "3-1100", "3-1200", "3-2100", "4-2100", "4-2200", "5-1100", "5-1300", "6-1100", "6-1600", "6-2000", "7-1100"];

async function fuzz(seed: number, ops: number): Promise<{ posts: Post[] }> {
  for (const k of Object.keys(cov)) delete cov[k];
  const r = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const code = (c: string) => fx.coa[c]!;
  const cashCoa: Record<string, string> = { [fx.bankAcctId]: "1-1200", [fx.cashAcctId]: "1-1100" };
  const acctIds = [fx.bankAcctId, fx.cashAcctId];
  const posts: Post[] = [
    { date: OPEN, code: "1-1200", dr: 10_000_000, cr: 0 }, { date: OPEN, code: "3-2100", dr: 0, cr: 10_000_000 },
    { date: OPEN, code: "1-1100", dr: 1_000_000, cr: 0 }, { date: OPEN, code: "3-2100", dr: 0, cr: 1_000_000 },
  ];
  const post = (date: string, dr: string, cr: string, amount: number) => { posts.push({ date, code: dr, dr: amount, cr: 0 }, { date, code: cr, dr: 0, cr: amount }); };
  /** Posting pembayaran (bertanda): Dr kas (uang) + Dr 1-1400 (PPh dipotong) / Cr 2-1210 (PPN) + Cr 4-1100 (sisanya). Diposting TERPISAH dari kode aplikasi. */
  const postPayment = (date: string, cashCode: string, cash: number, wh: number, vat: number) => {
    const rev = cash + wh - vat;
    posts.push({ date, code: cashCode, dr: Math.max(cash, 0), cr: Math.max(-cash, 0) }, { date, code: "1-1400", dr: Math.max(wh, 0), cr: Math.max(-wh, 0) },
      { date, code: "2-1210", dr: Math.max(-vat, 0), cr: Math.max(vat, 0) }, { date, code: "4-1100", dr: Math.max(-rev, 0), cr: Math.max(rev, 0) });
  };
  const invoices: { id: string; balance: number; cap: number; whUsed: number; tax: number; vatSum: number }[] = [];
  const payments: { id: string; date: string; amount: number; wh: number; vat: number; invoiceId: string; acctId: string | null; reversed: boolean; isReversal: boolean }[] = [];
  const entries: { id: string; amount: number; dir: "IN" | "OUT"; acctId: string; counter: string; reversed: boolean; type: "ENTRY" | "REVERSAL" }[] = [];
  const transfers: { id: string; amount: number; from: string; to: string; reversed: boolean; type: "ENTRY" | "REVERSAL" }[] = [];
  const journals: { id: string; lines: { code: string; dr: number; cr: number }[]; reversed: boolean; type: "ENTRY" | "REVERSAL" }[] = [];
  let bankDefault = true;
  const rndDate = () => isoPlus(OPEN, Math.floor(r() * (span + 1)));
  const attempt = async (fn: () => Promise<void>) => { try { await fn(); } catch (e) { if (!(e instanceof AppError)) throw e; hit("ditolak-bisnis"); } };

  // jurnal saldo awal (non-kas) pada tanggal mulai
  {
    const j = await createJournal(fx.finance, {
      kind: "OPENING", journalDate: OPEN, description: "Saldo awal fuzz",
      lines: [{ accountId: code("1-2100"), debit: 4_000_000, credit: 0 }, { accountId: code("2-2100"), debit: 0, credit: 1_500_000 }, { accountId: code("3-1100"), debit: 0, credit: 2_500_000 }],
    });
    posts.push({ date: OPEN, code: "1-2100", dr: 4_000_000, cr: 0 }, { date: OPEN, code: "2-2100", dr: 0, cr: 1_500_000 }, { date: OPEN, code: "3-1100", dr: 0, cr: 2_500_000 });
    journals.push({ id: j.id, lines: [{ code: "1-2100", dr: 4_000_000, cr: 0 }, { code: "2-2100", dr: 0, cr: 1_500_000 }, { code: "3-1100", dr: 0, cr: 2_500_000 }], reversed: false, type: "ENTRY" });
  }

  for (let i = 0; i < ops; i++) {
    const kind = pick(["invoice", "invoice", "payment", "payment", "payment", "payrev", "toggle", "exp_staff", "exp_staff", "exp_fin", "income", "financing", "investing", "transfer", "entryrev", "trrev", "journal", "journal", "journal", "jrev"]);
    await attempt(async () => {
      if (kind === "invoice") {
        const date = isoPlus(OPEN, Math.floor(r() * (span + 1)) - (r() < 0.15 ? 90 : 0)); // sebagian invoice mendahului tanggal mulai pembukuan
        const taxed = r() < 0.5;
        const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: date, paymentTermDays: 30, lines: [{ ...demiChefInput(fx).lines[0]!, quantity: 1 + Math.floor(r() * 5), taxConfigId: taxed ? fx.ppnId : null }] }))).id);
        invoices.push({ id: inv.id, balance: inv.amounts.total, cap: inv.amounts.total - inv.amounts.tax, whUsed: 0, tax: inv.amounts.tax, vatSum: 0 });
        if (taxed) hit("invoice-taxed");
        hit("invoice");
      } else if (kind === "payment") {
        const open = invoices.filter((x) => x.balance > 0);
        if (!open.length) return;
        const t = pick(open);
        const settled = Math.min(t.balance, 100_000 * (1 + Math.floor(r() * 30)));
        // sebagian pembayaran dipotong PPh oleh pelanggan (nilai acak; sistem tidak mengasumsikan tarif)
        const wh = r() < 0.3 ? Math.min(Math.floor(settled * r() * 0.1), t.cap - t.whUsed, settled - 1) : 0;
        const amount = settled - wh;
        const explicit = r() < 0.35 ? pick(acctIds) : null;
        const method = r() < 0.7 ? "Transfer" : "Tunai";
        const date = r() < 0.12 ? isoPlus(OPEN, -1 - Math.floor(r() * 60)) : rndDate(); // sebagian pembayaran pra-pembukuan
        const p = await recordPayment(r() < 0.5 ? fx.staff : fx.finance, { invoiceId: t.id, paymentDate: date, amount, withholdingAmount: wh, withholdingRef: wh > 0 ? "BP-FUZZ" : null, method, cashAccountId: explicit });
        const acctId = p.cashAccountId;
        const expected = explicit ?? (method === "Tunai" ? fx.cashAcctId : bankDefault ? fx.bankAcctId : null);
        expect(acctId).toBe(expected);
        t.balance -= settled; t.whUsed += wh; t.vatSum += p.vatAmount;
        if (t.balance === 0) expect(t.vatSum, "Σ PPN pembayaran = PPN invoice saat lunas").toBe(t.tax);
        payments.push({ id: p.id, date, amount, wh, vat: p.vatAmount, invoiceId: t.id, acctId, reversed: false, isReversal: false });
        if (wh > 0) hit("pay-withholding");
        if (p.vatAmount > 0) hit("pay-vat");
        if (acctId === null) { postPayment(date, "1-1450", amount, wh, p.vatAmount); hit("pay-unallocated"); }
        else if (date >= OPEN) { postPayment(date, cashCoa[acctId]!, amount, wh, p.vatAmount); hit("pay-allocated"); }
        else hit("pay-preopening");
      } else if (kind === "payrev") {
        const cand = payments.filter((p) => !p.reversed && !p.isReversal);
        if (!cand.length) return;
        const p = pick(cand);
        const rv = await reversePayment(fx.finance, p.id, { reason: "Fuzz pembalikan" });
        p.reversed = true;
        const inv = invoices.find((x) => x.id === rv.invoiceId)!;
        inv.balance += p.amount + p.wh; inv.whUsed -= p.wh; inv.vatSum -= p.vat;
        expect(rv.vatAmount + p.vat).toBe(0);
        expect(rv.withholdingAmount + p.wh).toBe(0);
        payments.push({ id: rv.id, date: today, amount: -p.amount, wh: -p.wh, vat: -p.vat, invoiceId: p.invoiceId, acctId: p.acctId, reversed: false, isReversal: true });
        // pembalikan bertanggal hari ini; akun asal tetap. Pembayaran asal yang pra-pembukuan → pembalikan (hari ini ≥ saldo awal) tetap diposting
        postPayment(today, p.acctId === null ? "1-1450" : cashCoa[p.acctId]!, -p.amount, -p.wh, -p.vat);
        hit("payrev");
        if (p.acctId !== null && p.date < OPEN) hit("payrev-of-preopening");
      } else if (kind === "toggle") {
        // memunculkan pembayaran tak teralokasi: matikan/nyalakan default bank
        bankDefault = !bankDefault;
        await prisma.cashAccount.update({ where: { id: fx.bankAcctId }, data: { isDefault: bankDefault } });
      } else if (kind === "exp_staff" || kind === "exp_fin") {
        const staff = kind === "exp_staff";
        const date = rndDate(); const amount = 10_000 * (1 + Math.floor(r() * 80)); const a = pick(acctIds); const c = pick(["5-1100", "5-1300", "6-1100", "6-1600"]);
        const e = await createEntry(staff ? pick([fx.staff, fx.staff2]) : fx.finance, { entryDate: date, cashAccountId: a, counterAccountId: code(c), amount, description: `Fuzz ${kind} ${i}` });
        const book = () => { post(date, c, cashCoa[a]!, amount); entries.push({ id: e.id, amount, dir: "OUT", acctId: a, counter: c, reversed: false, type: "ENTRY" }); hit("expense"); };
        if (!staff) { book(); return; }
        const fate = r();
        if (fate < 0.55) { await approveEntry(pick([fx.finance, fx.admin]), e.id); book(); }
        else if (fate < 0.75) { await rejectEntry(fx.finance, e.id, { reason: "Fuzz ditolak" }); hit("ditolak-pengeluaran"); }
        else if (fate < 0.9) { await cancelPendingEntry(e.createdById === fx.staff.userId ? fx.staff : fx.staff2, e.id); hit("batal-pengeluaran"); }
      } else if (kind === "income" || kind === "financing" || kind === "investing") {
        const date = rndDate(); const amount = 25_000 * (1 + Math.floor(r() * 120)); const a = pick(acctIds);
        const ch = kind === "income" ? { c: pick(["4-2100", "4-2200"]), dir: "IN" as const }
          : kind === "financing" ? pick([{ c: "3-1100", dir: "IN" as const }, { c: "3-1200", dir: "OUT" as const }, { c: "2-2100", dir: "IN" as const }, { c: "2-2100", dir: "OUT" as const }])
          : pick([{ c: "1-2100", dir: "OUT" as const }, { c: "1-2300", dir: "OUT" as const }, { c: "1-2200", dir: "IN" as const }]);
        const e = await createEntry(fx.finance, { entryDate: date, cashAccountId: a, counterAccountId: code(ch.c), direction: ch.dir, amount, description: `Fuzz ${kind} ${i}`, ...(ch.dir === "OUT" && amount > 1_000_000 ? { proofFileId: await makeProof(fx.finance) } : {}) });
        if (ch.dir === "IN") post(date, cashCoa[a]!, ch.c, amount); else post(date, ch.c, cashCoa[a]!, amount);
        entries.push({ id: e.id, amount, dir: ch.dir, acctId: a, counter: ch.c, reversed: false, type: "ENTRY" });
        hit(kind);
      } else if (kind === "transfer") {
        const [from, to]: [string, string] = r() < 0.5 ? [fx.bankAcctId, fx.cashAcctId] : [fx.cashAcctId, fx.bankAcctId];
        const amount = 20_000 * (1 + Math.floor(r() * 50)); const date = rndDate();
        const t = await createTransfer(fx.finance, { transferDate: date, fromAccountId: from, toAccountId: to, amount });
        post(date, cashCoa[to]!, cashCoa[from]!, amount);
        transfers.push({ id: t.id, amount, from, to, reversed: false, type: "ENTRY" });
        hit("transfer");
      } else if (kind === "entryrev") {
        const cand = entries.filter((e) => e.type === "ENTRY" && !e.reversed);
        if (!cand.length) return;
        const e = pick(cand);
        await reverseEntry(fx.finance, e.id, { reason: "Fuzz pembalikan entri" });
        e.reversed = true;
        if (e.dir === "OUT") post(today, cashCoa[e.acctId]!, e.counter, e.amount); else post(today, e.counter, cashCoa[e.acctId]!, e.amount);
        entries.push({ ...e, id: "rev", dir: e.dir === "IN" ? "OUT" : "IN", reversed: false, type: "REVERSAL" });
        hit("entryrev");
      } else if (kind === "trrev") {
        const cand = transfers.filter((t) => t.type === "ENTRY" && !t.reversed);
        if (!cand.length) return;
        const t = pick(cand);
        await reverseTransfer(fx.finance, t.id, { reason: "Fuzz pembalikan transfer" });
        t.reversed = true;
        post(today, cashCoa[t.from]!, cashCoa[t.to]!, t.amount);
        hit("trrev");
      } else if (kind === "journal") {
        // jurnal manual acak, seimbang: 1–3 baris debit, 1–3 baris kredit, total sama
        const nd = 1 + Math.floor(r() * 3), nc = 1 + Math.floor(r() * 3);
        const total = 1_000 * (1 + Math.floor(r() * 400));
        const split = (n: number) => { const cuts = Array.from({ length: n - 1 }, () => Math.floor(r() * (total - 1)) + 1).sort((a, b) => a - b); const parts: number[] = []; let prev = 0; for (const c of [...cuts, total]) { parts.push(c - prev); prev = c; } return parts.filter((p) => p > 0); };
        const ds = split(nd), cs = split(nc);
        const pool = NON_CASH_ELIGIBLE;
        const lines = [...ds.map((a) => ({ code: pick(pool), dr: a, cr: 0 })), ...cs.map((a) => ({ code: pick(pool), dr: 0, cr: a }))];
        if (new Set(lines.map((l) => l.code)).size < 2) return;
        const date = rndDate();
        const j = await createJournal(pick([fx.finance, fx.admin]), { journalDate: date, description: `Jurnal fuzz ${i}`, lines: lines.map((l) => ({ accountId: code(l.code), debit: l.dr, credit: l.cr })) });
        for (const l of lines) posts.push({ date, code: l.code, dr: l.dr, cr: l.cr });
        journals.push({ id: j.id, lines, reversed: false, type: "ENTRY" });
        hit("journal");
      } else if (kind === "jrev") {
        const cand = journals.filter((j) => j.type === "ENTRY" && !j.reversed);
        if (!cand.length) return;
        const j = pick(cand);
        await reverseJournal(fx.finance, j.id, { reason: "Fuzz pembalikan jurnal" });
        j.reversed = true;
        for (const l of j.lines) posts.push({ date: today, code: l.code, dr: l.cr, cr: l.dr });
        hit("jrev");
      }
    });
  }
  return { posts };
}

// ───────────────────────── oracle SQL ─────────────────────────
/** Menyusun ulang SELURUH posting langsung dari tabel (tanpa kode aplikasi). Tanggal terbatas ≤ asOf. */
async function sqlNet(asOf: string, from?: string): Promise<Record<string, number>> {
  const rows = await prisma.$queryRawUnsafe<{ code: string; net: bigint | number }[]>(`
    WITH ln AS (
      SELECT a."openingDate" AS d, c."code" AS code, a."openingBalance" AS dr, 0::bigint AS cr FROM cash_accounts a JOIN coa_accounts c ON c."id" = a."coaAccountId"
      UNION ALL SELECT a."openingDate", '3-2100', 0, a."openingBalance" FROM cash_accounts a
      UNION ALL SELECT p."paymentDate", c."code", GREATEST(p."amount", 0), GREATEST(-p."amount", 0)
        FROM payments p JOIN cash_accounts a ON a."id" = p."cashAccountId" JOIN coa_accounts c ON c."id" = a."coaAccountId" WHERE p."paymentDate" >= a."openingDate"
      UNION ALL SELECT p."paymentDate", '1-1450', GREATEST(p."amount", 0), GREATEST(-p."amount", 0) FROM payments p WHERE p."cashAccountId" IS NULL
      UNION ALL SELECT p."paymentDate", '1-1400', GREATEST(p."withholdingAmount", 0), GREATEST(-p."withholdingAmount", 0)
        FROM payments p LEFT JOIN cash_accounts a ON a."id" = p."cashAccountId" WHERE p."cashAccountId" IS NULL OR p."paymentDate" >= a."openingDate"
      UNION ALL SELECT p."paymentDate", '2-1210', GREATEST(-p."vatAmount", 0), GREATEST(p."vatAmount", 0)
        FROM payments p LEFT JOIN cash_accounts a ON a."id" = p."cashAccountId" WHERE p."cashAccountId" IS NULL OR p."paymentDate" >= a."openingDate"
      UNION ALL SELECT p."paymentDate", '4-1100', GREATEST(-(p."amount" + p."withholdingAmount" - p."vatAmount"), 0), GREATEST(p."amount" + p."withholdingAmount" - p."vatAmount", 0)
        FROM payments p LEFT JOIN cash_accounts a ON a."id" = p."cashAccountId" WHERE p."cashAccountId" IS NULL OR p."paymentDate" >= a."openingDate"
      UNION ALL SELECT e."entryDate", c."code", CASE WHEN e."direction" = 'IN' THEN e."amount" ELSE 0 END, CASE WHEN e."direction" = 'OUT' THEN e."amount" ELSE 0 END
        FROM cash_entries e JOIN cash_accounts a ON a."id" = e."cashAccountId" JOIN coa_accounts c ON c."id" = a."coaAccountId" WHERE e."status" = 'APPROVED'
      UNION ALL SELECT e."entryDate", k."code", CASE WHEN e."direction" = 'OUT' THEN e."amount" ELSE 0 END, CASE WHEN e."direction" = 'IN' THEN e."amount" ELSE 0 END
        FROM cash_entries e JOIN coa_accounts k ON k."id" = e."counterAccountId" WHERE e."status" = 'APPROVED'
      UNION ALL SELECT t."transferDate", c."code", t."amount", 0 FROM cash_transfers t JOIN cash_accounts a ON a."id" = t."toAccountId" JOIN coa_accounts c ON c."id" = a."coaAccountId"
      UNION ALL SELECT t."transferDate", c."code", 0, t."amount" FROM cash_transfers t JOIN cash_accounts a ON a."id" = t."fromAccountId" JOIN coa_accounts c ON c."id" = a."coaAccountId"
      UNION ALL SELECT j."journalDate", c."code", l."debit", l."credit" FROM journal_lines l JOIN journal_entries j ON j."id" = l."journalId" JOIN coa_accounts c ON c."id" = l."accountId"
    )
    SELECT code, SUM(dr) - SUM(cr) AS net FROM ln WHERE d <= '${asOf}'::date ${from ? `AND d >= '${from}'::date` : ""} GROUP BY code HAVING SUM(dr) - SUM(cr) <> 0`);
  return Object.fromEntries(rows.map((x) => [x.code, Number(x.net)]));
}
function shadowNet(posts: Post[], asOf: string, from?: string): Record<string, number> {
  const m: Record<string, number> = {};
  for (const p of posts) { if (p.date > asOf || (from && p.date < from)) continue; m[p.code] = (m[p.code] ?? 0) + p.dr - p.cr; }
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== 0));
}

const neg = (n: number) => (n === 0 ? 0 : -n);
const SEEDS = [11, 23, 37, 41, 59, 71, 83, 97];
describe("fuzz buku besar: model bayangan = oracle SQL = mesin aplikasi", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}`, async () => {
      const { posts } = await fuzz(seed, 150);
      // cakupan: pastikan skenario penting benar-benar terjadi (bukan sekadar ditolak diam-diam)
      for (const k of ["invoice", "pay-allocated", "expense", "journal"]) expect(cov[k] ?? 0, `cakupan ${k}`).toBeGreaterThan(0);

      const r = rng(seed * 7919);
      const dates = [OPEN, isoPlus(OPEN, 30), isoPlus(OPEN, 200), isoPlus(OPEN, 365), isoPlus(OPEN, Math.floor(span / 2)), today, ...Array.from({ length: 6 }, () => isoPlus(OPEN, Math.floor(r() * (span + 1))))];
      const { id: _bank } = { id: fx.bankAcctId };
      void _bank;
      const codeOf = new Map(Object.entries(fx.coa).map(([code, id]) => [id, code]));
      for (const asOf of dates) {
        const oracle = await sqlNet(asOf);
        const shadow = shadowNet(posts, asOf);
        expect(shadow, `seed ${seed} neraca saldo ${asOf}: bayangan = oracle SQL`).toEqual(oracle);
        const tb = await getTrialBalance(fx.finance, { to: asOf });
        const app = Object.fromEntries(tb.rows.map((x) => [x.code, x.net]));
        expect(app, `seed ${seed} neraca saldo ${asOf}: aplikasi = oracle SQL`).toEqual(oracle);
        expect(tb.balanced).toBe(true);
        expect(tb.totalDebit).toBe(Object.values(oracle).filter((v) => v > 0).reduce((a, b) => a + b, 0));

        // neraca: aset = liabilitas + ekuitas (+ laba), dan tiap kelompok = oracle
        const bs = await getBalanceSheet(fx.finance, { to: asOf });
        const typeOf = (code: string) => (code[0] === "1" ? "ASET" : code[0] === "2" ? "KEWAJIBAN" : code[0] === "3" ? "EKUITAS" : code[0] === "4" ? "PENDAPATAN" : "BEBAN");
        const sumType = (t: string) => Object.entries(oracle).filter(([c]) => typeOf(c) === t).reduce((s, [, v]) => s + v, 0);
        expect(bs.totalAssets, `seed ${seed} aset ${asOf}`).toBe(sumType("ASET"));
        expect(bs.totalLiabilities, `seed ${seed} liabilitas ${asOf}`).toBe(neg(sumType("KEWAJIBAN")));
        expect(bs.totalEquity, `seed ${seed} ekuitas ${asOf}`).toBe(neg(sumType("EKUITAS") + sumType("PENDAPATAN") + sumType("BEBAN")));
        expect(bs.balanced, `seed ${seed} neraca seimbang ${asOf}`).toBe(true);
        expect(bs.retainedEarningsPrior + bs.currentYearProfit).toBe(neg(sumType("PENDAPATAN") + sumType("BEBAN")));
      }

      // laba rugi: beberapa periode vs oracle (akun laba rugi saja, menurut kelompok kode)
      for (const [f, t] of [[OPEN, today], [isoPlus(OPEN, 100), isoPlus(OPEN, 400)], [isoPlus(OPEN, 365), today], [isoPlus(OPEN, 10), isoPlus(OPEN, 10)]] as [string, string][]) {
        if (f > t || t > today) continue;
        const oracle = await sqlNet(t, f);
        const gl = await getGlIncomeStatement(fx.finance, { from: f, to: t });
        const sumC = (pred: (c: string) => boolean) => Object.entries(oracle).filter(([c]) => pred(c)).reduce((s, [, v]) => s + v, 0);
        expect(gl.totalRevenue, `seed ${seed} pendapatan ${f}..${t}`).toBe(neg(sumC((c) => c.startsWith("4-1"))));
        expect(gl.totalOtherIncome).toBe(neg(sumC((c) => c.startsWith("4-") && !c.startsWith("4-1"))));
        expect(gl.totalDirectCosts).toBe(sumC((c) => c.startsWith("5")));
        expect(gl.totalOperatingCosts).toBe(sumC((c) => c.startsWith("6")));
        expect(gl.totalIncomeTax).toBe(sumC((c) => c.startsWith("7")));
        expect(gl.netProfit, `seed ${seed} laba bersih ${f}..${t}`).toBe(neg(sumC((c) => c[0] === "4" || c[0] === "5" || c[0] === "6" || c[0] === "7")));
      }

      // identitas kas: buku besar akun kas = saldo modul kas (mengikuti aturan saldo awal)
      const accts = await listCashAccounts(fx.finance);
      const tbToday = Object.fromEntries((await getTrialBalance(fx.finance, { to: today })).rows.map((x) => [x.code, x.net]));
      expect(tbToday["1-1200"] ?? 0, `seed ${seed} 1-1200 = saldo Bank`).toBe(accts.find((a) => a.id === fx.bankAcctId)!.balance);
      expect(tbToday["1-1100"] ?? 0, `seed ${seed} 1-1100 = saldo Kas`).toBe(accts.find((a) => a.id === fx.cashAcctId)!.balance);

      // buku besar per akun: saldo berjalan tiap baris konsisten dan penutupnya = oracle (sisi normal)
      for (const code of ["1-1200", "1-1100", "4-1100", "1-1450", "6-1600", "1-2100", "3-2100"]) {
        const g = await getGeneralLedger(fx.finance, { accountId: fx.coa[code], from: isoPlus(OPEN, -400), to: today }); // mulai sebelum data pertama (penerimaan tak teralokasi bisa mendahului saldo awal)
        let run = g.opening;
        const debitNormal = code[0] === "1" || code[0] === "5" || code[0] === "6";
        for (const row of g.rows) { run += debitNormal ? row.debit - row.credit : row.credit - row.debit; expect(row.balance).toBe(run); }
        const net = (await sqlNet(today))[code] ?? 0;
        expect(g.closing, `seed ${seed} buku besar ${code}`).toBe(debitNormal ? net : neg(net));
        expect(g.totalDebit - g.totalCredit).toBe(net);
      }

      // buku jurnal: setiap jurnal seimbang; jumlah baris debit/kredit total seimbang
      const book = await getJournalBook(fx.finance, { from: OPEN, to: today, pageSize: 100, page: 1 });
      for (const j of book.items) expect(j.lines.reduce((s, l) => s + l.debit - l.credit, 0), `seed ${seed} jurnal ${j.label} seimbang`).toBe(0);
      void codeOf;
    }, 180_000);
  }
});

describe("cakupan gabungan fuzz", () => {
  it("setiap jenis skenario penting terjadi minimal sekali di seluruh seed", () => {
    for (const k of ["invoice", "invoice-taxed", "pay-withholding", "pay-vat", "pay-allocated", "pay-unallocated", "pay-preopening", "payrev", "payrev-of-preopening", "expense", "ditolak-pengeluaran", "batal-pengeluaran", "income", "financing", "investing", "transfer", "trrev", "entryrev", "journal", "jrev"]) {
      expect(allCov[k] ?? 0, `cakupan gabungan ${k}`).toBeGreaterThan(0);
    }
  });
});

describe("rekonsiliasi (skrip db:reconcile) atas data fuzz", () => {
  const runReconcile = (): { code: number; out: string } => {
    try {
      const out = execFileSync("npx", ["tsx", "--conditions=react-server", "scripts/reconcile.ts"], {
        cwd: process.cwd(), env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, out };
    } catch (e) {
      const x = e as { status?: number; stdout?: string; stderr?: string };
      return { code: x.status ?? 99, out: `${x.stdout ?? ""}${x.stderr ?? ""}` };
    }
  };

  it("data sah → bersih; dirusak lewat SQL (memintas pemicu) → setiap jenis kerusakan terdeteksi", async () => {
    await fuzz(77, 70);
    const clean = runReconcile();
    expect(clean.code, clean.out).toBe(0);
    expect(clean.out).toMatch(/Rekonsiliasi bersih/);

    // Rusak: pemicu USER dimatikan (meniru DBA/ pemulihan cadangan yang salah). Setiap kerusakan dibuat lalu dibersihkan agar terdeteksi terpisah.
    const corrupt = async (setup: string[], teardown: string[], expectLine: RegExp) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE journal_lines DISABLE TRIGGER USER`);
      await prisma.$executeRawUnsafe(`ALTER TABLE journal_entries DISABLE TRIGGER USER`);
      await prisma.$executeRawUnsafe(`ALTER TABLE cash_entries DISABLE TRIGGER USER`);
      try {
        for (const q of setup) await prisma.$executeRawUnsafe(q);
        const res = runReconcile();
        expect(res.code, `harus gagal: ${expectLine}\n${res.out}`).toBe(1);
        expect(res.out).toMatch(expectLine);
      } finally {
        for (const q of teardown) await prisma.$executeRawUnsafe(q);
        await prisma.$executeRawUnsafe(`ALTER TABLE journal_lines ENABLE TRIGGER USER`);
        await prisma.$executeRawUnsafe(`ALTER TABLE journal_entries ENABLE TRIGGER USER`);
        await prisma.$executeRawUnsafe(`ALTER TABLE cash_entries ENABLE TRIGGER USER`);
      }
      const back = runReconcile();
      expect(back.code, back.out).toBe(0);
    };
    const jid = crypto.randomUUID();
    const hdr = `INSERT INTO journal_entries (id,kind,"entryType","journalDate",description,"createdById") VALUES ('${jid}','GENERAL','ENTRY','2025-03-01','Rusak','${fx.finance.userId}')`;
    const ln = (no: number, acct: string, dr: number, cr: number) => `INSERT INTO journal_lines (id,"journalId","lineNo","accountId",debit,credit) VALUES (gen_random_uuid(),'${jid}',${no},'${acct}',${dr},${cr})`;
    const wipe = [`DELETE FROM journal_lines WHERE "journalId"='${jid}'`, `DELETE FROM journal_entries WHERE id='${jid}'`];
    await corrupt([hdr, ln(1, fx.coa["6-2000"]!, 100, 0), ln(2, fx.coa["1-2900"]!, 0, 90)], wipe, /jurnal manual tidak seimbang/);
    await corrupt([hdr, ln(1, fx.coa["6-2000"]!, 100, 0)], wipe, /jurnal manual tidak seimbang|kurang dari dua baris/);
    await corrupt([hdr.replace("'2025-03-01'", "'2024-12-31'"), ln(1, fx.coa["6-2000"]!, 5, 0), ln(2, fx.coa["1-2900"]!, 0, 5)], wipe, /mendahului tanggal mulai pembukuan/);
    await corrupt([hdr, ln(1, fx.coa["1-1200"]!, 5, 0), ln(2, fx.coa["3-1100"]!, 0, 5)], wipe, /menyentuh akun kas\/bank atau akun cadangan/);
    await corrupt([hdr, ln(1, fx.coa["4-1100"]!, 0, 5), ln(2, fx.coa["3-1100"]!, 5, 0)], wipe, /menyentuh akun kas\/bank atau akun cadangan/);
    await corrupt([hdr.replace("'GENERAL'", "'OPENING'").replace("'2025-03-01'", "'2025-01-01'"), ln(1, fx.coa["6-2000"]!, 5, 0), ln(2, fx.coa["3-1100"]!, 0, 5)], wipe, /jurnal saldo awal memuat akun laba rugi/);
    await corrupt([`UPDATE coa_accounts SET "isActive" = false WHERE "code" = '1-1450'`], [`UPDATE coa_accounts SET "isActive" = true WHERE "code" = '1-1450'`], /akun sistem buku besar hilang/);
  }, 240_000);
});
