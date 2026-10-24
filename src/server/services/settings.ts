import "server-only";
import { z } from "zod";
import type { CompanySettings } from "@prisma/client";
import { prisma, transaction } from "../db";
import { Errors } from "../errors";
import { parseInput } from "../validate";
import { assertCan, type Actor } from "../actor";
import { diffFields, writeAudit } from "../audit";
import {
  optionalEmail, optionalNpwp, optionalPhone, optionalText, requiredText, uuid,
} from "@/lib/validation/common";
import type { BankAccountDto, CompanySettingsDto } from "@/lib/types";

export const toSettingsDto = (s: CompanySettings): CompanySettingsDto => ({
  name: s.name, tagline: s.tagline, address: s.address, phone: s.phone, email: s.email, website: s.website, npwp: s.npwp,
  logoFileId: s.logoFileId, stampFileId: s.stampFileId, signatureFileId: s.signatureFileId,
  signerName: s.signerName, signerTitle: s.signerTitle, closingText: s.closingText,
  defaultPaymentMethod: s.defaultPaymentMethod, defaultPaymentTermDays: s.defaultPaymentTermDays,
  defaultDueDateBasis: s.defaultDueDateBasis, paymentNote: s.paymentNote, footerNote: s.footerNote,
  invoiceNumberFormat: s.invoiceNumberFormat, invoiceNumberPrefix: s.invoiceNumberPrefix,
  invoiceNumberReset: s.invoiceNumberReset, invoiceNumberStart: s.invoiceNumberStart,
  invoiceNumberConfirmedAt: s.invoiceNumberConfirmedAt?.toISOString() ?? null,
  showLogo: s.showLogo, showStamp: s.showStamp, showSignature: s.showSignature,
  rupiahStyle: s.rupiahStyle, terbilangSource: s.terbilangSource,
});

/** Baris pengaturan (singleton). Gagal jelas bila seed belum dijalankan. */
export async function loadSettingsRow(tx: Pick<typeof prisma, "companySettings"> = prisma): Promise<CompanySettings> {
  const s = await tx.companySettings.findUnique({ where: { id: 1 } });
  if (!s) throw new Error("Pengaturan perusahaan belum diinisialisasi. Jalankan `npm run db:seed`.");
  return s;
}

/** Identitas visual untuk shell aplikasi (boleh dilihat semua pengguna login). */
export async function getBrand() {
  const s = await prisma.companySettings.findUnique({ where: { id: 1 }, select: { name: true, logoFileId: true } });
  return {
    name: s?.name ?? "Trilogika Edutama",
    logoUrl: s?.logoFileId ? `/api/files/${s.logoFileId}` : "/brand/logo.png",
  };
}

export async function getSettings(actor: Actor): Promise<CompanySettingsDto> {
  assertCan(actor, "settings:view");
  return toSettingsDto(await loadSettingsRow());
}

/** Pengaturan ringan yang dibutuhkan form invoice (default pembayaran) — tersedia untuk pembuat invoice. */
export async function getInvoiceDefaults(actor: Actor) {
  if (!actor) throw Errors.unauthenticated();
  const s = await loadSettingsRow();
  const banks = await prisma.bankAccount.findMany({ where: { isActive: true }, orderBy: [{ isDefault: "desc" }, { label: "asc" }] });
  return {
    defaultPaymentMethod: s.defaultPaymentMethod,
    defaultPaymentTermDays: s.defaultPaymentTermDays,
    defaultDueDateBasis: s.defaultDueDateBasis,
    numberingConfirmed: !!s.invoiceNumberConfirmedAt,
    banks: banks.map(toBankDto),
  };
}

const fileRef = z.preprocess((v) => (v === "" ? null : v ?? undefined), uuid.nullable().optional());

export const companyUpdateSchema = z.object({
  name: requiredText(2, 120, "Nama lembaga"),
  tagline: optionalText(120, "Tagline"),
  address: requiredText(5, 300, "Alamat"),
  phone: optionalPhone,
  email: optionalEmail,
  website: optionalText(200, "Website"),
  npwp: optionalNpwp,
  logoFileId: fileRef,
  stampFileId: fileRef,
  signatureFileId: fileRef,
  signerName: requiredText(2, 120, "Nama penandatangan"),
  signerTitle: requiredText(2, 60, "Jabatan penandatangan"),
  closingText: requiredText(1, 60, "Teks penutup"),
  defaultPaymentMethod: requiredText(2, 40, "Metode pembayaran default"),
  defaultPaymentTermDays: z.number().int().min(0, "Minimal 0 hari").max(365, "Maksimal 365 hari"),
  defaultDueDateBasis: z.enum(["CALENDAR_DAYS", "BUSINESS_DAYS"]),
  paymentNote: optionalText(500, "Catatan pembayaran"),
  footerNote: optionalText(500, "Footer"),
  showLogo: z.boolean(),
  showStamp: z.boolean(),
  showSignature: z.boolean(),
  rupiahStyle: z.enum(["REFERENCE", "PLAIN", "DECIMAL"]),
  terbilangSource: z.enum(["TOTAL", "BALANCE"]),
}).partial();

export async function updateCompanySettings(actor: Actor, raw: unknown): Promise<CompanySettingsDto> {
  assertCan(actor, "settings:manage");
  const input = parseInput(companyUpdateSchema, raw);

  return transaction(async (tx) => {
    const before = await loadSettingsRow(tx);
    // File referensi harus ada dan berjenis tepat (mencegah menunjuk bukti bayar sebagai logo).
    for (const [field, kind] of [["logoFileId", "LOGO"], ["stampFileId", "STAMP"], ["signatureFileId", "SIGNATURE"]] as const) {
      const id = input[field];
      if (id) {
        const f = await tx.storedFile.findUnique({ where: { id }, select: { kind: true } });
        if (!f || f.kind !== kind) throw Errors.validation(`File ${kind.toLowerCase()} tidak valid.`, { [field]: "File tidak valid" });
      }
    }
    const after = await tx.companySettings.update({ where: { id: 1 }, data: input });
    const d = diffFields(toSettingsDto(before) as unknown as Record<string, unknown>, toSettingsDto(after) as unknown as Record<string, unknown>);
    if (d.changed.length) {
      await writeAudit(tx, actor, {
        action: "settings.company_update", entityType: "CompanySettings", entityId: "1",
        summary: `Pengaturan diubah: ${d.changed.join(", ")}`, before: d.before, after: d.after,
      });
    }
    return toSettingsDto(after);
  });
}

// ───────────────────────────── Rekening bank ─────────────────────────────

export const toBankDto = (b: { id: string; label: string; accountNumber: string; accountName: string; isDefault: boolean; isActive: boolean }): BankAccountDto => ({
  id: b.id, label: b.label, accountNumber: b.accountNumber, accountName: b.accountName, isDefault: b.isDefault, isActive: b.isActive,
});

export const bankSchema = z.object({
  label: requiredText(2, 60, "Label bank"),
  accountNumber: z.string().trim().regex(/^[0-9A-Za-z\-\s.]{4,40}$/, "Nomor rekening tidak valid"),
  accountName: requiredText(2, 120, "Nama pemilik rekening"),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export async function listBankAccounts(actor: Actor): Promise<BankAccountDto[]> {
  assertCan(actor, "settings:view");
  const rows = await prisma.bankAccount.findMany({ orderBy: [{ isActive: "desc" }, { isDefault: "desc" }, { label: "asc" }] });
  return rows.map(toBankDto);
}

export async function createBankAccount(actor: Actor, raw: unknown): Promise<BankAccountDto> {
  assertCan(actor, "settings:manage");
  const input = parseInput(bankSchema, raw);
  return transaction(async (tx) => {
    const hasDefault = (await tx.bankAccount.count({ where: { isDefault: true, isActive: true } })) > 0;
    const makeDefault = input.isDefault === true || !hasDefault;
    if (makeDefault) await tx.bankAccount.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    const b = await tx.bankAccount.create({
      data: { label: input.label, accountNumber: input.accountNumber, accountName: input.accountName, isDefault: makeDefault, isActive: true },
    });
    await writeAudit(tx, actor, {
      action: "bank.create", entityType: "BankAccount", entityId: b.id, summary: `Rekening ${b.label} ${b.accountNumber} ditambahkan`, after: toBankDto(b),
    });
    return toBankDto(b);
  });
}

export async function updateBankAccount(actor: Actor, id: string, raw: unknown): Promise<BankAccountDto> {
  assertCan(actor, "settings:manage");
  const input = parseInput(bankSchema.partial(), raw);
  return transaction(async (tx) => {
    const before = await tx.bankAccount.findUnique({ where: { id } });
    if (!before) throw Errors.notFound("Rekening");
    if (input.isActive === false && before.isDefault && input.isDefault !== false) {
      const otherActive = await tx.bankAccount.count({ where: { isActive: true, id: { not: id } } });
      if (otherActive === 0) throw Errors.conflict("Tidak dapat menonaktifkan satu-satunya rekening aktif.");
    }
    if (input.isDefault === true) await tx.bankAccount.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } });
    const data = { ...input, ...(input.isActive === false ? { isDefault: false } : {}) };
    const after = await tx.bankAccount.update({ where: { id }, data });
    // Pastikan selalu ada satu default aktif.
    if (!(await tx.bankAccount.count({ where: { isDefault: true, isActive: true } }))) {
      const first = await tx.bankAccount.findFirst({ where: { isActive: true }, orderBy: { createdAt: "asc" } });
      if (first) await tx.bankAccount.update({ where: { id: first.id }, data: { isDefault: true } });
    }
    const d = diffFields(toBankDto(before) as unknown as Record<string, unknown>, toBankDto(after) as unknown as Record<string, unknown>);
    await writeAudit(tx, actor, {
      action: "bank.update", entityType: "BankAccount", entityId: id, summary: `Rekening ${after.label} diperbarui`, before: d.before, after: d.after,
    });
    return toBankDto((await tx.bankAccount.findUniqueOrThrow({ where: { id } })));
  });
}
