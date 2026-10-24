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

function pageSizeOf(buf: Buffer, name: string): { landscape: boolean } {
  const f = path.join(dir, `${name}.pdf`);
  writeFileSync(f, buf);
  const m = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(execFileSync("pdfinfo", [f], { encoding: "utf8" }))!;
  return { landscape: Number(m[1]) > Number(m[2]) };
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
  await expect(page.getByLabel("Product Description (dinamis)")).toHaveValue("Biaya Diklat & Uji Kompetensi\nBidang Food Production\n(Skema Demi Chef)");
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

  // Finance Manager menyetujui & menerbitkan draftnya sendiri (dengan konfirmasi)
  await page.getByRole("button", { name: "Setujui & terbitkan" }).click();
  await expect(page.getByRole("dialog", { name: /Setujui & terbitkan invoice/ })).toBeVisible();
  await page.getByRole("button", { name: "Ya, setujui & terbitkan" }).click();
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
  for (const s of [`: ${number}`, "CV Bima Satria Jaya", "7 Pax", "Rp. 2.000.000,-", "Rp. 14.000.000,-", ": Empat Belas Juta Rupiah", "MANDIRI-IDR", ": 137-00-2072139-1", "Sincerely,", "Finance Manager", "(Elva Aditya Fawwaz, S.E.)"]) {
    expect(text, s).toContain(s);
  }
  expect(text).not.toContain("DRAFT");
  expect(pageSizeOf(await pdf.body(), "issued-size").landscape).toBe(true); // format landscape

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
  await page.getByRole("button", { name: "Setujui & terbitkan" }).click();
  await page.getByRole("button", { name: "Ya, setujui & terbitkan" }).click();
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

test("Alur persetujuan: Staff mengajukan → Finance Manager meninjau lengkap, mengembalikan, lalu menyetujui → PDF resmi", async ({ browser }) => {
  const staffCtx = await browser.newContext();
  const finCtx = await browser.newContext();
  const staff = await staffCtx.newPage();
  const fin = await finCtx.newPage();
  await login(staff, "staff");
  await login(fin, "finance");

  // 1) Staff menginput lengkap: Product Description dinamis (nama peserta) — Remark tetap mengikuti program
  await fillDemiChefInvoice(staff, "3");
  const desc = staff.getByLabel("Product Description (dinamis)");
  await desc.fill("Biaya Diklat & Uji Kompetensi\nBidang Food Production\n(Skema Demi Chef)\nPeserta: Andi Saputra, Budi Santoso");
  const remark = staff.getByLabel("Remark (tetap mengikuti program)");
  await expect(remark).toHaveAttribute("placeholder", "Biaya Diklat & Uji Kompetensi Bidang Food Production (Skema Demi Chef)");
  await expect(remark).toHaveValue("");
  await expect(staff.getByLabel("Harga satuan baris 1")).toBeEnabled(); // staff menginput data lengkap
  await expect(staff.getByLabel("Diskon baris 1")).toBeVisible();
  await staff.getByRole("button", { name: "Simpan & ajukan verifikasi" }).click();
  await expect(staff).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
  const id = staff.url().split("/").pop()!;
  await expect(staff.getByRole("heading", { name: "Invoice menunggu verifikasi" })).toBeVisible();
  await expect(staff.getByText("Menunggu Verifikasi", { exact: true }).first()).toBeVisible();
  await expect(staff.getByText(/Menunggu verifikasi Finance Manager/)).toBeVisible();
  await expect(staff.getByRole("button", { name: "Setujui & terbitkan" })).toHaveCount(0); // staff tidak dapat menyetujui
  await expect(staff.getByRole("button", { name: "Tarik kembali" })).toBeVisible();
  await expect(staff.getByRole("link", { name: "Edit draft" })).toHaveCount(0); // terkunci

  // Dokumen yang diajukan: watermark DRAFT, tanpa nomor/tanda tangan
  const pending = await staff.request.get(`/api/invoices/${id}/pdf`);
  expect(pending.status()).toBe(200);
  const pendingText = await pdfText(pending, "pending");
  expect(pendingText).toContain("DRAFT");
  expect(pendingText).toContain("Peserta: Andi Saputra, Budi Santoso");
  expect(pendingText).toContain("( menunggu verifikasi )");
  expect(pendingText).not.toContain("(Elva Aditya Fawwaz, S.E.)");
  // Backend menolak penyuntingan & persetujuan oleh staff
  expect((await staff.request.put(`/api/invoices/${id}`, { data: { customerId: id }, headers: ORIGIN })).status()).toBeGreaterThanOrEqual(400);
  expect((await staff.request.post(`/api/invoices/${id}/issue`, { data: {}, headers: ORIGIN })).status()).toBe(403);
  expect((await staff.request.post(`/api/invoices/${id}/reject`, { data: { reason: "bukan penyetuju" }, headers: ORIGIN })).status()).toBe(403);

  // 2) Finance Manager melihat data lengkap & antrean di dashboard
  await fin.goto("/dashboard");
  await expect(fin.getByRole("link", { name: /Menunggu verifikasi/ })).toBeVisible(); // antrean verifikasi di dashboard
  await fin.goto(`/invoices/${id}`);
  await expect(fin.getByText(/Menunggu verifikasi Finance Manager/)).toBeVisible();
  await expect(fin.getByText("CV Bima Satria Jaya").first()).toBeVisible();
  await expect(fin.getByText("Peserta: Andi Saputra, Budi Santoso")).toBeVisible();
  await expect(fin.getByText("Staff Demo").first()).toBeVisible(); // pengaju terlihat
  await expect(fin.getByText("Rp 6.000.000").first()).toBeVisible();

  // 3) Dikembalikan dengan alasan wajib
  await fin.getByRole("button", { name: "Kembalikan ke staff" }).click();
  await fin.getByRole("button", { name: "Kembalikan", exact: true }).click();
  await expect(fin.getByRole("dialog").getByText(/alasan|Alasan/).first()).toBeVisible();
  await fin.getByLabel("Alasan / catatan perbaikan").fill("Jumlah peserta belum sesuai surat tugas");
  await fin.getByRole("button", { name: "Kembalikan", exact: true }).click();
  await expect(fin.getByText("Dikembalikan oleh")).toBeVisible();
  await expect(fin.getByRole("heading", { name: "Draft invoice" })).toBeVisible();

  // 4) Staff melihat catatan, memperbaiki, dan mengajukan ulang
  await staff.goto(`/invoices/${id}`);
  await expect(staff.getByText("Jumlah peserta belum sesuai surat tugas").first()).toBeVisible(); // catatan + riwayat (staff kini melihat riwayat)
  await staff.getByRole("link", { name: "Edit draft" }).first().click();
  await staff.getByLabel("Kuantitas baris 1").fill("2");
  await staff.getByRole("button", { name: "Simpan & ajukan verifikasi" }).click();
  await expect(staff.getByRole("heading", { name: "Invoice menunggu verifikasi" })).toBeVisible();

  // 5) Finance Manager menyetujui → nomor, tanda tangan, dan PDF resmi
  await fin.goto(`/invoices/${id}`);
  await fin.getByRole("button", { name: "Setujui & terbitkan" }).first().click();
  await fin.getByRole("button", { name: "Ya, setujui & terbitkan" }).click();
  const heading = fin.getByRole("heading", { name: /^Invoice \d+$/ });
  await expect(heading).toBeVisible();
  const number = (await heading.textContent())!.replace("Invoice ", "").trim();
  await expect(fin.getByText(/Disetujui & diterbitkan/).first()).toBeVisible();

  const official = await fin.request.get(`/api/invoices/${id}/pdf?download=1`);
  expect(official.status()).toBe(200);
  const officialText = await pdfText(official, "official");
  for (const s of [`: ${number}`, "4.000.000", "Finance Manager", "(Elva Aditya Fawwaz, S.E.)", "Peserta: Andi Saputra, Budi Santoso", "Remark : Biaya Diklat & Uji Kompetensi Bidang Food"]) {
    expect(officialText, s).toContain(s);
  }
  expect(officialText).not.toContain("DRAFT");
  expect(officialText).not.toContain("menunggu verifikasi");
  expect(pageSizeOf(await official.body(), "official-size").landscape).toBe(true);

  // 6) Staff Operasional setara Finance Manager setelah terbit: melihat PDF resmi dan mencatat pembayaran
  expect((await staff.request.get(`/api/invoices/${id}/pdf`)).status()).toBe(200);
  await staff.goto(`/invoices/${id}`);
  await expect(staff.getByRole("button", { name: "Preview PDF" })).toBeVisible();
  await expect(staff.getByRole("button", { name: "Setujui & terbitkan" })).toHaveCount(0); // approval tetap hanya penyetuju
  await staff.getByRole("button", { name: "Catat pembayaran" }).click();
  await staff.getByLabel("Nominal").fill("1000000");
  await staff.getByLabel("Referensi transfer").fill("TRX-E2E-STAFF");
  await staff.getByRole("button", { name: "Simpan pembayaran" }).click();
  await expect(staff.getByText("Dibayar Sebagian")).toBeVisible();
  await staff.goto("/payments");
  await expect(staff.getByText("TRX-E2E-STAFF")).toBeVisible();
  await staff.goto("/reports");
  await expect(staff.getByRole("heading", { name: "Laporan" })).toBeVisible();
  await staffCtx.close();
  await finCtx.close();
});
