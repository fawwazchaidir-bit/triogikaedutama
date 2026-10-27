import { describe, expect, it } from "vitest";
import {
  accountBalance, buildAccountLedger, buildCashFlow, buildIncomeStatement,
  type LedgerMovement, type StmtAccount, type StmtCounter, type StmtData,
} from "@/lib/accounting/statements";
import { COA_SEED } from "@/lib/accounting/coa-seed";

/**
 * PUTARAN 1 (unit) — angka dihitung TANGAN di komentar; fungsi murni tidak boleh menyimpang dari hitungan manual.
 */
const C = (code: string, name: string, type: StmtCounter["type"], section: StmtCounter["section"] = "OPERASI"): StmtCounter => ({ id: `c-${code}`, code, name, type, section });
const honor = C("5-1100", "Honor Instruktur", "BEBAN");
const atk = C("6-1600", "ATK", "BEBAN");
const bunga = C("4-2200", "Bunga", "PENDAPATAN");
const alat = C("1-2100", "Peralatan", "ASET", "INVESTASI");
const modal = C("3-1100", "Modal", "EKUITAS", "PENDANAAN");

const bank: StmtAccount = { id: "bank", name: "Bank", kind: "BANK", openingBalance: 10_000_000, openingDate: "2026-01-01" };
const kas: StmtAccount = { id: "kas", name: "Kas", kind: "KAS", openingBalance: 1_000_000, openingDate: "2026-01-01" };

const data = (): StmtData => ({
  accounts: [bank, kas],
  payments: [
    { date: "2026-01-10", amount: 5_000_000, withholding: 0, vat: 0, accountId: "bank" },
    { date: "2026-01-12", amount: 9_000_000, withholding: 0, vat: 0, accountId: "bank" },
    { date: "2026-02-03", amount: -5_000_000, withholding: 0, vat: 0, accountId: "bank" }, // pembalikan pembayaran 10 Jan
    { date: "2026-01-15", amount: 2_000_000, withholding: 0, vat: 0, accountId: null }, // belum dialokasikan
  ],
  entries: [
    { date: "2026-01-05", direction: "IN", amount: 20_000_000, accountId: "bank", counter: modal },
    { date: "2026-01-20", direction: "OUT", amount: 3_000_000, accountId: "bank", counter: honor },
    { date: "2026-01-25", direction: "OUT", amount: 275_000, accountId: "kas", counter: atk },
    { date: "2026-01-30", direction: "OUT", amount: 4_000_000, accountId: "bank", counter: alat },
    { date: "2026-02-05", direction: "IN", amount: 3_000_000, accountId: "bank", counter: honor }, // pembalikan beban 20 Jan
    { date: "2026-02-10", direction: "IN", amount: 100_000, accountId: "bank", counter: bunga },
  ],
  transfers: [{ date: "2026-01-18", fromId: "bank", toId: "kas", amount: 1_000_000 }],
});

describe("arus kas — hitungan tangan", () => {
  it("Januari 2026", () => {
    const r = buildCashFlow(data(), "2026-01-01", "2026-01-31");
    expect(r.operating.invoiceReceipts).toBe(14_000_000); // 5jt + 9jt (2jt tak teralokasi tidak masuk)
    expect(r.operating.expenses.map((l) => [l.code, l.amount])).toEqual([["5-1100", -3_000_000], ["6-1600", -275_000]]);
    expect(r.operating.net).toBe(10_725_000);
    expect(r.investing.net).toBe(-4_000_000);
    expect(r.financing.net).toBe(20_000_000);
    expect(r.netChange).toBe(26_725_000);
    expect(r.beginning).toBe(0);
    expect(r.newOpening).toBe(11_000_000); // kedua akun mulai di periode ini
    expect(r.ending).toBe(37_725_000);
    expect(r.notInBalances).toBe(2_000_000);
    const by = Object.fromEntries(r.accounts.map((a) => [a.id, a.ending]));
    expect(by).toEqual({ bank: 36_000_000, kas: 1_725_000 }); // bank: 10+14−3−4+20−1 ; kas: 1−0,275+1
  });

  it("Februari 2026: pembalikan pembayaran & pembalikan beban", () => {
    const r = buildCashFlow(data(), "2026-02-01", "2026-02-28");
    expect(r.beginning).toBe(37_725_000);
    expect(r.newOpening).toBe(0);
    expect(r.operating.invoiceReceipts).toBe(-5_000_000);
    expect(r.operating.otherIncome.map((l) => l.amount)).toEqual([100_000]);
    expect(r.operating.expenses.map((l) => [l.code, l.amount])).toEqual([["5-1100", 3_000_000]]); // beban berkurang
    expect(r.operating.net).toBe(-1_900_000);
    expect(r.ending).toBe(35_825_000);
  });

  it("transfer tidak mengubah total kas; hanya memindahkan antar akun", () => {
    const d = data();
    const withT = buildCashFlow(d, "2026-01-01", "2026-01-31");
    const without = buildCashFlow({ ...d, transfers: [] }, "2026-01-01", "2026-01-31");
    expect(withT.ending).toBe(without.ending);
    expect(withT.accounts.find((a) => a.id === "kas")!.transferIn).toBe(1_000_000);
    expect(withT.accounts.find((a) => a.id === "bank")!.transferOut).toBe(1_000_000);
  });

  it("akun yang mulai di tengah periode: saldo awalnya bukan arus; mutasi sebelum tanggal saldo awal diabaikan", () => {
    const late: StmtAccount = { id: "late", name: "Bank Baru", kind: "BANK", openingBalance: 500_000, openingDate: "2026-02-15" };
    const d: StmtData = {
      accounts: [bank, late], payments: [{ date: "2026-02-01", amount: 700_000, withholding: 0, vat: 0, accountId: "late" }, { date: "2026-02-20", amount: 300_000, withholding: 0, vat: 0, accountId: "late" }],
      entries: [], transfers: [],
    };
    const r = buildCashFlow(d, "2026-02-01", "2026-02-28");
    expect(r.beginning).toBe(10_000_000);
    expect(r.newOpening).toBe(500_000);
    expect(r.operating.invoiceReceipts).toBe(300_000); // 700rb (1 Feb) mendahului saldo awal akun → sudah dianggap termasuk saldo awal
    expect(r.notInBalances).toBe(700_000);
    expect(r.ending).toBe(10_000_000 + 500_000 + 300_000);
    expect(accountBalance(late, d, "2026-02-14")).toBe(0);
  });
});

describe("laba rugi basis kas — hitungan tangan", () => {
  it("Januari: pendapatan = semua penerimaan (termasuk yang belum dialokasikan)", () => {
    const r = buildIncomeStatement(data(), "2026-01-01", "2026-01-31");
    expect(r.revenue).toBe(16_000_000);
    expect(r.directCosts.map((l) => [l.code, l.amount])).toEqual([["5-1100", 3_000_000]]);
    expect(r.grossProfit).toBe(13_000_000);
    expect(r.operatingCosts.map((l) => [l.code, l.amount])).toEqual([["6-1600", 275_000]]);
    expect(r.operatingProfit).toBe(12_725_000);
    expect(r.netProfitBeforeTax).toBe(12_725_000);
    expect(r.vatCollected).toBe(0);
    expect(r.withheldByCustomers).toBe(0);
  });
  it("Februari: pembalikan membuat beban negatif (mengurangi), pendapatan negatif", () => {
    const r = buildIncomeStatement(data(), "2026-02-01", "2026-02-28");
    expect(r.revenue).toBe(-5_000_000);
    expect(r.totalDirectCosts).toBe(-3_000_000);
    expect(r.grossProfit).toBe(-2_000_000);
    expect(r.totalOtherIncome).toBe(100_000);
    expect(r.netProfitBeforeTax).toBe(-1_900_000);
  });
  it("investasi & pendanaan tidak pernah masuk laba rugi", () => {
    const r = buildIncomeStatement(data(), "2026-01-01", "2026-01-31");
    expect(JSON.stringify(r)).not.toContain("Peralatan");
    expect(JSON.stringify(r)).not.toContain("Modal");
  });
});

describe("buku kas per akun", () => {
  it("saldo berjalan & penutup konsisten dengan saldo akun", () => {
    const mv: LedgerMovement[] = [
      { date: "2026-01-10", order: "a", kind: "INVOICE_PAYMENT", description: "x", signed: 5_000_000, ref: "1" },
      { date: "2026-01-05", order: "b", kind: "ENTRY", description: "y", signed: 20_000_000, ref: "2" },
      { date: "2025-12-31", order: "c", kind: "ENTRY", description: "sebelum saldo awal", signed: 999, ref: "3" },
    ];
    const l = buildAccountLedger(bank, mv, "2026-01-01", "2026-01-31");
    expect(l.opening).toBe(10_000_000);
    expect(l.rows.map((r) => r.balance)).toEqual([30_000_000, 35_000_000]); // 5 Jan lalu 10 Jan
    expect(l.closing).toBe(35_000_000);
    const later = buildAccountLedger(bank, mv, "2026-01-08", "2026-01-31");
    expect(later.opening).toBe(30_000_000);
    expect(later.rows).toHaveLength(1);
  });
});

describe("bagan akun usulan", () => {
  it("kode unik, berformat d-dddd, digit pertama sesuai jenis, akun manual konsisten", () => {
    const codes = COA_SEED.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
    const digit: Record<string, string[]> = { ASET: ["1"], KEWAJIBAN: ["2"], EKUITAS: ["3"], PENDAPATAN: ["4"], BEBAN: ["5", "6", "7"] };
    for (const a of COA_SEED) {
      expect(a.code, a.code).toMatch(/^[0-9]-[0-9]{4}$/);
      expect(digit[a.type]!, a.code).toContain(a.code[0]);
      // Satu-satunya akun sistem yang boleh dipilih pada entri kas: akun utang pajak (untuk mencatat SETORAN pajak, arus kas operasi).
      const taxRemittance = ["2-1210", "2-1230"].includes(a.code);
      expect(a.isSystem && a.manualEntry, a.code).toBe(taxRemittance);
      if (a.manualEntry && a.type === "ASET") expect(a.section).toBe("INVESTASI");
      if (a.manualEntry && (a.type === "KEWAJIBAN" || a.type === "EKUITAS")) expect(a.section).toBe(taxRemittance ? "OPERASI" : "PENDANAAN");
    }
    // akun yang dicadangkan untuk tahap berikutnya tidak boleh dipilih manual
    for (const code of ["1-1100", "1-1200", "1-1300", "1-1400", "2-1100", "2-1200", "3-2100", "4-1100", "6-2000", "7-1100"]) {
      expect(COA_SEED.find((a) => a.code === code)!.manualEntry, code).toBe(false);
    }
  });
});

/** Pembangkit acak deterministik (mulberry32) untuk uji properti yang dapat diulang. */
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const dayOf = (n: number) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);

describe("properti (300 data acak): identitas laporan selalu berlaku", () => {
  it("saldo awal+arus = saldo akhir; Σ akun = total; periode dapat dijumlahkan; laba bersih = arus operasi bila semua alokasi", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
      const accounts: StmtAccount[] = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => ({
        id: `a${i}`, name: `A${i}`, kind: i === 0 ? "BANK" : "KAS", openingBalance: Math.floor(r() * 5_000_000), openingDate: dayOf(Math.floor(r() * 40)),
      }));
      const counters = [honor, atk, bunga, alat, modal];
      const payments = Array.from({ length: Math.floor(r() * 12) }, () => {
        const a = pick(accounts); const date = dayOf(Math.floor(r() * 120));
        return { date, amount: (r() < 0.2 ? -1 : 1) * (1 + Math.floor(r() * 3_000_000)), withholding: 0, vat: 0, accountId: a.id };
      });
      const entries = Array.from({ length: Math.floor(r() * 15) }, () => {
        const a = pick(accounts); const c = pick(counters);
        return { date: dayOf(Math.floor(r() * 120)), direction: pick(["IN", "OUT"] as const), amount: 1 + Math.floor(r() * 2_000_000), accountId: a.id, counter: c };
      });
      // Transfer sah (dijaga DB): tanggal tidak mendahului saldo awal akun mana pun.
      const transfers = accounts.length > 1 ? Array.from({ length: Math.floor(r() * 4) }, () => {
        const to = pick(accounts.slice(1));
        const floor = [accounts[0]!.openingDate, to.openingDate].sort().at(-1)!;
        const date = dayOf(Math.max(Math.floor(r() * 120), Math.round((Date.parse(`${floor}T00:00:00Z`) - Date.parse("2026-01-01T00:00:00Z")) / 86_400_000)));
        return { date, fromId: "a0", toId: to.id, amount: 1 + Math.floor(r() * 900_000) };
      }) : [];
      const d: StmtData = { accounts, payments, entries, transfers };

      const cut = dayOf(30 + Math.floor(r() * 60));
      const next = dayOf(31 + Math.floor(r() * 60) + 0);
      const full = buildCashFlow(d, dayOf(0), dayOf(119));
      expect(full.beginning + full.newOpening + full.netChange, `seed ${seed}`).toBe(full.ending);
      expect(full.accounts.reduce((s, a) => s + a.ending, 0), `seed ${seed}`).toBe(full.ending);
      for (const a of full.accounts) expect(a.beginning + a.newOpening + a.invoiceReceipts + a.otherIn - a.otherOut + a.transferIn - a.transferOut, `seed ${seed} ${a.id}`).toBe(a.ending);

      // aditif: [0..cut] lalu [cut+1..119]
      const p1 = buildCashFlow(d, dayOf(0), cut);
      const dayAfterCut = new Date(Date.parse(`${cut}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      const p2 = buildCashFlow(d, dayAfterCut, dayOf(119));
      expect(p2.beginning, `seed ${seed}`).toBe(p1.ending);
      expect(p1.netChange + p2.netChange, `seed ${seed}`).toBe(full.netChange);
      expect(p1.newOpening + p2.newOpening, `seed ${seed}`).toBe(full.newOpening);
      void next;

      // laba rugi vs arus operasi: sama bila semua penerimaan masuk saldo (alokasi + setelah tanggal saldo awal)
      const clean: StmtData = { ...d, payments: d.payments.filter((p) => p.date >= accounts.find((a) => a.id === p.accountId)!.openingDate), entries: d.entries.filter((e) => e.date >= accounts.find((a) => a.id === e.accountId)!.openingDate) };
      const cf = buildCashFlow(clean, dayOf(0), dayOf(119));
      const pl = buildIncomeStatement(clean, dayOf(0), dayOf(119));
      expect(pl.netProfitBeforeTax, `seed ${seed}`).toBe(cf.operating.net);
      expect(cf.notInBalances).toBe(0);
    }
  });
});
