import "server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma, transaction, type Tx } from "../db";
import { env } from "../env";
import { Errors } from "../errors";
import { parseInput } from "../validate";
import { assertCan, type Actor } from "../actor";
import { writeAudit } from "../audit";
import { lockInvoice } from "./invoice-lock";
import { resolvePaymentAccount } from "./cash-accounts";
import { derivePaymentStatus } from "@/lib/finance/calculate";
import { vatForPayment } from "@/lib/accounting/tax";
import { isValidIsoDate } from "@/lib/finance/due-date";
import { formatRupiah } from "@/lib/finance/money";
import { todayIso } from "@/lib/format";
import { isoToDate, dateToIso } from "../json";
import { assertBooksOpen } from "./books-lock";
import { isoDate, optionalText, requiredText, rupiah, uuid } from "@/lib/validation/common";
import type { Paged, PaymentDto } from "@/lib/types";

/**
 * ═══════════ LEDGER PEMBAYARAN ═══════════
 *  • Setiap pembayaran = satu baris `payments` yang TIDAK PERNAH diubah/dihapus (dijaga trigger DB).
 *  • Koreksi = baris REVERSAL bernilai negatif yang menunjuk pembayaran asal (sekali saja).
 *  • Total dibayar (dilunasi) invoice = Σ (amount + withholdingAmount) semua baris (PAYMENT positif + REVERSAL negatif):
 *    `amount` = uang yang benar-benar masuk; `withholdingAmount` = PPh yang dipotong pelanggan (bukti potong) — melunasi invoice tanpa uang.
 *    `vatAmount` = bagian PPN dari nilai yang dilunasi, dibekukan saat dicatat (lihat `vatForPayment`).
 *    Kolom cache invoices.paidAmount/balanceAmount/paymentStatus diperbarui di transaksi yang SAMA,
 *    di bawah kunci baris invoice. `npm run db:reconcile` memverifikasi cache == ledger.
 *  • Pembayaran melebihi sisa tagihan DITOLAK (tidak ada mekanisme kelebihan bayar tanpa otorisasi khusus).
 */

/**
 * PPN untuk pembayaran baru pada invoice ini (dipanggil di dalam transaksi, SETELAH lockInvoice).
 * Memakai total/PPN invoice dan Σ pembayaran sebelumnya; hasilnya dibekukan pada baris pembayaran.
 */
export async function vatForNewPayment(tx: Tx, invoiceId: string, settled: number): Promise<number> {
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { totalAmount: true, taxAmount: true } });
  if (Number(inv.taxAmount) <= 0) return 0;
  const agg = await tx.payment.aggregate({ where: { invoiceId }, _sum: { amount: true, withholdingAmount: true, vatAmount: true } });
  return vatForPayment({
    total: Number(inv.totalAmount), vat: Number(inv.taxAmount), settled,
    settledBefore: Number(agg._sum.amount ?? 0n) + Number(agg._sum.withholdingAmount ?? 0n), vatBefore: Number(agg._sum.vatAmount ?? 0n),
  });
}

/** Hitung ulang cache invoice dari ledger. Panggil di dalam transaksi, SETELAH lockInvoice. */
export async function applyLedger(tx: Tx, invoiceId: string): Promise<{ paid: number; balance: number; status: "UNPAID" | "PARTIALLY_PAID" | "PAID" }> {
  const agg = await tx.payment.aggregate({ where: { invoiceId }, _sum: { amount: true, withholdingAmount: true } });
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { totalAmount: true } });
  const paid = Number(agg._sum.amount ?? 0n) + Number(agg._sum.withholdingAmount ?? 0n);
  const total = Number(inv.totalAmount);
  const status = derivePaymentStatus(total, paid);
  await tx.invoice.update({
    where: { id: invoiceId },
    data: { paidAmount: BigInt(paid), balanceAmount: BigInt(total - paid), paymentStatus: status },
  });
  return { paid, balance: total - paid, status };
}

type PaymentRow = Prisma.PaymentGetPayload<{
  include: { invoice: { select: { number: true; customerNameSnapshot: true } }; recordedBy: { select: { name: true } }; reversal: { select: { id: true } }; cashAccount: { select: { name: true } } };
}>;

const paymentInclude = {
  invoice: { select: { number: true, customerNameSnapshot: true } },
  recordedBy: { select: { name: true } },
  reversal: { select: { id: true } },
  cashAccount: { select: { name: true } },
} satisfies Prisma.PaymentInclude;

export const toPaymentDto = (p: PaymentRow): PaymentDto => ({
  id: p.id, invoiceId: p.invoiceId, invoiceNumber: p.invoice.number, customerName: p.invoice.customerNameSnapshot,
  entryType: p.entryType, paymentDate: dateToIso(p.paymentDate), amount: Number(p.amount), method: p.method,
  withholdingAmount: Number(p.withholdingAmount), withholdingRef: p.withholdingRef, vatAmount: Number(p.vatAmount),
  reference: p.reference, note: p.note, reason: p.reason, isDownPayment: p.isDownPayment, proofFileId: p.proofFileId,
  recordedByName: p.recordedBy.name, createdAt: p.createdAt.toISOString(),
  reversedByPaymentId: p.reversal?.id ?? null, reversesPaymentId: p.reversesPaymentId,
  cashAccountId: p.cashAccountId, cashAccountName: p.cashAccount?.name ?? null,
});

export const paymentInputSchema = z.object({
  invoiceId: uuid,
  paymentDate: isoDate.refine(isValidIsoDate, "Tanggal pembayaran tidak valid"),
  /** Uang yang benar-benar diterima (neto setelah PPh yang dipotong pelanggan). */
  amount: rupiah("Nominal pembayaran").min(1, "Nominal pembayaran harus lebih dari 0"),
  /** PPh yang dipotong pelanggan (mis. PPh 23) sesuai bukti potong; ikut melunasi invoice tetapi bukan uang masuk. */
  withholdingAmount: z.preprocess((v) => (v === "" || v === undefined || v === null ? 0 : v), rupiah("PPh dipotong pelanggan")),
  withholdingRef: optionalText(60, "Nomor bukti potong"),
  method: requiredText(2, 40, "Metode pembayaran"),
  reference: optionalText(120, "Referensi transfer"),
  note: optionalText(500, "Catatan"),
  proofFileId: z.preprocess((v) => (v === "" ? null : v ?? null), uuid.nullable()),
  /** Akun kas/bank penerima; kosong → akun default menurut metode (Tunai → kas, lainnya → bank). */
  cashAccountId: z.preprocess((v) => (v === "" ? null : v ?? null), uuid.nullable()),
});

export async function recordPayment(actor: Actor, raw: unknown): Promise<PaymentDto> {
  assertCan(actor, "payment:record");
  const input = parseInput(paymentInputSchema, raw);
  const today = todayIso(env().APP_TIMEZONE);
  if (input.paymentDate > today) throw Errors.validation("Tanggal pembayaran tidak boleh di masa depan.", { paymentDate: "Tidak boleh di masa depan" });

  return transaction(async (tx) => {
    await lockInvoice(tx, input.invoiceId);
    await assertBooksOpen(tx, input.paymentDate, "pembayaran", "paymentDate");
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: input.invoiceId } });
    if (inv.status !== "ISSUED") {
      throw Errors.conflict(inv.status === "DRAFT" || inv.status === "SUBMITTED" ? "Pembayaran hanya dapat dicatat pada invoice yang sudah diterbitkan." : "Invoice sudah dibatalkan; pembayaran tidak dapat dicatat.");
    }
    const balance = Number(inv.balanceAmount);
    if (balance <= 0) throw Errors.conflict("Invoice ini sudah lunas.");
    const settled = input.amount + input.withholdingAmount;
    if (settled > balance) {
      throw Errors.validation(`Nominal${input.withholdingAmount ? " + PPh dipotong" : ""} melebihi sisa tagihan (${formatRupiah(balance, "PLAIN")}).`, {
        [input.withholdingAmount ? "withholdingAmount" : "amount"]: `Maksimal ${formatRupiah(balance, "PLAIN")}${input.withholdingAmount ? " (uang + PPh dipotong)" : ""}`,
      });
    }
    if (input.withholdingAmount > 0) {
      // Pemotongan tidak mungkin melebihi nilai jasa sebelum PPN (total − PPN). Tarif TIDAK diasumsikan; ketepatan nilai mengikuti bukti potong.
      const cap = Number(inv.totalAmount) - Number(inv.taxAmount);
      const priorWh = Number((await tx.payment.aggregate({ where: { invoiceId: inv.id }, _sum: { withholdingAmount: true } }))._sum.withholdingAmount ?? 0n);
      if (priorWh + input.withholdingAmount > cap) {
        throw Errors.validation(`Total PPh dipotong pada invoice ini tidak boleh melebihi nilai sebelum PPN (${formatRupiah(cap, "PLAIN")}).`, { withholdingAmount: "Melebihi nilai invoice sebelum PPN" });
      }
    } else if (input.withholdingRef) {
      throw Errors.validation("Nomor bukti potong hanya diisi bila ada PPh yang dipotong.", { withholdingRef: "Isi PPh dipotong lebih dulu" });
    }
    if (input.proofFileId) {
      const f = await tx.storedFile.findUnique({ where: { id: input.proofFileId }, select: { kind: true } });
      if (f?.kind !== "PAYMENT_PROOF") throw Errors.validation("Bukti pembayaran tidak valid.", { proofFileId: "File tidak valid" });
    }
    const cashAccountId = await resolvePaymentAccount(tx, input.method, input.cashAccountId);
    const vatAmount = await vatForNewPayment(tx, inv.id, settled);
    const p = await tx.payment.create({
      data: {
        invoiceId: inv.id, entryType: "PAYMENT", paymentDate: isoToDate(input.paymentDate), amount: BigInt(input.amount),
        withholdingAmount: BigInt(input.withholdingAmount), withholdingRef: input.withholdingAmount > 0 ? input.withholdingRef : null, vatAmount: BigInt(vatAmount),
        method: input.method, reference: input.reference, note: input.note, proofFileId: input.proofFileId, cashAccountId, recordedById: actor.userId,
      },
      include: paymentInclude,
    });
    const after = await applyLedger(tx, inv.id);
    await writeAudit(tx, actor, {
      action: "payment.record", entityType: "Invoice", entityId: inv.id,
      summary: `Pembayaran ${formatRupiah(input.amount, "PLAIN")} dicatat pada invoice ${inv.number}`,
      before: { paid: Number(inv.paidAmount), balance },
      after: { paymentId: p.id, amount: input.amount, withholding: input.withholdingAmount, vat: vatAmount, method: input.method, reference: input.reference, cashAccountId, paid: after.paid, balance: after.balance, paymentStatus: after.status },
    });
    return toPaymentDto(p);
  });
}

export const reversalSchema = z.object({
  reason: z.string().trim().min(5, "Alasan pembalikan wajib diisi (minimal 5 karakter)").max(300),
});

/** Koreksi pembayaran = tambah baris pembalikan. Histori asli tetap utuh. */
export async function reversePayment(actor: Actor, paymentId: string, raw: unknown): Promise<PaymentDto> {
  assertCan(actor, "payment:reverse");
  const { reason } = parseInput(reversalSchema, raw);
  const today = todayIso(env().APP_TIMEZONE);

  return transaction(async (tx) => {
    const orig = await tx.payment.findUnique({ where: { id: paymentId }, include: { reversal: { select: { id: true } } } });
    if (!orig) throw Errors.notFound("Pembayaran");
    await lockInvoice(tx, orig.invoiceId);
    if (orig.entryType !== "PAYMENT") throw Errors.conflict("Hanya pembayaran yang dapat dibalikkan.");
    // Baca ulang setelah kunci: transaksi lain mungkin baru saja membalikkannya.
    if (await tx.payment.findUnique({ where: { reversesPaymentId: paymentId }, select: { id: true } })) {
      throw Errors.conflict("Pembayaran ini sudah pernah dibalikkan.");
    }
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: orig.invoiceId } });
    if (inv.status !== "ISSUED") throw Errors.conflict("Invoice tidak dalam status terbit.");

    const p = await tx.payment.create({
      data: {
        invoiceId: orig.invoiceId, entryType: "REVERSAL", reversesPaymentId: orig.id, paymentDate: isoToDate(today),
        amount: -orig.amount, withholdingAmount: -orig.withholdingAmount, withholdingRef: orig.withholdingRef, vatAmount: -orig.vatAmount,
        method: orig.method, reference: orig.reference, reason, cashAccountId: orig.cashAccountId, recordedById: actor.userId,
      },
      include: paymentInclude,
    });
    const after = await applyLedger(tx, orig.invoiceId);
    await writeAudit(tx, actor, {
      action: "payment.reverse", entityType: "Invoice", entityId: orig.invoiceId,
      summary: `Pembayaran ${formatRupiah(Number(orig.amount), "PLAIN")} pada invoice ${inv.number} dibalikkan`,
      before: { paymentId: orig.id, amount: Number(orig.amount), paid: Number(inv.paidAmount), balance: Number(inv.balanceAmount), paymentStatus: inv.paymentStatus },
      after: { reversalId: p.id, paid: after.paid, balance: after.balance, paymentStatus: after.status },
      reason,
    });
    return toPaymentDto(p);
  });
}

export interface PaymentListQuery {
  invoiceId?: string; q?: string; from?: string; to?: string; method?: string;
  type?: "PAYMENT" | "REVERSAL"; page?: number; pageSize?: number;
}

export function buildPaymentWhere(query: PaymentListQuery): Prisma.PaymentWhereInput {
  const q = query.q?.trim();
  return {
    ...(query.invoiceId ? { invoiceId: query.invoiceId } : {}),
    ...(query.type ? { entryType: query.type } : {}),
    ...(query.method ? { method: query.method } : {}),
    ...(query.from || query.to ? { paymentDate: { ...(query.from ? { gte: isoToDate(query.from) } : {}), ...(query.to ? { lte: isoToDate(query.to) } : {}) } } : {}),
    ...(q ? { OR: [
      { reference: { contains: q, mode: "insensitive" } },
      { invoice: { number: { contains: q, mode: "insensitive" } } },
      { invoice: { customerNameSnapshot: { contains: q, mode: "insensitive" } } },
    ] } : {}),
  };
}

export async function listPayments(actor: Actor, query: PaymentListQuery = {}): Promise<Paged<PaymentDto>> {
  assertCan(actor, "payment:view");
  const pageSize = Math.min(Math.max(query.pageSize ?? 25, 1), 100);
  const page = Math.max(query.page ?? 1, 1);
  const where = buildPaymentWhere(query);
  const [total, rows] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({ where, include: paymentInclude, orderBy: [{ paymentDate: "desc" }, { createdAt: "desc" }], skip: (page - 1) * pageSize, take: pageSize }),
  ]);
  return { items: rows.map(toPaymentDto), total, page, pageSize, pageCount: Math.max(Math.ceil(total / pageSize), 1) };
}

export async function listPaymentsForInvoice(actor: Actor, invoiceId: string): Promise<PaymentDto[]> {
  assertCan(actor, "payment:view");
  const rows = await prisma.payment.findMany({ where: { invoiceId }, include: paymentInclude, orderBy: [{ createdAt: "asc" }] });
  return rows.map(toPaymentDto);
}
