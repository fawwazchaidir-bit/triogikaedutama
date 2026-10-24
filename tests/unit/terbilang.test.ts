import { describe, expect, it } from "vitest";
import { terbilang } from "@/lib/finance/terbilang";

describe("terbilang — contoh dari brief", () => {
  it.each([
    [14_000_000, "Empat Belas Juta Rupiah"],
    [2_500_000, "Dua Juta Lima Ratus Ribu Rupiah"],
    [1_000_000, "Satu Juta Rupiah"],
    [0, "Nol Rupiah"],
  ])("%i → %s", (n, expected) => {
    expect(terbilang(n)).toBe(expected);
  });
});

describe("terbilang — tata bahasa", () => {
  it.each([
    [1, "Satu Rupiah"],
    [10, "Sepuluh Rupiah"],
    [11, "Sebelas Rupiah"],
    [12, "Dua Belas Rupiah"],
    [19, "Sembilan Belas Rupiah"],
    [20, "Dua Puluh Rupiah"],
    [21, "Dua Puluh Satu Rupiah"],
    [99, "Sembilan Puluh Sembilan Rupiah"],
    [100, "Seratus Rupiah"],
    [101, "Seratus Satu Rupiah"],
    [111, "Seratus Sebelas Rupiah"],
    [200, "Dua Ratus Rupiah"],
    [999, "Sembilan Ratus Sembilan Puluh Sembilan Rupiah"],
    [1_000, "Seribu Rupiah"],
    [1_001, "Seribu Satu Rupiah"],
    [1_100, "Seribu Seratus Rupiah"],
    [1_999, "Seribu Sembilan Ratus Sembilan Puluh Sembilan Rupiah"],
    [2_000, "Dua Ribu Rupiah"],
    [11_000, "Sebelas Ribu Rupiah"],
    [100_000, "Seratus Ribu Rupiah"],
    [101_000, "Seratus Satu Ribu Rupiah"],
    [111_111, "Seratus Sebelas Ribu Seratus Sebelas Rupiah"],
    [1_000_001, "Satu Juta Satu Rupiah"],
    [1_001_000, "Satu Juta Seribu Rupiah"],
    [1_500_000, "Satu Juta Lima Ratus Ribu Rupiah"],
    [3_005_000, "Tiga Juta Lima Ribu Rupiah"],
    [1_000_000_000, "Satu Miliar Rupiah"],
    [1_250_000_000, "Satu Miliar Dua Ratus Lima Puluh Juta Rupiah"],
    [10_000_000_000, "Sepuluh Miliar Rupiah"],
    [1_000_000_000_000, "Satu Triliun Rupiah"],
    [999_999_999_999_999, "Sembilan Ratus Sembilan Puluh Sembilan Triliun Sembilan Ratus Sembilan Puluh Sembilan Miliar Sembilan Ratus Sembilan Puluh Sembilan Juta Sembilan Ratus Sembilan Puluh Sembilan Ribu Sembilan Ratus Sembilan Puluh Sembilan Rupiah"],
  ])("%i → %s", (n, expected) => {
    expect(terbilang(n)).toBe(expected);
  });

  it("tidak pernah menghasilkan 'Satu Ratus' / 'Satu Ribu' / 'Nol Ribu'", () => {
    for (const n of [100, 1_000, 100_000, 100_100, 1_100_000, 1_000_100, 1_001_001, 101_000_000]) {
      const t = terbilang(n);
      expect(t).not.toMatch(/Satu Ratus|Satu Ribu|Nol Ribu|Nol Juta/);
    }
  });

  it("tidak ada spasi ganda", () => {
    for (let n = 0; n < 3000; n += 7) expect(terbilang(n)).not.toMatch(/\s{2,}/);
  });
});

describe("terbilang — bigint, desimal, negatif", () => {
  it("menerima bigint", () => {
    expect(terbilang(14_000_000n)).toBe("Empat Belas Juta Rupiah");
  });
  it("mendukung desimal sebagai string", () => {
    expect(terbilang("1500.56")).toBe("Seribu Lima Ratus Koma Lima Enam Rupiah");
    expect(terbilang("2000,05")).toBe("Dua Ribu Koma Nol Lima Rupiah");
    expect(terbilang("2000.00")).toBe("Dua Ribu Rupiah");
  });
  it("negatif diberi 'Minus'", () => {
    expect(terbilang(-2_500)).toBe("Minus Dua Ribu Lima Ratus Rupiah");
    expect(terbilang(-0)).toBe("Nol Rupiah");
  });
  it("menolak nominal desimal dalam bentuk number (hindari float) dan input tidak valid", () => {
    expect(() => terbilang(10.5)).toThrow();
    expect(() => terbilang("abc")).toThrow();
    expect(() => terbilang(Number.NaN)).toThrow();
  });
  it("menolak nominal di luar jangkauan skala", () => {
    expect(() => terbilang(10n ** 21n)).toThrow(RangeError);
  });
});
