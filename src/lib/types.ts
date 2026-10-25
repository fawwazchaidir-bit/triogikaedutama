/** DTO yang melintasi batas server → browser. Semua nominal adalah `number` Rupiah bulat; tanggal DATE = "YYYY-MM-DD". */

import type { DueDateBasis } from "./finance/due-date";
import type { RupiahStyle } from "./finance/money";
import type { NumberReset } from "./finance/invoice-number";
import type { TaxMethod } from "./finance/calculate";

export type TerbilangSource = "TOTAL" | "BALANCE";

export interface CompanySettingsDto {
  name: string;
  tagline: string | null;
  address: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  npwp: string | null;
  logoFileId: string | null;
  stampFileId: string | null;
  signatureFileId: string | null;
  signerName: string;
  signerTitle: string;
  closingText: string;
  defaultPaymentMethod: string;
  defaultPaymentTermDays: number;
  defaultDueDateBasis: DueDateBasis;
  paymentNote: string | null;
  footerNote: string | null;
  invoiceNumberFormat: string;
  invoiceNumberPrefix: string;
  invoiceNumberReset: NumberReset;
  invoiceNumberStart: number;
  invoiceNumberConfirmedAt: string | null;
  showLogo: boolean;
  showStamp: boolean;
  showSignature: boolean;
  rupiahStyle: RupiahStyle;
  terbilangSource: TerbilangSource;
}

export interface BankAccountDto {
  id: string;
  label: string;
  accountNumber: string;
  accountName: string;
  isDefault: boolean;
  isActive: boolean;
}

export interface TaxConfigDto {
  id: string;
  code: string;
  name: string;
  rateBps: number;
  dppNumerator: number;
  dppDenominator: number;
  method: TaxMethod;
  note: string | null;
  isActive: boolean;
}

export interface CustomerDto {
  id: string;
  name: string;
  contactName: string | null;
  contactTitle: string | null;
  address: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  npwp: string | null;
  internalNote: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface CustomerSummaryDto extends CustomerDto {
  invoiceCount: number;
  /** Σ total invoice berstatus ISSUED */
  invoicedAmount: number;
  /** Σ pembayaran bersih diterima pada invoice ISSUED */
  paidAmount: number;
  /** Σ sisa tagihan invoice ISSUED */
  outstandingAmount: number;
}

export interface ProductDto {
  id: string;
  code: string;
  name: string;
  category: string | null;
  fieldOfTraining: string | null;
  schemeName: string | null;
  descriptionTemplate: string;
  /** Hasil render template (pratinjau & nilai awal baris invoice). */
  description: string;
  unit: string;
  defaultPrice: number;
  taxConfigId: string | null;
  isActive: boolean;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

// ───────────────────────────── Invoice ─────────────────────────────

export type InvoiceStatusValue = "DRAFT" | "SUBMITTED" | "ISSUED" | "CANCELLED";
export type PaymentStatusValue2 = "UNPAID" | "PARTIALLY_PAID" | "PAID";

export interface InvoiceLineDto {
  id: string;
  lineNo: number;
  productId: string | null;
  productCode: string | null;
  /** Teks program tetap (dasar Remark); null untuk baris bebas */
  programText: string | null;
  description: string;
  /** String desimal, mis. "7" atau "1.5" */
  quantity: string;
  unit: string;
  unitPrice: number;
  discountAmount: number;
  grossAmount: number;
  netAmount: number;
  taxConfigId: string | null;
  taxCode: string | null;
  taxName: string | null;
  taxRateBps: number | null;
}

export interface InvoiceAmountsDto {
  gross: number;
  discount: number;
  extraDiscount: number;
  subtotal: number;
  taxBase: number;
  tax: number;
  includedTax: number;
  transport: number;
  admin: number;
  surcharge: number;
  total: number;
  downPayment: number;
  paid: number;
  balance: number;
}

export interface InvoiceTaxGroupDto {
  code: string;
  name: string;
  rateBps: number;
  method: "EXCLUSIVE" | "INCLUSIVE";
  baseAmount: number;
  dppAmount: number;
  taxAmount: number;
  addedToTotal: boolean;
}

export interface InvoiceListItemDto {
  id: string;
  number: string | null;
  status: InvoiceStatusValue;
  paymentStatus: PaymentStatusValue2;
  isOverdue: boolean;
  invoiceDate: string;
  dueDate: string;
  customerId: string;
  customerName: string;
  totalAmount: number;
  paidAmount: number;
  /** 0 untuk invoice batal/draft */
  balanceAmount: number;
  createdById: string;
  createdByName: string;
}

export interface InvoiceDto {
  id: string;
  number: string | null;
  status: InvoiceStatusValue;
  paymentStatus: PaymentStatusValue2;
  isOverdue: boolean;
  invoiceDate: string;
  paymentMethod: string;
  paymentTermDays: number;
  dueDateBasis: "CALENDAR_DAYS" | "BUSINESS_DAYS";
  dueDate: string;
  reference: string | null;
  remark: string | null;
  internalNote: string | null;
  customerId: string;
  customerName: string;
  customer: { address: string | null; city: string | null; npwp: string | null; contactName: string | null; contactTitle: string | null; phone: string | null; email: string | null };
  /** true bila data pelanggan berasal dari snapshot beku (invoice terbit) */
  customerFrozen: boolean;
  bankAccountId: string | null;
  bank: { label: string; accountNumber: string; accountName: string } | null;
  lines: InvoiceLineDto[];
  amounts: InvoiceAmountsDto;
  taxGroups: InvoiceTaxGroupDto[];
  issuedAt: string | null;
  issuedByName: string | null;
  cancelledAt: string | null;
  cancelledByName: string | null;
  cancelReason: string | null;
  submittedAt: string | null;
  submittedByName: string | null;
  /** Alasan pengembalian oleh penyetuju (terisi bila draft dikembalikan) */
  rejectionReason: string | null;
  rejectedAt: string | null;
  rejectedByName: string | null;
  replacesInvoice: { id: string; number: string | null } | null;
  replacedBy: { id: string; number: string | null; status: InvoiceStatusValue }[];
  duplicatedFrom: { id: string; number: string | null } | null;
  createdAt: string;
  createdById: string;
  createdByName: string;
  updatedAt: string;
  version: number;
}

// ───────────────────────────── Pembayaran ─────────────────────────────

export interface PaymentDto {
  id: string;
  invoiceId: string;
  invoiceNumber: string | null;
  customerName: string;
  entryType: "PAYMENT" | "REVERSAL";
  paymentDate: string;
  /** Positif = pembayaran; negatif = pembalikan */
  amount: number;
  method: string;
  reference: string | null;
  note: string | null;
  reason: string | null;
  isDownPayment: boolean;
  proofFileId: string | null;
  recordedByName: string;
  createdAt: string;
  /** Akun kas/bank penerima (null = belum dialokasikan) */
  cashAccountId: string | null;
  cashAccountName: string | null;
  /** Pembayaran ini sudah dibalik oleh baris REVERSAL tertentu */
  reversedByPaymentId: string | null;
  reversesPaymentId: string | null;
}
