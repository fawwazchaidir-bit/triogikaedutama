import { prisma } from "@/server/db";
import type { Actor } from "@/server/actor";
import { hashPassword } from "@/server/auth/password";
import { seedCoa } from "@/server/services/finance-coa";
import { storeFile } from "@/server/services/files";

/** Seluruh tabel aplikasi (TRUNCATE tidak memicu trigger baris, sehingga aman untuk reset test). */
const TABLES = [
  "audit_logs", "payments", "cash_entries", "cash_transfers", "cash_accounts", "journal_lines", "journal_entries", "bank_matches", "bank_statement_lines", "bank_statements", "tax_year_inputs", "accounting_periods", "coa_accounts",
  "invoice_items", "invoices", "invoice_number_sequences", "products", "tax_configurations",
  "customers", "bank_accounts", "company_settings", "stored_files", "sessions", "rate_limit_buckets", "users",
];

export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
}

export interface Fixtures {
  admin: Actor; finance: Actor; staff: Actor; staff2: Actor;
  customerId: string; productId: string; bankId: string;
  ppnId: string;
  /** Terisi bila `seedFixtures({ finance: true })`: akun kas/bank + bagan akun usulan. */
  bankAcctId: string; cashAcctId: string;
  coa: Record<string, string>;
}

const PASSWORD = "Test-Password-123!";

async function makeUser(email: string, name: string, role: "ADMIN" | "FINANCE" | "STAFF"): Promise<Actor> {
  const u = await prisma.user.create({ data: { email, name, role, passwordHash: await hashPassword(PASSWORD) } });
  return { userId: u.id, email: u.email, name: u.name, role: u.role, ip: "127.0.0.1", userAgent: "vitest" };
}

export const TEST_PASSWORD = PASSWORD;

/** Data minimal yang meniru produksi: pengaturan, rekening, produk Demi Chef, pelanggan, pajak PPN 11%. */
export async function seedFixtures(opts: { confirmNumbering?: boolean; start?: number; finance?: boolean; openingDate?: string } = {}): Promise<Fixtures> {
  const admin = await makeUser("admin@test.local", "Admin Uji", "ADMIN");
  const finance = await makeUser("finance@test.local", "Finance Uji", "FINANCE");
  const staff = await makeUser("staff@test.local", "Staff Uji", "STAFF");
  const staff2 = await makeUser("staff2@test.local", "Staff Dua", "STAFF");

  await prisma.companySettings.create({
    data: {
      id: 1, name: "TRILOGIKA EDUTAMA", tagline: "Light & Insight", address: "Jambon 01/21, Trihanggo, Gamping, Sleman",
      phone: "0857-0124-6319", email: "info@trilogikaedutama.id", npwp: "65.472.603.3-542.000",
      signerName: "Elva Aditya Fawwaz, S.E.", signerTitle: "Finance Manager", closingText: "Sincerely,",
      defaultPaymentMethod: "Transfer", defaultPaymentTermDays: 4,
      invoiceNumberFormat: "{SEQ:5}", invoiceNumberReset: "NEVER", invoiceNumberStart: opts.start ?? 434,
      invoiceNumberConfirmedAt: opts.confirmNumbering === false ? null : new Date(),
      rupiahStyle: "REFERENCE", showLogo: false, showStamp: false, showSignature: false,
    },
  });
  if (opts.confirmNumbering !== false) {
    await prisma.invoiceNumberSequence.create({ data: { scopeKey: "ALL", nextValue: opts.start ?? 434 } });
  }
  const bank = await prisma.bankAccount.create({ data: { label: "MANDIRI-IDR", accountNumber: "137-00-2072139-1", accountName: "Trilogika Edutama", isDefault: true } });
  const product = await prisma.product.create({
    data: {
      code: "DEMI-CHEF", name: "Biaya Diklat & Uji Kompetensi", category: "Diklat", fieldOfTraining: "Food Production",
      schemeName: "Demi Chef", descriptionTemplate: "{name}\nBidang {field}\n(Skema {scheme})", unit: "Pax", defaultPrice: 2_000_000n,
    },
  });
  const customer = await prisma.customer.create({
    data: {
      name: "CV Bima Satria Jaya", normalizedName: "bima satria jaya", cityKey: "sleman", city: "Sleman",
      address: "Jl. Kaliurang Km 7, Sleman", createdById: admin.userId,
    },
  });
  const ppn = await prisma.taxConfiguration.create({ data: { code: "PPN11", name: "PPN 11%", rateBps: 1100, method: "EXCLUSIVE" } });
  let bankAcctId = "", cashAcctId = "";
  const coa: Record<string, string> = {};
  if (opts.finance) {
    await seedCoa(prisma);
    for (const a of await prisma.coaAccount.findMany()) coa[a.code] = a.id;
    const openingDate = new Date(`${opts.openingDate ?? "2026-01-01"}T00:00:00.000Z`);
    bankAcctId = (await prisma.cashAccount.create({ data: { name: "Bank Mandiri", kind: "BANK", coaAccountId: coa["1-1200"]!, openingBalance: 10_000_000n, openingDate, isDefault: true } })).id;
    cashAcctId = (await prisma.cashAccount.create({ data: { name: "Kas Kecil", kind: "KAS", coaAccountId: coa["1-1100"]!, openingBalance: 1_000_000n, openingDate, isDefault: true } })).id;
  }
  return { admin, finance, staff, staff2, customerId: customer.id, productId: product.id, bankId: bank.id, ppnId: ppn.id, bankAcctId, cashAcctId, coa };
}

/** Input invoice contoh dari brief: 7 Pax × Rp2.000.000. */
export function demiChefInput(fx: Fixtures, overrides: Record<string, unknown> = {}) {
  return {
    customerId: fx.customerId,
    invoiceDate: "2026-01-13",
    paymentMethod: "Transfer",
    paymentTermDays: 4,
    dueDateBasis: "CALENDAR_DAYS",
    reference: null,
    remark: null,
    internalNote: null,
    bankAccountId: null,
    lines: [{
      productId: fx.productId,
      description: "Biaya Diklat & Uji Kompetensi\nBidang Food Production\n(Skema Demi Chef)",
      quantity: 7, unit: "Pax", unitPrice: 2_000_000, discount: 0, taxConfigId: null,
    }],
    extraDiscount: 0, transport: 0, admin: 0, downPayment: 0,
    ...overrides,
  };
}

/** Unggah satu bukti pengeluaran (PDF minimal yang lolos pemeriksaan magic bytes) atas nama `actor`; dipakai untuk pengeluaran > Rp1 juta. */
export async function makeProof(actor: Actor, name = "bukti.pdf"): Promise<string> {
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46]);
  return (await storeFile(actor, "EXPENSE_PROOF", { name, bytes })).id;
}
