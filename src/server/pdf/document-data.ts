import "server-only";
import { prisma } from "../db";
import { Errors } from "../errors";
import { actorCan, assertCan, type Actor } from "../actor";
import { dateToIso } from "../json";
import { readFileBytes } from "../services/files";
import { loadSettingsRow } from "../services/settings";
import type { CompanySnapshot, CustomerSnapshot, DisplaySnapshot } from "../services/invoices";
import { formatNumberId, formatRupiah, type RupiahStyle } from "@/lib/finance/money";
import { terbilang } from "@/lib/finance/terbilang";
import { numberForFilename } from "@/lib/finance/invoice-number";
import { resolveRemark } from "@/lib/finance/remark";
import { formatDateShort } from "@/lib/format";
import type { InvoicePdfData, PdfImage } from "./InvoicePdf";
import type { InvoiceTaxGroupDto } from "@/lib/types";

/**
 * Menyusun data dokumen PDF dari invoice TERSIMPAN.
 *  • ISSUED / CANCELLED → HANYA dari snapshot beku (perubahan master/pengaturan tidak berpengaruh); nomor, tanda tangan
 *                         Finance Manager, dan cap muncul.
 *  • DRAFT / SUBMITTED  → dari data tersimpan + master saat ini, diberi watermark DRAFT. TANPA nomor, tanda tangan, dan cap
 *                         sampai diverifikasi (dicegah di sini, di sumber data — bukan sekadar disembunyikan di template).
 * Tidak pernah memakai nilai dari input browser yang belum disimpan.
 */

async function image(fileId: string | null | undefined): Promise<PdfImage | null> {
  const f = await readFileBytes(fileId);
  if (!f) return null;
  const format = f.mimeType === "image/png" ? "png" : f.mimeType === "image/jpeg" ? "jpg" : null;
  return format ? { data: f.data, format } : null;
}

const fmtQty = (q: string) => q.replace(".", ",");
const fmtAmt = (n: number, style: RupiahStyle) => (n === 0 ? "0" : formatRupiah(n, style));
const safeCustomer = (name: string) => name.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);

export interface InvoiceDocument {
  data: InvoicePdfData;
  filename: string;
  status: "DRAFT" | "SUBMITTED" | "ISSUED" | "CANCELLED";
  number: string | null;
  invoiceId: string;
}

export async function loadInvoiceDocument(actor: Actor, id: string): Promise<InvoiceDocument> {
  const visibility = actorCan(actor, "invoice:view") ? {} : actorCan(actor, "invoice:view_own") ? { createdById: actor.userId } : null;
  if (!visibility) throw Errors.forbidden();
  const inv = await prisma.invoice.findFirst({
    where: { id, ...visibility },
    include: { items: { orderBy: { lineNo: "asc" } }, customer: true, bankAccount: true },
  });
  if (!inv) throw Errors.notFound("Invoice");
  // DRAFT & SUBMITTED (menunggu verifikasi) diperlakukan sama: belum resmi.
  const isDraft = inv.status === "DRAFT" || inv.status === "SUBMITTED";
  assertCan(actor, isDraft ? "invoice:preview_draft" : "invoice:pdf");

  // ── Sumber data: snapshot (terbit/batal) atau master saat ini (draft) ──
  let company: CompanySnapshot;
  let display: DisplaySnapshot;
  let customerName: string;
  let bank: { label: string; accountNumber: string; accountName: string } | null;
  if (isDraft) {
    const st = await loadSettingsRow();
    company = {
      schemaVersion: 1, name: st.name, tagline: st.tagline, address: st.address, phone: st.phone, email: st.email, website: st.website,
      npwp: st.npwp, signerName: st.signerName, signerTitle: st.signerTitle, closingText: st.closingText,
      logoFileId: st.showLogo ? st.logoFileId : null, stampFileId: null, signatureFileId: null, // belum diverifikasi: tanpa cap & tanda tangan
      paymentNote: st.paymentNote, footerNote: st.footerNote,
    };
    display = { rupiahStyle: st.rupiahStyle, terbilangSource: st.terbilangSource };
    customerName = inv.customer.name;
    const b = inv.bankAccount ?? (await prisma.bankAccount.findFirst({ where: { isActive: true, isDefault: true } }));
    bank = b ? { label: b.label, accountNumber: b.accountNumber, accountName: b.accountName } : null;
  } else {
    if (!inv.companySnapshot || !inv.displaySnapshot) throw new Error(`Invoice ${inv.number} tidak memiliki snapshot — data tidak konsisten`);
    company = inv.companySnapshot as unknown as CompanySnapshot;
    display = inv.displaySnapshot as unknown as DisplaySnapshot;
    customerName = inv.customerNameSnapshot;
    bank = inv.bankLabel ? { label: inv.bankLabel, accountNumber: inv.bankAccountNumber ?? "", accountName: inv.bankAccountName ?? "" } : null;
  }
  void (inv.customerSnapshot as CustomerSnapshot | null);

  const style = display.rupiahStyle;
  const total = Number(inv.totalAmount);
  const dp = Number(inv.downPaymentAmount);
  const descriptions = inv.items.map((i) => i.description);
  const programTexts = inv.items.map((i) => i.programText);
  const taxGroups = ((inv.taxSnapshot as { groups?: InvoiceTaxGroupDto[] } | null)?.groups ?? []);
  const includedTax = taxGroups.filter((g) => !g.addedToTotal).reduce((a, g) => a + g.taxAmount, 0);

  const lines = inv.items.map((it) => ({
    no: it.lineNo,
    descriptionLines: it.description.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
    quantity: `${fmtQty(it.quantity.toString())} ${it.unit}`,
    unitPrice: formatRupiah(Number(it.unitPrice), style),
    netAmount: formatRupiah(Number(it.netAmount), style),
    note: Number(it.discountAmount) > 0 ? `Diskon: -${formatRupiah(Number(it.discountAmount), style)}` : null,
  }));

  const summary: InvoicePdfData["summary"] = [];
  const extraDiscount = Number(inv.extraDiscountAmount);
  if (inv.items.length > 1 || extraDiscount > 0) summary.push({ label: "Subtotal", value: formatRupiah(Number(inv.subtotalAmount), style) });
  if (extraDiscount > 0) summary.push({ label: "Discount", value: `-${formatRupiah(extraDiscount, style)}` });
  summary.push({ label: "Down Payment", value: fmtAmt(dp, style), bold: true, rule: true });
  summary.push({ label: includedTax > 0 ? "Tax (sudah termasuk)" : "Tax", value: fmtAmt(includedTax > 0 ? includedTax : Number(inv.taxAmount), style) });
  summary.push({ label: "Transport", value: fmtAmt(Number(inv.transportAmount), style) });
  summary.push({ label: "Administrasi", value: fmtAmt(Number(inv.adminAmount), style) });
  summary.push({ label: "Nett Total", value: formatRupiah(total, style), bold: true });
  if (dp > 0) summary.push({ label: "Sisa Tagihan", value: formatRupiah(total - dp, style), bold: true });

  const number = isDraft ? "DRAFT" : inv.number!;
  const inwordAmount = display.terbilangSource === "BALANCE" ? total - dp : total;

  const [logo, stamp, signature] = await Promise.all([image(company.logoFileId), image(company.stampFileId), image(company.signatureFileId)]);

  const data: InvoicePdfData = {
    watermark: isDraft ? "DRAFT" : inv.status === "CANCELLED" ? "DIBATALKAN" : null,
    approved: !isDraft,
    disclaimer: isDraft
      ? "DRAFT — belum diverifikasi Finance Manager. Bukan invoice resmi; jangan dikirim atau ditagihkan kepada pelanggan."
      : inv.status === "CANCELLED" ? "Invoice ini telah DIBATALKAN dan tidak berlaku sebagai tagihan." : null,
    company: {
      name: company.name, tagline: company.tagline,
      addressLines: company.address.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
      phone: company.phone, email: company.email, npwp: company.npwp,
      signerName: company.signerName, signerTitle: company.signerTitle, closingText: company.closingText,
      paymentNote: company.paymentNote, footerNote: company.footerNote, logo, stamp, signature,
    },
    meta: { number, invoiceDate: formatDateShort(dateToIso(inv.invoiceDate)), paymentTerm: inv.paymentMethod, dueDate: formatDateShort(dateToIso(inv.dueDate)) },
    customerName,
    lines,
    inword: terbilang(inwordAmount),
    // Remark = teks PROGRAM tetap (bukan Product Description yang dinamis / berisi nama peserta).
    remark: resolveRemark(inv.remark, programTexts, descriptions),
    bank,
    summary,
  };

  const filename = isDraft
    ? `Invoice_DRAFT_${inv.id.slice(0, 8)}_${safeCustomer(customerName)}.pdf`
    : `Invoice_${numberForFilename(number)}_${safeCustomer(customerName)}.pdf`;
  return { data, filename, status: inv.status, number: inv.number, invoiceId: inv.id };
}

export { formatNumberId };
