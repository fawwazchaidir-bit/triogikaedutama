import "dotenv/config";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

export const E2E_PASSWORD = "Sandi-Uji-Lokal-2026!";

/** Kosongkan DB test, migrasi, lalu isi dengan seed development (admin/finance/staff + data demo). */
export default async function globalSetup() {
  const url = process.env.TEST_DATABASE_URL!;
  if (/prod/i.test(url)) throw new Error("TEST_DATABASE_URL tampak seperti produksi — dibatalkan");
  const env = { ...process.env, DATABASE_URL: url, DEV_SEED_PASSWORD: E2E_PASSWORD, ADMIN_EMAIL: "", ADMIN_PASSWORD: "" };
  const run = (cmd: string) => execSync(cmd, { env, stdio: "pipe", encoding: "utf8" });
  run("npx prisma migrate deploy");
  // TRUNCATE tidak memicu trigger baris (audit_logs/payments tetap append-only di aplikasi).
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE audit_logs, payments, cash_entries, cash_transfers, cash_accounts, coa_accounts, invoice_items, invoices, invoice_number_sequences, products, tax_configurations,
       customers, bank_accounts, company_settings, stored_files, sessions, rate_limit_buckets, users RESTART IDENTITY CASCADE`,
    );
  } finally {
    await prisma.$disconnect();
  }
  const out = run("npm run -s db:seed:dev");
  if (!out.includes("Seed development selesai")) throw new Error(`Seed dev gagal:\n${out}`);
}
