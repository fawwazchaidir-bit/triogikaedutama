import { describe, expect, it } from "vitest";
import { MONTH_NAMES, nextPeriod, periodEnd, periodHasEnded, periodIndex, periodKey, periodLabel, periodStart, periodsBetween, prevPeriod } from "@/lib/accounting/periods";

describe("aritmatika periode", () => {
  it("kunci, awal, akhir, label", () => {
    expect(periodKey(2026, 3)).toBe("2026-03");
    expect(periodStart(2026, 3)).toBe("2026-03-01");
    expect(periodEnd(2026, 1)).toBe("2026-01-31");
    expect(periodEnd(2026, 4)).toBe("2026-04-30");
    expect(periodLabel(2026, 10)).toBe("Oktober 2026");
    expect(MONTH_NAMES).toHaveLength(12);
  });
  it("akhir Februari: tahun biasa, kabisat, abad", () => {
    expect(periodEnd(2026, 2)).toBe("2026-02-28");
    expect(periodEnd(2028, 2)).toBe("2028-02-29");
    expect(periodEnd(2100, 2)).toBe("2100-02-28"); // 2100 bukan kabisat
    expect(periodEnd(2000, 2)).toBe("2000-02-29"); // 2000 kabisat
  });
  it("periodHasEnded: hari terakhir bulan sendiri belum berakhir; sehari sesudahnya sudah", () => {
    expect(periodHasEnded(2026, 1, "2026-01-31")).toBe(false);
    expect(periodHasEnded(2026, 1, "2026-02-01")).toBe(true);
    expect(periodHasEnded(2026, 1, "2026-01-15")).toBe(false);
    expect(periodHasEnded(2026, 12, "2026-12-31")).toBe(false);
    expect(periodHasEnded(2026, 12, "2027-01-01")).toBe(true);
    expect(periodHasEnded(2028, 2, "2028-02-29")).toBe(false);
    expect(periodHasEnded(2028, 2, "2028-03-01")).toBe(true);
  });
  it("pergantian tahun", () => {
    expect(prevPeriod(2026, 1)).toEqual({ year: 2025, month: 12 });
    expect(nextPeriod(2026, 12)).toEqual({ year: 2027, month: 1 });
    expect(prevPeriod(2026, 7)).toEqual({ year: 2026, month: 6 });
    expect(nextPeriod(2026, 7)).toEqual({ year: 2026, month: 8 });
  });
  it("periodsBetween: inklusif, lintas tahun, kosong bila terbalik", () => {
    expect(periodsBetween({ year: 2025, month: 11 }, { year: 2026, month: 2 }).map((p) => periodKey(p.year, p.month))).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(periodsBetween({ year: 2026, month: 5 }, { year: 2026, month: 5 })).toHaveLength(1);
    expect(periodsBetween({ year: 2026, month: 6 }, { year: 2026, month: 5 })).toEqual([]);
  });
});

/** Sifat diuji pada sampel acak berbenih tetap (deterministik). */
function* samples(n: number, seed = 11): Generator<{ year: number; month: number }> {
  let x = seed;
  const r = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
  for (let i = 0; i < n; i++) yield { year: 2000 + Math.floor(r() * 200), month: 1 + Math.floor(r() * 12) };
}

describe("sifat", () => {
  it("next ∘ prev = identitas dan indeks naik tepat 1", () => {
    for (const p of samples(500)) {
      const n = nextPeriod(p.year, p.month);
      expect(prevPeriod(n.year, n.month)).toEqual(p);
      expect(periodIndex(n.year, n.month)).toBe(periodIndex(p.year, p.month) + 1);
    }
  });
  it("akhir bulan = sehari sebelum awal bulan berikutnya, dan masih di bulan itu", () => {
    for (const p of samples(500, 5)) {
      const n = nextPeriod(p.year, p.month);
      expect(Date.parse(`${periodEnd(p.year, p.month)}T00:00:00Z`) + 86_400_000).toBe(Date.parse(`${periodStart(n.year, n.month)}T00:00:00Z`));
      expect(periodEnd(p.year, p.month).startsWith(periodKey(p.year, p.month))).toBe(true);
    }
  });
  it("periodsBetween berurutan tanpa celah dan berjumlah selisih+1", () => {
    for (const a of samples(100, 9)) {
      const k = (a.year * 7 + a.month) % 41;
      let b = a;
      for (let i = 0; i < k; i++) b = nextPeriod(b.year, b.month);
      const list = periodsBetween(a, b);
      expect(list).toHaveLength(k + 1);
      list.forEach((p, i) => expect(periodIndex(p.year, p.month)).toBe(periodIndex(a.year, a.month) + i));
    }
  });
});
