/**
 * SEED DEVELOPMENT — data demo untuk pengembangan & uji manual. JANGAN dijalankan di produksi.
 *
 * Pengaman: menolak berjalan bila NODE_ENV=production atau DATABASE_URL tidak mengarah ke host lokal
 * (kecuali ALLOW_DEV_SEED=1 diset secara sadar). Password akun demo diambil dari DEV_SEED_PASSWORD
 * atau dibuat acak dan dicetak SEKALI di terminal.
 *
 * Seluruh data dibuat lewat SERVICE LAYER yang sama dengan aplikasi, sehingga angka, nomor, snapshot, dan audit
 * konsisten dengan perilaku sebenarnya.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { hashPassword } from "../src/server/auth/password";
import { prisma, seedBase } from "./seed";
import type { Actor } from "../src/server/actor";
import { createCustomer } from "../src/server/services/customers";
import { createProduct } from "../src/server/services/products";
import { createTaxConfig } from "../src/server/services/tax";
import { confirmNumbering } from "../src/server/services/numbering";
import { cancelInvoice, createDraft, issueInvoice } from "../src/server/services/invoices";
import { recordPayment } from "../src/server/services/payments";
import { createCashAccount } from "../src/server/services/cash-accounts";
import { createEntry, createTransfer } from "../src/server/services/cash-entries";
import { storeFile } from "../src/server/services/files";
import { addCalendarDays } from "../src/lib/finance/due-date";
import { todayIso } from "../src/lib/format";

function guard() {
  const url = process.env.DATABASE_URL ?? "";
  const local = /@(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(url);
  if ((process.env.NODE_ENV === "production" || !local) && process.env.ALLOW_DEV_SEED !== "1") {
    throw new Error("Seed development ditolak: bukan lingkungan lokal. (Set ALLOW_DEV_SEED=1 hanya bila Anda yakin.)");
  }
}

async function ensureUser(email: string, name: string, role: "ADMIN" | "FINANCE" | "STAFF", password: string): Promise<Actor> {
  const u = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name, role, passwordHash: await hashPassword(password) },
  });
  return { userId: u.id, email: u.email, name: u.name, role: u.role };
}

async function main() {
  guard();
  const password = process.env.DEV_SEED_PASSWORD || `${randomBytes(9).toString("base64url")}-Aa1`;
  process.env.ADMIN_EMAIL ||= "admin@trilogika.test";
  process.env.ADMIN_NAME ||= "Admin Demo";
  process.env.ADMIN_PASSWORD ||= password;
  await seedBase();

  const admin = await ensureUser("admin@trilogika.test", "Admin Demo", "ADMIN", password);
  const finance = await ensureUser("finance@trilogika.test", "Elva (Finance Demo)", "FINANCE", password);
  const staff = await ensureUser("staff@trilogika.test", "Staff Demo", "STAFF", password);
  await prisma.user.updateMany({ where: { email: { endsWith: "@trilogika.test" } }, data: { mustChangePassword: false } });

  if (await prisma.invoice.count()) {
    console.log("Data demo sudah ada (invoice terdeteksi) — dilewati. Password akun demo TIDAK diubah.");
    return;
  }
  // Setel ulang password demo agar sama dengan yang dicetak.
  await prisma.user.updateMany({ where: { email: { endsWith: "@trilogika.test" } }, data: { passwordHash: await hashPassword(password) } });

  const settings = await prisma.companySettings.findUniqueOrThrow({ where: { id: 1 } });
  if (!settings.invoiceNumberConfirmedAt) await confirmNumbering(admin, { nextNumber: 435, acknowledgeUnused: true });

  const c = async (name: string, city: string, extra: Record<string, unknown> = {}) =>
    (await createCustomer(finance, { name, city, ...extra })).id;
  const bima = await c("CV Bima Satria Jaya", "Sleman", { contactName: "Bima Satria", contactTitle: "Direktur", address: "Jl. Kaliurang Km 7, Sleman", phone: "0811-2233-4455", email: "bima@bimasatria.example" });
  const nusantara = await c("PT Nusantara Boga", "Yogyakarta", { contactName: "Sari Wulandari", contactTitle: "HR Manager", address: "Jl. Magelang No. 88, Yogyakarta", npwp: "01.234.567.8-543.000" });
  const tirta = await c("Hotel Tirta Asri", "Bantul", { contactName: "Pak Hendra", address: "Parangtritis, Bantul" });
  const smk = await c("SMK Negeri 3 Sleman", "Sleman", { contactName: "Bu Ratna", contactTitle: "Wakil Kepala Sekolah" });
  await c("PT Rasa Bersama", "Semarang", { contactName: "Andi" });

  await createTaxConfig(admin, { code: "PPN11", name: "PPN 11%", ratePercent: 11, method: "EXCLUSIVE", note: "Contoh untuk pengujian — sesuaikan dengan ketentuan perpajakan lembaga." });
  const ppn12 = await createTaxConfig(admin, { code: "PPN12-DPP", name: "PPN 12% (DPP Nilai Lain 11/12)", ratePercent: 12, dppNumerator: 11, dppDenominator: 12, method: "EXCLUSIVE", isActive: false, note: "Contoh DPP Nilai Lain. Nonaktif secara default." });
  void ppn12;

  const demi = await prisma.product.findUniqueOrThrow({ where: { code: "DEMI-CHEF" } });
  const barista = await createProduct(admin, { code: "BARISTA", name: "Biaya Diklat & Uji Kompetensi", category: "Diklat & Sertifikasi", fieldOfTraining: "Food & Beverage", schemeName: "Barista", unit: "Pax", defaultPrice: 1_750_000 });
  const tot = await createProduct(admin, { code: "TOT-BNSP", name: "Training of Trainers (TOT) Berstandar BNSP", category: "Pelatihan", fieldOfTraining: "Pengembangan SDM", unit: "Orang", defaultPrice: 3_500_000, descriptionTemplate: "{name}\nBidang {field}" });
  const prima = await createProduct(admin, { code: "PELAYANAN-PRIMA", name: "Pelatihan Pelayanan Prima", category: "Pelatihan", fieldOfTraining: "Pelayanan", unit: "Paket", defaultPrice: 12_500_000, descriptionTemplate: "{name}\nBidang {field}" });

  const today = todayIso("Asia/Jakarta");
  const ago = (d: number) => addCalendarDays(today, -d);
  const line = (p: { id: string; description?: string }, qty: number, price: number, unit: string, desc: string) =>
    ({ productId: p.id, description: desc, quantity: qty, unit, unitPrice: price, discount: 0, taxConfigId: null });
  const demiLine = (qty: number) => line(demi, qty, 2_000_000, "Pax", "Biaya Diklat & Uji Kompetensi\nBidang Food Production\n(Skema Demi Chef)");
  const baristaLine = (qty: number) => line(barista, qty, 1_750_000, "Pax", "Biaya Diklat & Uji Kompetensi\nBidang Food & Beverage\n(Skema Barista)");
  const base = { paymentMethod: "Transfer", paymentTermDays: 4, dueDateBasis: "CALENDAR_DAYS", reference: null, remark: null, internalNote: null, bankAccountId: null, extraDiscount: 0, transport: 0, admin: 0, downPayment: 0 };
  const mk = async (customerId: string, invoiceDate: string, lines: unknown[], extra: Record<string, unknown> = {}) =>
    issueInvoice(finance, (await createDraft(finance, { ...base, customerId, invoiceDate, lines, ...extra })).id);

  // Modul keuangan (basis kas): akun kas/bank + saldo awal (input manual Administrator) SEBELUM pembayaran dicatat.
  const coaByCode = async (code: string) => (await prisma.coaAccount.findUniqueOrThrow({ where: { code } })).id;
  const bankAcc = await createCashAccount(admin, { name: "Bank Mandiri IDR", kind: "BANK", coaAccountId: await coaByCode("1-1200"), openingBalance: 25_000_000, openingDate: ago(90), isDefault: true });
  const cashAcc = await createCashAccount(admin, { name: "Kas Kecil", kind: "KAS", coaAccountId: await coaByCode("1-1100"), openingBalance: 2_000_000, openingDate: ago(90), isDefault: true });

  // Invoice referensi dari dokumen contoh (7 Pax Demi Chef).
  const ref = await mk(bima, ago(40), [demiLine(7)]);
  await recordPayment(finance, { invoiceId: ref.id, paymentDate: ago(36), amount: 5_000_000, method: "Transfer", reference: "TRX-0001" });
  await recordPayment(finance, { invoiceId: ref.id, paymentDate: ago(30), amount: 9_000_000, method: "Transfer", reference: "TRX-0002" });

  const a = await mk(nusantara, ago(75), [baristaLine(10), { ...line(tot, 2, 3_500_000, "Orang", "Training of Trainers (TOT) Berstandar BNSP\nBidang Pengembangan SDM"), discount: 500_000 }], { transport: 250_000, admin: 100_000 });
  await recordPayment(finance, { invoiceId: a.id, paymentDate: ago(60), amount: a.amounts.total, method: "Transfer", reference: "TRX-0003" });
  await mk(tirta, ago(20), [line(prima, 1, 12_500_000, "Paket", "Pelatihan Pelayanan Prima\nBidang Pelayanan")], { downPayment: 5_000_000, paymentTermDays: 14 });
  await mk(smk, ago(33), [demiLine(12)]); // belum dibayar & sudah lewat jatuh tempo
  const partial = await mk(nusantara, ago(12), [baristaLine(6)], { paymentTermDays: 30, transport: 150_000 });
  await recordPayment(finance, { invoiceId: partial.id, paymentDate: ago(8), amount: 4_000_000, method: "Transfer", reference: "TRX-0004" });
  const wrong = await mk(bima, ago(5), [demiLine(2)]);
  await cancelInvoice(finance, wrong.id, { reason: "Salah pelanggan — diterbitkan ulang" });
  await mk(bima, ago(2), [demiLine(3)], { paymentTermDays: 7 });
  // Pengeluaran demo: Finance langsung berlaku; Staff menunggu persetujuan.
  const cat = async (code: string) => coaByCode(code);
  // Pengeluaran > Rp1 juta wajib berbukti: lampirkan bukti contoh (PDF minimal).
  const demoProof = async () => (await storeFile(finance, "EXPENSE_PROOF", { name: "bukti-contoh.pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46]) })).id;
  await createEntry(finance, { entryDate: ago(50), cashAccountId: bankAcc.id, counterAccountId: await cat("5-1100"), amount: 3_000_000, description: "Honor asesor uji kompetensi Demi Chef", payee: "Asesor BNSP", reference: "KW-001", proofFileId: await demoProof() });
  await createEntry(finance, { entryDate: ago(45), cashAccountId: bankAcc.id, counterAccountId: await cat("6-1200"), amount: 2_500_000, description: "Sewa kantor bulanan", payee: "Pemilik gedung", reference: "KW-002", proofFileId: await demoProof() });
  await createEntry(finance, { entryDate: ago(25), cashAccountId: bankAcc.id, counterAccountId: await cat("6-1300"), amount: 850_000, description: "Internet & listrik", reference: "KW-003" });
  await createTransfer(finance, { transferDate: ago(20), fromAccountId: bankAcc.id, toAccountId: cashAcc.id, amount: 1_000_000, description: "Isi kas kecil" });
  await createEntry(finance, { entryDate: ago(18), cashAccountId: cashAcc.id, counterAccountId: await cat("6-1600"), amount: 275_000, description: "ATK & fotokopi" });
  await createEntry(staff, { entryDate: ago(3), cashAccountId: cashAcc.id, counterAccountId: await cat("5-1400"), amount: 420_000, description: "Konsumsi peserta pelatihan Barista", payee: "Katering Bu Sri", reference: "NOTA-17" });
  await createDraft(staff, { ...base, customerId: tirta, invoiceDate: today, lines: [baristaLine(4)] });
  await createDraft(finance, { ...base, customerId: smk, invoiceDate: today, lines: [demiLine(8)], remark: "Gelombang 2" });

  console.log("\n══════════ Seed development selesai ══════════");
  console.log("Akun demo (password sama untuk ketiganya):");
  console.log("  admin@trilogika.test | finance@trilogika.test | staff@trilogika.test");
  console.log(`  Password: ${password}`);
  console.log("Catat password ini — tidak akan ditampilkan lagi.\n");
}

main()
  .catch((e) => { console.error(`\nSeed development GAGAL: ${e instanceof Error ? e.message : e}`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
