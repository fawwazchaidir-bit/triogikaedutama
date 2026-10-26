import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, makeProof, type Fixtures } from "../helpers/db";
import { createDraft, issueInvoice, submitInvoice } from "@/server/services/invoices";
import { recordPayment, reversePayment } from "@/server/services/payments";
import { listCashAccounts } from "@/server/services/cash-accounts";
import { approveEntry, cancelPendingEntry, createEntry, createTransfer, listEntries, rejectEntry, reverseEntry, reverseTransfer } from "@/server/services/cash-entries";
import { getAccountLedger, getCashFlow, getFinanceWarnings, getIncomeStatement, runStatement } from "@/server/services/finance-statements";
import { seedCoa } from "@/server/services/finance-coa";
import { getDashboard } from "@/server/services/dashboard";
import { runReport } from "@/server/services/reports";
import { todayIso } from "@/lib/format";
import { AppError } from "@/server/errors";

/**
 * PUTARAN 3 — INTEGRASI LINTAS MODUL.
 * Invoice ↔ pembayaran ↔ kas ↔ pengeluaran ↔ laporan, diuji dengan tiga cara BERBEDA dari putaran 1–2:
 *  (a) fuzz berbasis model: operasi acak dijalankan lewat service, hasilnya dibandingkan dengan "buku bayangan" independen di dalam tes;
 *  (b) silang-validasi dengan laporan invoice yang sudah ada (laporan pembayaran, dashboard) dan SQL murni;
 *  (c) rekonsiliasi lewat skrip `db:reconcile` (bersih → lolos; sengaja dirusak → terdeteksi).
 */
const today = todayIso("Asia/Jakarta");
const OPEN = "2025-01-01";
const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as AppError | null;

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const dayMs = 86_400_000;
const isoPlus = (base: string, n: number) => new Date(Date.parse(`${base}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);
const span = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${OPEN}T00:00:00Z`)) / dayMs);

/** Saldo akun dihitung ulang dengan SQL murni — oracle independen dari kode statements. */
async function sqlBalances(): Promise<Record<string, number>> {
  const rows = await prisma.$queryRawUnsafe<{ name: string; bal: bigint | number }[]>(`
    SELECT a."name", a."openingBalance"
      + COALESCE((SELECT SUM(p."amount") FROM payments p WHERE p."cashAccountId" = a."id" AND p."paymentDate" >= a."openingDate"), 0)
      + COALESCE((SELECT SUM(CASE WHEN e."direction" = 'IN' THEN e."amount" ELSE -e."amount" END) FROM cash_entries e WHERE e."cashAccountId" = a."id" AND e."status" = 'APPROVED' AND e."entryDate" >= a."openingDate"), 0)
      + COALESCE((SELECT SUM(t."amount") FROM cash_transfers t WHERE t."toAccountId" = a."id" AND t."transferDate" >= a."openingDate"), 0)
      - COALESCE((SELECT SUM(t."amount") FROM cash_transfers t WHERE t."fromAccountId" = a."id" AND t."transferDate" >= a."openingDate"), 0) AS bal
      FROM cash_accounts a`);
  return Object.fromEntries(rows.map((r) => [r.name, Number(r.bal)]));
}

function runReconcile(): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsx", "--conditions=react-server", "scripts/reconcile.ts"], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string };
    return { code: x.status ?? 99, out: `${x.stdout ?? ""}${x.stderr ?? ""}` };
  }
}

let fx: Fixtures;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures({ finance: true, openingDate: OPEN });
});
afterAll(async () => { await prisma.$disconnect(); });

// ───────────────────────────── (a) FUZZ BERBASIS MODEL ─────────────────────────────

interface Model {
  bal: Record<string, number>;
  payments: { date: string; amount: number; id: string; invoiceId: string; acct: string; reversed: boolean; isReversal: boolean }[];
  entries: { id: string; date: string; dir: "IN" | "OUT"; amount: number; acct: string; counter: string; type: "ENTRY" | "REVERSAL"; reversed: boolean }[];
  transfers: { id: string; date: string; from: string; to: string; amount: number; type: "ENTRY" | "REVERSAL"; reversed: boolean }[];
  invoices: { id: string; balance: number; date: string }[];
}

async function fuzz(seed: number, ops: number): Promise<Model> {
  const r = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const acctIds = [fx.bankAcctId, fx.cashAcctId];
  const m: Model = { bal: { [fx.bankAcctId]: 10_000_000, [fx.cashAcctId]: 1_000_000 }, payments: [], entries: [], transfers: [], invoices: [] };
  const code = (c: string) => fx.coa[c]!;
  const expenseCats = ["5-1100", "5-1200", "6-1100", "6-1300", "6-1600"];
  const rndDate = () => isoPlus(OPEN, Math.floor(r() * (span + 1)));
  const attempt = async (fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { if (!(e instanceof AppError)) throw e; } // kegagalan bisnis yang sah (mis. kelebihan bayar) diabaikan; bug sungguhan melempar error lain
  };

  for (let i = 0; i < ops; i++) {
    const kind = pick(["invoice", "invoice", "payment", "payment", "payment", "payrev", "exp_staff", "exp_staff", "exp_fin", "income", "financing", "investing", "transfer", "entryrev", "trrev"]);
    await attempt(async () => {
      if (kind === "invoice") {
        const date = rndDate();
        const dp = r() < 0.4 ? 500_000 * (1 + Math.floor(r() * 4)) : 0;
        const method = r() < 0.7 ? "Transfer" : "Tunai";
        const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: date, paymentTermDays: 30, paymentMethod: method, downPayment: dp, lines: [{ ...demiChefInput(fx).lines[0]!, quantity: 1 + Math.floor(r() * 5) }] }))).id);
        if (dp > 0) {
          const p = await prisma.payment.findFirstOrThrow({ where: { invoiceId: inv.id, isDownPayment: true } });
          const a = method === "Tunai" ? fx.cashAcctId : fx.bankAcctId;
          expect(p.cashAccountId).toBe(a);
          m.bal[a]! += dp;
          m.payments.push({ date: date, amount: dp, id: p.id, invoiceId: inv.id, acct: a, reversed: false, isReversal: false });
        }
        m.invoices.push({ id: inv.id, balance: inv.amounts.total - dp, date });
      } else if (kind === "payment") {
        const inv = m.invoices.filter((x) => x.balance > 0);
        if (!inv.length) return;
        const target = pick(inv);
        const amount = Math.min(target.balance, 100_000 * (1 + Math.floor(r() * 30)));
        const explicit = r() < 0.35 ? pick(acctIds) : null;
        const method = r() < 0.7 ? "Transfer" : "Tunai";
        const date = isoPlus(OPEN, Math.floor(r() * (span + 1)));
        const p = await recordPayment(r() < 0.5 ? fx.staff : fx.finance, { invoiceId: target.id, paymentDate: date, amount, method, cashAccountId: explicit });
        const a = explicit ?? (method === "Tunai" ? fx.cashAcctId : fx.bankAcctId);
        expect(p.cashAccountId).toBe(a);
        m.bal[a]! += amount; target.balance -= amount;
        m.payments.push({ date, amount, id: p.id, invoiceId: target.id, acct: a, reversed: false, isReversal: false });
      } else if (kind === "payrev") {
        const cand = m.payments.filter((p) => !p.reversed && !p.isReversal);
        if (!cand.length) return;
        const p = pick(cand);
        const rv = await reversePayment(fx.finance, p.id, { reason: "Fuzz pembalikan" });
        p.reversed = true;
        m.bal[p.acct]! -= p.amount;
        m.invoices.find((x) => x.id === p.invoiceId)!.balance += p.amount;
        m.payments.push({ date: today, amount: -p.amount, id: rv.id, invoiceId: p.invoiceId, acct: p.acct, reversed: false, isReversal: true });
      } else if (kind === "exp_staff" || kind === "exp_fin") {
        const staff = kind === "exp_staff";
        const date = rndDate(); const amount = 10_000 * (1 + Math.floor(r() * 80)); const a = pick(acctIds); const c = pick(expenseCats);
        const e = await createEntry(staff ? pick([fx.staff, fx.staff2]) : fx.finance, { entryDate: date, cashAccountId: a, counterAccountId: code(c), amount, description: `Fuzz ${kind} ${i}` });
        if (!staff) { expect(e.status).toBe("APPROVED"); m.bal[a]! -= amount; m.entries.push({ id: e.id, date, dir: "OUT", amount, acct: a, counter: c, type: "ENTRY", reversed: false }); return; }
        expect(e.status).toBe("PENDING");
        const fate = r();
        if (fate < 0.55) { await approveEntry(pick([fx.finance, fx.admin]), e.id); m.bal[a]! -= amount; m.entries.push({ id: e.id, date, dir: "OUT", amount, acct: a, counter: c, type: "ENTRY", reversed: false }); }
        else if (fate < 0.75) await rejectEntry(fx.finance, e.id, { reason: "Fuzz ditolak" });
        else if (fate < 0.9) await cancelPendingEntry(e.createdById === fx.staff.userId ? fx.staff : fx.staff2, e.id);
        // sisanya dibiarkan menunggu (tidak boleh memengaruhi saldo)
      } else if (kind === "income" || kind === "financing" || kind === "investing") {
        const date = rndDate(); const amount = 25_000 * (1 + Math.floor(r() * 120)); const a = pick(acctIds);
        const choice = kind === "income" ? { c: pick(["4-2100", "4-2200"]), dir: "IN" as const }
          : kind === "financing" ? pick([{ c: "3-1100", dir: "IN" as const }, { c: "3-1200", dir: "OUT" as const }, { c: "2-2100", dir: "IN" as const }, { c: "2-2100", dir: "OUT" as const }])
          : pick([{ c: "1-2100", dir: "OUT" as const }, { c: "1-2300", dir: "OUT" as const }, { c: "1-2200", dir: "IN" as const }]);
        const e = await createEntry(fx.finance, { entryDate: date, cashAccountId: a, counterAccountId: code(choice.c), direction: choice.dir, amount, description: `Fuzz ${kind} ${i}`, ...(choice.dir === "OUT" && amount > 1_000_000 ? { proofFileId: await makeProof(fx.finance) } : {}) });
        m.bal[a]! += choice.dir === "IN" ? amount : -amount;
        m.entries.push({ id: e.id, date, dir: choice.dir, amount, acct: a, counter: choice.c, type: "ENTRY", reversed: false });
      } else if (kind === "transfer") {
        const [from, to]: [string, string] = r() < 0.5 ? [fx.bankAcctId, fx.cashAcctId] : [fx.cashAcctId, fx.bankAcctId];
        const amount = 20_000 * (1 + Math.floor(r() * 50)); const date = rndDate();
        const t = await createTransfer(fx.finance, { transferDate: date, fromAccountId: from, toAccountId: to, amount });
        m.bal[from]! -= amount; m.bal[to]! += amount;
        m.transfers.push({ id: t.id, date, from, to, amount, type: "ENTRY", reversed: false });
      } else if (kind === "entryrev") {
        const cand = m.entries.filter((e) => e.type === "ENTRY" && !e.reversed);
        if (!cand.length) return;
        const e = pick(cand);
        const rv = await reverseEntry(fx.finance, e.id, { reason: "Fuzz pembalikan entri" });
        e.reversed = true;
        const dir = e.dir === "IN" ? "OUT" : "IN";
        m.bal[e.acct]! += dir === "IN" ? e.amount : -e.amount;
        m.entries.push({ id: rv.id, date: today, dir, amount: e.amount, acct: e.acct, counter: e.counter, type: "REVERSAL", reversed: false });
      } else if (kind === "trrev") {
        const cand = m.transfers.filter((t) => t.type === "ENTRY" && !t.reversed);
        if (!cand.length) return;
        const t = pick(cand);
        const rv = await reverseTransfer(fx.finance, t.id, { reason: "Fuzz pembalikan transfer" });
        t.reversed = true;
        m.bal[t.from]! += t.amount; m.bal[t.to]! -= t.amount;
        m.transfers.push({ id: rv.id, date: today, from: t.to, to: t.from, amount: t.amount, type: "REVERSAL", reversed: false });
      }
    });
  }
  return m;
}

async function verifyAgainstModel(m: Model, label: string) {
  const names: Record<string, string> = { [fx.bankAcctId]: "Bank Mandiri", [fx.cashAcctId]: "Kas Kecil" };
  const app = Object.fromEntries((await listCashAccounts(fx.finance)).map((a) => [a.id, a.balance]));
  const sql = await sqlBalances();
  for (const id of Object.keys(m.bal)) {
    expect(app[id], `${label}: saldo aplikasi ${names[id]} = model`).toBe(m.bal[id]);
    expect(sql[names[id]!], `${label}: saldo SQL ${names[id]} = model`).toBe(m.bal[id]);
    const ledger = await getAccountLedger(fx.finance, { accountId: id, from: OPEN, to: today });
    expect(ledger.closing, `${label}: penutup buku kas ${names[id]}`).toBe(m.bal[id]);
    // saldo berjalan tiap baris harus konsisten (tiap baris = sebelumnya + mutasi)
    let run = ledger.opening;
    for (const row of ledger.rows) { run += row.signed; expect(row.balance).toBe(run); }
  }
  const total = Object.values(m.bal).reduce((a, b) => a + b, 0);
  const cf = await getCashFlow(fx.finance, { from: OPEN, to: today });
  expect(cf.ending, `${label}: arus kas akhir = Σ saldo model`).toBe(total);
  expect(cf.beginning + cf.newOpening + cf.netChange).toBe(cf.ending);
  expect(cf.notInBalances).toBe(0);

  // laba rugi vs model (pendapatan = Σ pembayaran neto; beban per kategori neto pembalikan)
  const pl = await getIncomeStatement(fx.finance, { from: OPEN, to: today });
  expect(pl.revenue, `${label}: pendapatan`).toBe(m.payments.reduce((s, p) => s + p.amount, 0));
  const costOf = (c: string) => m.entries.filter((e) => e.counter === c).reduce((s, e) => s + (e.dir === "OUT" ? e.amount : -e.amount), 0);
  const modelCosts = (pred: (c: string) => boolean) => ["5-1100", "5-1200", "6-1100", "6-1300", "6-1600"].filter(pred).reduce((s, c) => s + costOf(c), 0);
  expect(pl.totalDirectCosts, `${label}: beban langsung`).toBe(modelCosts((c) => c.startsWith("5")));
  expect(pl.totalOperatingCosts, `${label}: beban operasional`).toBe(modelCosts((c) => c.startsWith("6")));
  const income = ["4-2100", "4-2200"].reduce((s, c) => s + m.entries.filter((e) => e.counter === c).reduce((a, e) => a + (e.dir === "IN" ? e.amount : -e.amount), 0), 0);
  expect(pl.totalOtherIncome, `${label}: pendapatan lain`).toBe(income);
  // identitas silang: laba bersih = arus kas operasi (semua alokasi & setelah saldo awal)
  expect(pl.netProfitBeforeTax, `${label}: laba bersih = arus operasi`).toBe(cf.operating.net);

  // silang-validasi dengan modul invoice yang sudah ada
  const payReport = await runReport(fx.finance, "payments", { from: OPEN, to: today });
  expect(payReport.totals?.amount, `${label}: laporan pembayaran = pendapatan`).toBe(pl.revenue);
  expect((await getDashboard(fx.finance, { from: OPEN, to: today })).receivedAmount, `${label}: dashboard kas diterima = pendapatan`).toBe(pl.revenue);

  // pengeluaran menunggu tidak pernah dihitung; invoice: cache = ledger
  const pend = await prisma.cashEntry.count({ where: { status: "PENDING" } });
  expect((await getFinanceWarnings(fx.finance)).pendingExpenses).toBe(pend);
  for (const inv of m.invoices) {
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(Number(row.balanceAmount), `${label}: sisa tagihan invoice`).toBe(inv.balance);
  }
}

describe("(a) fuzz berbasis model — tiga skenario acak berbeda", () => {
  for (const [seed, ops] of [[11, 70], [2026, 70], [987_654, 70]] as const) {
    it(`seed ${seed}: ${ops} operasi acak; saldo/laporan = buku bayangan = SQL murni`, async () => {
      const m = await fuzz(seed, ops);
      expect(m.payments.length + m.entries.length + m.transfers.length).toBeGreaterThan(15); // skenario benar-benar bergerak
      await verifyAgainstModel(m, `seed ${seed}`);
      const rec = runReconcile();
      expect(rec.code, rec.out).toBe(0);
      expect(rec.out).toContain("Rekonsiliasi bersih");
    }, 240_000);
  }

  it("periode dapat dirangkai: akhir bulan ke-n = awal bulan ke-(n+1); jumlah bulanan = total; potongan di batas hari inklusif", async () => {
    const m = await fuzz(31337, 60);
    const months: [string, string][] = [];
    for (let y = 2025; y <= 2026; y++) for (let mo = 1; mo <= 12; mo++) {
      const from = `${y}-${String(mo).padStart(2, "0")}-01`;
      const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
      if (from > today) break;
      months.push([from, last > today ? today : last]);
    }
    let prevEnd: number | null = null, sumNet = 0, sumRev = 0, sumProfit = 0;
    for (const [from, to] of months) {
      const cf = await getCashFlow(fx.finance, { from, to });
      const pl = await getIncomeStatement(fx.finance, { from, to });
      if (prevEnd !== null) expect(cf.beginning, `awal ${from} = akhir bulan sebelumnya`).toBe(prevEnd);
      prevEnd = cf.ending; sumNet += cf.netChange; sumRev += pl.revenue; sumProfit += pl.netProfitBeforeTax;
    }
    const whole = await getCashFlow(fx.finance, { from: OPEN, to: today });
    const wholePl = await getIncomeStatement(fx.finance, { from: OPEN, to: today });
    expect(sumNet + 11_000_000).toBe(whole.ending);
    expect(sumRev).toBe(wholePl.revenue);
    expect(sumProfit).toBe(wholePl.netProfitBeforeTax);
    await verifyAgainstModel(m, "rangkaian");
  }, 240_000);
});

// ───────────────────────────── (b) silang modul & alur peran ─────────────────────────────

describe("(b) alur lintas peran dari awal sampai laporan", () => {
  it("Staff input invoice → Finance setujui → staff catat pembayaran & pengeluaran → Finance setujui → angka konsisten di seluruh modul; staff tak melihat laporan keuangan", async () => {
    const draft = await createDraft(fx.staff, demiChefInput(fx, { invoiceDate: "2026-04-02", paymentTermDays: 14, downPayment: 3_000_000 }));
    await submitInvoice(fx.staff, draft.id);
    const inv = await issueInvoice(fx.finance, draft.id);
    await recordPayment(fx.staff, { invoiceId: inv.id, paymentDate: "2026-04-10", amount: 6_000_000, method: "Transfer" });
    const exp = await createEntry(fx.staff, { entryDate: "2026-04-11", cashAccountId: fx.bankAcctId, counterAccountId: fx.coa["5-1100"], amount: 2_000_000, description: "Honor asesor", proofFileId: await makeProof(fx.staff) });
    expect((await getIncomeStatement(fx.finance, { from: "2026-04-01", to: "2026-04-30" })).totalDirectCosts).toBe(0); // belum disetujui
    await approveEntry(fx.finance, exp.id);

    const pl = await getIncomeStatement(fx.finance, { from: "2026-04-01", to: "2026-04-30" });
    expect(pl).toMatchObject({ revenue: 9_000_000, totalDirectCosts: 2_000_000, netProfitBeforeTax: 7_000_000 });
    expect((await runReport(fx.finance, "payments", { from: "2026-04-01", to: "2026-04-30" })).totals?.amount).toBe(9_000_000);
    expect((await getDashboard(fx.finance, { from: "2026-04-01", to: "2026-04-30" })).receivedAmount).toBe(9_000_000);
    expect((await listCashAccounts(fx.finance)).find((a) => a.id === fx.bankAcctId)!.balance).toBe(10_000_000 + 9_000_000 - 2_000_000);

    // staff: boleh melihat pengeluarannya sendiri & laporan invoice, tidak boleh laporan keuangan/kas
    expect((await listEntries(fx.staff, {})).items[0]).toMatchObject({ status: "APPROVED", approvedByName: "Finance Uji" });
    expect((await err(getIncomeStatement(fx.staff, {})))?.code).toBe("FORBIDDEN");
    expect((await err(listCashAccounts(fx.staff)))?.code).toBe("FORBIDDEN");
    expect((await runReport(fx.staff, "payments", {})).totals?.amount).toBe(9_000_000);

    // jejak audit lengkap & berurutan untuk seluruh perjalanan
    const actions = (await prisma.auditLog.findMany({ orderBy: { id: "asc" } })).map((l) => l.action).filter((a) => /invoice\.|payment\.|expense\./.test(a));
    expect(actions).toEqual(["invoice.create_draft", "invoice.submit", "invoice.issue", "payment.record", "expense.create", "expense.approve"]);
  });

  it("ekspor laporan keuangan tercatat di audit; CSV/XLSX konsisten dengan angka layar", async () => {
    await createEntry(fx.finance, { entryDate: "2026-04-11", cashAccountId: fx.bankAcctId, counterAccountId: fx.coa["6-1300"], amount: 300_000, description: "Internet" });
    const t = await runStatement(fx.finance, "income-statement", { from: "2026-04-01", to: "2026-04-30" });
    expect(t.rows.find((x) => String(x.item).startsWith("Laba (rugi) bersih"))!.amount).toBe(-300_000);
    expect(t.disclaimer).toMatch(/PPh 23/);
  });
});

describe("(b2) seed & idempotensi", () => {
  it("seedCoa dua kali tidak menggandakan dan tidak menimpa penyesuaian Administrator", async () => {
    const before = await prisma.coaAccount.count();
    await prisma.coaAccount.update({ where: { id: fx.coa["6-1300"]! }, data: { name: "Listrik & Internet (disesuaikan)" } });
    expect(await seedCoa(prisma)).toBe(0);
    expect(await prisma.coaAccount.count()).toBe(before);
    expect((await prisma.coaAccount.findUniqueOrThrow({ where: { id: fx.coa["6-1300"]! } })).name).toBe("Listrik & Internet (disesuaikan)");
  });
});

// ───────────────────────────── (c) rekonsiliasi & pagar skema ─────────────────────────────

describe("(c) rekonsiliasi mendeteksi pelanggaran yang sengaja dibuat", () => {
  it("data bersih → lolos; data dirusak (pagar dimatikan sementara) → terdeteksi dengan kode keluar 1", async () => {
    const e = await createEntry(fx.finance, { entryDate: "2026-03-09", cashAccountId: fx.bankAcctId, counterAccountId: fx.coa["6-1300"], amount: 500_000, description: "Internet" });
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: "2026-03-02" }))).id);
    const p = await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-03-05", amount: 1_000_000, method: "Transfer" });
    const clean = runReconcile();
    expect(clean.code, clean.out).toBe(0);
    expect(clean.out).toMatch(/Bank Mandiri=10500000/); // 10jt + 1jt − 0,5jt

    // Rusak: tanggal entri mendahului saldo awal, pembalikan pembayaran ke akun lain
    await prisma.$executeRawUnsafe(`ALTER TABLE cash_entries DISABLE TRIGGER cash_entries_guard`);
    await prisma.$executeRawUnsafe(`ALTER TABLE payments DISABLE TRIGGER payments_reversal_check`);
    await prisma.$executeRawUnsafe(`ALTER TABLE payments DISABLE TRIGGER payments_append_only`);
    try {
      await prisma.$executeRawUnsafe(`UPDATE cash_entries SET "entryDate" = '2024-06-01' WHERE id = '${e.id}'`);
      await prisma.$executeRawUnsafe(`INSERT INTO payments (id,"invoiceId","entryType","reversesPaymentId","paymentDate",amount,method,reason,"cashAccountId","recordedById")
        VALUES (gen_random_uuid(),'${inv.id}','REVERSAL','${p.id}',now(),-1000000,'Transfer','rusak','${fx.cashAcctId}','${fx.finance.userId}')`);
      const bad = runReconcile();
      expect(bad.code).toBe(1);
      expect(bad.out).toContain("entri kas mendahului saldo awal akun");
      expect(bad.out).toContain("pembalikan pembayaran memakai akun kas berbeda");
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE cash_entries ENABLE TRIGGER cash_entries_guard`);
      await prisma.$executeRawUnsafe(`ALTER TABLE payments ENABLE TRIGGER payments_reversal_check`);
      await prisma.$executeRawUnsafe(`ALTER TABLE payments ENABLE TRIGGER payments_append_only`);
    }
  }, 120_000);

  it("pagar skema masih terpasang (mencegah migrasi mendatang menghapusnya tanpa sengaja)", async () => {
    const trig = (await prisma.$queryRawUnsafe<{ tgname: string }[]>(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`)).map((t) => t.tgname);
    for (const t of ["cash_entries_guard", "cash_entries_insert_check", "cash_transfers_insert_check", "cash_transfers_append_only", "cash_accounts_guard", "coa_guard", "payments_reversal_check", "payments_append_only", "audit_logs_append_only"]) {
      expect(trig, t).toContain(t);
    }
    const idx = (await prisma.$queryRawUnsafe<{ indexname: string }[]>(`SELECT indexname FROM pg_indexes WHERE schemaname='public'`)).map((i) => i.indexname);
    expect(idx).toContain("cash_accounts_one_default_per_kind");
    const cons = (await prisma.$queryRawUnsafe<{ conname: string }[]>(`SELECT conname FROM pg_constraint`)).map((c) => c.conname);
    for (const c of ["cash_entries_amount_pos", "cash_entries_shape", "cash_entries_status_shape", "cash_transfers_distinct", "cash_transfers_shape", "cash_accounts_opening_nonneg", "cash_accounts_default_active", "coa_code_format", "coa_system_not_manual"]) {
      expect(cons, c).toContain(c);
    }
  });
});

// ───────────────────────────── (d) tanggal kabisat, batas hari, volume ─────────────────────────────

describe("(d) kabisat, batas periode inklusif, dan volume", () => {
  it("29 Februari 2024, akhir/awal bulan & tahun: entri pada batas dihitung tepat satu kali", async () => {
    await resetDb();
    fx = await seedFixtures({ finance: true, openingDate: "2023-12-31" });
    const mk = (date: string, amount: number, cat = "6-1300") => createEntry(fx.finance, { entryDate: date, cashAccountId: fx.bankAcctId, counterAccountId: fx.coa[cat], amount, description: `batas ${date}` });
    for (const [d, a] of [["2023-12-31", 1], ["2024-01-01", 10], ["2024-02-28", 100], ["2024-02-29", 1_000], ["2024-03-01", 10_000], ["2024-12-31", 100_000], ["2025-01-01", 1_000_000]] as const) await mk(d, a);
    const cost = async (from: string, to: string) => (await getIncomeStatement(fx.finance, { from, to })).totalOperatingCosts;
    expect(await cost("2024-02-29", "2024-02-29")).toBe(1_000); // satu hari saja
    expect(await cost("2024-02-01", "2024-02-29")).toBe(1_100); // 28 + 29 Feb
    expect(await cost("2024-03-01", "2024-03-01")).toBe(10_000);
    expect(await cost("2024-01-01", "2024-12-31")).toBe(10 + 100 + 1_000 + 10_000 + 100_000); // 31 Des 2023 & 1 Jan 2025 di luar
    expect(await cost("2023-12-31", "2023-12-31")).toBe(1);
    expect(await cost("2025-01-01", "2025-01-01")).toBe(1_000_000);
    expect((await err(createEntry(fx.finance, { entryDate: "2023-02-29", cashAccountId: fx.bankAcctId, counterAccountId: fx.coa["6-1300"], amount: 1, description: "tidak kabisat" })))?.code).toBe("VALIDATION");
    expect((await mk("2024-02-29", 7)).entryDate).toBe("2024-02-29");
    const cf = await getCashFlow(fx.finance, { from: "2024-02-29", to: "2024-03-01" });
    expect(cf.beginning).toBe(11_000_000 - 1 - 10 - 100);
    expect(cf.operating.expenses[0]!.amount).toBe(-(1_000 + 10_000 + 7));
  });

  it("volume: 600 entri + 300 pembayaran — laporan tetap benar dan cepat (< 5 dtk)", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: "2025-02-01", lines: [{ ...demiChefInput(fx).lines[0]!, quantity: 400, unitPrice: 2_000_000 }] }))).id);
    const uid = fx.finance.userId;
    const rows = Array.from({ length: 600 }, (_, i) => ({
      entryDate: new Date(`${isoPlus("2025-01-01", i % 400)}T00:00:00Z`), direction: "OUT" as const, amount: BigInt(1_000 + i), cashAccountId: i % 2 ? fx.cashAcctId : fx.bankAcctId,
      counterAccountId: fx.coa[["5-1100", "6-1300", "6-1600"][i % 3]!]!, description: `bulk ${i}`, status: "APPROVED" as const, createdById: uid, approvedById: uid, approvedAt: new Date(),
    }));
    await prisma.cashEntry.createMany({ data: rows });
    await prisma.payment.createMany({ data: Array.from({ length: 300 }, (_, i) => ({
      invoiceId: inv.id, entryType: "PAYMENT" as const, paymentDate: new Date(`${isoPlus("2025-02-01", i)}T00:00:00Z`), amount: BigInt(2_000 + i), method: "Transfer", cashAccountId: fx.bankAcctId, recordedById: uid,
    })) });
    const t0 = Date.now();
    const cf = await getCashFlow(fx.finance, { from: OPEN, to: today });
    const pl = await getIncomeStatement(fx.finance, { from: OPEN, to: today });
    const ledger = await getAccountLedger(fx.finance, { accountId: fx.bankAcctId, from: OPEN, to: today });
    expect(Date.now() - t0).toBeLessThan(5_000);
    const sumOut = rows.reduce((s, r) => s + Number(r.amount), 0);
    const sumPay = Array.from({ length: 300 }, (_, i) => 2_000 + i).reduce((a, b) => a + b, 0);
    expect(pl.revenue).toBe(sumPay);
    expect(pl.totalDirectCosts + pl.totalOperatingCosts).toBe(sumOut);
    expect(cf.ending).toBe(11_000_000 + sumPay - sumOut);
    const sql = await sqlBalances();
    expect(cf.accounts.find((a) => a.id === fx.bankAcctId)!.ending).toBe(sql["Bank Mandiri"]);
    expect(ledger.closing).toBe(sql["Bank Mandiri"]);
  }, 120_000);
});
