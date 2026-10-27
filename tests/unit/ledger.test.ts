import { describe, expect, it } from "vitest";
import {
  balanceSheet, deriveLines, generalLedger, glIncome, groupJournals, trialBalance,
  type CoaType, type GlAccount, type GlInput,
} from "@/lib/accounting/ledger";
import { accountBalance, buildIncomeStatement, type StmtData } from "@/lib/accounting/statements";

/** PUTARAN 1 (tahap 2, unit) — buku besar basis kas; seluruh angka dihitung tangan di komentar. */
const mk = (code: string, name: string, type: CoaType): GlAccount => ({ id: `a-${code}`, code, name, type });
const COA: GlAccount[] = [
  mk("1-1100", "Kas", "ASET"), mk("1-1200", "Bank", "ASET"), mk("1-1400", "PPh dibayar dimuka", "ASET"), mk("1-1450", "Penerimaan belum dialokasikan", "ASET"),
  mk("2-1210", "Utang PPN", "KEWAJIBAN"), mk("2-1230", "Utang PPh badan", "KEWAJIBAN"),
  mk("1-2100", "Peralatan", "ASET"), mk("1-2900", "Akumulasi penyusutan", "ASET"), mk("2-2100", "Utang bank", "KEWAJIBAN"),
  mk("3-1100", "Modal", "EKUITAS"), mk("3-1200", "Prive", "EKUITAS"), mk("3-2100", "Saldo laba", "EKUITAS"),
  mk("4-1100", "Pendapatan jasa", "PENDAPATAN"), mk("4-2200", "Bunga", "PENDAPATAN"),
  mk("5-1100", "Honor", "BEBAN"), mk("6-1600", "ATK", "BEBAN"), mk("6-2000", "Penyusutan", "BEBAN"), mk("7-1100", "PPh badan", "BEBAN"),
];
const id = (code: string) => `a-${code}`;
const ca = (n: string, coa: string, opening: number, date: string, kind: "KAS" | "BANK" = "BANK") => ({ id: n, name: n, kind, openingBalance: opening, openingDate: date, coaAccountId: id(coa) });

function base(): GlInput {
  let t = 0;
  const at = () => `2026-01-01T00:00:${String(t++).padStart(2, "0")}.000Z`;
  return {
    coa: COA,
    accounts: [ca("bank", "1-1200", 10_000_000, "2026-01-01"), ca("kas", "1-1100", 1_000_000, "2026-01-01", "KAS")],
    payments: [
      { id: "p1", date: "2026-01-10", createdAt: at(), amount: 5_000_000, withholding: 0, vat: 0, accountId: "bank", label: "invoice 00434" },
      { id: "p2", date: "2026-01-12", createdAt: at(), amount: 9_000_000, withholding: 0, vat: 0, accountId: "bank", label: "invoice 00435" },
      { id: "p3", date: "2026-01-15", createdAt: at(), amount: 2_000_000, withholding: 0, vat: 0, accountId: null, label: "invoice 00436" },
      { id: "p4", date: "2026-02-03", createdAt: at(), amount: -5_000_000, withholding: 0, vat: 0, accountId: "bank", label: "invoice 00434" },
      { id: "p0", date: "2025-12-20", createdAt: at(), amount: 700_000, withholding: 0, vat: 0, accountId: "bank", label: "invoice 00001" }, // pra-pembukuan
    ],
    entries: [
      { id: "e1", date: "2026-01-05", createdAt: at(), direction: "IN", amount: 20_000_000, accountId: "bank", counterAccountId: id("3-1100"), description: "Setoran modal", entryType: "ENTRY" },
      { id: "e2", date: "2026-01-20", createdAt: at(), direction: "OUT", amount: 3_000_000, accountId: "bank", counterAccountId: id("5-1100"), description: "Honor asesor", entryType: "ENTRY" },
      { id: "e3", date: "2026-01-25", createdAt: at(), direction: "OUT", amount: 275_000, accountId: "kas", counterAccountId: id("6-1600"), description: "ATK", entryType: "ENTRY" },
      { id: "e4", date: "2026-01-30", createdAt: at(), direction: "OUT", amount: 4_000_000, accountId: "bank", counterAccountId: id("1-2100"), description: "Beli laptop", entryType: "ENTRY" },
      { id: "e5", date: "2026-02-05", createdAt: at(), direction: "IN", amount: 3_000_000, accountId: "bank", counterAccountId: id("5-1100"), description: "Pembalikan: Honor asesor", entryType: "REVERSAL" },
      { id: "e6", date: "2026-02-10", createdAt: at(), direction: "IN", amount: 100_000, accountId: "bank", counterAccountId: id("4-2200"), description: "Jasa giro", entryType: "ENTRY" },
    ],
    transfers: [{ id: "t1", date: "2026-01-18", createdAt: at(), fromId: "bank", toId: "kas", amount: 1_000_000, description: "Isi kas" }],
    manual: [
      { id: "m1", label: "JU-000001", date: "2026-01-01", createdAt: at(), description: "Saldo awal peralatan", lines: [{ accountId: id("1-2100"), debit: 5_000_000, credit: 0, memo: null }, { accountId: id("3-1100"), debit: 0, credit: 5_000_000, memo: null }] },
      { id: "m2", label: "JU-000002", date: "2026-01-31", createdAt: at(), description: "Penyusutan Januari", lines: [{ accountId: id("6-2000"), debit: 100_000, credit: 0, memo: null }, { accountId: id("1-2900"), debit: 0, credit: 100_000, memo: "peralatan" }] },
    ],
  };
}
const bal = (lines: ReturnType<typeof deriveLines>, code: string, asOf: string) => {
  const tb = trialBalance(lines, COA, asOf);
  return tb.rows.find((r) => r.code === code)?.net ?? 0;
};

describe("penurunan jurnal dari kejadian kas", () => {
  it("setiap sumber menghasilkan jurnal seimbang (debit = kredit per sumber)", () => {
    const lines = deriveLines(base());
    for (const j of groupJournals(lines)) {
      expect(j.lines.reduce((s, l) => s + l.debit, 0), j.key).toBe(j.lines.reduce((s, l) => s + l.credit, 0));
    }
  });

  it("neraca saldo per 31 Jan 2026 (hitungan tangan)", () => {
    const lines = deriveLines(base());
    const tb = trialBalance(lines, COA, "2026-01-31");
    // bank 10+5+9+20−3−4−1 = 36jt ; kas 1+1−0,275 = 1,725jt ; 1-1450 = 2jt ; peralatan 4+5 = 9jt ; akumulasi −0,1jt (kredit)
    expect(Object.fromEntries(tb.rows.map((r) => [r.code, r.net]))).toEqual({
      "1-1100": 1_725_000, "1-1200": 36_000_000, "1-1450": 2_000_000, "1-2100": 9_000_000, "1-2900": -100_000,
      "3-1100": -25_000_000, "3-2100": -11_000_000, "4-1100": -16_000_000, "5-1100": 3_000_000, "6-1600": 275_000, "6-2000": 100_000,
    });
    expect(tb.totalDebit).toBe(52_100_000);
    expect(tb.totalCredit).toBe(52_100_000);
    expect(tb.balanced).toBe(true);
  });

  it("pembayaran pra-pembukuan (sebelum saldo awal akun) tidak dijurnal; belum dialokasikan → 1-1450", () => {
    const lines = deriveLines(base());
    expect(lines.some((l) => l.sourceId === "p0")).toBe(false);
    const p3 = lines.filter((l) => l.sourceId === "p3");
    expect(p3.map((l) => [l.accountId, l.debit, l.credit])).toEqual([[id("1-1450"), 2_000_000, 0], [id("4-1100"), 0, 2_000_000]]);
  });

  it("pembalikan membalik sisi: pembayaran negatif → Dr pendapatan / Cr kas; entri masuk pada beban → Dr kas / Cr beban", () => {
    const lines = deriveLines(base());
    expect(lines.filter((l) => l.sourceId === "p4").map((l) => [l.accountId, l.debit, l.credit])).toEqual([[id("4-1100"), 5_000_000, 0], [id("1-1200"), 0, 5_000_000]]);
    expect(lines.filter((l) => l.sourceId === "e5").map((l) => [l.accountId, l.debit, l.credit])).toEqual([[id("1-1200"), 3_000_000, 0], [id("5-1100"), 0, 3_000_000]]);
    expect(bal(lines, "5-1100", "2026-02-28")).toBe(0); // beban Honor kembali nol setelah pembalikan
  });

  it("saldo akun kas di buku besar = saldo modul kas (implementasi independen tahap 1)", () => {
    const d = base();
    const lines = deriveLines(d);
    const stmt: StmtData = {
      accounts: d.accounts, payments: d.payments.map((p) => ({ date: p.date, amount: p.amount, withholding: p.withholding, vat: p.vat, accountId: p.accountId })),
      entries: d.entries.map((e) => ({ date: e.date, direction: e.direction, amount: e.amount, accountId: e.accountId, counter: { id: e.counterAccountId, code: "x", name: "x", type: "BEBAN", section: "OPERASI" } })),
      transfers: d.transfers.map((t) => ({ date: t.date, fromId: t.fromId, toId: t.toId, amount: t.amount })),
    };
    for (const asOf of ["2026-01-01", "2026-01-31", "2026-02-28", "2026-12-31"]) {
      expect(bal(lines, "1-1200", asOf), asOf).toBe(accountBalance(d.accounts[0]!, stmt, asOf));
      expect(bal(lines, "1-1100", asOf), asOf).toBe(accountBalance(d.accounts[1]!, stmt, asOf));
    }
  });
});

describe("neraca (laporan posisi keuangan)", () => {
  it("31 Jan 2026: aset 48,625jt = liabilitas 0 + ekuitas 48,625jt (modal 25 + saldo laba 11 + laba berjalan 12,625)", () => {
    const b = balanceSheet(deriveLines(base()), COA, "2026-01-31");
    expect(b.currentAssets.map((i) => [i.code, i.amount])).toEqual([["1-1100", 1_725_000], ["1-1200", 36_000_000], ["1-1450", 2_000_000]]);
    expect(b.fixedAssets.map((i) => [i.code, i.amount])).toEqual([["1-2100", 9_000_000], ["1-2900", -100_000]]); // akumulasi = pengurang aset
    expect(b.totalAssets).toBe(48_625_000);
    expect(b.totalLiabilities).toBe(0);
    expect(b.equity.map((i) => [i.code, i.amount])).toEqual([["3-1100", 25_000_000], ["3-2100", 11_000_000]]);
    expect(b.currentYearProfit).toBe(12_625_000); // 16 − 3 − 0,275 − 0,1
    expect(b.retainedEarningsPrior).toBe(0);
    expect(b.totalEquity).toBe(48_625_000);
    expect(b.balanced).toBe(true);
  });

  it("lintas tahun: laba tahun lalu menjadi 'saldo laba sebelumnya', laba tahun ini terpisah; tetap seimbang", () => {
    const d = base();
    d.accounts = [ca("bank", "1-1200", 1_000_000, "2025-01-01")];
    d.payments = [{ id: "a", date: "2025-06-10", createdAt: "1", amount: 10_000_000, withholding: 0, vat: 0, accountId: "bank", label: "i1" }, { id: "b", date: "2026-02-10", createdAt: "2", amount: 3_000_000, withholding: 0, vat: 0, accountId: "bank", label: "i2" }];
    d.entries = [{ id: "c", date: "2025-07-01", createdAt: "3", direction: "OUT", amount: 4_000_000, accountId: "bank", counterAccountId: id("5-1100"), description: "Honor", entryType: "ENTRY" }];
    d.transfers = []; d.manual = [];
    const lines = deriveLines(d);
    const b = balanceSheet(lines, COA, "2026-03-01");
    expect(b.retainedEarningsPrior).toBe(6_000_000); // 2025: 10 − 4
    expect(b.currentYearProfit).toBe(3_000_000);
    expect(b.totalAssets).toBe(1_000_000 + 10_000_000 - 4_000_000 + 3_000_000);
    expect(b.equity.map((i) => [i.code, i.amount])).toEqual([["3-2100", 1_000_000]]);
    expect(b.balanced).toBe(true);
    // 31 Des 2025: seluruh laba 2025 masih "tahun berjalan"
    const b25 = balanceSheet(lines, COA, "2025-12-31");
    expect(b25).toMatchObject({ retainedEarningsPrior: 0, currentYearProfit: 6_000_000, balanced: true });
  });

  it("sebelum tanggal mulai: nol dan seimbang", () => {
    const b = balanceSheet(deriveLines(base()), COA, "2025-12-31");
    expect(b.totalAssets).toBe(0);
    expect(b.balanced).toBe(true);
  });

  it("prive mengurangi ekuitas (saldo debit pada akun ekuitas); utang bank menambah liabilitas jangka panjang", () => {
    const d = base();
    d.entries.push({ id: "e7", date: "2026-01-28", createdAt: "z1", direction: "OUT", amount: 2_000_000, accountId: "bank", counterAccountId: id("3-1200"), description: "Prive", entryType: "ENTRY" });
    d.entries.push({ id: "e8", date: "2026-01-29", createdAt: "z2", direction: "IN", amount: 7_000_000, accountId: "bank", counterAccountId: id("2-2100"), description: "Pinjaman", entryType: "ENTRY" });
    const b = balanceSheet(deriveLines(d), COA, "2026-01-31");
    expect(b.equity.find((i) => i.code === "3-1200")!.amount).toBe(-2_000_000);
    expect(b.longTermLiabilities).toEqual([{ code: "2-2100", name: "Utang bank", amount: 7_000_000 }]);
    expect(b.totalAssets).toBe(48_625_000 - 2_000_000 + 7_000_000);
    expect(b.balanced).toBe(true);
  });
});

describe("laba rugi dari buku besar & buku besar per akun", () => {
  it("Januari: laba bersih sebelum pajak 12,625jt = laba modul kas 12,725jt − penyusutan 0,1jt (jurnal manual)", () => {
    const d = base();
    const lines = deriveLines(d);
    const g = glIncome(lines, COA, "2026-01-01", "2026-01-31");
    expect(g).toMatchObject({ totalRevenue: 16_000_000, totalDirectCosts: 3_000_000, grossProfit: 13_000_000, totalOperatingCosts: 375_000, profitBeforeTax: 12_625_000, netProfit: 12_625_000 });
    const stage1 = buildIncomeStatement({
      accounts: d.accounts, payments: d.payments.map((p) => ({ date: p.date, amount: p.amount, withholding: p.withholding, vat: p.vat, accountId: p.accountId })),
      entries: d.entries.map((e) => ({ date: e.date, direction: e.direction, amount: e.amount, accountId: e.accountId, counter: { id: e.counterAccountId, code: COA.find((a) => a.id === e.counterAccountId)!.code, name: "x", type: COA.find((a) => a.id === e.counterAccountId)!.type, section: "OPERASI" } })),
      transfers: [],
    }, "2026-01-01", "2026-01-31");
    expect(stage1.netProfitBeforeTax).toBe(12_725_000);
    expect(stage1.netProfitBeforeTax - g.profitBeforeTax).toBe(100_000); // tepat selisih jurnal manual penyusutan
  });

  it("pajak penghasilan (jurnal manual 7-xxxx) dikurangkan setelah laba sebelum pajak", () => {
    const d = base();
    d.manual.push({ id: "m3", label: "JU-000003", date: "2026-01-31", createdAt: "zz", description: "Estimasi PPh badan", lines: [{ accountId: id("7-1100"), debit: 500_000, credit: 0, memo: null }, { accountId: id("2-2100"), debit: 0, credit: 500_000, memo: null }] });
    const g = glIncome(deriveLines(d), COA, "2026-01-01", "2026-01-31");
    expect(g.profitBeforeTax).toBe(12_625_000);
    expect(g.totalIncomeTax).toBe(500_000);
    expect(g.netProfit).toBe(12_125_000);
    expect(balanceSheet(deriveLines(d), COA, "2026-01-31").balanced).toBe(true);
  });

  it("buku besar pendapatan: saldo awal, mutasi berurutan, penutup", () => {
    const g = generalLedger(deriveLines(base()), COA.find((a) => a.code === "4-1100")!, "2026-02-01", "2026-02-28");
    expect(g.opening).toBe(16_000_000);
    expect(g.rows.map((r) => [r.date, r.debit, r.credit, r.balance])).toEqual([["2026-02-03", 5_000_000, 0, 11_000_000]]);
    expect(g.closing).toBe(11_000_000);
    const bank = generalLedger(deriveLines(base()), COA.find((a) => a.code === "1-1200")!, "2026-01-01", "2026-01-31");
    expect(bank.rows[0]).toMatchObject({ source: "OPENING_CASH", debit: 10_000_000, balance: 10_000_000 });
    expect(bank.closing).toBe(36_000_000);
    expect(bank.totalDebit - bank.totalCredit).toBe(36_000_000);
  });
});

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const dayOf = (n: number) => new Date(Date.UTC(2025, 0, 1 + n)).toISOString().slice(0, 10);

describe("properti (400 data acak): buku besar selalu seimbang & konsisten dengan modul kas", () => {
  it("neraca saldo seimbang, aset = liabilitas + ekuitas, saldo akun kas = modul kas, laba GL = laba modul kas (tanpa jurnal manual)", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed * 7919);
      const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
      const accounts = [ca("bank", "1-1200", Math.floor(r() * 5_000_000), dayOf(Math.floor(r() * 30))), ca("kas", "1-1100", Math.floor(r() * 2_000_000), dayOf(Math.floor(r() * 30)), "KAS")];
      const counters = ["3-1100", "3-1200", "2-2100", "1-2100", "4-2200", "5-1100", "6-1600"];
      let n = 0;
      const open = (a: string) => accounts.find((x) => x.id === a)!.openingDate;
      const d: GlInput = {
        coa: COA, accounts,
        payments: Array.from({ length: Math.floor(r() * 10) }, () => { const a = r() < 0.15 ? null : pick(accounts).id; return { id: `p${n}`, date: dayOf(Math.floor(r() * 400)), createdAt: String(n++).padStart(6, "0"), amount: (r() < 0.2 ? -1 : 1) * (1 + Math.floor(r() * 2_000_000)), withholding: 0, vat: 0, accountId: a, label: "inv" }; }),
        entries: Array.from({ length: Math.floor(r() * 14) }, () => { const a = pick(accounts).id; const c = pick(counters); const date = dayOf(Math.max(Math.floor(r() * 400), Math.round((Date.parse(open(a)) - Date.parse("2025-01-01")) / 86_400_000))); return { id: `e${n}`, date, createdAt: String(n++).padStart(6, "0"), direction: pick(["IN", "OUT"] as const), amount: 1 + Math.floor(r() * 1_500_000), accountId: a, counterAccountId: id(c), description: "x", entryType: "ENTRY" as const }; }),
        transfers: [], manual: [],
      };
      const floor = [accounts[0]!.openingDate, accounts[1]!.openingDate].sort().at(-1)!;
      d.transfers = Array.from({ length: Math.floor(r() * 3) }, () => ({ id: `t${n}`, date: dayOf(Math.max(Math.floor(r() * 400), Math.round((Date.parse(floor) - Date.parse("2025-01-01")) / 86_400_000))), createdAt: String(n++).padStart(6, "0"), fromId: "bank", toId: "kas", amount: 1 + Math.floor(r() * 500_000), description: "t" }));
      const asOf = dayOf(399);
      const lines = deriveLines(d);
      const tb = trialBalance(lines, COA, asOf);
      expect(tb.balanced, `seed ${seed}: neraca saldo`).toBe(true);
      const bs = balanceSheet(lines, COA, asOf);
      expect(bs.balanced, `seed ${seed}: neraca (selisih ${bs.difference})`).toBe(true);
      const stmt: StmtData = {
        accounts, payments: d.payments.map((p) => ({ date: p.date, amount: p.amount, withholding: p.withholding, vat: p.vat, accountId: p.accountId })),
        entries: d.entries.map((e) => { const c = COA.find((a) => a.id === e.counterAccountId)!; return { date: e.date, direction: e.direction, amount: e.amount, accountId: e.accountId, counter: { id: c.id, code: c.code, name: c.name, type: c.type, section: "OPERASI" as const } }; }),
        transfers: d.transfers.map((t) => ({ date: t.date, fromId: t.fromId, toId: t.toId, amount: t.amount })),
      };
      expect(bal(lines, "1-1200", asOf), `seed ${seed}: kas bank`).toBe(accountBalance(accounts[0]!, stmt, asOf));
      expect(bal(lines, "1-1100", asOf), `seed ${seed}: kas`).toBe(accountBalance(accounts[1]!, stmt, asOf));
      // laba bersih GL (semua sumber PENDAPATAN/BEBAN) == laba modul kas: hanya akun 4-2200/5-1100/6-1600 yang dipakai entri + pendapatan invoice
      const gl = glIncome(lines, COA, dayOf(0), asOf);
      const s1 = buildIncomeStatement(stmt, dayOf(0), asOf);
      expect(gl.profitBeforeTax, `seed ${seed}: laba GL = laba modul kas`).toBe(s1.netProfitBeforeTax);
    }
  });
});
