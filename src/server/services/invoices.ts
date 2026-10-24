import "server-only";
import { Prisma } from "@prisma/client";
import type { Customer, TaxConfiguration } from "@prisma/client";
import { prisma, transaction, type Tx } from "../db";
import { env } from "../env";
import { Errors } from "../errors";
import { parseInput } from "../validate";
import { actorCan, assertCan, type Actor } from "../actor";
import { writeAudit } from "../audit";
import { dateToIso, isoToDate, toJson } from "../json";
import { lockInvoice } from "./invoice-lock";
import { applyLedger } from "./payments";
import { allocateInvoiceNumber } from "./numbering";
import { loadSettingsRow } from "./settings";
import { toTaxRule } from "./tax";
import { calculateInvoice, CalcError, type CalcResult, type TaxRule } from "@/lib/finance/calculate";
import { computeDueDate } from "@/lib/finance/due-date";
import { formatRupiah } from "@/lib/finance/money";
import { todayIso } from "@/lib/format";
import { cancelSchema, invoiceInputSchema, issueSchema, rejectSchema, type InvoiceInput } from "@/lib/validation/invoice";
import { resolveRemark } from "@/lib/finance/remark";
import { flattenDescription } from "@/lib/finance/description-template";
import { renderProductDescription } from "./products";
import type {
  InvoiceAmountsDto, InvoiceDto, InvoiceLineDto, InvoiceListItemDto, InvoiceTaxGroupDto, Paged,
} from "@/lib/types";

// ───────────────────────────── Snapshot yang dibekukan saat terbit ─────────────────────────────

export interface CompanySnapshot {
  schemaVersion: 1;
  name: string; tagline: string | null; address: string; phone: string | null; email: string | null;
  website: string | null; npwp: string | null;
  signerName: string; signerTitle: string; closingText: string;
  logoFileId: string | null; stampFileId: string | null; signatureFileId: string | null;
  paymentNote: string | null; footerNote: string | null;
}
export interface DisplaySnapshot { rupiahStyle: "REFERENCE" | "PLAIN" | "DECIMAL"; terbilangSource: "TOTAL" | "BALANCE" }
export interface CustomerSnapshot {
  address: string | null; city: string | null; npwp: string | null; contactName: string | null;
  contactTitle: string | null; phone: string | null; email: string | null;
}

const customerSnap = (c: Customer): CustomerSnapshot => ({
  address: c.address, city: c.city, npwp: c.npwp, contactName: c.contactName, contactTitle: c.contactTitle, phone: c.phone, email: c.email,
});

// ───────────────────────────── Akses & visibilitas ─────────────────────────────

function visibilityWhere(actor: Actor): Prisma.InvoiceWhereInput {
  if (actorCan(actor, "invoice:view")) return {};
  if (actorCan(actor, "invoice:view_own")) return { createdById: actor.userId };
  throw Errors.forbidden();
}

function canEditDraft(actor: Actor, inv: { createdById: string }): boolean {
  if (!actorCan(actor, "invoice:create")) return false;
  return actor.role !== "STAFF" || inv.createdById === actor.userId;
}

const isOverdue = (status: string, balance: bigint | number, dueDate: string, today: string) =>
  status === "ISSUED" && Number(balance) > 0 && dueDate < today;

// ───────────────────────────── Resolusi input → data tersimpan ─────────────────────────────

type ExistingLine = { productId: string | null; unitPrice: bigint; taxConfigId: string | null };

interface Resolved {
  customer: Customer;
  calc: CalcResult;
  bankAccountId: string | null;
  dueDate: string;
  lineRows: Prisma.InvoiceItemCreateWithoutInvoiceInput[];
  header: Omit<Prisma.InvoiceUncheckedCreateInput, "createdById" | "items">;
}

/**
 * Satu-satunya jalur yang mengubah input pengguna menjadi data invoice tersimpan.
 * Di sini server: memuat master data, menegakkan hak (harga/diskon/pajak), MENGHITUNG ULANG semua nominal,
 * dan menghitung jatuh tempo. Angka apa pun yang dikirim browser selain input mentah diabaikan.
 */
async function resolveInput(tx: Tx, actor: Actor, input: InvoiceInput, existing: ExistingLine[] = []): Promise<Resolved> {
  const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
  if (!customer) throw Errors.validation("Pelanggan tidak ditemukan.", { customerId: "Pilih pelanggan" });
  if (!customer.isActive) throw Errors.validation("Pelanggan sudah diarsipkan.", { customerId: "Pelanggan diarsipkan" });

  const productIds = [...new Set(input.lines.map((l) => l.productId).filter((v): v is string => !!v))];
  const products = new Map((await tx.product.findMany({ where: { id: { in: productIds } } })).map((p) => [p.id, p]));
  const taxIds = [...new Set(input.lines.map((l) => l.taxConfigId).filter((v): v is string => !!v))];
  const taxes = new Map<string, TaxConfiguration>((await tx.taxConfiguration.findMany({ where: { id: { in: taxIds } } })).map((t) => [t.id, t]));

  const canOverride = actorCan(actor, "invoice:override_price");
  const canDiscount = actorCan(actor, "invoice:discount");
  if (!canDiscount && input.extraDiscount > 0) {
    throw Errors.forbidden("Anda tidak berwenang memberi diskon.");
  }

  const rules: (TaxRule | null)[] = [];
  input.lines.forEach((l, i) => {
    const label = `Baris ${i + 1}`;
    const product = l.productId ? products.get(l.productId) : undefined;
    if (l.productId && !product) throw Errors.validation(`${label}: produk tidak ditemukan.`, { [`lines.${i}.productId`]: "Produk tidak ditemukan" });
    const prev = existing.find((e) => e.productId === l.productId && e.productId !== null);
    if (product && !product.isActive && !prev) {
      throw Errors.validation(`${label}: produk "${product.name}" sudah diarsipkan.`, { [`lines.${i}.productId`]: "Produk diarsipkan" });
    }
    if (!canDiscount && l.discount > 0) throw Errors.forbidden("Anda tidak berwenang memberi diskon.");
    if (!canOverride) {
      // Tanpa hak override: harga & pajak harus sama dengan master (atau tidak berubah dari draft sebelumnya).
      if (!product) throw Errors.forbidden(`${label}: baris tanpa produk hanya dapat dibuat oleh pengguna yang berhak mengubah harga.`);
      const priceOk = BigInt(l.unitPrice) === product.defaultPrice || (prev && BigInt(l.unitPrice) === prev.unitPrice);
      if (!priceOk) throw Errors.forbidden(`${label}: Anda tidak berwenang mengubah harga dari master.`);
      const taxOk = (l.taxConfigId ?? null) === (product.taxConfigId ?? null) || (prev && (l.taxConfigId ?? null) === prev.taxConfigId);
      if (!taxOk) throw Errors.forbidden(`${label}: Anda tidak berwenang mengubah pengaturan pajak.`);
    }
    if (l.taxConfigId) {
      const t = taxes.get(l.taxConfigId);
      if (!t || !t.isActive) throw Errors.validation(`${label}: konfigurasi pajak tidak ditemukan atau tidak aktif.`, { [`lines.${i}.taxConfigId`]: "Pajak tidak aktif" });
      rules.push(toTaxRule(t));
    } else {
      rules.push(null);
    }
  });

  let calc: CalcResult;
  try {
    calc = calculateInvoice({
      lines: input.lines.map((l, i) => ({ quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, tax: rules[i] })),
      extraDiscount: input.extraDiscount, transport: input.transport, admin: input.admin, downPayment: input.downPayment,
    });
  } catch (e) {
    if (e instanceof CalcError) {
      const field = e.lineIndex !== undefined ? { [`lines.${e.lineIndex}`]: e.message } : undefined;
      throw Errors.validation(e.lineIndex !== undefined ? `Baris ${e.lineIndex + 1}: ${e.message}` : e.message, field);
    }
    throw e;
  }

  // Rekening: pilihan pengguna, atau default aktif.
  let bankAccountId: string | null = null;
  if (input.bankAccountId) {
    const b = await tx.bankAccount.findUnique({ where: { id: input.bankAccountId } });
    if (!b || !b.isActive) throw Errors.validation("Rekening bank tidak aktif.", { bankAccountId: "Pilih rekening aktif" });
    bankAccountId = b.id;
  } else {
    bankAccountId = (await tx.bankAccount.findFirst({ where: { isActive: true, isDefault: true } }))?.id ?? null;
  }

  const dueDate = computeDueDate(input.invoiceDate, input.paymentTermDays, input.dueDateBasis);

  const lineRows = input.lines.map((l, i): Prisma.InvoiceItemCreateWithoutInvoiceInput => {
    const cl = calc.lines[i]!;
    const product = l.productId ? products.get(l.productId) : undefined;
    const rule = rules[i];
    return {
      lineNo: i + 1,
      ...(product ? { product: { connect: { id: product.id } } } : {}),
      productCode: product?.code ?? null,
      // Teks program TETAP dari master produk (dasar Remark) — tidak dari isian pengguna.
      programText: product ? flattenDescription(renderProductDescription(product)) : null,
      description: l.description,
      quantity: new Prisma.Decimal(cl.quantityMilli).div(1000),
      unit: l.unit,
      unitPrice: BigInt(l.unitPrice),
      grossAmount: BigInt(cl.grossAmount),
      discountAmount: BigInt(cl.discountAmount),
      netAmount: BigInt(cl.netAmount),
      ...(rule ? { taxConfig: { connect: { id: rule.key } } } : {}),
      taxSnapshot: rule ? toJson({ code: rule.code, name: rule.name, rateBps: rule.rateBps, dppNumerator: rule.dppNumerator, dppDenominator: rule.dppDenominator, method: rule.method }) : Prisma.DbNull,
    };
  });

  const header = {
    invoiceDate: isoToDate(input.invoiceDate), paymentMethod: input.paymentMethod, paymentTermDays: input.paymentTermDays,
    dueDateBasis: input.dueDateBasis, dueDate: isoToDate(dueDate), reference: input.reference, remark: input.remark,
    internalNote: input.internalNote, customerId: customer.id, customerNameSnapshot: customer.name, bankAccountId,
    ...amountColumns(calc),
  };
  return { customer, calc, bankAccountId, dueDate, lineRows, header };
}

function amountColumns(c: CalcResult) {
  return {
    grossAmount: BigInt(c.grossAmount), discountAmount: BigInt(c.discountAmount), extraDiscountAmount: BigInt(c.extraDiscountAmount),
    subtotalAmount: BigInt(c.subtotalAmount), taxBaseAmount: BigInt(c.taxBaseAmount), taxAmount: BigInt(c.taxAmount),
    transportAmount: BigInt(c.transportAmount), adminAmount: BigInt(c.adminAmount), surchargeAmount: BigInt(c.surchargeAmount),
    totalAmount: BigInt(c.totalAmount), downPaymentAmount: BigInt(c.downPaymentAmount),
    paidAmount: 0n, balanceAmount: BigInt(c.totalAmount),
  };
}

// ───────────────────────────── DTO ─────────────────────────────

const detailInclude = {
  items: { orderBy: { lineNo: "asc" } },
  customer: true,
  bankAccount: true,
  createdBy: { select: { name: true } },
  issuedBy: { select: { name: true } },
  cancelledBy: { select: { name: true } },
  submittedBy: { select: { name: true } },
  rejectedBy: { select: { name: true } },
  replaces: { select: { id: true, number: true } },
  replacedBy: { select: { id: true, number: true, status: true } },
  duplicatedFrom: { select: { id: true, number: true } },
} satisfies Prisma.InvoiceInclude;

type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof detailInclude }>;

function toLineDto(it: InvoiceRow["items"][number]): InvoiceLineDto {
  const snap = (it.taxSnapshot ?? null) as { code?: string; name?: string; rateBps?: number } | null;
  return {
    id: it.id, lineNo: it.lineNo, productId: it.productId, productCode: it.productCode, programText: it.programText, description: it.description,
    quantity: it.quantity.toString(), unit: it.unit, unitPrice: Number(it.unitPrice), discountAmount: Number(it.discountAmount),
    grossAmount: Number(it.grossAmount), netAmount: Number(it.netAmount), taxConfigId: it.taxConfigId,
    taxCode: snap?.code ?? null, taxName: snap?.name ?? null, taxRateBps: snap?.rateBps ?? null,
  };
}

export function toInvoiceDto(r: InvoiceRow, today: string): InvoiceDto {
  const preIssue = r.status === "DRAFT" || r.status === "SUBMITTED";
  const frozen = !preIssue && r.customerSnapshot;
  const cs = (frozen ? r.customerSnapshot : customerSnap(r.customer)) as unknown as CustomerSnapshot;
  const taxGroups = ((r.taxSnapshot as { groups?: InvoiceTaxGroupDto[] } | null)?.groups ?? []) as InvoiceTaxGroupDto[];
  const total = Number(r.totalAmount);
  const paid = Number(r.paidAmount);
  const balance = r.status === "CANCELLED" ? 0 : preIssue ? total - Number(r.downPaymentAmount) : Number(r.balanceAmount);
  const amounts: InvoiceAmountsDto = {
    gross: Number(r.grossAmount), discount: Number(r.discountAmount), extraDiscount: Number(r.extraDiscountAmount),
    subtotal: Number(r.subtotalAmount), taxBase: Number(r.taxBaseAmount), tax: Number(r.taxAmount),
    includedTax: taxGroups.filter((g) => !g.addedToTotal).reduce((a, g) => a + g.taxAmount, 0),
    transport: Number(r.transportAmount), admin: Number(r.adminAmount), surcharge: Number(r.surchargeAmount),
    total, downPayment: Number(r.downPaymentAmount), paid, balance,
  };
  const dueDate = dateToIso(r.dueDate);
  return {
    id: r.id, number: r.number, status: r.status, paymentStatus: r.paymentStatus,
    isOverdue: isOverdue(r.status, r.balanceAmount, dueDate, today),
    invoiceDate: dateToIso(r.invoiceDate), paymentMethod: r.paymentMethod, paymentTermDays: r.paymentTermDays,
    dueDateBasis: r.dueDateBasis, dueDate, reference: r.reference, remark: r.remark, internalNote: r.internalNote,
    customerId: r.customerId, customerName: r.customerNameSnapshot, customer: cs, customerFrozen: !!frozen,
    bankAccountId: r.bankAccountId,
    bank: r.bankLabel ? { label: r.bankLabel, accountNumber: r.bankAccountNumber ?? "", accountName: r.bankAccountName ?? "" }
      : preIssue && r.bankAccount ? { label: r.bankAccount.label, accountNumber: r.bankAccount.accountNumber, accountName: r.bankAccount.accountName } : null,
    lines: r.items.map(toLineDto), amounts, taxGroups,
    issuedAt: r.issuedAt?.toISOString() ?? null, issuedByName: r.issuedBy?.name ?? null,
    cancelledAt: r.cancelledAt?.toISOString() ?? null, cancelledByName: r.cancelledBy?.name ?? null, cancelReason: r.cancelReason,
    submittedAt: r.submittedAt?.toISOString() ?? null, submittedByName: r.submittedBy?.name ?? null,
    rejectionReason: r.rejectionReason, rejectedAt: r.rejectedAt?.toISOString() ?? null, rejectedByName: r.rejectedBy?.name ?? null,
    replacesInvoice: r.replaces, replacedBy: r.replacedBy, duplicatedFrom: r.duplicatedFrom,
    createdAt: r.createdAt.toISOString(), createdById: r.createdById, createdByName: r.createdBy.name,
    updatedAt: r.updatedAt.toISOString(), version: r.version,
  };
}

async function loadRow(db: Pick<typeof prisma, "invoice">, id: string): Promise<InvoiceRow> {
  const row = await db.invoice.findUnique({ where: { id }, include: detailInclude });
  if (!row) throw Errors.notFound("Invoice");
  return row;
}

export async function getInvoice(actor: Actor, id: string): Promise<InvoiceDto> {
  const where = visibilityWhere(actor);
  const row = await prisma.invoice.findFirst({ where: { id, ...where }, include: detailInclude });
  if (!row) throw Errors.notFound("Invoice"); // 404, bukan 403: tidak membocorkan keberadaan invoice milik orang lain
  return toInvoiceDto(row, todayIso(env().APP_TIMEZONE));
}

// ───────────────────────────── Draft ─────────────────────────────

export async function createDraft(actor: Actor, raw: unknown): Promise<InvoiceDto> {
  assertCan(actor, "invoice:create");
  const input = parseInput(invoiceInputSchema, raw);
  const id = await transaction(async (tx) => {
    const r = await resolveInput(tx, actor, input);
    const inv = await tx.invoice.create({
      data: { ...r.header, createdById: actor.userId, status: "DRAFT", paymentStatus: "UNPAID", items: { create: r.lineRows } },
    });
    await writeAudit(tx, actor, {
      action: "invoice.create_draft", entityType: "Invoice", entityId: inv.id,
      summary: `Draft invoice dibuat untuk ${r.customer.name} (${formatRupiah(r.calc.totalAmount, "PLAIN")})`,
      after: auditView(r.header, input),
    });
    return inv.id;
  });
  return toInvoiceDto(await loadRow(prisma, id), todayIso(env().APP_TIMEZONE));
}

const auditView = (header: Record<string, unknown>, input: InvoiceInput) => ({
  customerId: input.customerId, invoiceDate: input.invoiceDate, paymentMethod: input.paymentMethod,
  paymentTermDays: input.paymentTermDays, dueDateBasis: input.dueDateBasis, reference: input.reference,
  totalAmount: Number(header.totalAmount), extraDiscount: input.extraDiscount, transport: input.transport,
  admin: input.admin, downPayment: input.downPayment,
  lines: input.lines.map((l) => ({ productId: l.productId, description: l.description, quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice, discount: l.discount, taxConfigId: l.taxConfigId })),
});

export async function updateDraft(actor: Actor, id: string, raw: unknown): Promise<InvoiceDto> {
  assertCan(actor, "invoice:create");
  const input = parseInput(invoiceInputSchema, raw);
  await transaction(async (tx) => {
    await lockInvoice(tx, id);
    const cur = await tx.invoice.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { lineNo: "asc" } } } });
    if (!canEditDraft(actor, cur)) throw Errors.notFound("Invoice");
    if (cur.status === "SUBMITTED") {
      throw Errors.conflict("Invoice sedang menunggu verifikasi dan terkunci. Tarik kembali pengajuan terlebih dahulu bila perlu mengubahnya.");
    }
    if (cur.status !== "DRAFT") {
      throw Errors.conflict(`Invoice ${cur.number ?? ""} sudah ${cur.status === "ISSUED" ? "diterbitkan" : "dibatalkan"} dan tidak dapat diedit. Batalkan lalu terbitkan ulang bila perlu.`);
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== cur.version) {
      throw Errors.conflict("Draft ini baru saja diubah oleh pengguna/tab lain. Muat ulang halaman untuk melihat versi terbaru.");
    }
    const r = await resolveInput(tx, actor, input, cur.items);
    await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
    await tx.invoice.update({
      where: { id },
      data: { ...r.header, version: { increment: 1 }, items: { create: r.lineRows } },
    });
    await writeAudit(tx, actor, {
      action: "invoice.update_draft", entityType: "Invoice", entityId: id,
      summary: `Draft diubah (total ${formatRupiah(Number(cur.totalAmount), "PLAIN")} → ${formatRupiah(r.calc.totalAmount, "PLAIN")})`,
      before: {
        customerId: cur.customerId, invoiceDate: dateToIso(cur.invoiceDate), totalAmount: Number(cur.totalAmount),
        lines: cur.items.map((i) => ({ description: i.description, quantity: i.quantity.toString(), unitPrice: Number(i.unitPrice), discount: Number(i.discountAmount) })),
      },
      after: auditView(r.header, input),
    });
  });
  return toInvoiceDto(await loadRow(prisma, id), todayIso(env().APP_TIMEZONE));
}

export async function deleteDraft(actor: Actor, id: string): Promise<void> {
  assertCan(actor, "invoice:create");
  await transaction(async (tx) => {
    await lockInvoice(tx, id);
    const cur = await tx.invoice.findUniqueOrThrow({ where: { id }, include: { items: true } });
    if (!canEditDraft(actor, cur)) throw Errors.notFound("Invoice");
    if (cur.status === "SUBMITTED") throw Errors.conflict("Invoice sedang menunggu verifikasi. Tarik kembali pengajuan sebelum menghapus.");
    if (cur.status !== "DRAFT") throw Errors.conflict("Hanya draft yang dapat dihapus. Invoice terbit harus dibatalkan.");
    await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
    await tx.invoice.delete({ where: { id } });
    await writeAudit(tx, actor, {
      action: "invoice.delete_draft", entityType: "Invoice", entityId: id,
      summary: `Draft untuk ${cur.customerNameSnapshot} (${formatRupiah(Number(cur.totalAmount), "PLAIN")}) dihapus`,
      before: { customerName: cur.customerNameSnapshot, totalAmount: Number(cur.totalAmount), lines: cur.items.map((i) => ({ description: i.description, quantity: i.quantity.toString(), unitPrice: Number(i.unitPrice) })) },
    });
  });
}

// ───────────────────────────── Pengajuan, verifikasi, penerbitan ─────────────────────────────

type StoredInvoice = Prisma.InvoiceGetPayload<{ include: { items: true; customer: true; bankAccount: true } }>;

const ruleSnapshot = (r: TaxRule) => ({ code: r.code, name: r.name, rateBps: r.rateBps, dppNumerator: r.dppNumerator, dppDenominator: r.dppDenominator, method: r.method });

/** Bandingkan snapshot pajak tersimpan (JSONB — urutan key tidak dijamin) dengan aturan pajak saat ini, per field. */
function sameTaxSnapshot(stored: unknown, rule: TaxRule | null): boolean {
  if (!rule) return stored === null || stored === undefined;
  if (typeof stored !== "object" || stored === null) return false;
  const a = stored as Record<string, unknown>;
  const b = ruleSnapshot(rule);
  return (Object.keys(b) as (keyof typeof b)[]).every((k) => a[k] === b[k]);
}

/**
 * Hitung ulang seluruh nominal dari DATA TERSIMPAN (bukan dari input klien) dengan konfigurasi pajak AKTIF saat ini.
 * Dipakai oleh pengajuan (validasi + pembekuan baris) dan penerbitan.
 */
async function evaluateStored(tx: Tx, inv: StoredInvoice, forWhat: string) {
  const taxIds = [...new Set(inv.items.map((i) => i.taxConfigId).filter((v): v is string => !!v))];
  const taxes = new Map((await tx.taxConfiguration.findMany({ where: { id: { in: taxIds } } })).map((t) => [t.id, t]));
  const rules = inv.items.map((it) => {
    if (!it.taxConfigId) return null;
    const t = taxes.get(it.taxConfigId);
    if (!t || !t.isActive) throw Errors.conflict(`Baris ${it.lineNo}: konfigurasi pajak tidak aktif. Perbarui draft sebelum ${forWhat}.`);
    return toTaxRule(t);
  });
  let calc: CalcResult;
  try {
    calc = calculateInvoice({
      lines: inv.items.map((it, i) => ({ quantity: it.quantity.toString(), unitPrice: Number(it.unitPrice), discount: Number(it.discountAmount), tax: rules[i] })),
      extraDiscount: Number(inv.extraDiscountAmount), transport: Number(inv.transportAmount), admin: Number(inv.adminAmount), downPayment: Number(inv.downPaymentAmount),
    });
  } catch (e) {
    if (e instanceof CalcError) throw Errors.validation(e.message);
    throw e;
  }
  if (calc.totalAmount <= 0) throw Errors.validation(`Total invoice harus lebih dari Rp 0 untuk ${forWhat}.`);
  return { calc, rules };
}

/** Bekukan nilai & snapshot pajak per baris (hanya boleh selagi invoice masih DRAFT — dijaga trigger). */
async function freezeLines(tx: Tx, inv: StoredInvoice, calc: CalcResult, rules: (TaxRule | null)[]) {
  for (const [i, it] of inv.items.entries()) {
    const cl = calc.lines[i]!;
    const rule = rules[i];
    await tx.invoiceItem.update({
      where: { id: it.id },
      data: { grossAmount: BigInt(cl.grossAmount), netAmount: BigInt(cl.netAmount), taxSnapshot: rule ? toJson(ruleSnapshot(rule)) : Prisma.DbNull },
    });
  }
}

const loadStored = (tx: Tx, id: string) =>
  tx.invoice.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { lineNo: "asc" } }, customer: true, bankAccount: true } });

/**
 * AJUKAN draft untuk diverifikasi Finance Manager. Setelah diajukan isinya TERKUNCI (aplikasi + trigger DB) —
 * staff tidak dapat mengubah apa yang sedang diperiksa. Dokumen tetap berwatermark DRAFT, tanpa nomor/cap/tanda tangan.
 */
export async function submitInvoice(actor: Actor, id: string): Promise<InvoiceDto> {
  assertCan(actor, "invoice:submit");
  await transaction(async (tx) => {
    await lockInvoice(tx, id);
    const inv = await loadStored(tx, id);
    if (!canEditDraft(actor, inv)) throw Errors.notFound("Invoice");
    if (inv.status === "SUBMITTED") throw Errors.conflict("Invoice ini sudah diajukan dan menunggu verifikasi.");
    if (inv.status !== "DRAFT") throw Errors.conflict(`Invoice ini sudah ${inv.status === "ISSUED" ? "diterbitkan" : "dibatalkan"}.`);
    if (!inv.customer.isActive) throw Errors.conflict("Pelanggan sudah diarsipkan; aktifkan kembali atau ganti pelanggan.");

    const { calc, rules } = await evaluateStored(tx, inv, "diajukan");
    await freezeLines(tx, inv, calc, rules);
    await tx.invoice.update({
      where: { id },
      data: {
        status: "SUBMITTED", submittedAt: new Date(), submittedById: actor.userId,
        rejectedAt: null, rejectedById: null, rejectionReason: null,
        customerNameSnapshot: inv.customer.name, ...amountColumns(calc), version: { increment: 1 },
      },
    });
    await writeAudit(tx, actor, {
      action: "invoice.submit", entityType: "Invoice", entityId: id,
      summary: `Invoice untuk ${inv.customer.name} (${formatRupiah(calc.totalAmount, "PLAIN")}) diajukan untuk verifikasi`,
      before: { status: "DRAFT" }, after: { status: "SUBMITTED", totalAmount: calc.totalAmount },
    });
  });
  return toInvoiceDto(await loadRow(prisma, id), todayIso(env().APP_TIMEZONE));
}

/** Pengaju menarik kembali pengajuannya (selama belum diverifikasi) → kembali DRAFT agar dapat diedit. */
export async function recallInvoice(actor: Actor, id: string): Promise<InvoiceDto> {
  assertCan(actor, "invoice:submit");
  await transaction(async (tx) => {
    await lockInvoice(tx, id);
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id } });
    if (!canEditDraft(actor, inv)) throw Errors.notFound("Invoice");
    if (inv.status !== "SUBMITTED") throw Errors.conflict("Hanya invoice yang menunggu verifikasi yang dapat ditarik kembali.");
    await tx.invoice.update({ where: { id }, data: { status: "DRAFT", submittedAt: null, submittedById: null, version: { increment: 1 } } });
    await writeAudit(tx, actor, {
      action: "invoice.recall", entityType: "Invoice", entityId: id, summary: "Pengajuan ditarik kembali menjadi draft",
      before: { status: "SUBMITTED" }, after: { status: "DRAFT" },
    });
  });
  return toInvoiceDto(await loadRow(prisma, id), todayIso(env().APP_TIMEZONE));
}

/** Penyetuju (Finance Manager/Admin) mengembalikan pengajuan ke staff dengan alasan wajib. */
export async function rejectInvoice(actor: Actor, id: string, raw: unknown): Promise<InvoiceDto> {
  assertCan(actor, "invoice:approve");
  const { reason } = parseInput(rejectSchema, raw);
  await transaction(async (tx) => {
    await lockInvoice(tx, id);
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id } });
    if (inv.status !== "SUBMITTED") throw Errors.conflict("Hanya invoice yang menunggu verifikasi yang dapat dikembalikan.");
    await tx.invoice.update({
      where: { id },
      data: { status: "DRAFT", submittedAt: null, submittedById: null, rejectedAt: new Date(), rejectedById: actor.userId, rejectionReason: reason, version: { increment: 1 } },
    });
    await writeAudit(tx, actor, {
      action: "invoice.reject", entityType: "Invoice", entityId: id, summary: `Pengajuan invoice ${inv.customerNameSnapshot} dikembalikan ke staff`,
      before: { status: "SUBMITTED" }, after: { status: "DRAFT" }, reason,
    });
  });
  return toInvoiceDto(await loadRow(prisma, id), todayIso(env().APP_TIMEZONE));
}

/**
 * SETUJUI & TERBITKAN invoice (hanya penyetuju). Dapat dari status SUBMITTED (alur normal) atau DRAFT (penyetuju
 * menerbitkan draftnya sendiri). Seluruhnya dalam SATU transaksi:
 *   kunci baris → validasi ulang → hitung ulang di server → alokasi nomor → bekukan snapshot →
 *   (opsional) catat DP sebagai pembayaran → audit.
 * Bila satu langkah gagal, tidak ada yang tersimpan (termasuk nomor). Klik ganda/dua pengguna: yang kedua menunggu
 * kunci lalu melihat status ISSUED dan ditolak — tidak ada nomor ganda maupun penerbitan ganda.
 * Untuk SUBMITTED, yang disetujui HARUS sama dengan yang diajukan; bila konfigurasi (mis. pajak) berubah sejak itu,
 * penerbitan ditolak dan invoice dikembalikan ke staff untuk diajukan ulang.
 */
export async function issueInvoice(actor: Actor, id: string, raw: unknown = {}): Promise<InvoiceDto> {
  assertCan(actor, "invoice:approve");
  const { expectedTotalAmount } = parseInput(issueSchema, raw ?? {});

  await transaction(async (tx) => {
    await lockInvoice(tx, id);
    const inv = await loadStored(tx, id);
    if (inv.status === "ISSUED") throw Errors.conflict(`Invoice ini sudah diterbitkan sebagai ${inv.number}.`, { number: inv.number, alreadyIssued: true });
    if (inv.status === "CANCELLED") throw Errors.conflict("Invoice ini sudah dibatalkan.");
    const wasStatus = inv.status;

    const settings = await loadSettingsRow(tx);
    if (!settings.invoiceNumberConfirmedAt) {
      throw Errors.conflict("Nomor awal invoice belum dikonfirmasi. Administrator harus mengonfirmasinya di Pengaturan → Penomoran sebelum invoice dapat diterbitkan.");
    }
    if (!inv.customer.isActive) throw Errors.conflict("Pelanggan sudah diarsipkan; aktifkan kembali atau ganti pelanggan.");

    const { calc, rules } = await evaluateStored(tx, inv, "diterbitkan");
    if (expectedTotalAmount !== undefined && expectedTotalAmount !== calc.totalAmount) {
      throw Errors.conflict(
        `Total berubah sejak Anda meninjau (${formatRupiah(expectedTotalAmount, "PLAIN")} → ${formatRupiah(calc.totalAmount, "PLAIN")}), mungkin karena konfigurasi pajak diperbarui. Muat ulang dan tinjau kembali.`,
      );
    }

    if (wasStatus === "SUBMITTED") {
      // Baris sudah dibekukan saat diajukan: pastikan hasil hitung sekarang IDENTIK dengan yang diajukan.
      const same = calc.totalAmount === Number(inv.totalAmount) && inv.items.every((it, i) => {
        return sameTaxSnapshot(it.taxSnapshot, rules[i] ?? null) && it.netAmount === BigInt(calc.lines[i]!.netAmount);
      });
      if (!same) {
        throw Errors.conflict("Konfigurasi (mis. tarif pajak) berubah sejak invoice diajukan, sehingga hasil hitung berbeda. Kembalikan ke staff untuk diajukan ulang.");
      }
    } else {
      // Item lebih dulu (trigger mengizinkan hanya selagi induk masih DRAFT): bekukan snapshot pajak per baris.
      await freezeLines(tx, inv, calc, rules);
    }

    const bank = inv.bankAccount?.isActive ? inv.bankAccount : await tx.bankAccount.findFirst({ where: { isActive: true, isDefault: true } });
    const invoiceDate = dateToIso(inv.invoiceDate);
    const dueDate = computeDueDate(invoiceDate, inv.paymentTermDays, inv.dueDateBasis);
    const { number, scopeKey, seq } = await allocateInvoiceNumber(tx, settings, invoiceDate);

    const company: CompanySnapshot = {
      schemaVersion: 1, name: settings.name, tagline: settings.tagline, address: settings.address, phone: settings.phone,
      email: settings.email, website: settings.website, npwp: settings.npwp, signerName: settings.signerName,
      signerTitle: settings.signerTitle, closingText: settings.closingText,
      logoFileId: settings.showLogo ? settings.logoFileId : null,
      stampFileId: settings.showStamp ? settings.stampFileId : null,
      signatureFileId: settings.showSignature ? settings.signatureFileId : null,
      paymentNote: settings.paymentNote, footerNote: settings.footerNote,
    };
    const display: DisplaySnapshot = { rupiahStyle: settings.rupiahStyle, terbilangSource: settings.terbilangSource };

    await tx.invoice.update({
      where: { id },
      data: {
        status: "ISSUED", number, numberScope: scopeKey, numberSeq: seq,
        issuedAt: new Date(), issuedById: actor.userId,
        dueDate: isoToDate(dueDate),
        ...amountColumns(calc),
        remark: resolveRemark(inv.remark, inv.items.map((i) => i.programText), inv.items.map((i) => i.description)),
        customerNameSnapshot: inv.customer.name, customerSnapshot: toJson(customerSnap(inv.customer)),
        bankAccountId: bank?.id ?? null, bankLabel: bank?.label ?? null, bankAccountNumber: bank?.accountNumber ?? null, bankAccountName: bank?.accountName ?? null,
        taxSnapshot: toJson({ groups: calc.taxGroups }), companySnapshot: toJson(company), displaySnapshot: toJson(display),
        version: { increment: 1 },
      },
    });

    // DP yang dinyatakan pada invoice dicatat SEKALI sebagai baris ledger → satu-satunya sumber "uang diterima".
    if (calc.downPaymentAmount > 0) {
      await tx.payment.create({
        data: {
          invoiceId: id, entryType: "PAYMENT", paymentDate: isoToDate(invoiceDate), amount: BigInt(calc.downPaymentAmount),
          method: inv.paymentMethod, reference: "Down Payment (dicatat saat penerbitan)", isDownPayment: true, recordedById: actor.userId,
        },
      });
    }
    await applyLedger(tx, id);

    await writeAudit(tx, actor, {
      action: "invoice.issue", entityType: "Invoice", entityId: id,
      summary: `Invoice ${number} ${wasStatus === "SUBMITTED" ? "disetujui dan " : ""}diterbitkan untuk ${inv.customer.name} (${formatRupiah(calc.totalAmount, "PLAIN")})`,
      before: { status: wasStatus, number: null, submittedById: inv.submittedById },
      after: {
        status: "ISSUED", number, totalAmount: calc.totalAmount, taxAmount: calc.taxAmount, downPayment: calc.downPaymentAmount,
        dueDate, customerName: inv.customer.name, scope: scopeKey, seq, approvedBy: actor.email,
      },
    });
  });

  return toInvoiceDto(await loadRow(prisma, id), todayIso(env().APP_TIMEZONE));
}

// ───────────────────────────── Pembatalan & duplikasi ─────────────────────────────

/**
 * Batalkan invoice terbit. Nomor TETAP melekat pada invoice batal (tidak dipakai ulang), alasan & pelaku tercatat.
 * Invoice dengan pembayaran aktif tidak dapat dibatalkan: balikkan pembayaran dahulu (jejak uang tetap utuh).
 */
export async function cancelInvoice(actor: Actor, id: string, raw: unknown): Promise<{ invoice: InvoiceDto; replacementId: string | null }> {
  assertCan(actor, "invoice:cancel");
  const { reason, createReplacement } = parseInput(cancelSchema, raw);

  const replacementId = await transaction(async (tx) => {
    await lockInvoice(tx, id);
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { lineNo: "asc" } } } });
    if (inv.status === "CANCELLED") throw Errors.conflict("Invoice ini sudah dibatalkan.");
    if (inv.status === "DRAFT" || inv.status === "SUBMITTED") throw Errors.conflict("Hanya invoice terbit yang dapat dibatalkan. Draft dihapus, pengajuan dikembalikan/ditarik.");
    if (Number(inv.paidAmount) !== 0) {
      throw Errors.conflict("Invoice ini memiliki pembayaran tercatat. Balikkan seluruh pembayaran terlebih dahulu sebelum membatalkan.");
    }
    await tx.invoice.update({
      where: { id },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelledById: actor.userId, cancelReason: reason, version: { increment: 1 } },
    });
    let newId: string | null = null;
    if (createReplacement) newId = await duplicateTx(tx, actor, inv, { replaces: inv.id });
    await writeAudit(tx, actor, {
      action: "invoice.cancel", entityType: "Invoice", entityId: id,
      summary: `Invoice ${inv.number} dibatalkan`,
      before: { status: "ISSUED", totalAmount: Number(inv.totalAmount) }, after: { status: "CANCELLED", replacementDraftId: newId }, reason,
    });
    return newId;
  });
  return { invoice: toInvoiceDto(await loadRow(prisma, id), todayIso(env().APP_TIMEZONE)), replacementId };
}

type DupSource = Prisma.InvoiceGetPayload<{ include: { items: true } }>;

/** Salin invoice menjadi DRAFT baru: tanpa nomor, pembayaran, atau status lunas dari sumber. */
async function duplicateTx(tx: Tx, actor: Actor, src: DupSource, opts: { replaces?: string } = {}): Promise<string> {
  const settings = await loadSettingsRow(tx);
  const today = todayIso(env().APP_TIMEZONE);
  const dueDate = computeDueDate(today, src.paymentTermDays, src.dueDateBasis);
  const customer = await tx.customer.findUniqueOrThrow({ where: { id: src.customerId } });
  const copy = await tx.invoice.create({
    data: {
      status: "DRAFT", paymentStatus: "UNPAID", createdById: actor.userId,
      invoiceDate: isoToDate(today), dueDate: isoToDate(dueDate),
      paymentMethod: src.paymentMethod || settings.defaultPaymentMethod, paymentTermDays: src.paymentTermDays, dueDateBasis: src.dueDateBasis,
      reference: src.reference, remark: src.remark, internalNote: src.internalNote,
      customerId: src.customerId, customerNameSnapshot: customer.name, bankAccountId: src.bankAccountId,
      grossAmount: src.grossAmount, discountAmount: src.discountAmount, extraDiscountAmount: src.extraDiscountAmount,
      subtotalAmount: src.subtotalAmount, taxBaseAmount: src.taxBaseAmount, taxAmount: src.taxAmount,
      transportAmount: src.transportAmount, adminAmount: src.adminAmount, surchargeAmount: src.surchargeAmount,
      totalAmount: src.totalAmount, downPaymentAmount: 0n, paidAmount: 0n, balanceAmount: src.totalAmount,
      duplicatedFromId: src.id, replacesInvoiceId: opts.replaces ?? null,
      items: {
        create: src.items.map((i) => ({
          lineNo: i.lineNo, productId: i.productId, productCode: i.productCode, programText: i.programText, description: i.description, quantity: i.quantity,
          unit: i.unit, unitPrice: i.unitPrice, grossAmount: i.grossAmount, discountAmount: i.discountAmount, netAmount: i.netAmount,
          taxConfigId: i.taxConfigId, taxSnapshot: i.taxSnapshot ?? Prisma.DbNull,
        })),
      },
    },
  });
  await writeAudit(tx, actor, {
    action: "invoice.duplicate", entityType: "Invoice", entityId: copy.id,
    summary: `Draft dibuat dari ${src.number ?? "draft"}${opts.replaces ? " (pengganti invoice batal)" : ""}`,
    after: { duplicatedFrom: src.id, replaces: opts.replaces ?? null },
  });
  return copy.id;
}

export async function duplicateInvoice(actor: Actor, id: string): Promise<InvoiceDto> {
  assertCan(actor, "invoice:create");
  const where = visibilityWhere(actor);
  const newId = await transaction(async (tx) => {
    const src = await tx.invoice.findFirst({ where: { id, ...where }, include: { items: { orderBy: { lineNo: "asc" } } } });
    if (!src) throw Errors.notFound("Invoice");
    return duplicateTx(tx, actor, src);
  });
  return toInvoiceDto(await loadRow(prisma, newId), todayIso(env().APP_TIMEZONE));
}

// ───────────────────────────── Daftar & pencarian ─────────────────────────────

export interface InvoiceListQuery {
  q?: string;
  from?: string;
  to?: string;
  customerId?: string;
  status?: "DRAFT" | "SUBMITTED" | "ISSUED" | "CANCELLED";
  /** UNPAID | PARTIALLY_PAID | PAID | OVERDUE (OVERDUE diturunkan dari jatuh tempo) */
  paymentStatus?: "UNPAID" | "PARTIALLY_PAID" | "PAID" | "OVERDUE";
  createdById?: string;
  sort?: "date" | "total" | "due" | "number";
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

export function buildInvoiceWhere(actor: Actor, f: InvoiceListQuery, today: string): Prisma.InvoiceWhereInput {
  const and: Prisma.InvoiceWhereInput[] = [visibilityWhere(actor)];
  const q = f.q?.trim();
  if (q) and.push({ OR: [{ number: { contains: q, mode: "insensitive" } }, { customerNameSnapshot: { contains: q, mode: "insensitive" } }, { reference: { contains: q, mode: "insensitive" } }] });
  if (f.from) and.push({ invoiceDate: { gte: isoToDate(f.from) } });
  if (f.to) and.push({ invoiceDate: { lte: isoToDate(f.to) } });
  if (f.customerId) and.push({ customerId: f.customerId });
  if (f.createdById) and.push({ createdById: f.createdById });
  if (f.status) and.push({ status: f.status });
  if (f.paymentStatus === "OVERDUE") and.push({ status: "ISSUED", balanceAmount: { gt: 0 }, dueDate: { lt: isoToDate(today) } });
  else if (f.paymentStatus) and.push({ status: "ISSUED", paymentStatus: f.paymentStatus });
  return { AND: and };
}

function orderBy(f: InvoiceListQuery): Prisma.InvoiceOrderByWithRelationInput[] {
  const dir = f.dir === "asc" ? "asc" : "desc";
  switch (f.sort) {
    case "total": return [{ totalAmount: dir }, { createdAt: "desc" }];
    case "due": return [{ dueDate: dir }, { createdAt: "desc" }];
    case "number": return [{ numberSeq: { sort: dir, nulls: "last" } }, { createdAt: "desc" }];
    default: return [{ invoiceDate: dir }, { createdAt: "desc" }];
  }
}

const listInclude = { createdBy: { select: { name: true } } } satisfies Prisma.InvoiceInclude;

export function toListItem(r: Prisma.InvoiceGetPayload<{ include: typeof listInclude }>, today: string): InvoiceListItemDto {
  const dueDate = dateToIso(r.dueDate);
  return {
    id: r.id, number: r.number, status: r.status, paymentStatus: r.paymentStatus, isOverdue: isOverdue(r.status, r.balanceAmount, dueDate, today),
    invoiceDate: dateToIso(r.invoiceDate), dueDate, customerId: r.customerId, customerName: r.customerNameSnapshot,
    totalAmount: Number(r.totalAmount), paidAmount: Number(r.paidAmount),
    balanceAmount: r.status === "ISSUED" ? Number(r.balanceAmount) : 0,
    createdById: r.createdById, createdByName: r.createdBy.name,
  };
}

export async function listInvoices(actor: Actor, f: InvoiceListQuery = {}): Promise<Paged<InvoiceListItemDto>> {
  const today = todayIso(env().APP_TIMEZONE);
  const where = buildInvoiceWhere(actor, f, today);
  const pageSize = Math.min(Math.max(f.pageSize ?? 20, 1), 200);
  const page = Math.max(f.page ?? 1, 1);
  const [total, rows] = await Promise.all([
    prisma.invoice.count({ where }),
    prisma.invoice.findMany({ where, include: listInclude, orderBy: orderBy(f), skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  return { items: rows.map((r) => toListItem(r, today)), total, page, pageSize, pageCount: Math.max(Math.ceil(total / pageSize), 1) };
}

/** Untuk ekspor: seluruh hasil filter (maks 20.000 baris), tanpa paginasi. */
export async function listInvoicesForExport(actor: Actor, f: InvoiceListQuery = {}): Promise<InvoiceListItemDto[]> {
  const today = todayIso(env().APP_TIMEZONE);
  const rows = await prisma.invoice.findMany({ where: buildInvoiceWhere(actor, f, today), include: listInclude, orderBy: orderBy(f), take: 20_000 });
  return rows.map((r) => toListItem(r, today));
}
