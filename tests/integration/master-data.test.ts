import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, type Fixtures } from "../helpers/db";
import { createCustomer, listCustomers, searchCustomers, setCustomerActive, updateCustomer, getCustomer } from "@/server/services/customers";
import { createProduct, listProducts, searchProducts, updateProduct } from "@/server/services/products";
import { createTaxConfig, listTaxConfigs, updateTaxConfig } from "@/server/services/tax";
import { createBankAccount, getSettings, updateBankAccount, updateCompanySettings, listBankAccounts } from "@/server/services/settings";
import { confirmNumbering, getNumberingStatus, setNextNumber, updateNumberingConfig, allocateInvoiceNumber } from "@/server/services/numbering";
import { readFileForActor, sniffMime, storeFile } from "@/server/services/files";
import { createDraft, issueInvoice } from "@/server/services/invoices";
import { recordPayment } from "@/server/services/payments";
import { AppError } from "@/server/errors";

let fx: Fixtures;
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures();
});
const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as AppError;

describe("pelanggan", () => {
  it("CRUD + pencarian + pengarsipan tanpa menghapus histori", async () => {
    const c = await createCustomer(fx.finance, { name: "PT Maju Jaya", city: "Yogyakarta", email: "Info@Maju.id", npwp: "01.234.567.8-901.000", contactName: "Bu Sari" });
    expect(c.email).toBe("info@maju.id");
    const upd = await updateCustomer(fx.finance, c.id, { name: "PT Maju Jaya Abadi", city: "Yogyakarta", contactName: "Bu Sari", email: "info@maju.id", npwp: "01.234.567.8-901.000" });
    expect(upd.name).toBe("PT Maju Jaya Abadi");
    expect((await searchCustomers(fx.staff, "maju")).map((x) => x.id)).toEqual([c.id]);
    expect((await listCustomers(fx.finance, { q: "sari" })).items).toHaveLength(1);

    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { customerId: c.id }))).id);
    await setCustomerActive(fx.finance, c.id, false);
    expect(await searchCustomers(fx.staff, "maju")).toHaveLength(0); // tidak muncul di autocomplete
    expect((await listCustomers(fx.finance, { status: "archived" })).items).toHaveLength(1);
    expect(await prisma.invoice.count({ where: { id: inv.id } })).toBe(1); // histori utuh
    const summary = await getCustomer(fx.finance, c.id);
    expect(summary).toMatchObject({ invoiceCount: 1, invoicedAmount: 14_000_000, outstandingAmount: 14_000_000 });
    await recordPayment(fx.finance, { invoiceId: inv.id, paymentDate: "2026-01-14", amount: 4_000_000, method: "Transfer" });
    expect(await getCustomer(fx.finance, c.id)).toMatchObject({ paidAmount: 4_000_000, outstandingAmount: 10_000_000 });
    await setCustomerActive(fx.finance, c.id, true);
    expect(await searchCustomers(fx.staff, "maju")).toHaveLength(1);
  });

  it("pencegahan duplikasi: identik ditolak; mirip butuh konfirmasi; NPWP/email sama terdeteksi", async () => {
    await createCustomer(fx.finance, { name: "CV Cahaya Baru", city: "Sleman", npwp: "11.111.111.1-111.000", email: "a@cahaya.id" });
    const exact = await err(createCustomer(fx.finance, { name: "cahaya baru, CV.", city: "sleman" }));
    expect(exact.code).toBe("CONFLICT");
    expect((exact.extra?.duplicates as unknown[])).toHaveLength(1);
    const similar = await err(createCustomer(fx.finance, { name: "PT Cahaya Baru", city: "Bantul" }));
    expect(similar.code).toBe("CONFLICT");
    expect(similar.extra?.needsConfirmation).toBe(true);
    const sameNpwp = await err(createCustomer(fx.finance, { name: "Nama Lain Sama Sekali", npwp: "11.111.111.1-111.000" }));
    expect(sameNpwp.extra?.needsConfirmation).toBe(true);
    const ok = await createCustomer(fx.finance, { name: "PT Cahaya Baru", city: "Bantul", confirmDistinct: true });
    expect(ok.city).toBe("Bantul");
    // unique index DB sebagai pagar terakhir
    await expect(prisma.customer.create({ data: { name: "x", normalizedName: "cahaya baru", cityKey: "bantul", createdById: fx.admin.userId } })).rejects.toThrow();
  });

  it("izin: staff operasional setara Finance Manager untuk pelanggan (buat, ubah, arsip)", async () => {
    const c = await createCustomer(fx.staff, { name: "Pelanggan Dari Staff" });
    expect((await updateCustomer(fx.staff, c.id, { name: "Pelanggan Diubah Staff" })).name).toBe("Pelanggan Diubah Staff");
    expect((await setCustomerActive(fx.staff, c.id, false)).isActive).toBe(false);
    expect((await err(createCustomer(fx.finance, { name: "A" }))).code).toBe("VALIDATION"); // nama terlalu pendek
    expect((await err(createCustomer(fx.finance, { name: "Email Salah", email: "bukan-email" }))).code).toBe("VALIDATION");
  });
});

describe("produk & template deskripsi", () => {
  it("template menghasilkan deskripsi Demi Chef; baris kosong dibuang; kode unik; placeholder tak dikenal ditolak", async () => {
    const list = await listProducts(fx.staff);
    expect(list.items[0]!.description).toBe("Biaya Diklat & Uji Kompetensi\nBidang Food Production\n(Skema Demi Chef)");
    const p = await createProduct(fx.admin, { code: "barista-1", name: "Pelatihan Barista", fieldOfTraining: "F&B", unit: "Orang", defaultPrice: 1_500_000, descriptionTemplate: "{name}\nBidang {field}\n(Skema {scheme})" });
    expect(p.code).toBe("BARISTA-1");
    expect(p.description).toBe("Pelatihan Barista\nBidang F&B");
    expect((await err(createProduct(fx.admin, { code: "BARISTA-1", name: "Dobel", unit: "Pax", defaultPrice: 1 }))).code).toBe("CONFLICT");
    const bad = await err(createProduct(fx.admin, { code: "X-1", name: "Produk X", unit: "Pax", defaultPrice: 1, descriptionTemplate: "{name} {harga}" }));
    expect(bad.code).toBe("VALIDATION");
    expect(bad.message).toMatch(/\{harga\}/);
    expect((await err(createProduct(fx.admin, { code: "X-2", name: "Produk X", unit: "Pax", defaultPrice: -5 }))).code).toBe("VALIDATION");
    expect((await err(createProduct(fx.finance, { code: "X-3", name: "Produk X", unit: "Pax", defaultPrice: 5 }))).code).toBe("FORBIDDEN");
    expect((await searchProducts(fx.staff, "barista")).map((x) => x.code)).toEqual(["BARISTA-1"]);
  });

  it("mengubah harga master tercatat di audit & tidak menyentuh draft yang sudah berisi snapshot baris", async () => {
    const d = await createDraft(fx.finance, demiChefInput(fx));
    const before = await prisma.product.findUniqueOrThrow({ where: { id: fx.productId } });
    await updateProduct(fx.admin, fx.productId, { code: before.code, name: before.name, category: before.category, fieldOfTraining: before.fieldOfTraining, schemeName: before.schemeName, descriptionTemplate: before.descriptionTemplate, unit: before.unit, defaultPrice: 3_000_000, taxConfigId: null, isActive: true });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "product.update" } });
    expect((log.before as { defaultPrice: number }).defaultPrice).toBe(2_000_000);
    expect((log.after as { defaultPrice: number }).defaultPrice).toBe(3_000_000);
    const item = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: d.id } });
    expect(item.unitPrice).toBe(2_000_000n);
  });

  it("produk dapat memuat konfigurasi pajak aktif saja", async () => {
    const t = await createTaxConfig(fx.admin, { code: "ppn12", name: "PPN 12% (DPP 11/12)", ratePercent: 12, dppNumerator: 11, dppDenominator: 12 });
    await updateTaxConfig(fx.admin, t.id, { isActive: false });
    const r = await err(createProduct(fx.admin, { code: "TAX-1", name: "Produk Pajak", unit: "Pax", defaultPrice: 1, taxConfigId: t.id }));
    expect(r.code).toBe("VALIDATION");
  });
});

describe("konfigurasi pajak", () => {
  it("persen → basis point, DPP nilai lain, hanya admin, perubahan tidak mengubah invoice terbit", async () => {
    const t = await createTaxConfig(fx.admin, { code: "ppn12", name: "PPN 12% (DPP 11/12)", ratePercent: 12, dppNumerator: 11, dppDenominator: 12 });
    expect(t).toMatchObject({ code: "PPN12", rateBps: 1200, dppNumerator: 11, dppDenominator: 12, method: "EXCLUSIVE" });
    expect((await err(createTaxConfig(fx.finance, { code: "X", name: "X", ratePercent: 5 }))).code).toBe("FORBIDDEN");
    expect((await err(createTaxConfig(fx.admin, { code: "PPN12", name: "Dobel", ratePercent: 5 }))).code).toBe("CONFLICT");
    expect((await err(createTaxConfig(fx.admin, { code: "BAD", name: "Bad", ratePercent: 12.345 }))).code).toBe("VALIDATION");
    const line = { ...demiChefInput(fx).lines[0]!, taxConfigId: t.id };
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { lines: [line] }))).id);
    expect(inv.amounts.tax).toBe(1_540_000); // 14.000.000 × 11/12 × 12%
    expect(inv.amounts.total).toBe(15_540_000);
    await updateTaxConfig(fx.admin, t.id, { ratePercent: 15 });
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(row.taxAmount).toBe(1_540_000n);
    expect(row.totalAmount).toBe(15_540_000n);
    expect((await listTaxConfigs(fx.admin)).find((x) => x.id === t.id)?.rateBps).toBe(1500);
  });

  it("pajak yang dinonaktifkan menghalangi penerbitan draft yang memakainya", async () => {
    const t = await createTaxConfig(fx.admin, { code: "PPN", name: "PPN", ratePercent: 11 });
    const d = await createDraft(fx.finance, demiChefInput(fx, { lines: [{ ...demiChefInput(fx).lines[0]!, taxConfigId: t.id }] }));
    await updateTaxConfig(fx.admin, t.id, { isActive: false });
    expect((await err(issueInvoice(fx.finance, d.id))).message).toMatch(/pajak tidak aktif/);
  });

  it("perubahan tarif di antara draft dan terbit memicu peninjauan ulang (total tidak berubah diam-diam)", async () => {
    const t = await createTaxConfig(fx.admin, { code: "PPN", name: "PPN", ratePercent: 11 });
    const d = await createDraft(fx.finance, demiChefInput(fx, { lines: [{ ...demiChefInput(fx).lines[0]!, taxConfigId: t.id }] }));
    expect(d.amounts.total).toBe(15_540_000);
    await updateTaxConfig(fx.admin, t.id, { ratePercent: 12 });
    const r = await err(issueInvoice(fx.finance, d.id, { expectedTotalAmount: d.amounts.total }));
    expect(r.code).toBe("CONFLICT");
    expect(r.message).toMatch(/Total berubah/);
  });
});

describe("pengaturan perusahaan & rekening", () => {
  it("admin mengubah identitas; audit mencatat before/after; finance hanya baca; validasi", async () => {
    const s = await getSettings(fx.finance);
    expect(s.name).toBe("TRILOGIKA EDUTAMA");
    expect((await err(updateCompanySettings(fx.finance, { name: "X Corp" }))).code).toBe("FORBIDDEN");
    expect((await getSettings(fx.staff)).name).toBe("TRILOGIKA EDUTAMA"); // staff: hanya baca (setara Finance Manager)
    expect((await err(updateCompanySettings(fx.staff, { name: "X Corp" }))).code).toBe("FORBIDDEN");
    const updated = await updateCompanySettings(fx.admin, { phone: "0811-1111-2222", defaultPaymentTermDays: 7, tagline: "" });
    expect(updated).toMatchObject({ phone: "0811-1111-2222", defaultPaymentTermDays: 7, tagline: null });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "settings.company_update" } });
    expect((log.before as { phone: string }).phone).toBe("0857-0124-6319");
    expect((log.after as { phone: string }).phone).toBe("0811-1111-2222");
    expect((await err(updateCompanySettings(fx.admin, { email: "salah" }))).code).toBe("VALIDATION");
    expect((await err(updateCompanySettings(fx.admin, { defaultPaymentTermDays: -1 }))).code).toBe("VALIDATION");
    expect((await err(updateCompanySettings(fx.admin, { logoFileId: "bukan-uuid" }))).code).toBe("VALIDATION");
  });

  it("rekening: satu default aktif, tidak bisa menonaktifkan satu-satunya rekening", async () => {
    const b2 = await createBankAccount(fx.admin, { label: "BCA-IDR", accountNumber: "123-456-7890", accountName: "Trilogika Edutama", isDefault: true });
    const list = await listBankAccounts(fx.admin);
    expect(list.filter((b) => b.isDefault)).toHaveLength(1);
    expect(list.find((b) => b.isDefault)?.id).toBe(b2.id);
    await updateBankAccount(fx.admin, fx.bankId, { isActive: false });
    expect((await err(updateBankAccount(fx.admin, b2.id, { isActive: false }))).code).toBe("CONFLICT");
    // invoice baru memakai rekening default aktif
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id);
    expect(inv.bank?.label).toBe("BCA-IDR");
  });
});

describe("penomoran invoice", () => {
  it("konfirmasi wajib + pernyataan belum dipakai; nomor tidak boleh mundur; harus admin", async () => {
    await resetDb();
    fx = await seedFixtures({ confirmNumbering: false });
    let st = await getNumberingStatus(fx.admin);
    expect(st).toMatchObject({ confirmed: false, nextNumber: "00434" });
    expect((await err(confirmNumbering(fx.finance, { nextNumber: 435, acknowledgeUnused: true }))).code).toBe("FORBIDDEN");
    expect((await err(confirmNumbering(fx.admin, { nextNumber: 435, acknowledgeUnused: false }))).code).toBe("VALIDATION");
    await confirmNumbering(fx.admin, { nextNumber: 435, acknowledgeUnused: true });
    st = await getNumberingStatus(fx.admin);
    expect(st).toMatchObject({ confirmed: true, nextNumber: "00435" });
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id);
    expect(inv.number).toBe("00435");
    expect((await err(setNextNumber(fx.admin, { nextNumber: 435, reason: "mundur" }))).code).toBe("CONFLICT");
    expect((await err(setNextNumber(fx.admin, { nextNumber: 500, reason: "x" }))).code).toBe("VALIDATION");
    await setNextNumber(fx.admin, { nextNumber: 500, reason: "Impor invoice lama hingga 00499" });
    expect((await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id)).number).toBe("00500");
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "settings.numbering_set_next" } });
    expect(log.reason).toMatch(/Impor/);
    expect((log.before as { nextValue: number }).nextValue).toBe(436);
  });

  it("format INV/TE/{YYYY}/{SEQ:4} dengan reset tahunan: scope per tahun; tanggal invoice menentukan scope", async () => {
    await updateNumberingConfig(fx.admin, { invoiceNumberFormat: "INV/TE/{YYYY}/{SEQ:4}", invoiceNumberPrefix: "", invoiceNumberReset: "YEARLY", invoiceNumberStart: 1 });
    const mk = async (date: string) => (await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx, { invoiceDate: date }))).id)).number;
    expect(await mk("2026-01-13")).toBe("INV/TE/2026/0001");
    expect(await mk("2026-06-01")).toBe("INV/TE/2026/0002");
    expect(await mk("2027-01-02")).toBe("INV/TE/2027/0001");
    expect(await mk("2026-12-31")).toBe("INV/TE/2026/0003"); // invoice bertanggal 2026 yang terlambat diterbitkan
    expect((await prisma.invoiceNumberSequence.findMany({ orderBy: { scopeKey: "asc" } })).map((s) => [s.scopeKey, s.nextValue])).toEqual([["2026", 4], ["2027", 2], ["ALL", 434]]);
  });

  it("konfigurasi yang akan menabrak nomor terpakai ditolak; format tidak valid ditolak", async () => {
    await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id); // 00434
    const r = await err(updateNumberingConfig(fx.admin, { invoiceNumberFormat: "{SEQ:5}", invoiceNumberPrefix: "", invoiceNumberReset: "YEARLY", invoiceNumberStart: 434 }));
    expect(r.code).toBe("CONFLICT");
    expect(r.message).toMatch(/00434/);
    expect((await err(updateNumberingConfig(fx.admin, { invoiceNumberFormat: "INV-{YYYY}", invoiceNumberPrefix: "", invoiceNumberReset: "NEVER", invoiceNumberStart: 1 }))).code).toBe("VALIDATION");
    expect((await err(updateNumberingConfig(fx.finance, { invoiceNumberFormat: "{SEQ:5}", invoiceNumberPrefix: "", invoiceNumberReset: "NEVER", invoiceNumberStart: 1 }))).code).toBe("FORBIDDEN");
  });

  it("allocateInvoiceNumber berjalan di bawah row lock: 25 alokasi paralel = 25 nomor unik", async () => {
    const cfg = { invoiceNumberFormat: "{SEQ:5}", invoiceNumberPrefix: "", invoiceNumberReset: "NEVER" as const, invoiceNumberStart: 434 };
    const res = await Promise.all(Array.from({ length: 25 }, () => prisma.$transaction((tx) => allocateInvoiceNumber(tx, cfg, "2026-01-13"))));
    expect(new Set(res.map((r) => r.number)).size).toBe(25);
    expect(Math.min(...res.map((r) => r.seq))).toBe(434);
    expect(Math.max(...res.map((r) => r.seq))).toBe(458);
  });
});

describe("unggah file", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const PDF = new TextEncoder().encode("%PDF-1.7\n...");
  const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3]);

  it("validasi berdasarkan magic bytes, bukan nama/ekstensi", async () => {
    expect(sniffMime(PNG)?.mime).toBe("image/png");
    expect(sniffMime(PDF)?.mime).toBe("application/pdf");
    expect(sniffMime(SVG)).toBeNull();
    expect(sniffMime(EXE)).toBeNull();
    expect((await err(storeFile(fx.admin, "LOGO", { name: "logo.png", bytes: SVG }))).code).toBe("VALIDATION");
    expect((await err(storeFile(fx.admin, "LOGO", { name: "logo.png", bytes: EXE }))).code).toBe("VALIDATION");
    expect((await err(storeFile(fx.admin, "LOGO", { name: "logo.pdf", bytes: PDF }))).code).toBe("VALIDATION"); // PDF bukan logo
    expect((await err(storeFile(fx.admin, "LOGO", { name: "kosong.png", bytes: new Uint8Array() }))).code).toBe("VALIDATION");
    const big = new Uint8Array(4 * 1024 * 1024); big.set(PNG);
    expect((await err(storeFile(fx.admin, "LOGO", { name: "besar.png", bytes: big }))).message).toMatch(/maksimal 3 MB/);
    const ok = await storeFile(fx.admin, "LOGO", { name: "../../etc/passwd.png", bytes: PNG });
    const row = await prisma.storedFile.findUniqueOrThrow({ where: { id: ok.id } });
    expect(row.originalName).toBe("_.._etc_passwd.png"); // tanpa pemisah path & tanpa titik di depan
    expect(row.originalName).not.toMatch(/[\\/]/);
    expect(row.mimeType).toBe("image/png");
    expect(row.sha256).toHaveLength(64);
  });

  it("izin: logo/cap hanya admin; bukti bayar oleh pencatat pembayaran (Finance Manager & Staff Operasional)", async () => {
    expect((await err(storeFile(fx.finance, "LOGO", { name: "l.png", bytes: PNG }))).code).toBe("FORBIDDEN");
    expect((await err(storeFile(fx.staff, "LOGO", { name: "l.png", bytes: PNG }))).code).toBe("FORBIDDEN");
    const proof = await storeFile(fx.finance, "PAYMENT_PROOF", { name: "bukti.pdf", bytes: PDF });
    expect((await readFileForActor(fx.finance, proof.id)).mimeType).toBe("application/pdf");
    expect((await readFileForActor(fx.staff, proof.id)).mimeType).toBe("application/pdf");
    const staffProof = await storeFile(fx.staff, "PAYMENT_PROOF", { name: "b.pdf", bytes: PDF });
    expect((await readFileForActor(fx.finance, staffProof.id)).kind).toBe("PAYMENT_PROOF");
    const logo = await storeFile(fx.admin, "LOGO", { name: "l.png", bytes: PNG });
    expect((await readFileForActor(fx.staff, logo.id)).kind).toBe("LOGO"); // logo tampil di shell semua pengguna
    await expect(prisma.$executeRaw`UPDATE stored_files SET "originalName" = 'x'`).rejects.toThrow(/append-only/);
  });

  it("bukti pembayaran harus berjenis PAYMENT_PROOF dan terlampir pada pembayaran", async () => {
    const inv = await issueInvoice(fx.finance, (await createDraft(fx.finance, demiChefInput(fx))).id);
    const logo = await storeFile(fx.admin, "LOGO", { name: "l.png", bytes: PNG });
    const input = { invoiceId: inv.id, paymentDate: "2026-01-14", amount: 1_000_000, method: "Transfer" };
    expect((await err(recordPayment(fx.finance, { ...input, proofFileId: logo.id }))).code).toBe("VALIDATION");
    const proof = await storeFile(fx.finance, "PAYMENT_PROOF", { name: "bukti.png", bytes: PNG });
    const p = await recordPayment(fx.finance, { ...input, proofFileId: proof.id });
    expect(p.proofFileId).toBe(proof.id);
  });
});
