import { writeFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, type Fixtures } from "../helpers/db";
import { createDraft, issueInvoice } from "@/server/services/invoices";
import { recordPayment } from "@/server/services/payments";
import { createEntry, createTransfer } from "@/server/services/cash-entries";
import { createJournal } from "@/server/services/journals";
import { getTrialBalance } from "@/server/services/finance-ledger";
import { closePeriod, listPeriods, reopenPeriod } from "@/server/services/periods";
import { getBooksLock } from "@/server/services/books-lock";
import { periodEnd } from "@/lib/accounting/periods";
import { AppError } from "@/server/errors";

/**
 * TUTUP BUKU · PUTARAN 3 — FUZZ BERBASIS MODEL.
 * Urutan acak transaksi bertanggal acak (Jan–Apr 2026) + tutup/buka bulan acak. "Model bayangan" hanya melacak bulan terakhir yang ditutup;
 * dari situ diturunkan: transaksi bertanggal ≤ akhir bulan itu HARUS ditolak, sisanya HARUS diterima. Oracle independen (SQL mentah)
 * memeriksa foto tiap periode tertutup: aset, pendapatan, dan laba bulan itu. Selain itu "pembekuan": neraca saldo tiap periode tertutup
 * tidak boleh berubah sejak saat ditutup, apa pun yang terjadi sesudahnya.
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

function rng(seed: number) {
  let s = seed;
  const next = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T,>(a: readonly T[]) => a[Math.floor(next() * a.length)]! };
}
const dateOf = (offset: number) => new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);

// ───────── Oracle independen (SQL mentah, tanpa kode akuntansi aplikasi) ─────────
const assetsAt = (end: string) => q(`SELECT (
    (SELECT COALESCE(SUM("openingBalance"),0) FROM cash_accounts WHERE "openingDate" <= '${end}')
  + (SELECT COALESCE(SUM(amount),0) FROM payments WHERE "paymentDate" <= '${end}' AND "cashAccountId" IS NOT NULL)
  + (SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN amount ELSE -amount END),0) FROM cash_entries WHERE status = 'APPROVED' AND "entryDate" <= '${end}')
  - (SELECT COALESCE(SUM(jl.credit - jl.debit),0) FROM journal_lines jl JOIN journal_entries je ON je.id = jl."journalId" JOIN coa_accounts a ON a.id = jl."accountId" WHERE a.code = '1-2900' AND je."journalDate" <= '${end}')
  )::bigint AS v`);
const revenueIn = (from: string, to: string) => q(`SELECT COALESCE(SUM(amount),0)::bigint AS v FROM payments WHERE "paymentDate" BETWEEN '${from}' AND '${to}'`);
const expenseIn = (from: string, to: string) => q(`SELECT (
    (SELECT COALESCE(SUM(amount),0) FROM cash_entries WHERE status = 'APPROVED' AND direction = 'OUT' AND "entryDate" BETWEEN '${from}' AND '${to}')
  + (SELECT COALESCE(SUM(jl.debit - jl.credit),0) FROM journal_lines jl JOIN journal_entries je ON je.id = jl."journalId" JOIN coa_accounts a ON a.id = jl."accountId" WHERE a.code = '6-2000' AND je."journalDate" BETWEEN '${from}' AND '${to}')
  )::bigint AS v`);

async function run(seed: number, steps: number) {
  const R = rng(seed);
  const big = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: "2026-01-01", paymentTermDays: 30, lines: [{ ...demiChefInput(fx).lines[0]!, quantity: 700 }] }))).id);
  let lastClosed = 0; // bulan terakhir yang ditutup menurut model (0 = tidak ada)
  const frozen = new Map<number, string>(); // bulan → neraca saldo saat ditutup
  const tbJson = async (m: number) => JSON.stringify((await getTrialBalance(fx.finance, { to: periodEnd(2026, m) })).rows.map((r) => [r.code, r.net]));
  const lockEnd = () => (lastClosed ? periodEnd(2026, lastClosed) : null);
  const log: string[] = [];

  const expectOutcome = async (date: string, label: string, act: () => Promise<unknown>) => {
    const lock = lockEnd();
    const e = await err(act());
    const shouldReject = lock !== null && date <= lock;
    log.push(`${label} ${date} → ${e ? e.code : "ok"}`);
    if (shouldReject) { expect(e?.code, `${label} ${date} (kunci ${lock}) harus ditolak\n${log.slice(-6).join("\n")}`).toBe("VALIDATION"); }
    else expect(e, `${label} ${date} (kunci ${lock}) harus diterima: ${e?.message}\n${log.slice(-6).join("\n")}`).toBeNull();
  };

  for (let i = 0; i < steps; i++) {
    const op = R.int(0, 99);
    const date = dateOf(R.int(0, 119));
    if (op < 28) await expectOutcome(date, "bayar", () => recordPayment(fx.finance, { invoiceId: big.id, paymentDate: date, amount: R.int(10, 500) * 1000, method: "Transfer" }));
    else if (op < 55) await expectOutcome(date, "beban", () => createEntry(fx.finance, { entryDate: date, cashAccountId: R.pick([fx.bankAcctId, fx.cashAcctId]), counterAccountId: c(R.pick(["6-1300", "6-1600", "6-1400"])), amount: R.int(1, 300) * 1000, description: `Beban ${i}` }));
    else if (op < 65) await expectOutcome(date, "transfer", () => createTransfer(fx.finance, { transferDate: date, fromAccountId: fx.bankAcctId, toAccountId: fx.cashAcctId, amount: R.int(1, 100) * 1000 }));
    else if (op < 75) {
      const amount = R.int(1, 50) * 1000;
      await expectOutcome(date, "jurnal", () => createJournal(fx.finance, { journalDate: date, description: `Penyusutan ${i}`, lines: [{ accountId: c("6-2000"), debit: amount, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: amount }] }));
    }
    else if (op < 90) {
      const m = R.pick([lastClosed + 1, lastClosed + 1, lastClosed + 1, lastClosed + 2, lastClosed, 10]);
      const ok = m === lastClosed + 1 && m >= 1 && m <= 9;
      const e = await err(closePeriod(fx.finance, { year: 2026, month: m, acknowledge: ["bank-recon", "negative-cash", "unallocated", "withholding-ref", "draft-invoices"], note: `Tutup ${m}` }));
      log.push(`tutup ${m} → ${e ? e.code : "ok"}`);
      if (ok) { expect(e, `tutup ${m} harus berhasil: ${e?.message}\n${log.slice(-6).join("\n")}`).toBeNull(); lastClosed = m; frozen.set(m, await tbJson(m)); }
      else expect(e?.code, `tutup ${m} (terakhir ${lastClosed}) harus ditolak`).toBe("CONFLICT");
    } else {
      const m = R.pick([lastClosed, lastClosed, lastClosed - 1, lastClosed + 1]);
      const ok = lastClosed > 0 && m === lastClosed;
      const e = await err(reopenPeriod(fx.finance, { year: 2026, month: m < 1 ? 1 : m, reason: `Buka ${m}` }));
      log.push(`buka ${m} → ${e ? e.code : "ok"}`);
      if (ok) { expect(e, `buka ${m} harus berhasil: ${e?.message}`).toBeNull(); frozen.delete(lastClosed); lastClosed -= 1; }
      else expect(e?.code, `buka ${m} (terakhir ${lastClosed}) harus ditolak`).toBe("CONFLICT");
    }

    // invarian setiap langkah
    expect(await getBooksLock(), `kunci setelah langkah ${i}\n${log.slice(-4).join("\n")}`).toBe(lockEnd());
    if (i % 5 === 4 || i === steps - 1) {
      const list = await listPeriods(fx.finance);
      expect(list.lockConsistent).toBe(true);
      expect(list.periods.filter((p) => p.state === "CLOSED").map((p) => p.month).sort((a, b) => a - b)).toEqual(Array.from({ length: lastClosed }, (_, k) => k + 1));
      for (const p of list.periods.filter((x) => x.state === "CLOSED")) {
        const end = periodEnd(2026, p.month), start = `2026-${String(p.month).padStart(2, "0")}-01`;
        expect(p.verified, `foto ${p.key} harus cocok\n${log.slice(-6).join("\n")}`).toBe(true);
        expect(p.snapshot!.assets, `aset ${p.key}`).toBe(await assetsAt(end));
        const rev = await revenueIn(start, end), exp = await expenseIn(start, end);
        expect(p.snapshot!.revenue, `pendapatan ${p.key}`).toBe(rev);
        expect(p.snapshot!.profitBeforeTax, `laba ${p.key}`).toBe(rev - exp);
        expect(await tbJson(p.month), `neraca saldo ${p.key} berubah setelah ditutup`).toBe(frozen.get(p.month));
      }
    }
  }
  return { lastClosed, log };
}

describe("fuzz: model penutupan vs layanan + oracle SQL", () => {
  for (const seed of [101, 202, 303]) {
    it(`benih ${seed}: 70 langkah acak`, async () => {
      const { lastClosed, log } = await run(seed, 70);
      if (process.env.FUZZ_LOG) writeFileSync(`${process.env.FUZZ_LOG}/fuzz-${seed}.log`, `tertutup sampai bulan ${lastClosed}\n${log.join("\n")}\n`);
      // pastikan skenario benar-benar menguji penutupan (bukan cuma transaksi)
      expect(log.filter((l) => l.startsWith("tutup") && l.endsWith("ok")).length).toBeGreaterThan(0);
      expect(log.filter((l) => /→ VALIDATION$/.test(l) && !l.startsWith("tutup") && !l.startsWith("buka")).length + lastClosed).toBeGreaterThan(0);
    }, 240_000);
  }
});
