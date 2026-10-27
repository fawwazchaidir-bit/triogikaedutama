import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const ORIGIN = { Origin: "http://127.0.0.1:3100" };

test.describe("RBAC end-to-end", () => {
  test("Staff Operasional: setara Finance Manager kecuali approval & dashboard; API sensitif → 403", async ({ page }) => {
    await login(page, "staff");
    const nav = page.getByRole("navigation", { name: "Menu utama" });
    // Pembayaran & Laporan kini tersedia; Dashboard tetap tidak ada
    await expect(nav.getByRole("link")).toHaveText(["Invoice", "Pelanggan", "Produk & Layanan", "Pembayaran", "Pengeluaran", "Laporan", "Pengaturan"]);

    // staff melihat seluruh invoice (draft miliknya + invoice terbit lainnya)
    await page.goto("/invoices");
    const rows = page.locator("tbody tr");
    const seeded = rows.filter({ hasText: "Hotel Tirta Asri" }).filter({ hasText: "DRAFT" });
    await expect(seeded).toHaveCount(1);
    await expect(rows.filter({ hasText: "PT Nusantara Boga" }).first()).toBeVisible();

    // form: staff menginput data lengkap — harga, diskon, dan pajak dapat diisi
    await page.goto("/invoices/new");
    await page.getByRole("combobox", { name: "Pelanggan" }).fill("Bima");
    await page.getByRole("option", { name: /CV Bima Satria Jaya/ }).click();
    await page.getByRole("combobox", { name: "Produk baris 1" }).fill("Barista");
    await page.getByRole("option", { name: /Barista/ }).click();
    await expect(page.getByLabel("Harga satuan baris 1")).toBeEnabled();
    await expect(page.getByLabel("Harga satuan baris 1")).toHaveValue("1.750.000");
    await expect(page.getByLabel("Diskon tambahan")).toBeVisible();
    await expect(page.getByLabel("Diskon baris 1")).toBeVisible();
    await page.getByLabel("Kuantitas baris 1").fill("2");
    await page.getByRole("button", { name: "Simpan draft" }).click();
    await expect(page.getByRole("heading", { name: "Draft invoice" })).toBeVisible();
    // staff dapat mengajukan, tetapi tidak dapat menyetujui/menerbitkan
    await expect(page.getByRole("button", { name: "Ajukan untuk verifikasi" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Setujui & terbitkan" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Kembalikan ke staff" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Preview PDF" })).toBeVisible();
    const id = page.url().split("/").pop()!;

    // Penegakan di backend (bukan sekadar tombol tersembunyi)
    const issue = await page.request.post(`/api/invoices/${id}/issue`, { data: {}, headers: ORIGIN });
    expect(issue.status()).toBe(403);
    const reject = await page.request.post(`/api/invoices/${id}/reject`, { data: { reason: "bukan penyetuju" }, headers: ORIGIN });
    expect(reject.status()).toBe(403);
    expect((await page.request.post(`/api/invoices/${id}/cancel`, { data: { reason: "bukan Finance Manager" }, headers: ORIGIN })).status()).toBe(403);
    for (const [method, url] of [["get", "/api/dashboard"], ["get", "/api/audit-logs"], ["get", "/api/users"], ["get", "/api/tax"]] as const) {
      const r = await page.request[method](url);
      expect(r.status(), url).toBe(403);
    }
    for (const url of ["/api/payments", "/api/reports/invoices", "/api/settings"]) expect((await page.request.get(url)).status(), url).toBe(200);
    expect((await page.request.patch("/api/settings", { data: { name: "HACK" }, headers: ORIGIN })).status()).toBe(403);
    expect((await page.request.patch("/api/settings/numbering", { data: { invoiceNumberFormat: "{SEQ:9}", invoiceNumberPrefix: "", invoiceNumberReset: "NEVER", invoiceNumberStart: 1 }, headers: ORIGIN })).status()).toBe(403);
    // halaman Pembayaran & Laporan terbuka; Dashboard 404
    for (const p of ["/payments", "/reports"]) expect((await page.goto(p))!.status(), p).toBe(200);
    expect((await page.goto("/dashboard"))!.status()).toBe(404);
    expect((await page.request.get(`/api/invoices/${id}/pdf?download=1`)).status()).toBe(200); // draft sendiri: pratinjau berwatermark boleh
    // mengedit invoice orang lain tetap ditolak (draft milik staff lain / invoice terbit)
    const all = await page.request.get("/api/invoices?status=ISSUED&pageSize=1");
    const someoneElse = (await all.json()).data.items[0].id as string;
    expect([404, 409, 422]).toContain((await page.request.put(`/api/invoices/${someoneElse}`, { data: { customerId: someoneElse }, headers: ORIGIN })).status());
  });

  test("Finance Manager: dapat menyetujui/bayar/laporan; tidak dapat mengelola pengguna, penomoran, pajak, atau audit log", async ({ page }) => {
    await login(page, "finance");
    await expect(page.getByRole("navigation", { name: "Menu utama" }).getByRole("link")).toHaveText(["Dashboard", "Invoice", "Pelanggan", "Produk & Layanan", "Pembayaran", "Pengeluaran", "Kas & Bank", "Rekonsiliasi Bank", "Jurnal", "Laporan", "Laporan Keuangan", "Pajak", "Tutup Buku", "Pengaturan"]);
    for (const [method, url] of [["get", "/api/users"], ["get", "/api/audit-logs"], ["get", "/api/tax"]] as const) {
      expect((await page.request[method](url)).status(), url).toBe(403);
    }
    expect((await page.request.patch("/api/settings/numbering", { data: { invoiceNumberFormat: "{SEQ:9}", invoiceNumberPrefix: "", invoiceNumberReset: "NEVER", invoiceNumberStart: 1 }, headers: ORIGIN })).status()).toBe(403);
    expect((await page.request.get("/api/reports/invoices")).status()).toBe(200);
    await page.goto("/settings");
    await expect(page.getByText("Anda hanya dapat melihat pengaturan ini")).toBeVisible();
    await expect(page.getByRole("button", { name: "Simpan pengaturan" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Pengguna" })).toHaveCount(0);
  });

  test("Admin: ubah pengaturan perusahaan → tercatat di audit log; unggah SVG ditolak; pajak & pengguna terkelola", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/settings");
    const phone = page.getByLabel("Telepon");
    await phone.fill("0811-9999-0000");
    await page.getByRole("button", { name: "Simpan pengaturan" }).click();
    await expect(page.getByText("Pengaturan disimpan.")).toBeVisible();
    await phone.fill("0857-0124-6319");
    await page.getByRole("button", { name: "Simpan pengaturan" }).click();
    await page.goto("/audit-log?action=settings.");
    await expect(page.getByText("settings.company_update").first()).toBeVisible();
    await expect(page.getByText("Pengaturan diubah: phone").first()).toBeVisible();

    // upload SVG (berpotensi XSS) ditolak berdasarkan isi file
    const svg = await page.request.post("/api/settings/files", {
      headers: ORIGIN,
      multipart: { kind: "LOGO", file: { name: "logo.png", mimeType: "image/png", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') } },
    });
    expect(svg.status()).toBe(422);
    const png = await page.request.post("/api/settings/files", {
      headers: ORIGIN,
      multipart: { kind: "LOGO", file: { name: "x.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64") } },
    });
    expect(png.status()).toBe(201);

    await page.goto("/settings?tab=tax");
    await page.getByRole("button", { name: "Tambah pajak" }).click();
    await page.getByLabel(/^Kode/).fill("PPN-E2E");
    await page.getByLabel(/^Nama/).fill("PPN E2E 11%");
    await page.getByRole("button", { name: "Simpan", exact: true }).click();
    await expect(page.getByText("PPN-E2E")).toBeVisible();

    await page.goto("/settings?tab=users");
    await expect(page.getByRole("row", { name: /finance@trilogika.test/ })).toBeVisible();
    await page.goto("/audit-log");
    await expect(page.getByText("tax.create").first()).toBeVisible();
  });

  test("Pelanggan: pencegahan duplikasi di UI", async ({ page }) => {
    await login(page, "finance");
    await page.goto("/customers");
    await page.getByRole("button", { name: "Tambah pelanggan" }).click();
    await page.getByLabel("Nama perusahaan / instansi").fill("cv bima satria jaya");
    await page.getByLabel("Kota").fill("Sleman");
    await page.getByRole("button", { name: "Simpan", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "sudah ada" })).toBeVisible();
  });
});
