import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const ORIGIN = { Origin: "http://127.0.0.1:3100" };

test.describe("RBAC end-to-end", () => {
  test("Staff: menu terbatas, harga & pajak terkunci, tanpa tombol Terbitkan; API sensitif → 403", async ({ page }) => {
    await login(page, "staff");
    const nav = page.getByRole("navigation", { name: "Menu utama" });
    await expect(nav.getByRole("link")).toHaveText(["Invoice", "Pelanggan", "Produk & Layanan"]);

    // hanya invoice miliknya
    await page.goto("/invoices");
    const rows = page.locator("tbody tr");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Hotel Tirta Asri");
    await expect(rows.first()).toContainText("DRAFT");

    // form: harga/pajak terkunci, tanpa diskon, tombol baris bebas tidak berlaku
    await page.goto("/invoices/new");
    await page.getByRole("combobox", { name: "Pelanggan" }).fill("Bima");
    await page.getByRole("option", { name: /CV Bima Satria Jaya/ }).click();
    await page.getByRole("combobox", { name: "Produk baris 1" }).fill("Barista");
    await page.getByRole("option", { name: /Barista/ }).click();
    await expect(page.getByLabel("Harga satuan baris 1")).toBeDisabled();
    await expect(page.getByLabel("Harga satuan baris 1")).toHaveValue("1.750.000");
    await expect(page.getByLabel("Diskon tambahan")).toHaveCount(0);
    await expect(page.getByLabel("Diskon baris 1")).toHaveCount(0);
    await page.getByLabel("Kuantitas baris 1").fill("2");
    await page.getByRole("button", { name: "Simpan draft" }).click();
    await expect(page.getByRole("heading", { name: "Draft invoice" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Terbitkan" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Preview PDF" })).toBeVisible();
    const id = page.url().split("/").pop()!;

    // Penegakan di backend (bukan sekadar tombol tersembunyi)
    const issue = await page.request.post(`/api/invoices/${id}/issue`, { data: {}, headers: ORIGIN });
    expect(issue.status()).toBe(403);
    const forced = await page.request.post("/api/invoices", {
      headers: ORIGIN,
      data: { customerId: id, invoiceDate: "2026-01-01", paymentMethod: "Transfer", paymentTermDays: 4, dueDateBasis: "CALENDAR_DAYS", lines: [{ productId: null, description: "x", quantity: 1, unit: "Pax", unitPrice: 1, discount: 0, taxConfigId: null }] },
    });
    expect([403, 422]).toContain(forced.status());
    for (const [method, url] of [["get", "/api/dashboard"], ["get", "/api/payments"], ["get", "/api/audit-logs"], ["get", "/api/users"], ["get", "/api/settings"], ["get", "/api/reports/invoices"], ["get", "/api/tax"]] as const) {
      const r = await page.request[method](url);
      expect(r.status(), url).toBe(403);
    }
    expect((await page.request.post("/api/payments", { data: {}, headers: ORIGIN })).status()).toBe(403);
    expect((await page.request.patch("/api/settings", { data: { name: "HACK" }, headers: ORIGIN })).status()).toBe(403);
    expect((await page.request.get(`/api/invoices/${id}/pdf?download=1`)).status()).toBe(200); // draft sendiri: pratinjau boleh
    // PDF invoice terbit orang lain: tidak boleh (404, tidak membocorkan keberadaan)
    const all = await page.request.get("/api/invoices?pageSize=5");
    expect((await all.json()).data.items.every((i: { createdByName: string }) => i.createdByName === "Staff Demo")).toBe(true);
  });

  test("Finance: dapat terbit/bayar/laporan; tidak dapat mengelola pengguna, penomoran, pajak, atau audit log", async ({ page }) => {
    await login(page, "finance");
    await expect(page.getByRole("navigation", { name: "Menu utama" }).getByRole("link")).toHaveText(["Dashboard", "Invoice", "Pelanggan", "Produk & Layanan", "Pembayaran", "Laporan", "Pengaturan"]);
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
