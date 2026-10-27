import ExcelJS from "exceljs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, type Fixtures } from "../helpers/db";
import { createDraft, issueInvoice } from "@/server/services/invoices";
import { recordPayment } from "@/server/services/payments";
import { createEntry } from "@/server/services/cash-entries";
import { createJournal } from "@/server/services/journals";
import { getCashTieOut, runStatement } from "@/server/services/finance-statements";
import { renderReportPdf } from "@/server/pdf/render";
import { toCsv, toXlsx, type ReportTable } from "@/server/export";
import { AppError } from "@/server/errors";

/**
 * LAPORAN · PUTARAN 1 — PEMBANDING PERIODE, KECOCOKAN KAS, DAN PDF (hitung-tangan).
 * Saldo awal 1 Jan 2026: Bank 10.000.000 + Kas 1.000.000.
 * Januari: terima 5.000.000 (5 Jan) · listrik 400.000 (6-1300, 10 Jan)
 *   → pendapatan 5.000.000, beban 400.000, laba 4.600.000; aset 15.600.000
 * Februari: terima 3.000.000 (10 Feb) · ATK 200.000 (6-1600, 12 Feb) · listrik 150.000 (6-1300, 15 Feb) · bunga bank 50.000 (4-2200, 20 Feb)
 *   → pendapatan 3.000.000, beban 350.000, pendapatan lain 50.000, laba 2.700.000; aset 18.300.000; laba berjalan kumulatif 7.300.000
 */
const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as AppError | null;
let fx: Fixtures;
const c = (code: string) => fx.coa[code]!;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures({ finance: true, openingDate: "2026-01-01" });
});
afterAll(async () => { await prisma.$disconnect(); });

async function books() {
  const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: "2026-01-02", paymentTermDays: 30 }))).id);
  await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-01-05", amount: 5_000_000, method: "Transfer" });
  await createEntry(fx.finance, { entryDate: "2026-01-10", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1300"), amount: 400_000, description: "Listrik Januari" });
  await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-02-10", amount: 3_000_000, method: "Transfer" });
  await createEntry(fx.finance, { entryDate: "2026-02-12", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1600"), amount: 200_000, description: "ATK" });
  await createEntry(fx.finance, { entryDate: "2026-02-15", cashAccountId: fx.bankAcctId, counterAccountId: c("6-1300"), amount: 150_000, description: "Listrik Februari" });
  await createEntry(fx.finance, { entryDate: "2026-02-20", cashAccountId: fx.bankAcctId, counterAccountId: c("4-2200"), direction: "IN", amount: 50_000, description: "Bunga bank" });
}
const feb = { from: "2026-02-01", to: "2026-02-28" }, jan = { from: "2026-01-01", to: "2026-01-31" };
type R = Record<string, string | number | null>;
const find = (t: ReportTable, re: RegExp): R => {
  const r = t.rows.find((x) => re.test(String(x.item)));
  if (!r) throw new Error(`baris ${re} tidak ada: ${t.rows.map((x) => x.item).join(" | ")}`);
  return r;
};
const pick = (r: R) => [r.amount, r.prev, r.change, r.pct];

describe("laba rugi dengan pembanding", () => {
  it("Februari vs Januari: kolom, jumlah, selisih, persen, baris yang hanya ada di salah satu periode", async () => {
    await books();
    const t = await runStatement(fx.finance, "income-statement", { ...feb, compare: "previous" });
    expect(t.columns.map((x) => x.key)).toEqual(["item", "amount", "prev", "change", "pct"]);
    expect(t.compareLabel).toBe("1 Januari 2026 – 31 Januari 2026");
    expect(t.disclaimer).toMatch(/BASIS KAS/);
    expect(pick(find(t, /^Jumlah pendapatan usaha$/))).toEqual([3_000_000, 5_000_000, -2_000_000, -40]);
    expect(pick(find(t, /6-1300/))).toEqual([150_000, 400_000, -250_000, -62.5]);
    expect(pick(find(t, /6-1600/))).toEqual([200_000, 0, 200_000, null]); // baru di Februari
    expect(pick(find(t, /4-2200/))).toEqual([50_000, 0, 50_000, null]);
    expect(pick(find(t, /^Jumlah beban operasional$/))).toEqual([350_000, 400_000, -50_000, -12.5]);
    expect(pick(find(t, /^Laba \(rugi\) usaha$/))).toEqual([2_650_000, 4_600_000, -1_950_000, -42.39]);
    expect(pick(find(t, /sebelum pajak penghasilan/))).toEqual([2_700_000, 4_600_000, -1_900_000, -41.3]);
    // baris judul tidak punya angka
    expect(pick(find(t, /^Pendapatan usaha$/))).toEqual([null, null, null, null]);
  });

  it("kolom 'periode ini' dan 'pembanding' identik dengan laporan biasa untuk periode masing-masing (tiap baris)", async () => {
    await books();
    const cmp = await runStatement(fx.finance, "income-statement", { ...feb, compare: "previous" });
    const curOnly = await runStatement(fx.finance, "income-statement", feb);
    const prevOnly = await runStatement(fx.finance, "income-statement", jan);
    const by = (t: ReportTable) => new Map(t.rows.map((r) => [String(r.item), r.amount]));
    const a = by(curOnly), b = by(prevOnly);
    for (const r of cmp.rows) {
      if (r.kind === "head") continue;
      expect(r.amount, `periode ini: ${r.item}`).toBe(a.get(String(r.item)) ?? 0);
      expect(r.prev, `pembanding: ${r.item}`).toBe(b.get(String(r.item)) ?? 0);
    }
    // setiap baris laporan biasa muncul di tabel pembanding (tidak ada yang hilang)
    for (const label of [...a.keys(), ...b.keys()]) expect(cmp.rows.some((r) => String(r.item) === label), label).toBe(true);
  });

  it("jumlah baris = baris total di KEDUA kolom (invarian penjumlahan)", async () => {
    await books();
    const t = await runStatement(fx.finance, "income-statement", { ...feb, compare: "previous" });
    const col = (key: "amount" | "prev", start: RegExp, end: RegExp) => {
      const i = t.rows.findIndex((r) => start.test(String(r.item))), j = t.rows.findIndex((r) => end.test(String(r.item)));
      return t.rows.slice(i + 1, j).filter((r) => r.kind === "line").reduce((s, r) => s + (r[key] as number), 0);
    };
    for (const key of ["amount", "prev"] as const) {
      expect(col(key, /^Pendapatan usaha$/, /^Jumlah pendapatan usaha$/)).toBe(find(t, /^Jumlah pendapatan usaha$/)[key]);
      expect(col(key, /^Beban operasional$/, /^Jumlah beban operasional$/)).toBe(find(t, /^Jumlah beban operasional$/)[key]);
    }
  });

  it("pembanding tahun lalu (sebelum pembukuan): semua nol, persen kosong, tidak error", async () => {
    await books();
    const t = await runStatement(fx.finance, "income-statement", { ...feb, compare: "year" });
    expect(t.compareLabel).toBe("1 Februari 2025 – 28 Februari 2025");
    expect(pick(find(t, /^Jumlah pendapatan usaha$/))).toEqual([3_000_000, 0, 3_000_000, null]);
  });

  it("tanpa pembanding: bentuk lama tidak berubah (2 kolom, tanpa compareLabel)", async () => {
    await books();
    const t = await runStatement(fx.finance, "income-statement", { ...feb, compare: "none" });
    expect(t.columns.map((x) => x.key)).toEqual(["item", "amount"]);
    expect(t.compareLabel).toBeUndefined();
    expect(t).toEqual({ ...(await runStatement(fx.finance, "income-statement", feb)), generatedAt: t.generatedAt });
  });

  it("neraca saldo & buku besar mengabaikan pembanding; nilai tak sah ditolak", async () => {
    await books();
    const tb = await runStatement(fx.finance, "trial-balance", { to: "2026-02-28", compare: "previous" });
    expect(tb.columns.map((x) => x.key)).toEqual(["code", "name", "debit", "credit"]);
    expect((await err(runStatement(fx.finance, "income-statement", { ...feb, compare: "bulan-lalu" })))?.code).toBe("VALIDATION");
  });

  it("rentang bulan penuh dibandingkan dengan bulan kalender sebelumnya; rentang tidak utuh dengan jumlah hari sama", async () => {
    await books();
    const q = await runStatement(fx.finance, "income-statement", { from: "2026-02-01", to: "2026-03-31", compare: "previous" });
    expect(q.compareLabel).toBe("1 Desember 2025 – 31 Januari 2026"); // 2 bulan penuh sebelumnya
    const odd = await runStatement(fx.finance, "income-statement", { from: "2026-02-10", to: "2026-02-20", compare: "previous" }); // 11 hari
    expect(odd.compareLabel).toBe("30 Januari 2026 – 9 Februari 2026");
    expect(pick(find(odd, /^Jumlah pendapatan usaha$/))[0]).toBe(3_000_000); // 10 Feb
  });
});

describe("neraca dan arus kas dengan pembanding + kecocokan kas", () => {
  it("neraca 28 Feb vs 31 Jan", async () => {
    await books();
    const t = await runStatement(fx.finance, "balance-sheet", { from: "2026-02-01", to: "2026-02-28", compare: "previous" });
    expect(t.compareLabel).toBe("Per 31 Januari 2026");
    const m = (re: RegExp) => pick(find(t, re));
    expect(m(/^Jumlah aset$/)).toEqual([18_300_000, 15_600_000, 2_700_000, 17.31]);
    expect(m(/Laba \(rugi\) tahun berjalan/)).toEqual([7_300_000, 4_600_000, 2_700_000, 58.7]);
    expect(m(/3-2100/)).toEqual([11_000_000, 11_000_000, 0, 0]);
    expect(m(/^Jumlah liabilitas dan ekuitas$/)).toEqual([18_300_000, 15_600_000, 2_700_000, 17.31]);
    expect(m(/Selisih \(aset/)).toEqual([0, 0, 0, null]);
  });

  it("neraca tanpa tanggal awal: 'sebelumnya' = akhir tahun lalu (nol karena sebelum pembukuan); 'tahun lalu' = tanggal sama 2025", async () => {
    await books();
    const p = await runStatement(fx.finance, "balance-sheet", { to: "2026-02-28", compare: "previous" });
    expect(p.compareLabel).toBe("Per 31 Desember 2025");
    expect(pick(find(p, /^Jumlah aset$/))).toEqual([18_300_000, 0, 18_300_000, null]);
    const y = await runStatement(fx.finance, "balance-sheet", { to: "2026-02-28", compare: "year" });
    expect(y.compareLabel).toBe("Per 28 Februari 2025");
  });

  it("arus kas Feb vs Jan: baris yang sama, kas akhir tersambung, rincian per akun tidak ikut", async () => {
    await books();
    const t = await runStatement(fx.finance, "cash-flow", { ...feb, compare: "previous" });
    const m = (re: RegExp) => pick(find(t, re));
    expect(m(/^Kas neto dari aktivitas operasi$/)).toEqual([2_700_000, 4_600_000, -1_900_000, -41.3]);
    expect(m(/^Saldo kas & bank akhir periode$/)).toEqual([18_300_000, 15_600_000, 2_700_000, 17.31]);
    expect(m(/^Saldo kas & bank awal periode$/)).toEqual([15_600_000, 0, 15_600_000, null]);
    expect(t.rows.some((r) => /Rincian per akun|→ akhir/.test(String(r.item)))).toBe(false);
    // kas akhir Jan (pembanding) = kas awal Feb (periode ini)
    expect(find(t, /^Saldo kas & bank awal periode$/).amount).toBe(find(t, /^Saldo kas & bank akhir periode$/).prev);
  });

  it("kecocokan kas: arus kas = buku besar pada neraca dan arus kas; tampil sebagai baris 'Pemeriksaan silang'", async () => {
    await books();
    const tie = await getCashTieOut(fx.finance, feb);
    expect(tie).toEqual({ asOf: "2026-02-28", cashFlowEnding: 18_300_000, ledgerCash: 18_300_000, difference: 0, ok: true });
    for (const type of ["balance-sheet", "cash-flow"] as const) {
      const t = await runStatement(fx.finance, type, feb);
      expect(find(t, /Saldo kas & bank akhir menurut laporan arus kas/).amount, type).toBe(18_300_000);
      expect(find(t, /Saldo akun kas\/bank menurut buku besar/).amount, type).toBe(18_300_000);
      const diff = find(t, /^Selisih \(harus 0\)/);
      expect([diff.amount, String(diff.item)], type).toEqual([0, "Selisih (harus 0) ✓ cocok"]);
    }
  });

  it("kecocokan kas tetap benar dengan penerimaan tak teralokasi, transfer, dan jurnal manual non-kas", async () => {
    await books();
    await prisma.cashAccount.update({ where: { id: fx.bankAcctId }, data: { isDefault: false } });
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: "2026-02-20", paymentTermDays: 30 }))).id);
    await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-02-25", amount: 900_000, method: "Transfer" }); // → 1-1450, bukan kas
    await createJournal(fx.finance, { journalDate: "2026-02-27", description: "Penyusutan", lines: [{ accountId: c("6-2000"), debit: 10_000, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: 10_000 }] });
    const tie = await getCashTieOut(fx.finance, feb);
    expect(tie).toMatchObject({ cashFlowEnding: 18_300_000, ledgerCash: 18_300_000, ok: true });
  });
});

describe("kecocokan kas mendeteksi selisih", () => {
  it("jurnal yang menyentuh akun kas (disisipkan dengan melewati trigger) → tie-out TIDAK COCOK di neraca dan arus kas", async () => {
    await books();
    const jid = crypto.randomUUID();
    await prisma.$executeRawUnsafe(`ALTER TABLE journal_entries DISABLE TRIGGER USER`); await prisma.$executeRawUnsafe(`ALTER TABLE journal_lines DISABLE TRIGGER USER`);
    try {
      await prisma.$executeRawUnsafe(`INSERT INTO journal_entries (id,kind,"entryType","journalDate",description,"createdById") VALUES ('${jid}','GENERAL','ENTRY','2026-02-15','Ilegal','${fx.finance.userId}')`);
      await prisma.$executeRawUnsafe(`INSERT INTO journal_lines (id,"journalId","lineNo","accountId",debit,credit) VALUES (gen_random_uuid(),'${jid}',1,'${c("1-1200")}',123000,0),(gen_random_uuid(),'${jid}',2,'${c("3-1100")}',0,123000)`);
    } finally { await prisma.$executeRawUnsafe(`ALTER TABLE journal_entries ENABLE TRIGGER USER`); await prisma.$executeRawUnsafe(`ALTER TABLE journal_lines ENABLE TRIGGER USER`); }
    expect(await getCashTieOut(fx.finance, feb)).toEqual({ asOf: "2026-02-28", cashFlowEnding: 18_300_000, ledgerCash: 18_423_000, difference: -123_000, ok: false });
    for (const type of ["balance-sheet", "cash-flow"] as const) {
      const d = find(await runStatement(fx.finance, type, feb), /^Selisih \(harus 0\)/);
      expect([d.amount, String(d.item)], type).toEqual([-123_000, "Selisih (harus 0) — TIDAK COCOK, hubungi Administrator"]);
    }
  });
});

describe("ekspor: CSV / Excel / PDF memuat angka yang sama", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "rpt-pdf-"));
  const info = (buf: Buffer, name: string) => {
    const f = path.join(tmp, `${name}.pdf`); writeFileSync(f, buf);
    if (process.env.PDF_OUT_DIR) writeFileSync(path.join(process.env.PDF_OUT_DIR, `laporan-${name}.pdf`), buf); // opsional: inspeksi visual manual
    const i = execFileSync("pdfinfo", [f], { encoding: "utf8" });
    return { pages: Number(/Pages:\s+(\d+)/.exec(i)![1]), landscape: (() => { const m = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(i)!; return Number(m[1]) > Number(m[2]); })(), text: execFileSync("pdftotext", ["-layout", f, "-"], { encoding: "utf8" }) };
  };
  const pdf = (t: ReportTable) => renderReportPdf(t, { companyName: "TRILOGIKA EDUTAMA", printedBy: "Finance Uji" });

  it("PDF laba rugi biasa: potret, memuat judul, perusahaan, angka, penafian, nomor halaman; simbol non-Latin disamarkan", async () => {
    await books();
    const t = await runStatement(fx.finance, "income-statement", feb);
    const buf = await pdf(t);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    const p = info(buf, "is");
    expect(p).toMatchObject({ pages: 1, landscape: false });
    for (const needle of ["TRILOGIKA EDUTAMA", "Laporan Laba Rugi (Basis Kas)", "1 Februari 2026", "Jumlah pendapatan usaha", "3.000.000", "2.700.000", "BASIS KAS", "Halaman 1 dari 1", "Dicetak", "oleh Finance Uji"]) expect(p.text, needle).toContain(needle);
  });

  it("PDF pembanding: lanskap, lima kolom, persen tampil", async () => {
    await books();
    const p = info(await pdf(await runStatement(fx.finance, "income-statement", { ...feb, compare: "previous" })), "is-cmp");
    expect(p.landscape).toBe(true);
    expect(p.text).toContain("Pembanding: 1 Januari 2026");
    expect(p.text).toMatch(/Jumlah pendapatan usaha\s+3\.000\.000\s+5\.000\.000\s+-2\.000\.000\s+-40/);
  });

  it("PDF neraca, arus kas (simbol ✓ dibuang), neraca saldo (total), buku besar (lanskap) valid", async () => {
    await books();
    const bs = info(await pdf(await runStatement(fx.finance, "balance-sheet", feb)), "bs");
    expect(bs.text).toContain("Jumlah aset");
    expect(bs.text).toContain("18.300.000");
    expect(bs.text).toMatch(/Selisih \(harus 0\) cocok\s+0/); // simbol ✓ dibuang di PDF, kata "cocok" tetap
    const cf = info(await pdf(await runStatement(fx.finance, "cash-flow", feb)), "cf");
    expect(cf.text).toContain("Saldo kas & bank akhir periode");
    expect(cf.text).toContain("-> akhir"); // panah → diganti ->
    const tb = info(await pdf(await runStatement(fx.finance, "trial-balance", { to: "2026-02-28" })), "tb");
    expect(tb.text).toMatch(/TOTAL\s+\d/);
    const gl = info(await pdf(await runStatement(fx.finance, "general-ledger", { accountId: c("1-1200"), ...feb })), "gl");
    expect(gl.landscape).toBe(true);
    expect(gl.text).toContain("Saldo awal periode");
    expect(gl.text).toMatch(/TOTAL\s+3\.050\.000\s+350\.000\s+17\.300\.000/); // baris total di kolom tanggal tetap teks "TOTAL"
    expect(gl.text).not.toContain("//");
  });

  it("buku besar panjang → beberapa halaman dengan judul kolom & nomor halaman di setiap halaman", async () => {
    await books();
    for (let i = 0; i < 70; i++) await createJournal(fx.finance, { journalDate: "2026-02-27", description: `Penyusutan ${i}`, lines: [{ accountId: c("6-2000"), debit: 1000, credit: 0 }, { accountId: c("1-2900"), debit: 0, credit: 1000 }] });
    const p = info(await pdf(await runStatement(fx.finance, "general-ledger", { accountId: c("6-2000"), ...feb })), "gl-long");
    expect(p.pages).toBeGreaterThan(1);
    expect((p.text.match(/Halaman \d+ dari \d+/g) ?? []).length).toBe(p.pages);
    expect((p.text.match(/Tanggal\s+Sumber\s+Uraian/g) ?? []).length).toBe(p.pages); // header berulang
  });

  it("CSV & Excel membawa kolom pembanding yang sama; teks berawalan = + - @ dinetralkan", async () => {
    await books();
    const t = await runStatement(fx.finance, "income-statement", { ...feb, compare: "previous" });
    const csv = toCsv(t);
    expect(csv).toContain("Periode ini (Rp),Pembanding (Rp),Selisih (Rp),Perubahan (%)");
    expect(csv).toMatch(/Jumlah pendapatan usaha,3000000,5000000,-2000000,-40/);
    expect((await toXlsx(t)).byteLength).toBeGreaterThan(2000);
    // buku besar: baris total di kolom bertipe tanggal harus tetap "TOTAL", bukan tanggal tak sah
    const gl = await runStatement(fx.finance, "general-ledger", { accountId: c("1-1200"), ...feb });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await toXlsx(gl)) as unknown as ArrayBuffer);
    const last = wb.worksheets[0]!.lastRow!;
    expect(last.getCell(1).value).toBe("TOTAL");
    expect(last.getCell(5).value).toBe(350_000);
  });
});
