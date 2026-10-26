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

  test("Staff: pengeluaran di atas Rp1 juta wajib berbukti (UI + API); tepat Rp1 juta boleh tanpa bukti", async ({ page }) => {
    await login(page, "staff");
    await page.goto("/expenses");
    await page.getByRole("button", { name: "Catat pengeluaran" }).click();
    const dlg = page.getByRole("dialog", { name: "Catat pengeluaran" });
    await dlg.getByLabel("Kategori").selectOption({ label: "5-1100 — Honor Instruktur, Asesor & Narasumber" });
    await dlg.getByLabel("Keterangan").fill("Honor besar E2E");
    await expect(dlg.getByText(/Wajib.*untuk pengeluaran di atas Rp 1\.000\.000/)).toBeVisible();

    await dlg.getByLabel("Nominal").fill("1000000"); // batas: tanpa bukti boleh → tidak ditandai wajib
    await expect(dlg.getByText("Bukti (opsional)")).toBeVisible();
    await dlg.getByLabel("Nominal").fill("1500000"); // di atas batas → label berubah jadi wajib
    await expect(dlg.getByText("Bukti transaksi")).toBeVisible();
    await dlg.getByRole("button", { name: "Simpan" }).click();
    await expect(dlg.getByRole("alert").filter({ hasText: /Bukti wajib untuk pengeluaran di atas Rp 1\.000\.000/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /Honor besar E2E/ })).toHaveCount(0);

    // lampirkan bukti → berhasil (menunggu persetujuan)
    await dlg.getByLabel(/Bukti transaksi/).setInputFiles({ name: "nota.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
    await dlg.getByRole("button", { name: "Simpan" }).click();
    const row = page.getByRole("row", { name: /Honor besar E2E/ });
    await expect(row).toContainText("Menunggu persetujuan");
    await expect(row.getByRole("link", { name: "Unduh bukti" })).toBeVisible();

    // API langsung tanpa bukti juga ditolak server (bukan hanya UI)
    const cats = (await (await page.request.get("/api/finance/coa")).json()).data as { id: string; code: string }[];
    const accts = (await (await page.request.get("/api/finance/cash-accounts/options")).json()).data as { id: string }[];
    const res = await page.request.post("/api/finance/entries", { headers: ORIGIN, data: {
      entryDate: new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10), cashAccountId: accts[0]!.id,
      counterAccountId: cats.find((c) => c.code === "5-1100")!.id, amount: 1_000_001, description: "Tanpa bukti lewat API",
    } });
    expect(res.status()).toBe(422);
    expect((await res.json()).error.fieldErrors.proofFileId).toMatch(/wajib/i);
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
    await expect(page.getByRole("navigation", { name: "Menu utama" }).getByRole("link")).toHaveText(["Dashboard", "Invoice", "Pelanggan", "Produk & Layanan", "Pembayaran", "Pengeluaran", "Kas & Bank", "Jurnal", "Laporan", "Laporan Keuangan", "Pengaturan"]);
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
  test("Finance Manager: jurnal manual seimbang → buku jurnal, neraca saldo, neraca, buku besar; pembalikan; penutupan buku", async ({ page }) => {
    await login(page, "finance");
    await page.goto("/journals");
    await expect(page.getByRole("heading", { name: "Jurnal" })).toBeVisible();
    // pembayaran/entri kas dari tes sebelumnya sudah muncul otomatis sebagai jurnal (tanpa input ganda)
    await expect(page.getByTestId("journal-item").first()).toBeVisible();
    await expect(page.getByTestId("journal-item").filter({ hasText: "Pembayaran invoice" }).first()).toBeVisible();

    const journalDialog = async (desc: string, amount: string) => {
      await page.getByRole("button", { name: "Catat jurnal" }).click();
      const dlg = page.getByRole("dialog", { name: "Catat jurnal manual" });
      await dlg.getByLabel("Keterangan").fill(desc);
      await dlg.getByLabel("Akun baris 1").selectOption({ label: "6-2000 — Beban Penyusutan" });
      await dlg.getByLabel("Debit baris 1").fill(amount);
      return dlg;
    };

    // tidak seimbang → tombol simpan nonaktif dan selisih ditampilkan
    let dlg = await journalDialog("Penyusutan E2E salah", "100000");
    await dlg.getByLabel("Akun baris 2").selectOption({ label: "1-2900 — Akumulasi Penyusutan" });
    await dlg.getByLabel("Kredit baris 2").fill("90000");
    await expect(dlg.getByRole("status")).toContainText("Selisih");
    await expect(dlg.getByRole("button", { name: "Simpan jurnal" })).toBeDisabled();
    await dlg.getByLabel("Kredit baris 2").fill("100000");
    await expect(dlg.getByRole("status")).toContainText("Seimbang");
    await dlg.getByRole("button", { name: "Simpan jurnal" }).click();
    await expect(page.getByText("Jurnal dicatat.")).toBeVisible();
    const item = page.getByTestId("journal-item").filter({ hasText: "Penyusutan E2E salah" });
    await expect(item).toContainText("6-2000");
    await expect(item).toContainText("Akumulasi Penyusutan");

    // koreksi lewat pembalikan (alasan wajib) — jurnal asli tetap tampil
    await item.getByRole("button", { name: "Balikkan" }).click();
    await page.getByRole("button", { name: "Balikkan jurnal" }).click();
    await expect(page.getByRole("dialog").getByText(/Alasan minimal 5 karakter/)).toBeVisible();
    await page.getByLabel("Alasan pembalikan").fill("Nominal keliru");
    await page.getByRole("button", { name: "Balikkan jurnal" }).click();
    await expect(page.getByText("Jurnal dibalikkan.")).toBeVisible();
    await expect(page.getByTestId("journal-item").filter({ hasText: "Pembalikan: Penyusutan E2E salah" })).toContainText("Pembalikan");
    await expect(page.getByTestId("journal-item").filter({ hasText: /^.*Penyusutan E2E salah/ }).first()).toBeVisible();

    // jurnal yang benar
    dlg = await journalDialog("Penyusutan E2E benar", "90000");
    await dlg.getByLabel("Akun baris 2").selectOption({ label: "1-2900 — Akumulasi Penyusutan" });
    await dlg.getByLabel("Kredit baris 2").fill("90000");
    await dlg.getByRole("button", { name: "Simpan jurnal" }).click();
    await expect(page.getByText("Jurnal dicatat.")).toBeVisible();
    await page.getByLabel("Sumber").selectOption("MANUAL");
    await page.getByRole("button", { name: "Terapkan" }).click();
    await expect(page.getByTestId("journal-item")).toHaveCount(3);

    // neraca saldo & neraca seimbang; laba rugi memuat beban penyusutan; buku besar akun
    await page.goto("/statements?type=trial-balance");
    await expect(page.getByRole("status").filter({ hasText: "Seimbang" })).toBeVisible();
    await expect(page.getByRole("row", { name: /6-2000.*Beban Penyusutan/ })).toContainText("90.000");
    await page.goto("/statements?type=balance-sheet");
    await expect(page.getByText("Neraca seimbang")).toBeVisible();
    await expect(page.getByText("1-2900 Akumulasi Penyusutan")).toBeVisible();
    await page.goto("/statements?type=income-statement");
    await expect(page.getByText("6-2000 Beban Penyusutan")).toBeVisible();
    await page.goto("/statements?type=general-ledger");
    await expect(page.getByText("Pilih akun untuk melihat buku besarnya.")).toBeVisible();
    await page.locator('select[name="accountId"]').selectOption({ label: "6-2000 — Beban Penyusutan" });
    await page.getByRole("button", { name: "Terapkan" }).click();
    await expect(page.getByRole("heading", { name: /Buku Besar — 6-2000/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /Total & saldo akhir/ })).toContainText("90.000");
    // neraca per akhir tahun lalu (tanggal akhir saja) tidak error
    await page.goto(`/statements?type=balance-sheet&to=${wib().slice(0, 4)}-01-01`);
    await expect(page.getByText(/Neraca seimbang|NERACA TIDAK SEIMBANG/)).toBeVisible();
    await expect(page.getByText("Tanggal awal tidak boleh setelah tanggal akhir")).toHaveCount(0);

    // ekspor neraca saldo & buku besar
    const tbCsv = await page.request.get(`/api/finance/statements/trial-balance?format=csv&to=${wib()}`);
    expect(tbCsv.status()).toBe(200);
    expect((await tbCsv.body()).toString("utf8")).toContain("Neraca Saldo");
    expect((await page.request.get("/api/finance/statements/general-ledger?format=csv")).status()).toBe(422); // tanpa akun
    expect((await page.request.get("/api/finance/journal-book?source=BUKAN")).status()).toBe(422);
  });

  test("Penutupan buku: Finance menutup sampai kemarin → jurnal bertanggal ditutup ditolak (UI + API); dicabut → diterima; staff tidak punya akses", async ({ page, browser }) => {
    await login(page, "finance");
    await page.goto("/journals");
    await expect(page.getByText("Buku belum ditutup.")).toBeVisible();
    const yesterday = new Date(Date.now() + 7 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
    await page.getByRole("button", { name: "Tutup buku" }).click();
    let dlg = page.getByRole("dialog", { name: "Penutupan buku" });
    await dlg.getByLabel("Buku ditutup sampai tanggal").fill(yesterday);
    await expect(dlg.getByRole("button", { name: "Simpan" })).toBeDisabled(); // alasan wajib
    await dlg.getByLabel("Alasan").fill("Laporan bulanan E2E final");
    await dlg.getByRole("button", { name: "Simpan" }).click();
    await expect(page.getByText("Buku ditutup.")).toBeVisible();
    await expect(page.getByText(/Buku ditutup sampai/)).toBeVisible();

    // jurnal bertanggal di periode tertutup ditolak dengan pesan jelas
    await page.getByRole("button", { name: "Catat jurnal" }).click();
    const jd = page.getByRole("dialog", { name: "Catat jurnal manual" });
    await jd.getByLabel("Tanggal").fill(yesterday);
    await jd.getByLabel("Keterangan").fill("Jurnal mundur E2E");
    await jd.getByLabel("Akun baris 1").selectOption({ label: "6-2000 — Beban Penyusutan" });
    await jd.getByLabel("Debit baris 1").fill("1000");
    await jd.getByLabel("Akun baris 2").selectOption({ label: "1-2900 — Akumulasi Penyusutan" });
    await jd.getByLabel("Kredit baris 2").fill("1000");
    await jd.getByRole("button", { name: "Simpan jurnal" }).click();
    await expect(jd.getByRole("alert").filter({ hasText: /Buku sudah ditutup sampai/ })).toBeVisible();
    await jd.getByRole("button", { name: "Batal" }).click();

    // API: pembayaran/entri bertanggal mundur juga ditolak; bertanggal hari ini diterima
    const accts = (await (await page.request.get("/api/finance/cash-accounts/options")).json()).data as { id: string }[];
    const cats = (await (await page.request.get("/api/finance/coa")).json()).data as { id: string; code: string }[];
    const entry = (entryDate: string) => page.request.post("/api/finance/entries", { headers: ORIGIN, data: { entryDate, cashAccountId: accts[0]!.id, counterAccountId: cats.find((c) => c.code === "6-1600")!.id, amount: 5000, description: "ATK uji penutupan" } });
    const back = await entry(yesterday);
    expect(back.status()).toBe(422);
    expect((await back.json()).error.message).toMatch(/Buku sudah ditutup sampai/);
    expect((await entry(wib())).status()).toBe(201);

    // staff: tidak dapat membaca/mengubah penutupan maupun jurnal
    const sctx = await browser.newContext();
    const sp = await sctx.newPage();
    await login(sp, "staff");
    expect((await sp.goto("/journals"))!.status()).toBe(404);
    expect((await sp.request.get("/api/finance/books-lock")).status()).toBe(403);
    expect((await sp.request.put("/api/finance/books-lock", { headers: ORIGIN, data: { lockedThrough: null, reason: "coba-coba staff" } })).status()).toBe(403);
    expect((await sp.request.get("/api/finance/journal-book")).status()).toBe(403);
    expect((await sp.request.post("/api/finance/journals", { headers: ORIGIN, data: {} })).status()).toBe(403);
    await sctx.close();

    // cabut penutupan → jurnal mundur diterima
    await page.reload();
    await page.getByRole("button", { name: "Ubah penutupan" }).click();
    dlg = page.getByRole("dialog", { name: "Penutupan buku" });
    await dlg.getByLabel("Alasan").fill("Audit selesai, kunci dicabut");
    await dlg.getByRole("button", { name: "Cabut penutupan" }).click();
    await expect(page.getByText("Penutupan buku dicabut.")).toBeVisible();
    await expect(page.getByText("Buku belum ditutup.")).toBeVisible();
    expect((await entry(yesterday)).status()).toBe(201);
  });
});
