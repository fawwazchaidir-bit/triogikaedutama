import { describe, expect, it } from "vitest";
import { addMonths, changeOf, comparativeRange, mergeComparative, type BaseRow } from "@/lib/accounting/compare";

describe("addMonths", () => {
  it("menjaga akhir bulan dan melintas tahun", () => {
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2028-03-31", -1)).toBe("2028-02-29");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
    expect(addMonths("2026-12-31", 2)).toBe("2027-02-28");
    expect(addMonths("2028-02-29", -12)).toBe("2027-02-28");
    expect(addMonths("2026-10-01", -12)).toBe("2025-10-01");
  });
});

describe("comparativeRange", () => {
  it("laba rugi: satu bulan penuh dibanding bulan kalender sebelumnya (bukan 31 hari mundur)", () => {
    expect(comparativeRange("range", "2026-10-01", "2026-10-31", "previous")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(comparativeRange("range", "2026-03-01", "2026-03-31", "previous")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(comparativeRange("range", "2026-01-01", "2026-01-31", "previous")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
  it("laba rugi: beberapa bulan penuh → jumlah bulan sama; kuartal dan tahun penuh", () => {
    expect(comparativeRange("range", "2026-07-01", "2026-09-30", "previous")).toEqual({ from: "2026-04-01", to: "2026-06-30" });
    expect(comparativeRange("range", "2026-01-01", "2026-12-31", "previous")).toEqual({ from: "2025-01-01", to: "2025-12-31" });
  });
  it("laba rugi: rentang tidak utuh bulan → jumlah hari sama, tepat sebelum awal", () => {
    expect(comparativeRange("range", "2026-10-10", "2026-10-20", "previous")).toEqual({ from: "2026-09-29", to: "2026-10-09" }); // 11 hari
    expect(comparativeRange("range", "2026-01-01", "2026-10-27", "previous")).toEqual({ from: "2025-03-07", to: "2025-12-31" }); // 300 hari (7 Mar–31 Des)
  });
  it("tahun lalu: tanggal sama; akhir bulan tetap akhir bulan (Feb kabisat)", () => {
    expect(comparativeRange("range", "2026-01-01", "2026-10-27", "year")).toEqual({ from: "2025-01-01", to: "2025-10-27" });
    expect(comparativeRange("range", "2028-02-01", "2028-02-29", "year")).toEqual({ from: "2027-02-01", to: "2027-02-28" });
    expect(comparativeRange("range", "2026-02-01", "2026-02-28", "year")).toEqual({ from: "2025-02-01", to: "2025-02-28" });
    expect(comparativeRange("asof", "2026-01-01", "2026-06-30", "year")).toEqual({ from: "2025-01-01", to: "2025-06-30" });
    // akhir Februari tahun biasa → akhir Februari tahun kabisat sebelumnya (29, bukan 28)
    expect(comparativeRange("range", "2029-02-01", "2029-02-28", "year")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(comparativeRange("range", "2026-11-01", "2026-11-30", "year")).toEqual({ from: "2025-11-01", to: "2025-11-30" });
  });
  it("neraca: 'previous' = hari sebelum awal periode (akhir tahun lalu bila tanpa tanggal awal)", () => {
    expect(comparativeRange("asof", "2026-01-01", "2026-10-27", "previous")).toEqual({ from: "2025-12-31", to: "2025-12-31" });
    expect(comparativeRange("asof", "2026-10-01", "2026-10-31", "previous")).toEqual({ from: "2026-09-30", to: "2026-09-30" });
  });
});

describe("changeOf", () => {
  it("selisih dan persen (basis poin); pembanding nol/kosong → persen kosong; pembanding negatif memakai nilai mutlak", () => {
    expect(changeOf(150, 100)).toEqual({ change: 50, changeBps: 5000 });
    expect(changeOf(50, 100)).toEqual({ change: -50, changeBps: -5000 });
    expect(changeOf(100, 0)).toEqual({ change: 100, changeBps: null });
    expect(changeOf(null, 5)).toEqual({ change: null, changeBps: null });
    expect(changeOf(5, null)).toEqual({ change: null, changeBps: null });
    expect(changeOf(-50, -100)).toEqual({ change: 50, changeBps: 5000 });
    expect(changeOf(1, 3)).toEqual({ change: -2, changeBps: -6667 });
  });
});

const L = (item: string, amount: number | null, kind: BaseRow["kind"] = "line"): BaseRow => ({ item, amount, kind });
describe("mergeComparative", () => {
  it("baris sama digabung; baris hanya di pembanding disisipkan setelah tetangganya; baris hanya di sekarang bernilai pembanding 0", () => {
    const cur = [L("Pendapatan", null, "head"), L("   4-1100 Jasa", 100), L("   4-2200 Bunga", 5), L("Jumlah", 105, "total")];
    const prev = [L("Pendapatan", null, "head"), L("   4-1100 Jasa", 80), L("   4-2100 Sewa", 20), L("Jumlah", 100, "total")];
    const m = mergeComparative(cur, prev);
    expect(m.map((r) => r.item)).toEqual(["Pendapatan", "   4-1100 Jasa", "   4-2100 Sewa", "   4-2200 Bunga", "Jumlah"]);
    expect(m.map((r) => [r.amount, r.prev, r.change])).toEqual([[null, null, null], [100, 80, 20], [0, 20, -20], [5, 0, 5], [105, 100, 5]]);
    expect(m[1]!.changeBps).toBe(2500);
    expect(m[3]!.changeBps).toBeNull(); // pembanding 0
  });
  it("jumlah total tetap = jumlah baris setelah digabung (invarian)", () => {
    const cur = [L("a", 3), L("b", 4), L("T", 7, "total")];
    const prev = [L("a", 1), L("c", 9), L("T", 10, "total")];
    const m = mergeComparative(cur, prev);
    const sum = (key: "amount" | "prev") => m.filter((r) => r.kind === "line").reduce((s, r) => s + (r[key] ?? 0), 0);
    expect(sum("amount")).toBe(m.find((r) => r.kind === "total")!.amount);
    expect(sum("prev")).toBe(m.find((r) => r.kind === "total")!.prev);
  });
  it("pembanding kosong / sekarang kosong", () => {
    expect(mergeComparative([L("a", 1)], []).map((r) => [r.prev, r.change])).toEqual([[0, 1]]);
    expect(mergeComparative([], [L("a", 2)]).map((r) => [r.amount, r.prev, r.change])).toEqual([[0, 2, -2]]);
  });
  it("baris pertama hanya di pembanding disisipkan di awal", () => {
    expect(mergeComparative([L("b", 1)], [L("a", 1), L("b", 1)]).map((r) => r.item)).toEqual(["a", "b"]);
  });
});
