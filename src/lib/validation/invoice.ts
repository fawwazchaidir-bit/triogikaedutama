import { z } from "zod";
import { isValidIsoDate } from "@/lib/finance/due-date";
import { isoDate, optionalText, requiredText, rupiah, uuid } from "./common";

/** Skema input invoice — dipakai server (otoritatif) dan browser (validasi cepat). */
export const invoiceLineSchema = z.object({
  productId: z.preprocess((v) => (v === "" ? null : v ?? null), uuid.nullable()),
  description: requiredText(1, 600, "Deskripsi"),
  /** Desimal maksimal 3 digit; string/number. Validasi mendalam ada di calculateInvoice. */
  quantity: z.union([z.string().trim().min(1, "Kuantitas wajib diisi"), z.number()]),
  unit: requiredText(1, 20, "Satuan"),
  unitPrice: rupiah("Harga satuan"),
  discount: rupiah("Diskon baris").default(0),
  taxConfigId: z.preprocess((v) => (v === "" ? null : v ?? null), uuid.nullable()),
});

export const invoiceInputSchema = z.object({
  customerId: uuid,
  invoiceDate: isoDate.refine(isValidIsoDate, "Tanggal invoice tidak valid").refine((d) => d >= "2000-01-01" && d <= "2100-12-31", "Tahun di luar jangkauan"),
  paymentMethod: requiredText(2, 40, "Metode pembayaran"),
  paymentTermDays: z.number({ error: "Jangka waktu wajib diisi" }).int().min(0, "Minimal 0 hari").max(365, "Maksimal 365 hari"),
  dueDateBasis: z.enum(["CALENDAR_DAYS", "BUSINESS_DAYS"]),
  reference: optionalText(120, "Referensi"),
  remark: optionalText(500, "Remark"),
  internalNote: optionalText(1000, "Catatan internal"),
  bankAccountId: z.preprocess((v) => (v === "" ? null : v ?? null), uuid.nullable()),
  lines: z.array(invoiceLineSchema).min(1, "Tambahkan minimal satu baris produk/layanan").max(100, "Maksimal 100 baris"),
  extraDiscount: rupiah("Diskon tambahan").default(0),
  transport: rupiah("Transport").default(0),
  admin: rupiah("Administrasi").default(0),
  downPayment: rupiah("Down Payment").default(0),
  /** Untuk update draft: versi yang dilihat pengguna (optimistic locking). */
  expectedVersion: z.number().int().min(1).optional(),
});

export type InvoiceInput = z.infer<typeof invoiceInputSchema>;
export type InvoiceLineInput = z.infer<typeof invoiceLineSchema>;

export const issueSchema = z.object({
  /** Total yang dilihat & dikonfirmasi pengguna. Bila berbeda dari hitungan server → ditolak. */
  expectedTotalAmount: z.number().int().min(0).optional(),
});

export const cancelSchema = z.object({
  reason: z.string().trim().min(5, "Alasan pembatalan wajib diisi (minimal 5 karakter)").max(300),
  createReplacement: z.boolean().optional(),
});
