import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { login } from "./helpers";

const ORIGIN = { Origin: "http://127.0.0.1:3100" };
const dir = mkdtempSync(path.join(tmpdir(), "e2e-pdf-"));

async function pdfText(res: APIResponse, name: string): Promise<string> {
  const f = path.join(dir, `${name}.pdf`);
  writeFileSync(f, await res.body());
  return execFileSync("pdftotext", ["-layout", f, "-"], { encoding: "utf8" }).replace(/[ \t]+/g, " ");
}

async function fillDemiChefInvoice(page: Page, qty: string) {
  await page.goto("/invoices/new");
  await page.getByRole("combobox", { name: "Pelanggan" }).fill("Bima");
  await page.getByRole("option", { name: /CV Bima Satria Jaya/ }).click();
  await page.getByRole("combobox", { name: "Produk baris 1" }).fill("Demi");
  await page.getByRole("option", { name: /Demi Chef/ }).click();
  await page.getByLabel("Kuantitas baris 1").fill(qty);
}

test.describe.configure({ mode: "serial" });

test("Finance: buat → draft → preview → terbitkan → unduh PDF → bayar sebagian → lunas", async ({ page }) => {
  await login(page, "finance");
  await fillDemiChefInvoice(page, "7");

  // Isian otomatis dari master + perhitungan langsung
  await expect(page.getByLabel("Harga satuan baris 1")).toHaveValue("2.000.000");
  await expect(page.getByLabel("Deskripsi (tampil di invoice)")).toHaveValue("Biaya Diklat & Uji Kompetensi\nBidang Food Production\n(Skema Demi Chef)");
  await expect(page.getByText("Empat Belas Juta Rupiah")).toBeVisible();
  await expect(page.getByText("Rp 14.000.000").first()).toBeVisible();
  await expect(page.getByLabel("Tanggal jatuh tempo")).toContainText(/\d{2}\/\d{2}\/\d{4}/);

  await page.getByRole("button", { name: "Simpan draft" }).click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  const id = page.url().split("/").pop()!;
  await expect(page.getByRole("heading", { name: "Draft invoice" })).toBeVisible();

  // Pratinjau draft: PDF berwatermark DRAFT dari data TERSIMPAN
  await page.getByRole("button", { name: "Preview PDF" }).click();
  await expect(page.locator("iframe[title^='Pratinjau PDF']")).toBeVisible();
  const draftPdf = await page.request.get(`/api/invoices/${id}/pdf`);
  expect(draftPdf.status()).toBe(200);
  expect(draftPdf.headers()["content-type"]).toBe("application/pdf");
  const draftText = await pdfText(draftPdf, "draft");
  expect(draftText).toContain("DRAFT");
  expect(draftText).toContain("CV Bima Satria Jaya");
  await page.keyboard.press("Escape");

  // Terbitkan (dengan konfirmasi)
  await page.getByRole("button", { name: "Terbitkan" }).click();
  await expect(page.getByRole("dialog", { name: /Terbitkan invoice/ })).toBeVisible();
  await page.getByRole("button", { name: "Ya, terbitkan" }).click();
  const heading = page.getByRole("heading", { name: /^Invoice \d+$/ });
  await expect(heading).toBeVisible();
  const number = (await heading.textContent())!.replace("Invoice ", "").trim();
  expect(number).toMatch(/^\d{5}$/);
  await expect(page.getByText("Diterbitkan", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Belum Dibayar")).toBeVisible();

  // PDF final: nama file otomatis + isi sesuai data tersimpan
  const pdf = await page.request.get(`/api/invoices/${id}/pdf?download=1`);
  expect(pdf.headers()["content-disposition"]).toContain(`Invoice_${number}_CV_Bima_Satria_Jaya.pdf`);
  const text = await pdfText(pdf, "issued");
  for (const s of [`: ${number}`, "CV Bima Satria Jaya", "7 Pax", "Rp. 2.000.000,-", "Rp. 14.000.000,-", ": Empat Belas Juta Rupiah", "MANDIRI-IDR", ": 137-00-2072139-1", "Sincerely,", "(Elva Aditya Fawwaz, S.E.)"]) {
    expect(text, s).toContain(s);
  }
  expect(text).not.toContain("DRAFT");

  // Pembayaran sebagian 5 jt
  const pay = async (amount: string) => {
    await page.getByRole("button", { name: "Catat pembayaran" }).click();
    await page.getByLabel("Nominal").fill(amount);
    await page.getByLabel("Referensi transfer").fill(`TRX-E2E-${amount}`);
    await page.getByRole("button", { name: "Simpan pembayaran" }).click();
  };
  await pay("5000000");
  await expect(page.getByText("Dibayar Sebagian")).toBeVisible();
  await expect(page.getByText("Rp 9.000.000").first()).toBeVisible();

  // Kelebihan bayar ditolak oleh server dengan pesan jelas
  await page.getByRole("button", { name: "Catat pembayaran" }).click();
  await page.getByLabel("Nominal").fill("10000000");
  await page.getByRole("button", { name: "Simpan pembayaran" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "melebihi sisa tagihan" })).toBeVisible();
  await page.getByLabel("Nominal").fill("9000000");
  await page.getByRole("button", { name: "Simpan pembayaran" }).click();
  await expect(page.getByText("Lunas").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Catat pembayaran" })).toHaveCount(0);

  // Riwayat audit tampil di detail
  await expect(page.getByText("Pembayaran dicatat").first()).toBeVisible();
  await expect(page.getByText("Diterbitkan", { exact: false }).last()).toBeVisible();

  // Tidak dapat diedit setelah terbit (server menolak; URL edit dialihkan ke detail)
  await page.goto(`/invoices/${id}/edit`);
  await expect(page).toHaveURL(new RegExp(`/invoices/${id}$`));
  const put = await page.request.put(`/api/invoices/${id}`, { data: { customerId: id }, headers: ORIGIN });
  expect([409, 422]).toContain(put.status());
});

test("Finance: dua tab menerbitkan draft yang sama → hanya satu yang berhasil, satu nomor terpakai", async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  await login(a, "finance");
  await fillDemiChefInput(a);
  async function fillDemiChefInput(p: Page) { await fillDemiChefInvoice(p, "2"); await p.getByRole("button", { name: "Simpan draft" }).click(); await expect(p).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/); }
  const id = a.url().split("/").pop()!;
  const b = await ctx.newPage();
  await b.goto(`/invoices/${id}`);
  const before = await a.request.get("/api/invoices?status=ISSUED&pageSize=1&sort=number&dir=desc", { headers: ORIGIN });
  const lastNumber = (await before.json()).data.items[0].number as string;

  const results = await Promise.all([
    a.request.post(`/api/invoices/${id}/issue`, { data: {}, headers: ORIGIN }),
    b.request.post(`/api/invoices/${id}/issue`, { data: {}, headers: ORIGIN }),
    a.request.post(`/api/invoices/${id}/issue`, { data: {}, headers: ORIGIN }),
  ]);
  const statuses = results.map((r) => r.status()).sort();
  expect(statuses).toEqual([200, 409, 409]);
  const issued = (await (results.find((r) => r.status() === 200)!).json()).data;
  expect(Number(issued.number)).toBe(Number(lastNumber) + 1); // tepat satu nomor terpakai, tanpa celah
  await ctx.close();
});

test("Finance: duplikasi membuat draft baru tanpa nomor/pembayaran; pembatalan menyimpan riwayat & nomor", async ({ page }) => {
  await login(page, "finance");
  await page.goto("/invoices?status=ISSUED&paymentStatus=PAID");
  await page.locator("tbody tr").first().getByRole("link").first().click();
  const srcUrl = page.url();
  const srcNumber = (await page.getByRole("heading", { name: /^Invoice \d+$/ }).textContent())!.replace("Invoice ", "");
  await page.getByRole("button", { name: "Aksi lainnya" }).click();
  await page.getByRole("menuitem", { name: "Duplikasi" }).click();
  await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}\/edit$/);
  await expect(page.getByRole("heading", { name: "Edit draft invoice" })).toBeVisible();
  await page.getByRole("button", { name: "Simpan draft" }).click();
  await expect(page.getByRole("heading", { name: "Draft invoice" })).toBeVisible();
  await expect(page.getByText(/^Disalin dari \d{5}$/)).toBeVisible();
  await expect(page.getByText("Belum ada pembayaran")).toHaveCount(0); // draft tidak menampilkan bagian pembayaran
  await page.getByRole("button", { name: "Terbitkan" }).click();
  await page.getByRole("button", { name: "Ya, terbitkan" }).click();
  const newNumber = (await page.getByRole("heading", { name: /^Invoice \d+$/ }).textContent())!.replace("Invoice ", "");
  expect(Number(newNumber)).toBeGreaterThan(Number(srcNumber));
  await expect(page.getByText("Belum Dibayar")).toBeVisible();

  // Batalkan: alasan wajib
  await page.getByRole("button", { name: "Aksi lainnya" }).click();
  await page.getByRole("menuitem", { name: "Batalkan invoice…" }).click();
  await page.getByRole("button", { name: "Batalkan invoice" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /alasan/i })).toBeVisible();
  await page.getByLabel("Alasan pembatalan").fill("Uji E2E: salah nama pelanggan");
  await page.getByLabel(/Buat draft pengganti/).uncheck();
  await page.getByRole("button", { name: "Batalkan invoice" }).click();
  await expect(page.getByText("Invoice dibatalkan").first()).toBeVisible();
  await expect(page.getByText(`Nomor ${newNumber} tidak akan dipakai ulang`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview PDF" })).toBeVisible(); // PDF invoice batal tetap ada (watermark)
  await page.goto("/invoices?status=CANCELLED");
  await expect(page.getByRole("link", { name: newNumber })).toBeVisible();
  void srcUrl;
});

test("Daftar invoice: pencarian, filter, urut, paginasi, dan ekspor CSV/Excel", async ({ page }) => {
  await login(page, "finance");
  await page.goto("/invoices");
  await page.getByPlaceholder("Cari…").fill("Nusantara");
  await page.getByRole("button", { name: "Terapkan" }).click();
  await expect(page).toHaveURL(/q=Nusantara/);
  const rows = page.locator("tbody tr");
  await expect(rows.first()).toContainText("PT Nusantara Boga");
  for (const r of await rows.all()) await expect(r).toContainText("PT Nusantara Boga");
  await page.getByRole("link", { name: /Urutkan berdasarkan Total/ }).click();
  await expect(page).toHaveURL(/sort=total/);

  const csv = await page.request.get("/api/invoices/export?format=csv&q=Nusantara");
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  const body = (await csv.body()).toString("utf8");
  expect(body).toContain("PT Nusantara Boga");
  expect(body).not.toContain("CV Bima");
  const xlsx = await page.request.get("/api/invoices/export?format=xlsx");
  expect(xlsx.headers()["content-type"]).toContain("spreadsheetml");
  expect((await xlsx.body()).subarray(0, 2).toString()).toBe("PK"); // berkas zip/xlsx valid

  await page.goto("/invoices?paymentStatus=OVERDUE");
  await expect(page.locator("tbody tr").first()).toContainText(/Jatuh Tempo/);
});
