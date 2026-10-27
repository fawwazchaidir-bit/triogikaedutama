import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, type Fixtures } from "../helpers/db";
import { createDraft, issueInvoice } from "@/server/services/invoices";
import { recordPayment } from "@/server/services/payments";
import { createEntry, createTransfer } from "@/server/services/cash-entries";
import { autoMatchStatement, createEntryForLine, createStatement, finalizeStatement, getStatementWorkspace, matchLine, reopenStatement } from "@/server/services/bank-reconciliation";
import { listCashAccounts } from "@/server/services/cash-accounts";

/**
 * REKONSILIASI BANK · PUTARAN 3 — FUZZ BERBASIS MODEL.
 * "Bank" adalah kebenaran terpisah: tiap transaksi buku dikliring bank dengan jeda acak (sebagian beredar lintas bulan / tak pernah),
 * sebagian setoran digabung, ditambah biaya & bunga yang hanya ada di bank. Rekonsiliasi harus berujung selisih 0 tiap bulan, dengan
 * saldo buku cocok dengan SQL murni dan transaksi beredar cocok dengan model.
 */
const YEAR = new Date().getUTCFullYear();
const d = (m: number, day: number) => `${YEAR}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const dayMs = 86_400_000;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);
const eom = (m: number) => new Date(Date.UTC(YEAR, m, 0)).toISOString().slice(0, 10);
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
let fx: Fixtures;
beforeEach(async () => { await resetDb(); fx = await seedFixtures({ finance: true, openingDate: d(1, 1) }); });
afterAll(async () => { await prisma.$disconnect(); });

/** Saldo akun bank pada akhir hari `asOf`, SQL murni (independen dari kode aplikasi). */
async function sqlBankBalance(asOf: string): Promise<number> {
  const [r] = await prisma.$queryRawUnsafe<{ bal: bigint }[]>(`
    SELECT a."openingBalance"
      + COALESCE((SELECT SUM(p."amount") FROM payments p WHERE p."cashAccountId" = a."id" AND p."paymentDate" >= a."openingDate" AND p."paymentDate" <= '${asOf}'), 0)
      + COALESCE((SELECT SUM(CASE WHEN e."direction" = 'IN' THEN e."amount" ELSE -e."amount" END) FROM cash_entries e WHERE e."cashAccountId" = a."id" AND e."status" = 'APPROVED' AND e."entryDate" >= a."openingDate" AND e."entryDate" <= '${asOf}'), 0)
      + COALESCE((SELECT SUM(t."amount") FROM cash_transfers t WHERE t."toAccountId" = a."id" AND t."transferDate" >= a."openingDate" AND t."transferDate" <= '${asOf}'), 0)
      - COALESCE((SELECT SUM(t."amount") FROM cash_transfers t WHERE t."fromAccountId" = a."id" AND t."transferDate" >= a."openingDate" AND t."transferDate" <= '${asOf}'), 0) AS bal
      FROM cash_accounts a WHERE a."id" = '${fx.bankAcctId}'`);
  return Number(r!.bal);
}

interface Truth { type: "PAYMENT" | "CASH_ENTRY" | "TRANSFER"; id: string; date: string; amount: number; clears: string | null; groupWith?: string }
interface BankLine { date: string; description: string; amount: number; kind: "SINGLE" | "GROUP" | "BANKONLY"; items: Truth[]; counter?: string }

async function world(seed: number): Promise<Truth[]> {
  const r = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const truth: Truth[] = [];
  const clearDate = (date: string): string | null => {
    const x = r();
    if (x < 0.07) return null; // tak pernah dikliring dalam kuartal ini
    return addDays(date, Math.floor(r() * 7));
  };
  const invoices: { id: string; balance: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: d(1, 2), paymentTermDays: 30 }))).id);
    invoices.push({ id: inv.id, balance: inv.amounts.total });
  }
  const n = 40 + Math.floor(r() * 20);
  for (let k = 0; k < n; k++) {
    const date = addDays(d(1, 2), Math.floor(r() * 85)); // 2 Jan – akhir Maret
    const kind = pick(["pay", "pay", "pay", "exp", "exp", "tr"]);
    if (kind === "pay") {
      const t = pick(invoices.filter((x) => x.balance > 0));
      if (!t) continue;
      const amount = Math.min(t.balance, 100_000 * (1 + Math.floor(r() * 6)));
      const p = await recordPayment(fx.finance, { invoiceId: t.id, paymentDate: date, amount, method: "Transfer", cashAccountId: fx.bankAcctId });
      t.balance -= amount;
      truth.push({ type: "PAYMENT", id: p.id, date, amount, clears: clearDate(date) });
    } else if (kind === "exp") {
      const amount = 50_000 * (1 + Math.floor(r() * 8));
      const e = await createEntry(fx.finance, { entryDate: date, cashAccountId: fx.bankAcctId, counterAccountId: fx.coa[pick(["6-1300", "6-1600", "5-1200"])]!, amount, description: `Fuzz biaya ${k}` });
      truth.push({ type: "CASH_ENTRY", id: e.id, date, amount: -amount, clears: clearDate(date) });
    } else {
      const amount = 50_000 * (1 + Math.floor(r() * 6));
      const out = r() < 0.5;
      const t = await createTransfer(fx.finance, { transferDate: date, fromAccountId: out ? fx.bankAcctId : fx.cashAcctId, toAccountId: out ? fx.cashAcctId : fx.bankAcctId, amount });
      truth.push({ type: "TRANSFER", id: t.id, date, amount: out ? -amount : amount, clears: clearDate(date) });
    }
  }
  return truth;
}

/** Susun baris rekening koran sebuah bulan dari model "bank". */
function bankLines(truth: Truth[], m: number, r: () => number): BankLine[] {
  const lo = d(m, 1), hi = eom(m);
  const clearing = truth.filter((t) => t.clears !== null && t.clears >= lo && t.clears <= hi);
  const lines: BankLine[] = [];
  const used = new Set<string>();
  // gabungkan sebagian setoran (pembayaran masuk yang dikliring pada hari yang sama) menjadi satu baris
  const byDay = new Map<string, Truth[]>();
  for (const t of clearing.filter((x) => x.type === "PAYMENT")) (byDay.get(t.clears!) ?? byDay.set(t.clears!, []).get(t.clears!)!).push(t);
  for (const [day, ts] of byDay) {
    if (ts.length >= 2 && r() < 0.6) {
      const grp = ts.slice(0, 2 + Math.floor(r() * Math.min(ts.length - 1, 2)));
      lines.push({ date: day, description: "SETORAN KLIRING GABUNGAN", amount: grp.reduce((s, x) => s + x.amount, 0), kind: "GROUP", items: grp });
      grp.forEach((g) => used.add(g.id));
    }
  }
  for (const t of clearing) {
    if (used.has(t.id)) continue;
    lines.push({ date: t.clears!, description: t.type === "PAYMENT" ? "TRF MASUK" : t.type === "TRANSFER" ? "TRANSFER KE/DARI KAS" : "DEBIT BIAYA", amount: t.amount, kind: "SINGLE", items: [t] });
  }
  // biaya & bunga yang hanya ada di bank
  for (let i = 0; i < 2 + Math.floor(r() * 2); i++) {
    const day = d(m, 1 + Math.floor(r() * 27));
    if (r() < 0.6) lines.push({ date: day, description: "BIAYA ADM", amount: -(1000 * (5 + Math.floor(r() * 20))), kind: "BANKONLY", items: [], counter: "6-1800" });
    else lines.push({ date: day, description: "BUNGA", amount: 1000 * (3 + Math.floor(r() * 30)), kind: "BANKONLY", items: [], counter: "4-2200" });
  }
  return lines.sort((a, b) => a.date.localeCompare(b.date));
}

const SEEDS = [3, 17, 29, 41, 53, 67];
describe("fuzz rekonsiliasi bank: 3 bulan berturut-turut selisih 0", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}`, async () => {
      const truth = await world(seed);
      const r = rng(seed * 104729);
      let opening = 10_000_000;
      let groups = 0, bankOnly = 0;
      const stmtIds: string[] = [];
      for (const m of [1, 2, 3]) {
        const lines = bankLines(truth, m, r);
        const sum = lines.reduce((s, l) => s + l.amount, 0);
        const st = await createStatement(fx.finance, {
          cashAccountId: fx.bankAcctId, periodStart: d(m, 1), periodEnd: eom(m), openingBalance: opening, closingBalance: opening + sum, label: `Fuzz ${m}`,
          lines: lines.map((l) => ({ txDate: l.date, description: l.description, amount: l.amount })),
        });
        stmtIds.push(st.id);
        let ws = await getStatementWorkspace(fx.finance, st.id);
        const lineOf = (bl: BankLine, used: Set<string>) => ws.lines.find((l) => !used.has(l.id) && l.txDate === bl.date && l.amount === bl.amount && l.description === bl.description)!;
        const claimed = new Set<string>();
        // 1) setoran gabungan secara manual (agar pencocokan otomatis tidak mencurinya)
        for (const bl of lines.filter((x) => x.kind === "GROUP")) {
          const ln = lineOf(bl, claimed); claimed.add(ln.id);
          await matchLine(fx.finance, ln.id, { items: bl.items.map((t) => ({ type: t.type, id: t.id })) });
          groups++;
        }
        // 2) otomatis
        await autoMatchStatement(fx.finance, st.id, { windowDays: 7 });
        ws = await getStatementWorkspace(fx.finance, st.id);
        // 3) sisanya: biaya/bunga dari bank → entri kas; baris tunggal yang ambigu → pilih transaksi bebas bernilai sama
        for (const ln of ws.lines.filter((l) => l.matched !== l.amount)) {
          const bo = lines.find((b) => b.kind === "BANKONLY" && b.date === ln.txDate && b.amount === ln.amount && b.description === ln.description);
          if (bo) { await createEntryForLine(fx.finance, ln.id, { counterAccountId: fx.coa[bo.counter!]! }); bankOnly++; continue; }
          const fresh = await getStatementWorkspace(fx.finance, st.id);
          const free = fresh.outstanding.find((i) => i.matchedIn === null && i.amount === ln.amount && i.date <= ln.txDate);
          expect(free, `seed ${seed} bulan ${m}: harus ada transaksi bebas bernilai ${ln.amount} untuk baris ${ln.description}`).toBeTruthy();
          await matchLine(fx.finance, ln.id, { items: [{ type: free!.type, id: free!.id }] });
        }
        ws = await getStatementWorkspace(fx.finance, st.id);
        const end = eom(m);
        expect(ws.summary.unmatchedLines, `seed ${seed} bulan ${m}`).toBe(0);
        expect(ws.summary.difference, `seed ${seed} bulan ${m}: selisih`).toBe(0);
        expect(ws.summary.bookBalance, `seed ${seed} bulan ${m}: saldo buku = SQL`).toBe(await sqlBankBalance(end));
        // transaksi beredar menurut model: dated ≤ akhir bulan dan belum dikliring sampai akhir bulan (dengan transaksi bank-only otomatis cocok)
        const outstandingModel = truth.filter((t) => t.date <= end && (t.clears === null || t.clears > end)).reduce((s, t) => s + t.amount, 0);
        expect(ws.summary.outstandingNet, `seed ${seed} bulan ${m}: beredar`).toBe(outstandingModel);
        await finalizeStatement(fx.finance, st.id);
        opening += sum;
      }
      expect(groups + bankOnly).toBeGreaterThan(0);
      // akhir Maret: saldo buku aplikasi akun = SQL
      const bal = (await listCashAccounts(fx.finance)).find((a) => a.id === fx.bankAcctId)!.balance;
      expect(bal).toBe(await sqlBankBalance("2999-12-31"));
      // Maret dibuka kembali lalu difinalisasi ulang tanpa mengubah apa pun
      await reopenStatement(fx.finance, stmtIds[2]!, { reason: "Uji buka kembali fuzz" });
      expect((await getStatementWorkspace(fx.finance, stmtIds[2]!)).summary.canFinalize).toBe(true);
      await finalizeStatement(fx.finance, stmtIds[2]!);
    }, 240_000);
  }
});

describe("db:reconcile atas rekonsiliasi bank", () => {
  const run = () => { try { return { code: 0, out: execFileSync("npx", ["tsx", "--conditions=react-server", "scripts/reconcile.ts"], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; } catch (e) { const x = e as { status?: number; stdout?: string; stderr?: string }; return { code: x.status ?? 99, out: `${x.stdout ?? ""}${x.stderr ?? ""}` }; } };
  it("data sah bersih; kerusakan lewat SQL (memintas pemicu) terdeteksi", async () => {
    const truth = await world(5);
    const r = rng(77);
    const lines = bankLines(truth, 1, r).filter((l) => l.kind === "SINGLE");
    const sum = lines.reduce((s, l) => s + l.amount, 0);
    const st = await createStatement(fx.finance, { cashAccountId: fx.bankAcctId, periodStart: d(1, 1), periodEnd: eom(1), openingBalance: 10_000_000, closingBalance: 10_000_000 + sum, lines: lines.map((l) => ({ txDate: l.date, description: l.description, amount: l.amount })) });
    await autoMatchStatement(fx.finance, st.id, { windowDays: 7 });
    expect(run().code).toBe(0);
    const ws = await getStatementWorkspace(fx.finance, st.id);
    for (const ln of ws.lines.filter((l) => l.matched !== l.amount)) {
      const free = (await getStatementWorkspace(fx.finance, st.id)).outstanding.find((i) => i.matchedIn === null && i.amount === ln.amount);
      if (free) await matchLine(fx.finance, ln.id, { items: [{ type: free.type, id: free.id }] });
    }
    const fin = await getStatementWorkspace(fx.finance, st.id);
    expect(fin.summary.canFinalize, JSON.stringify(fin.summary)).toBe(true);
    await finalizeStatement(fx.finance, st.id);
    expect(run().code).toBe(0);
    await prisma.$executeRawUnsafe(`ALTER TABLE bank_matches DISABLE TRIGGER USER`);
    try {
      const m = await prisma.bankMatch.findFirstOrThrow({});
      await prisma.$executeRawUnsafe(`DELETE FROM bank_matches WHERE id = '${m.id}'`);
      const bad = run();
      expect(bad.code, bad.out).toBe(1);
      expect(bad.out).toMatch(/rekonsiliasi bank/i);
    } finally { await prisma.$executeRawUnsafe(`ALTER TABLE bank_matches ENABLE TRIGGER USER`); }
  }, 120_000);
});
