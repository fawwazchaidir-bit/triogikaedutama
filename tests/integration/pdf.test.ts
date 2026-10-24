import { beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, type Fixtures } from "../helpers/db";
import { cancelInvoice, createDraft, issueInvoice, rejectInvoice, submitInvoice } from "@/server/services/invoices";
import { renderInvoicePdf } from "@/server/pdf/render";
import { AppError } from "@/server/errors";

let fx: Fixtures;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures();
});

const OUT = process.env.PDF_OUT_DIR; // opsional: simpan PDF untuk inspeksi visual manual
const tmp = mkdtempSync(path.join(tmpdir(), "inv-pdf-"));

function pdfText(buf: Buffer, name: string, mode: "-layout" | "-raw" = "-layout"): string {
  const f = path.join(tmp, `${name}.pdf`);
  writeFileSync(f, buf);
  if (OUT) writeFileSync(path.join(OUT, `${name}.pdf`), buf);
  return execFileSync("pdftotext", [mode, f, "-"], { encoding: "utf8" });
}
/** Ukuran halaman pertama dari `pdfinfo` (mis. "841.89 x 595.276 pts (A4)"). */
const pageSize = (buf: Buffer, name: string): { width: number; height: number; landscape: boolean } => {
  const f = path.join(tmp, `${name}-s.pdf`);
  writeFileSync(f, buf);
  const m = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(execFileSync("pdfinfo", [f], { encoding: "utf8" }))!;
  const width = Number(m[1]), height = Number(m[2]);
  return { width, height, landscape: width > height };
};
const pages = (buf: Buffer, name: string): number => {
  const f = path.join(tmp, `${name}-p.pdf`);
  writeFileSync(f, buf);
  return Number(/Pages:\s+(\d+)/.exec(execFileSync("pdfinfo", [f], { encoding: "utf8" }))![1]);
};

describe("PDF invoice", () => {
  it("invoice referensi: struktur, nomor, tanggal, terbilang, total, rekening — sesuai data tersimpan", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id);
    const { buffer, doc } = await renderInvoicePdf(fx.finance, inv.id);
    expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(doc.filename).toBe("Invoice_00434_CV_Bima_Satria_Jaya.pdf");
    expect(pages(buffer, "ref")).toBe(1);
    expect(pageSize(buffer, "ref")).toMatchObject({ landscape: true }); // A4 landscape
    const t = pdfText(buffer, "ref").replace(/[ \t]+/g, " "); // pdftotext meratakan spasi antar-kolom; abaikan lebar spasi
    for (const expected of [
      "TRILOGIKA EDUTAMA", "“Light & Insight”", "Jambon 01/21, Trihanggo, Gamping, Sleman", "Phone : 0857-0124-6319",
      "Email : info@trilogikaedutama.id", "NPWP : 65.472.603.3-542.000", "INVOICE", "Number", "00434", "Inv. Date", "13/01/2026",
      "Payment Term", "Transfer", "Due Date", "17/01/2026", "Customer", ": CV Bima Satria Jaya",
      "No.", "Product Description", "Quantity", "Unit Price", "Nett Amount",
      "Biaya Diklat & Uji Kompetensi", "Bidang Food Production", "(Skema Demi Chef)", "7 Pax", "Rp. 2.000.000,-", "Rp. 14.000.000,-",
      "Inword", ": Empat Belas Juta Rupiah", "Remark", "Transfer Via", "MANDIRI-IDR",
      "A/C", ": 137-00-2072139-1", "A/N", ": Trilogika Edutama", "Down Payment", "Tax", "Transport", "Administrasi", "Nett Total",
      "Sincerely,", "Finance Manager", "(Elva Aditya Fawwaz, S.E.)",
    ]) expect(t, `PDF harus memuat "${expected}"`).toContain(expected);
    expect(t).not.toContain("DRAFT");
    expect(t).not.toContain("menunggu verifikasi");
    expect(t).not.toContain("Sisa Tagihan"); // tanpa DP tidak ada baris sisa
    // Remark satu kalimat (urutan baca mentah, karena tata letak membungkusnya ke dua baris)
    const raw = pdfText(buffer, "ref", "-raw").replace(/\s+/g, " ");
    expect(raw).toContain("Remark : Biaya Diklat & Uji Kompetensi Bidang Food Production (Skema Demi Chef)");
    expect(raw).not.toMatch(/\w-\s\w/); // tidak ada kata terpotong tanda hubung
  });

  it("PDF memakai SNAPSHOT: master berubah setelah terbit tidak mengubah isi PDF", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id);
    const before = pdfText((await renderInvoicePdf(fx.finance, inv.id)).buffer, "snap-before");
    await prisma.companySettings.update({ where: { id: 1 }, data: { name: "LEMBAGA BARU", phone: "000", signerName: "Orang Lain", rupiahStyle: "PLAIN" } });
    await prisma.customer.update({ where: { id: fx.customerId }, data: { name: "PT Ganti Nama" } });
    await prisma.bankAccount.update({ where: { id: fx.bankId }, data: { accountNumber: "999-999" } });
    await prisma.product.update({ where: { id: fx.productId }, data: { defaultPrice: 1n } });
    const after = pdfText((await renderInvoicePdf(fx.finance, inv.id)).buffer, "snap-after");
    expect(after).toBe(before);
    expect(after).not.toContain("LEMBAGA BARU");
    expect(after).toContain("CV Bima Satria Jaya");
  });

  it("DP, diskon, pajak, banyak item: baris ringkasan sesuai angka tersimpan", async () => {
    const line = demiChefInput(fx).lines[0]!;
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, {
      lines: [{ ...line, quantity: 3, taxConfigId: fx.ppnId, discount: 100_000 }, { ...line, productId: null, description: "Konsultasi", quantity: "1.5", unit: "Hari", unitPrice: 1_000_000 }],
      extraDiscount: 200_000, transport: 150_000, admin: 50_000, downPayment: 5_000_000,
    }))).id);
    const t = pdfText((await renderInvoicePdf(fx.finance, inv.id)).buffer, "complex");
    expect(t).toContain("1,5 Hari");
    expect(t).toContain("Subtotal");
    expect(t).toContain("Discount");
    expect(t).toContain("Rp. 5.000.000,-"); // DP
    expect(t).toContain("Sisa Tagihan");
    expect(t).toContain(`Rp. ${(inv.amounts.total).toLocaleString("id-ID")},-`);
    expect(t).toContain("Diskon: -Rp. 100.000,-");
    expect(t).toContain("Rp. 150.000,-");
  });

  it("draft ber-watermark DRAFT tanpa nomor/tanda tangan; invoice batal ber-watermark DIBATALKAN; staff hanya pratinjau draft sendiri", async () => {
    const draft = await createDraft(fx.staff, demiChefInput(fx));
    const t = pdfText((await renderInvoicePdf(fx.staff, draft.id)).buffer, "draft");
    expect(t).toContain("DRAFT");
    expect(t).toContain("Number");
    expect(t).toContain("( menunggu verifikasi )");
    expect(t).not.toContain("(Elva Aditya Fawwaz, S.E.)"); // nama penandatangan baru muncul setelah diverifikasi
    expect(t).not.toContain("00434");
    // staff tidak boleh melihat PDF invoice terbit
    const issued = await issueInvoice(fx.finance, (await createDraft(fx.staff2, demiChefInput(fx))).id);
    await expect(renderInvoicePdf(fx.staff, "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(AppError);
    await expect(renderInvoicePdf(fx.staff2, issued.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { invoice } = await cancelInvoice(fx.finance, issued.id, { reason: "Salah pelanggan" });
    const c = pdfText((await renderInvoicePdf(fx.finance, invoice.id)).buffer, "cancelled");
    expect(c).toContain("DIBATALKAN");
    expect(c).toContain("00434"); // invoice batal tetap menunjukkan nomornya
  });

  it("dokumen yang diajukan (menunggu verifikasi) = watermark DRAFT, tanpa nomor, cap, tanda tangan; baru lengkap setelah disetujui", async () => {
    const asset = (f: string) => readFileSync(path.join(__dirname, "../../prisma/seed-assets", f));
    const mk = async (kind: "LOGO" | "STAMP" | "SIGNATURE", f: string) => (await prisma.storedFile.create({
      data: { kind, originalName: f, mimeType: "image/png", size: asset(f).length, sha256: "x".repeat(64), data: asset(f), uploadedById: fx.admin.userId },
    })).id;
    await prisma.companySettings.update({
      where: { id: 1 },
      data: {
        logoFileId: await mk("LOGO", "logo.png"), stampFileId: await mk("STAMP", "stamp.png"), signatureFileId: await mk("SIGNATURE", "stamp.png"),
        showLogo: true, showStamp: true, showSignature: true,
      },
    });
    const imgs = (b: string) => execFileSync("pdfimages", ["-list", path.join(tmp, b)], { encoding: "utf8" }).trim().split("\n").length - 2;

    const d = await createDraft(fx.staff, demiChefInput(fx));
    await submitInvoice(fx.staff, d.id);
    const pending = await renderInvoicePdf(fx.finance, d.id); // Finance Manager meninjau dokumen yang diajukan
    expect(pending.doc).toMatchObject({ status: "SUBMITTED", number: null });
    expect(pending.doc.filename).toMatch(/^Invoice_DRAFT_/);
    expect(pending.doc.data).toMatchObject({ watermark: "DRAFT", approved: false });
    const pt = pdfText(pending.buffer, "submitted");
    writeFileSync(path.join(tmp, "submitted.pdf"), pending.buffer);
    expect(pt).toContain("DRAFT");
    expect(pt).toContain("belum diverifikasi Finance Manager");
    expect(pt).toContain("Finance Manager"); // jabatan tetap tercetak, penandatangan belum
    expect(pt).toContain("( menunggu verifikasi )");
    expect(pt).not.toContain("00434");
    expect(pt).not.toContain("Elva Aditya Fawwaz");
    expect(imgs("submitted.pdf")).toBe(2); // hanya logo — tanpa cap & tanda tangan

    // dikembalikan ke staff → tetap DRAFT tanpa nomor/cap/tanda tangan
    await rejectInvoice(fx.finance, d.id, { reason: "Perbaiki nama pelanggan" });
    const back = await renderInvoicePdf(fx.staff, d.id);
    writeFileSync(path.join(tmp, "returned.pdf"), back.buffer);
    expect(back.doc.data.watermark).toBe("DRAFT");
    expect(imgs("returned.pdf")).toBe(2);

    // setelah disetujui: nomor, nama penandatangan, cap & tanda tangan muncul; watermark hilang
    await submitInvoice(fx.staff, d.id);
    const inv = await issueInvoice(fx.finance, d.id);
    const done = await renderInvoicePdf(fx.finance, inv.id);
    writeFileSync(path.join(tmp, "approved.pdf"), done.buffer);
    const at = pdfText(done.buffer, "approved");
    expect(done.doc.data).toMatchObject({ watermark: null, approved: true, disclaimer: null });
    expect(at).toContain("00434");
    expect(at).toContain("(Elva Aditya Fawwaz, S.E.)");
    expect(at).not.toContain("DRAFT");
    expect(at).not.toContain("menunggu verifikasi");
    expect(imgs("approved.pdf")).toBe(6); // logo + cap + tanda tangan (PNG ber-alpha = gambar + smask)
  });

  it("Product Description dinamis (nama peserta) tampil di tabel; Remark tetap teks program tanpa nama peserta", async () => {
    const line = demiChefInput(fx).lines[0]!;
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.staff, demiChefInput(fx, {
      lines: [{ ...line, description: "Biaya Diklat & Uji Kompetensi\nBidang Food Production\n(Skema Demi Chef)\nPeserta: Andi Saputra, Budi Santoso" }],
    }))).id);
    const { buffer } = await renderInvoicePdf(fx.finance, inv.id);
    const raw = pdfText(buffer, "dyn", "-raw").replace(/\s+/g, " ");
    expect(raw).toContain("Peserta: Andi Saputra, Budi Santoso"); // di kolom Product Description
    expect(raw).toContain("Remark : Biaya Diklat & Uji Kompetensi Bidang Food Production (Skema Demi Chef)");
    const remarkPart = raw.slice(raw.indexOf("Remark :"));
    expect(remarkPart.slice(0, 120)).not.toContain("Andi"); // nama peserta tidak ikut di Remark
  });

  it("daftar peserta sangat panjang pada satu baris: tidak error, mengalir ke halaman berikut, total tetap utuh", async () => {
    const line = demiChefInput(fx).lines[0]!;
    const names = Array.from({ length: 70 }, (_, i) => `${i + 1}. Peserta Pelatihan Nomor ${i + 1}`).join("\n");
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.staff, demiChefInput(fx, {
      lines: [{ ...line, quantity: 70, description: `Biaya Diklat & Uji Kompetensi\nBidang Food Production\n(Skema Demi Chef)\n${names}` }],
    }))).id);
    const { buffer } = await renderInvoicePdf(fx.finance, inv.id);
    const n = pages(buffer, "peserta");
    expect(n).toBeGreaterThan(1);
    const t = pdfText(buffer, "peserta");
    for (const i of [1, 35, 70]) expect(t).toContain(`${i}. Peserta Pelatihan Nomor ${i}`);
    expect(t.match(/Nett Total/g)?.length).toBe(1);
    expect(t.match(/Product Description/g)?.length).toBe(n);
  });

  it("tata letak landscape: judul INVOICE di tengah halaman; blok Number/Inv. Date/Term/Due Date mepet kanan", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id);
    const { buffer } = await renderInvoicePdf(fx.finance, inv.id);
    const f = path.join(tmp, "bbox.pdf");
    writeFileSync(f, buffer);
    const html = execFileSync("pdftotext", ["-bbox", f, "-"], { encoding: "utf8" });
    const word = (w: string) => {
      const m = new RegExp(`<word xMin="([\\d.]+)" yMin="([\\d.]+)" xMax="([\\d.]+)" yMax="([\\d.]+)">${w}</word>`).exec(html)!;
      return { x0: Number(m[1]), y0: Number(m[2]), x1: Number(m[3]), y1: Number(m[4]) };
    };
    const { width } = pageSize(buffer, "bbox");
    const title = word("INVOICE");
    expect((title.x0 + title.x1) / 2).toBeGreaterThan(width / 2 - 8);
    expect((title.x0 + title.x1) / 2).toBeLessThan(width / 2 + 8); // tepat di tengah
    const due = word("Due");
    expect(due.x0).toBeGreaterThan(width * 0.62); // blok meta menjorok ke kanan
    const dueDate = word("17/01/2026");
    expect(width - dueDate.x1).toBeLessThan(width * 0.2); // nilai berakhir dekat tepi kanan
    expect(word("Number").x0).toBeGreaterThan(title.x1); // di sebelah kanan judul
  });

  it("deskripsi panjang & banyak item: lanjut ke halaman berikut, header tabel diulang, total tetap bersama konteksnya", async () => {
    const longDesc = Array.from({ length: 4 }, (_, i) => `Baris ${i + 1} deskripsi sangat panjang untuk menguji pembungkusan teks pada kolom tabel`).join("\n");
    const lines = Array.from({ length: 30 }, (_, i) => ({
      productId: fx.productId, description: i % 5 === 0 ? longDesc : `Item layanan ${i + 1}`, quantity: i + 1, unit: "Pax", unitPrice: 2_000_000, discount: 0, taxConfigId: null,
    }));
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { lines }))).id);
    const { buffer } = await renderInvoicePdf(fx.finance, inv.id);
    const n = pages(buffer, "multi");
    expect(n).toBeGreaterThan(1);
    const t = pdfText(buffer, "multi");
    const headers = t.match(/Product Description/g) ?? [];
    expect(headers.length).toBe(n); // header tabel muncul di setiap halaman
    expect(t.match(/Nett Total/g)?.length).toBe(1);
    expect(t).toContain(`Halaman 1 / ${n}`);
    for (let i = 1; i <= 30; i++) if ((i - 1) % 5 !== 0) expect(t).toContain(`Item layanan ${i}`);
    expect(t.match(/Baris 1 deskripsi/g)?.length).toBe(6); // 6 item berdeskripsi panjang, tidak ada yang terpotong
    expect(t.match(/Baris 4 deskripsi/g)?.length).toBe(6);
    // halaman terakhir memuat total beserta setidaknya satu baris item (tidak terpisah dari konteksnya)
    const lastPage = t.split("\f").filter((p) => p.trim())[n - 1]!;
    expect(lastPage).toContain("Nett Total");
    expect(lastPage).toMatch(/Item layanan \d+|Baris 1 deskripsi/);
  });

  it("logo & cap dari pengaturan ikut tercetak (dibekukan saat terbit); draft tidak memakai cap", async () => {
    const asset = (f: string) => readFileSync(path.join(__dirname, "../../prisma/seed-assets", f));
    const mk = async (kind: "LOGO" | "STAMP", f: string) => (await prisma.storedFile.create({
      data: { kind, originalName: f, mimeType: "image/png", size: asset(f).length, sha256: "x".repeat(64), data: asset(f), uploadedById: fx.admin.userId },
    })).id;
    const logoId = await mk("LOGO", "logo.png");
    const stampId = await mk("STAMP", "stamp.png");
    await prisma.companySettings.update({ where: { id: 1 }, data: { logoFileId: logoId, stampFileId: stampId, showLogo: true, showStamp: true } });
    const draft = await createDraft(fx.finance, demiChefInput(fx));
    const dBuf = (await renderInvoicePdf(fx.finance, draft.id)).buffer;
    writeFileSync(path.join(tmp, "with-draft.pdf"), dBuf);
    const inv = await issueInvoice(fx.finance, draft.id);
    const { buffer } = await renderInvoicePdf(fx.finance, inv.id);
    pdfText(buffer, "with-images");
    const imgs = (b: string) => execFileSync("pdfimages", ["-list", path.join(tmp, b)], { encoding: "utf8" }).trim().split("\n").length - 2;
    expect(imgs("with-images.pdf")).toBe(4); // logo + cap (PNG ber-alpha = gambar + smask)
    expect(imgs("with-draft.pdf")).toBe(2); // draft: hanya logo
    // setelah terbit, mematikan cap di pengaturan tidak mengubah invoice lama
    await prisma.companySettings.update({ where: { id: 1 }, data: { showStamp: false, showLogo: false } });
    const again = (await renderInvoicePdf(fx.finance, inv.id)).buffer;
    writeFileSync(path.join(tmp, "again.pdf"), again);
    expect(imgs("again.pdf")).toBe(4);
  });

  it("nama file memakai nomor format lain & aman", async () => {
    await prisma.companySettings.update({ where: { id: 1 }, data: { invoiceNumberFormat: "INV/TE/{YYYY}/{SEQ:4}", invoiceNumberReset: "YEARLY", invoiceNumberStart: 1 } });
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id);
    const { doc } = await renderInvoicePdf(fx.finance, inv.id);
    expect(doc.filename).toBe("Invoice_INV-TE-2026-0001_CV_Bima_Satria_Jaya.pdf");
    expect(readFileSync(path.join(tmp, "ref.pdf"), { flag: "a+" }).length >= 0).toBe(true);
  });
});
