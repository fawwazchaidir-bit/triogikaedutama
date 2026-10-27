import { describe, expect, it } from "vitest";
import { detectMapping, parseAmount, parseCsv, parseDate, parseStatementLines } from "@/lib/accounting/bank-csv";
import { reconSummary, suggestMatches, type BookItem, type MatchLine } from "@/lib/accounting/bank-match";

describe("parseAmount", () => {
  it("format Indonesia (titik ribuan, koma desimal) dan Inggris", () => {
    expect(parseAmount("1.234.567", "ID")).toEqual({ value: 1_234_567 });
    expect(parseAmount("1.234.567,00", "ID")).toEqual({ value: 1_234_567 });
    expect(parseAmount("1,234,567.00", "EN")).toEqual({ value: 1_234_567 });
    expect(parseAmount("Rp 2.500.000,-".replace(",-", ""), "ID")).toEqual({ value: 2_500_000 });
  });
  it("tanda: minus depan/belakang, kurung, CR/DB", () => {
    expect(parseAmount("-1.000", "ID")).toEqual({ value: -1000 });
    expect(parseAmount("1.000-", "ID")).toEqual({ value: -1000 });
    expect(parseAmount("(1.000)", "ID")).toEqual({ value: -1000 });
    expect(parseAmount("1.000 DB", "ID")).toEqual({ value: -1000 });
    expect(parseAmount("1.000 CR", "ID")).toEqual({ value: 1000 });
    expect(parseAmount("+1.000", "ID")).toEqual({ value: 1000 });
  });
  it("sen non-nol, sampah, dan nilai raksasa ditolak; kosong = null", () => {
    expect(parseAmount("1.000,50", "ID")).toMatchObject({ error: expect.stringContaining("sen") });
    expect(parseAmount("abc", "ID")).toMatchObject({ error: expect.any(String) });
    expect(parseAmount("1,2,3,4", "EN")).toMatchObject({ error: expect.any(String) });
    expect(parseAmount("123456789012345678", "ID")).toMatchObject({ error: expect.stringContaining("besar") });
    expect(parseAmount("", "ID")).toBeNull();
    expect(parseAmount("0", "ID")).toEqual({ value: 0 });
  });
});

describe("parseDate", () => {
  it("DMY, YMD, nama bulan Indonesia/Inggris, tahun 2 digit; tanggal mustahil ditolak", () => {
    expect(parseDate("27/10/2026", "DMY")).toBe("2026-10-27");
    expect(parseDate("27-10-26", "DMY")).toBe("2026-10-27");
    expect(parseDate("2026-10-27", "DMY")).toBe("2026-10-27");
    expect(parseDate("27 Okt 2026", "DMY")).toBe("2026-10-27");
    expect(parseDate("27-Oct-2026", "DMY")).toBe("2026-10-27");
    expect(parseDate("10/27/2026", "MDY")).toBe("2026-10-27");
    expect(parseDate("27/10/2026 14:05:33", "DMY")).toBe("2026-10-27");
    expect(parseDate("31/02/2026", "DMY")).toBeNull();
    expect(parseDate("32/01/2026", "DMY")).toBeNull();
    expect(parseDate("27/13/2026", "DMY")).toBeNull();
    expect(parseDate("29/02/2028", "DMY")).toBe("2028-02-29");
    expect(parseDate("29/02/2027", "DMY")).toBeNull();
    expect(parseDate("bukan tanggal", "DMY")).toBeNull();
  });
});

describe("CSV rekening koran", () => {
  const csv = `Tanggal;Keterangan;Referensi;Debet;Kredit;Saldo
03/01/2026;"TRF MASUK PT Bima, INV 00435";REF123;;5.000.000,00;15.000.000
05/01/2026;BIAYA ADM;;15.000,00;;14.985.000
06/01/2026;Saldo Awal;;;;
`;
  it("mendeteksi pembatas, judul, dan memetakan debit/kredit → nilai bertanda; baris tanpa mutasi dilewati", () => {
    const { delimiter, rows } = parseCsv(csv);
    expect(delimiter).toBe(";");
    const map = detectMapping(rows);
    expect(map).toMatchObject({ hasHeader: true, date: 0, description: 1, reference: 2, debit: 3, credit: 4, amount: null, dateFormat: "DMY", numberFormat: "ID" });
    const r = parseStatementLines(rows, map);
    expect(r.errors).toEqual([]);
    expect(r.lines).toEqual([
      { lineNo: 1, txDate: "2026-01-03", description: "TRF MASUK PT Bima, INV 00435", reference: "REF123", amount: 5_000_000 },
      { lineNo: 2, txDate: "2026-01-05", description: "BIAYA ADM", reference: null, amount: -15_000 },
    ]);
  });
  it("kolom jumlah bertanda, format Inggris, kutip berisi baris baru dan BOM", () => {
    const text = '﻿Date,Description,Amount\r\n2026-02-01,"Setoran\ntunai",1000000\r\n2026-02-02,Tarik,-250000\r\n';
    const { rows } = parseCsv(text);
    const r = parseStatementLines(rows, detectMapping(rows));
    expect(r.errors).toEqual([]);
    expect(r.lines.map((l) => [l.txDate, l.amount])).toEqual([["2026-02-01", 1_000_000], ["2026-02-02", -250_000]]);
    expect(r.lines[0]!.description).toBe("Setoran\ntunai");
  });
  it("galat per baris dilaporkan dengan nomor baris; debit+kredit bersamaan ditolak; tanpa judul memakai urutan umum", () => {
    const text = `01/01/2026;A;1.000;2.000\n99/01/2026;B;;500\n02/01/2026;;;500\n03/01/2026;C;;1.000,5`;
    const { rows } = parseCsv(text);
    const map = detectMapping(rows);
    expect(map.hasHeader).toBe(false);
    const r = parseStatementLines(rows, map);
    expect(r.lines).toHaveLength(0);
    expect(r.errors.map((e) => e.row)).toEqual([1, 2, 3, 4]);
    expect(r.errors[0]!.message).toMatch(/bersamaan/);
    expect(r.errors[1]!.message).toMatch(/Tanggal/);
    expect(r.errors[2]!.message).toMatch(/Uraian/);
    expect(r.errors[3]!.message).toMatch(/sen/);
  });
  it("lebih dari 5000 baris ditolak", () => {
    const rows = Array.from({ length: 5001 }, () => ["01/01/2026", "x", "1.000"]);
    expect(parseStatementLines(rows, { hasHeader: false, date: 0, description: 1, reference: null, amount: 2, debit: null, credit: null, dateFormat: "DMY", numberFormat: "ID" }).errors[0]!.message).toMatch(/Maksimal/);
  });
});

const item = (id: string, date: string, amount: number, hint = ""): BookItem => ({ type: "PAYMENT", id, date, createdAt: id, amount, label: id, hint });
const line = (id: string, date: string, amount: number, description = "", matched = 0): MatchLine => ({ id, date, amount, description, reference: null, matched });

describe("suggestMatches", () => {
  it("1-ke-1 nilai sama dalam jendela hari; terdekat menang; di luar jendela / nilai beda tidak", () => {
    const r = suggestMatches([line("L1", "2026-01-10", 500_000)], [item("a", "2026-01-08", 500_000), item("b", "2026-01-09", 500_000), item("c", "2026-01-10", 499_999), item("d", "2026-01-20", 500_000)]);
    expect(r.map((x) => [x.lineId, x.item.id])).toEqual([["L1", "b"]]);
  });
  it("ambigu (dua kandidat sama baik) dilewati; petunjuk teks memecah kebuntuan", () => {
    const items = [item("a", "2026-01-09", 700_000, "invoice 00435 Bima"), item("b", "2026-01-09", 700_000, "invoice 00436 Sari")];
    expect(suggestMatches([line("L1", "2026-01-10", 700_000, "TRF 00436 PT Sari")], items).map((x) => x.item.id)).toEqual(["b"]);
    expect(suggestMatches([line("L1", "2026-01-10", 700_000, "TRF tanpa petunjuk")], items)).toEqual([]);
  });
  it("dua baris berebut satu transaksi → keduanya dilewati; sisa sudah dicocokkan sebagian dihitung", () => {
    expect(suggestMatches([line("L1", "2026-01-10", 300_000), line("L2", "2026-01-10", 300_000)], [item("a", "2026-01-10", 300_000)])).toEqual([]);
    expect(suggestMatches([line("L1", "2026-01-10", 800_000, "", 500_000)], [item("a", "2026-01-10", 300_000), item("b", "2026-01-10", 800_000)]).map((x) => x.item.id)).toEqual(["a"]);
  });
  it("properti 300 acak: usulan selalu 1-ke-1, nilai sama persis, dalam jendela", () => {
    let seed = 5;
    const r = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let n = 0; n < 300; n++) {
      const items = Array.from({ length: 1 + Math.floor(r() * 8) }, (_, i) => item(`i${i}`, `2026-01-${String(1 + Math.floor(r() * 28)).padStart(2, "0")}`, 1000 * (1 + Math.floor(r() * 4)) * (r() < 0.3 ? -1 : 1)));
      const lines = Array.from({ length: 1 + Math.floor(r() * 8) }, (_, i) => line(`l${i}`, `2026-01-${String(1 + Math.floor(r() * 28)).padStart(2, "0")}`, 1000 * (1 + Math.floor(r() * 4)) * (r() < 0.3 ? -1 : 1)));
      const out = suggestMatches(lines, items, 3);
      expect(new Set(out.map((o) => o.lineId)).size).toBe(out.length);
      expect(new Set(out.map((o) => o.item.id)).size).toBe(out.length);
      for (const o of out) { const l = lines.find((x) => x.id === o.lineId)!; expect(l.amount).toBe(o.item.amount); expect(Math.abs(Date.parse(l.date) - Date.parse(o.item.date))).toBeLessThanOrEqual(3 * 86_400_000); }
    }
  });
});

describe("reconSummary", () => {
  it("selisih = saldo akhir bank + transaksi belum cocok − saldo buku; nol bila cek/setoran dalam perjalanan menjelaskan semuanya", () => {
    // bank 10jt; buku 10,5jt = +0,8jt setoran dalam perjalanan − 0,3jt cek beredar
    const s = reconSummary(10_000_000, 10_500_000, [{ amount: 800_000 }, { amount: -300_000 }]);
    expect(s).toEqual({ closing: 10_000_000, outstandingNet: 500_000, adjustedBank: 10_500_000, bookBalance: 10_500_000, difference: 0 });
    expect(reconSummary(10_000_000, 10_400_000, [{ amount: 500_000 }]).difference).toBe(100_000);
  });
});
