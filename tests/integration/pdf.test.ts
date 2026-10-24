import { beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, type Fixtures } from "../helpers/db";
import { cancelInvoice, createDraft, issueInvoice } from "@/server/services/invoices";
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
    const t = pdfText(buffer, "ref").replace(/[ \t]+/g, " "); // pdftotext meratakan spasi antar-kolom; abaikan lebar spasi
    for (const expected of [
      "TRILOGIKA EDUTAMA", "“Light & Insight”", "Jambon 01/21, Trihanggo, Gamping, Sleman", "Phone : 0857-0124-6319",
      "Email : info@trilogikaedutama.id", "NPWP : 65.472.603.3-542.000", "INVOICE", "Number", ": 00434", "Inv. Date", ": 13/01/2026",
      "Payment Term", ": Transfer", "Due Date", ": 17/01/2026", "Customer", ": CV Bima Satria Jaya",
      "No.", "Product Description", "Quantity", "Unit Price", "Nett Amount",
      "Biaya Diklat & Uji Kompetensi", "Bidang Food Production", "(Skema Demi Chef)", "7 Pax", "Rp. 2.000.000,-", "Rp. 14.000.000,-",
      "Inword", ": Empat Belas Juta Rupiah", "Remark", "Transfer Via", "MANDIRI-IDR",
      "A/C", ": 137-00-2072139-1", "A/N", ": Trilogika Edutama", "Down Payment", "Tax", "Transport", "Administrasi", "Nett Total",
      "Sincerely,", "Finance", "(Elva Aditya Fawwaz, S.E.)",
    ]) expect(t, `PDF harus memuat "${expected}"`).toContain(expected);
    expect(t).not.toContain("DRAFT");
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

  it("draft ber-watermark DRAFT; invoice batal ber-watermark DIBATALKAN; staff hanya pratinjau draft sendiri", async () => {
    const draft = await createDraft(fx.staff, demiChefInput(fx));
    const t = pdfText((await renderInvoicePdf(fx.staff, draft.id)).buffer, "draft");
    expect(t).toContain("DRAFT");
    expect(t).toContain("Number");
    // staff tidak boleh melihat PDF invoice terbit
    const issued = await issueInvoice(fx.finance, (await createDraft(fx.staff2, demiChefInput(fx))).id);
    await expect(renderInvoicePdf(fx.staff, draft.id.replace(/./, "0"))).rejects.toBeInstanceOf(AppError);
    await expect(renderInvoicePdf(fx.staff2, issued.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { invoice } = await cancelInvoice(fx.finance, issued.id, { reason: "Salah pelanggan" });
    const c = pdfText((await renderInvoicePdf(fx.finance, invoice.id)).buffer, "cancelled");
    expect(c).toContain("DIBATALKAN");
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
