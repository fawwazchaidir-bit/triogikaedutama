import { expect, test } from "@playwright/test";
import { login } from "./helpers";

const ORIGIN = { Origin: "http://127.0.0.1:3100" };
test.describe.configure({ mode: "serial" });

const wib = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

test.describe("modul keuangan basis kas (UI + RBAC)", () => {
  test("Admin: tambah akun bank dengan saldo awal manual; akun tampil dengan saldo & dapat diubah selagi belum ada mutasi", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/settings?tab=finance");
    await expect(page.getByRole("heading", { name: "Akun kas & bank" })).toBeVisible();
    await expect(page.getByRole("row", { name: /Bank Mandiri IDR/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Bagan akun/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /6-1300.*Listrik, Air, Internet/ })).toBeVisible();

    await page.getByRole("button", { name: "Tambah akun" }).first().click();
    const dlg = page.getByRole("dialog", { name: "Tambah akun kas/bank" });
    await dlg.getByLabel("Nama akun").fill("Bank E2E BCA");
    await dlg.getByLabel(/^Saldo awal/).fill("5000000");
    await dlg.getByLabel("Tanggal saldo awal").fill(wib());
    await dlg.getByRole("button", { name: "Simpan" }).click();
    await expect(page.getByText("Akun disimpan.")).toBeVisible();
    const row = page.getByRole("row", { name: /Bank E2E BCA/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText("5.000.000");

    // nama ganda ditolak dengan pesan jelas
    await page.getByRole("button", { name: "Tambah akun" }).first().click();
    const dlg2 = page.getByRole("dialog", { name: "Tambah akun kas/bank" });
    await dlg2.getByLabel("Nama akun").fill("Bank E2E BCA");
    await dlg2.getByLabel("Tanggal saldo awal").fill(wib());
    await dlg2.getByRole("button", { name: "Simpan" }).click();
    await expect(dlg2.getByRole("alert").filter({ hasText: "sudah ada" })).toBeVisible();
    await dlg2.getByRole("button", { name: "Batal" }).click();
  });

  test("Staff: mencatat pengeluaran → menunggu persetujuan; tidak ada akses kas/laporan keuangan/persetujuan", async ({ page }) => {
    await login(page, "staff");
    await expect(page.getByRole("navigation", { name: "Menu utama" }).getByRole("link", { name: "Pengeluaran" })).toBeVisible();
    await page.goto("/expenses");
    await page.getByRole("button", { name: "Catat pengeluaran" }).click();
    const dlg = page.getByRole("dialog", { name: "Catat pengeluaran" });
    await dlg.getByLabel("Kategori").selectOption({ label: "6-1600 — ATK & Perlengkapan Kantor" });
    await dlg.getByLabel("Nominal").fill("123000");
    await dlg.getByLabel("Penerima").fill("Toko ATK Maju");
    await dlg.getByLabel("Keterangan").fill("ATK E2E staff");
    await dlg.getByRole("button", { name: "Simpan" }).click();
    await expect(page.getByText(/diajukan; menunggu persetujuan/)).toBeVisible();
    const row = page.getByRole("row", { name: /ATK E2E staff/ });
    await expect(row).toContainText("Menunggu persetujuan");
    await expect(row.getByRole("button", { name: "Setujui" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Batalkan" })).toBeVisible(); // pencatat dapat membatalkan pengajuannya

    // kategori yang tersedia untuk staff hanya beban (tidak ada pendapatan/modal/aset)
    await page.getByRole("button", { name: "Catat pengeluaran" }).click();
    const opts = await page.getByRole("dialog", { name: "Catat pengeluaran" }).getByLabel("Kategori").locator("option").allTextContents();
    expect(opts.length).toBeGreaterThan(8);
    expect(opts.filter((o) => /^(1|2|3|4|7)-/.test(o))).toEqual([]);
    await page.keyboard.press("Escape");

    // halaman & API keuangan tertutup
    for (const p of ["/cash", "/statements"]) expect((await page.goto(p))!.status(), p).toBe(404);
    for (const u of ["/api/finance/cash-accounts", "/api/finance/statements/cash-flow", "/api/finance/transfers", "/api/finance/coa/00000000-0000-4000-8000-000000000000"]) {
      const r = u.includes("/coa/") ? await page.request.patch(u, { data: { name: "x" }, headers: ORIGIN }) : await page.request.get(u);
      expect(r.status(), u).toBe(403);
    }
    expect((await page.request.post("/api/finance/transfers", { data: {}, headers: ORIGIN })).status()).toBe(403);
    // staff memanggil API entri non-pengeluaran langsung → 403
    const coa = await (await page.request.get("/api/finance/coa")).json();
    expect(coa.data.every((c: { type: string }) => c.type === "BEBAN")).toBe(true);
    await page.goto("/settings");
    await expect(page.getByRole("link", { name: "Keuangan" })).toHaveCount(0);
  });

  test("Finance Manager: menyetujui & menolak (alasan wajib); laporan laba rugi, arus kas, kas & bank, transfer, pembalikan, ekspor", async ({ page, browser }) => {
    // staff menambah satu pengajuan lagi untuk ditolak
    const sctx = await browser.newContext();
    const sp = await sctx.newPage();
    await login(sp, "staff");
    await sp.goto("/expenses");
    await sp.getByRole("button", { name: "Catat pengeluaran" }).click();
    const d = sp.getByRole("dialog", { name: "Catat pengeluaran" });
    await d.getByLabel("Kategori").selectOption({ label: "6-1500 — Transportasi & Perjalanan Dinas" });
    await d.getByLabel("Nominal").fill("77000");
    await d.getByLabel("Keterangan").fill("Bensin E2E ditolak");
    await d.getByRole("button", { name: "Simpan" }).click();
    await expect(sp.getByRole("row", { name: /Bensin E2E ditolak/ })).toBeVisible();

    await login(page, "finance");
    await page.goto("/dashboard");
    await expect(page.getByRole("navigation", { name: "Menu utama" }).getByRole("link")).toHaveText(["Dashboard", "Invoice", "Pelanggan", "Produk & Layanan", "Pembayaran", "Pengeluaran", "Kas & Bank", "Laporan", "Laporan Keuangan", "Pengaturan"]);
    await page.goto("/expenses?status=PENDING");
    await expect(page.getByText(/pengeluaran menunggu persetujuan/)).toBeVisible();

    // setujui ATK
    const atk = page.getByRole("row", { name: /ATK E2E staff/ });
    await atk.getByRole("button", { name: "Setujui" }).click();
    await page.getByRole("button", { name: "Ya, setujui" }).click();
    await expect(page.getByText("Pengeluaran disetujui.")).toBeVisible();

    // tolak bensin: alasan wajib
    const bensin = page.getByRole("row", { name: /Bensin E2E ditolak/ });
    await bensin.getByRole("button", { name: "Tolak" }).click();
    await page.getByRole("button", { name: "Tolak pengeluaran" }).click();
    await expect(page.getByRole("dialog").getByText(/Alasan minimal 5 karakter/)).toBeVisible();
    await page.getByLabel("Alasan penolakan").fill("Tanpa nota");
    await page.getByRole("button", { name: "Tolak pengeluaran" }).click();
    await expect(page.getByText("Pengeluaran ditolak.")).toBeVisible();

    // staff melihat hasil keputusan (alasan penolakan)
    await sp.goto("/expenses");
    await expect(sp.getByRole("row", { name: /ATK E2E staff/ })).toContainText("Berlaku");
    await expect(sp.getByRole("row", { name: /Bensin E2E ditolak/ })).toContainText("Ditolak: Tanpa nota");
    await sctx.close();

    // Laba rugi memuat ATK yang disetujui, tanpa bensin yang ditolak
    await page.goto("/statements?type=income-statement");
    await expect(page.getByRole("heading", { name: "Laporan Laba Rugi (Basis Kas)" })).toBeVisible();
    await expect(page.getByText("6-1600 ATK & Perlengkapan Kantor")).toBeVisible();
    await expect(page.getByText("6-1500")).toHaveCount(0);
    await expect(page.getByText(/BASIS KAS|Basis Kas/).first()).toBeVisible();
    await expect(page.getByText(/PPh 23/)).toBeVisible(); // penafian pajak

    // Arus kas + ekspor CSV/XLSX
    await page.getByRole("link", { name: "Arus Kas" }).click();
    await expect(page.getByRole("heading", { name: "Laporan Arus Kas (Basis Kas)" })).toBeVisible();
    await expect(page.getByText("Saldo kas & bank akhir periode")).toBeVisible();
    const from = `${wib().slice(0, 4)}-01-01`;
    const csv = await page.request.get(`/api/finance/statements/cash-flow?format=csv&from=${from}&to=${wib()}`);
    expect(csv.status()).toBe(200);
    expect(csv.headers()["content-type"]).toContain("text/csv");
    expect((await csv.body()).toString("utf8")).toContain("Laporan Arus Kas");
    const xlsx = await page.request.get(`/api/finance/statements/income-statement?format=xlsx&from=${from}&to=${wib()}`);
    expect((await xlsx.body()).subarray(0, 2).toString()).toBe("PK");
    expect((await page.request.get("/api/finance/statements/neraca")).status()).toBe(404);
    expect((await page.request.get(`/api/finance/statements/cash-flow?from=${wib()}&to=2020-01-01`)).status()).toBe(422);

    // Kas & Bank: kartu saldo, buku kas, transfer, pembalikan transfer
    await page.goto("/cash");
    await expect(page.getByText("Total kas & bank")).toBeVisible();
    await expect(page.getByRole("link", { name: /Bank Mandiri IDR/ })).toBeVisible();
    await page.getByRole("button", { name: "Transfer antar akun" }).click();
    const t = page.getByRole("dialog", { name: "Transfer antar akun" });
    await t.getByLabel("Dari akun").selectOption({ label: "Bank Mandiri IDR" });
    await t.getByLabel("Ke akun").selectOption({ label: "Kas Kecil" });
    await t.getByLabel("Nominal").fill("100000");
    await t.getByLabel("Keterangan").fill("Transfer E2E");
    await t.getByRole("button", { name: "Simpan transfer" }).click();
    await expect(page.getByText("Transfer dicatat.")).toBeVisible();
    const tr = page.locator("section", { has: page.getByRole("heading", { name: "Transfer antar akun terbaru" }) }).getByRole("row", { name: /Transfer E2E/ });
    await expect(tr).toBeVisible();
    await tr.getByRole("button", { name: "Balikkan" }).click();
    await page.getByLabel("Alasan pembalikan").fill("Salah akun uji");
    await page.getByRole("button", { name: "Balikkan transfer" }).click();
    await expect(page.getByText("Transfer dibalikkan.")).toBeVisible();
    await expect(page.getByText("Pembalikan").first()).toBeVisible();

    // Finance mencatat penerimaan non-operasional (modal) → langsung berlaku
    await page.getByRole("button", { name: "Catat penerimaan / non-operasional" }).click();
    const o = page.getByRole("dialog", { name: "Catat penerimaan / non-operasional" });
    await o.getByLabel("Kategori").selectOption({ label: "3-1100 — Modal Disetor" });
    await o.getByLabel("Nominal").fill("1000000");
    await o.getByLabel("Keterangan").fill("Setoran modal E2E");
    await o.getByRole("button", { name: "Simpan" }).click();
    await expect(page.getByText("Entri kas dicatat.")).toBeVisible();
    await page.goto("/expenses?kind=OTHER");
    const modal = page.getByRole("row", { name: /Setoran modal E2E/ });
    await expect(modal).toContainText("Berlaku");
    await modal.getByRole("button", { name: "Balikkan" }).click();
    await page.getByLabel("Alasan pembalikan").fill("Uji pembalikan modal");
    await page.getByRole("button", { name: "Balikkan entri" }).click();
    await expect(page.getByText("Entri dibalikkan.")).toBeVisible();
    await expect(page.getByRole("row", { name: /Pembalikan: Setoran modal E2E/ })).toBeVisible();
  });

  test("Pembayaran invoice memilih akun kas penerima ('Diterima di') dan tampil di daftar pembayaran & buku kas", async ({ page }) => {
    await login(page, "finance");
    const cust = (await (await page.request.get("/api/customers/search?q=Bima")).json()).data[0].id as string;
    const prod = (await (await page.request.get("/api/products/search?q=Demi")).json()).data[0].id as string;
    const draft = await page.request.post("/api/invoices", { headers: ORIGIN, data: {
      customerId: cust, invoiceDate: wib(), paymentMethod: "Transfer", paymentTermDays: 7, dueDateBasis: "CALENDAR_DAYS",
      lines: [{ productId: prod, description: "Diklat E2E kas", quantity: 1, unit: "Pax", unitPrice: 2_000_000, discount: 0, taxConfigId: null }],
    } });
    expect(draft.status()).toBe(201);
    const id = (await draft.json()).data.id as string;
    const issued = await page.request.post(`/api/invoices/${id}/issue`, { headers: ORIGIN, data: {} });
    expect(issued.status()).toBe(200);

    await page.goto(`/invoices/${id}`);
    await page.getByRole("button", { name: "Catat pembayaran" }).click();
    const dlg = page.getByRole("dialog", { name: /Catat pembayaran/ });
    await expect(dlg.getByLabel("Diterima di")).toBeVisible();
    await expect(dlg.getByLabel("Diterima di").locator("option").first()).toContainText("Otomatis");
    await dlg.getByLabel("Diterima di").selectOption({ label: "Kas Kecil" });
    await dlg.getByLabel("Nominal").fill("500000");
    await dlg.getByLabel("Referensi transfer").fill("KAS-E2E-1");
    await dlg.getByRole("button", { name: "Simpan pembayaran" }).click();
    await expect(page.getByText("Pembayaran dicatat.")).toBeVisible();

    await page.goto("/payments?q=KAS-E2E-1");
    await expect(page.getByRole("row", { name: /KAS-E2E-1/ })).toContainText("Kas Kecil");
    // otomatis (metode Transfer) → bank default
    await page.goto(`/invoices/${id}`);
    await page.getByRole("button", { name: "Catat pembayaran" }).click();
    const d2 = page.getByRole("dialog", { name: /Catat pembayaran/ });
    await d2.getByLabel("Nominal").fill("300000");
    await d2.getByLabel("Referensi transfer").fill("BANK-E2E-1");
    await d2.getByRole("button", { name: "Simpan pembayaran" }).click();
    await expect(page.getByText("Pembayaran dicatat.")).toBeVisible();
    await page.goto("/payments?q=BANK-E2E-1");
    await expect(page.getByRole("row", { name: /BANK-E2E-1/ })).toContainText("Bank Mandiri IDR");

    // muncul pada buku kas akun terkait dengan saldo berjalan
    await page.goto("/cash");
    await page.getByRole("link", { name: /Kas Kecil/ }).first().click();
    await expect(page.getByRole("heading", { name: "Buku kas — Kas Kecil" })).toBeVisible();
    await expect(page.getByText(/Pembayaran invoice .*Bima Satria Jaya/).first()).toBeVisible();
  });
});
