import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePagePermission } from "@/server/auth/current";
import { getInvoice } from "@/server/services/invoices";
import { listPaymentsForInvoice } from "@/server/services/payments";
import { getInvoiceHistory } from "@/server/services/audit";
import { Card, CardHeader, EmptyState, Notice, PageHeader } from "@/components/ui/card";
import { InvoiceStatusBadge, PaymentStatusBadge, Badge } from "@/components/ui/badge";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { InvoiceActions } from "@/components/invoice-actions";
import { PaymentReverseButton } from "@/components/payment-reverse";
import { can } from "@/lib/permissions";
import { invoiceCan } from "@/lib/invoice-can";
import { formatRupiah } from "@/lib/finance/money";
import { terbilang } from "@/lib/finance/terbilang";
import { formatDateLong, formatDateShort, formatDateTime } from "@/lib/format";
import { uuid } from "@/lib/validation/common";
import { AppError } from "@/server/errors";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Detail Invoice" };
export const dynamic = "force-dynamic";

const ACTION_LABELS: Record<string, string> = {
  "invoice.create_draft": "Draft dibuat", "invoice.update_draft": "Draft diubah", "invoice.delete_draft": "Draft dihapus",
  "invoice.submit": "Diajukan untuk verifikasi", "invoice.recall": "Pengajuan ditarik kembali", "invoice.reject": "Dikembalikan ke staff",
  "invoice.issue": "Disetujui & diterbitkan", "invoice.cancel": "Dibatalkan", "invoice.duplicate": "Disalin dari invoice lain",
  "payment.record": "Pembayaran dicatat", "payment.reverse": "Pembayaran dibalikkan", "invoice.pdf_download": "PDF diunduh",
};

export default async function InvoiceDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ preview?: string }> }) {
  const user = await requirePagePermission(["invoice:view", "invoice:view_own"]);
  const id = uuid.safeParse((await params).id);
  if (!id.success) notFound();
  const inv = await getInvoice(user, id.data).catch((e: unknown) => { if (e instanceof AppError && e.code === "NOT_FOUND") notFound(); throw e; });
  const sp = await searchParams;
  const perm = invoiceCan(user.role, user.userId, inv);
  const payments = can(user.role, "payment:view") && (inv.status === "ISSUED" || inv.status === "CANCELLED") ? await listPaymentsForInvoice(user, inv.id) : null;
  const history = can(user.role, "invoice:history") ? await getInvoiceHistory(user, inv.id) : null;
  const R = (n: number) => formatRupiah(n, "PLAIN");
  const a = inv.amounts;
  const canReverse = can(user.role, "payment:reverse") && inv.status === "ISSUED";
  const isDraft = inv.status === "DRAFT";
  const isSubmitted = inv.status === "SUBMITTED";

  return (
    <div>
      <PageHeader
        title={inv.number ? `Invoice ${inv.number}` : isSubmitted ? "Invoice menunggu verifikasi" : "Draft invoice"}
        description={inv.customerName}
        actions={<InvoiceActions variant="bar" inv={{ id: inv.id, number: inv.number, status: inv.status, customerName: inv.customerName, totalAmount: a.total, balanceAmount: a.balance }} can={perm} initialDialog={sp.preview === "1" && perm.pdf ? "preview" : undefined} />}
      />
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <InvoiceStatusBadge status={inv.status} />
        <PaymentStatusBadge status={inv.paymentStatus} overdue={inv.isOverdue} invoiceStatus={inv.status} />
        {inv.replacesInvoice && <Badge tone="blue">Pengganti <Link className="underline" href={`/invoices/${inv.replacesInvoice.id}`}>{inv.replacesInvoice.number}</Link></Badge>}
        {inv.duplicatedFrom && <Badge>Disalin dari <Link className="underline" href={`/invoices/${inv.duplicatedFrom.id}`}>{inv.duplicatedFrom.number ?? "draft"}</Link></Badge>}
        {inv.replacedBy.map((r) => <Badge key={r.id} tone="amber">Diganti oleh <Link className="underline" href={`/invoices/${r.id}`}>{r.number ?? "draft"}</Link></Badge>)}
      </div>

      {inv.status === "CANCELLED" && (
        <div className="mb-5"><Notice tone="danger"><strong>Invoice dibatalkan</strong> pada {formatDateTime(inv.cancelledAt)} oleh {inv.cancelledByName}. Alasan: {inv.cancelReason}. Nomor {inv.number} tidak akan dipakai ulang.</Notice></div>
      )}
      {isDraft && inv.rejectionReason && (
        <div className="mb-5"><Notice tone="warn"><strong>Dikembalikan oleh {inv.rejectedByName}</strong> pada {formatDateTime(inv.rejectedAt)}. Catatan: {inv.rejectionReason}</Notice></div>
      )}
      {isDraft && <div className="mb-5"><Notice tone="info">Ini masih <strong>draft</strong>: belum bernomor, tanpa tanda tangan &amp; cap, dan dokumennya berwatermark DRAFT. Data pelanggan mengikuti master saat ini sampai invoice diterbitkan (setelah itu dibekukan).</Notice></div>}
      {isSubmitted && (
        <div className="mb-5"><Notice tone="warn"><strong>Menunggu verifikasi Finance Manager</strong> — diajukan {formatDateTime(inv.submittedAt)} oleh {inv.submittedByName}. Isi dikunci selama diperiksa; dokumen tetap berwatermark DRAFT (tanpa nomor, tanda tangan, dan cap) sampai disetujui.</Notice></div>
      )}
      {inv.isOverdue && <div className="mb-5"><Notice tone="danger">Invoice ini melewati jatuh tempo ({formatDateLong(inv.dueDate)}). Sisa tagihan {R(a.balance)}.</Notice></div>}

      <div className="grid gap-5 xl:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader title="Informasi" description={inv.customerFrozen ? "Data pelanggan & lembaga dibekukan saat penerbitan." : undefined} />
            <dl className="grid gap-x-8 gap-y-3 p-5 text-sm sm:grid-cols-2">
              <Info label="Pelanggan" value={inv.customerName} />
              <Info label="Alamat" value={[inv.customer.address, inv.customer.city].filter(Boolean).join(", ") || "—"} />
              <Info label="NPWP pelanggan" value={inv.customer.npwp ?? "—"} />
              <Info label="Kontak" value={[inv.customer.contactName, inv.customer.contactTitle].filter(Boolean).join(" — ") || "—"} />
              <Info label="Tanggal invoice" value={formatDateLong(inv.invoiceDate)} />
              <Info label="Jatuh tempo" value={`${formatDateLong(inv.dueDate)} (${inv.paymentTermDays} ${inv.dueDateBasis === "BUSINESS_DAYS" ? "hari kerja" : "hari kalender"})`} />
              <Info label="Metode pembayaran" value={inv.paymentMethod} />
              <Info label="Referensi / kontrak" value={inv.reference ?? "—"} />
              <Info label="Rekening tujuan" value={inv.bank ? `${inv.bank.label} · ${inv.bank.accountNumber} a.n. ${inv.bank.accountName}` : "—"} />
              <Info label="Dibuat oleh" value={`${inv.createdByName} · ${formatDateTime(inv.createdAt)}`} />
              {inv.submittedAt && <Info label="Diajukan" value={`${formatDateTime(inv.submittedAt)} oleh ${inv.submittedByName}`} />}
              {inv.issuedAt && <Info label="Disetujui & diterbitkan" value={`${formatDateTime(inv.issuedAt)} oleh ${inv.issuedByName}`} />}
              {inv.remark && <Info label="Remark (program)" value={inv.remark} className="sm:col-span-2" />}
              {inv.internalNote && <Info label="Catatan internal" value={inv.internalNote} className="sm:col-span-2" />}
            </dl>
          </Card>

          <Card>
            <CardHeader title="Rincian transaksi" />
            <TableWrap>
              <Table>
                <thead><tr><Th>No.</Th><Th>Deskripsi</Th><Th>Qty</Th><Th align="right">Harga satuan</Th><Th align="right">Diskon</Th><Th>Pajak</Th><Th align="right">Jumlah bersih</Th></tr></thead>
                <tbody>
                  {inv.lines.map((l) => (
                    <tr key={l.id}>
                      <Td>{l.lineNo}</Td>
                      <Td className="whitespace-pre-line">{l.description}{l.productCode && <span className="mt-1 block text-xs text-muted">{l.productCode}</span>}</Td>
                      <Td>{l.quantity.replace(".", ",")} {l.unit}</Td>
                      <Td align="right">{R(l.unitPrice)}</Td>
                      <Td align="right">{l.discountAmount ? `-${R(l.discountAmount)}` : "—"}</Td>
                      <Td>{l.taxName ?? "—"}</Td>
                      <Td align="right" className="font-medium">{R(l.netAmount)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          </Card>

          {payments && (
            <Card>
              <CardHeader title="Pembayaran" description="Buku besar pembayaran bersifat append-only; koreksi dilakukan dengan pembalikan." />
              {payments.length === 0 ? <EmptyState title="Belum ada pembayaran" description={inv.status === "ISSUED" ? "Catat pembayaran lewat tombol di atas." : undefined} /> : (
                <TableWrap>
                  <Table>
                    <thead><tr><Th>Tanggal</Th><Th>Jenis</Th><Th>Metode / referensi</Th><Th align="right">Uang diterima</Th><Th align="right">PPh dipotong</Th><Th>Dicatat oleh</Th><Th>Bukti</Th><Th align="right">Aksi</Th></tr></thead>
                    <tbody>
                      {payments.map((p) => (
                        <tr key={p.id} className={cn(p.entryType === "REVERSAL" && "bg-brand-50/40")}>
                          <Td>{formatDateShort(p.paymentDate)}</Td>
                          <Td>{p.entryType === "REVERSAL" ? <Badge tone="red">Pembalikan</Badge> : p.isDownPayment ? <Badge tone="blue">Down Payment</Badge> : <Badge>Pembayaran</Badge>}{p.reversedByPaymentId && <Badge tone="gray" className="ml-1">Sudah dibalik</Badge>}</Td>
                          <Td>{p.method}{p.reference ? ` · ${p.reference}` : ""}{p.reason && <span className="block text-xs text-muted">Alasan: {p.reason}</span>}{p.note && <span className="block text-xs text-muted">{p.note}</span>}</Td>
                          <Td align="right" className={cn(p.amount < 0 && "text-brand-700")}>{R(p.amount)}</Td>
                          <Td align="right">{p.withholdingAmount ? <>{R(p.withholdingAmount)}{p.withholdingRef && <span className="block text-xs text-muted">{p.withholdingRef}</span>}</> : "—"}</Td>
                          <Td>{p.recordedByName}</Td>
                          <Td>{p.proofFileId ? <a className="text-brand-700 underline" href={`/api/files/${p.proofFileId}`}>Unduh</a> : "—"}</Td>
                          <Td align="right">{canReverse && p.entryType === "PAYMENT" && !p.reversedByPaymentId ? <PaymentReverseButton paymentId={p.id} amount={p.amount} invoiceNumber={inv.number} /> : null}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </TableWrap>
              )}
            </Card>
          )}

          {history && (
            <Card>
              <CardHeader title="Riwayat" description="Jejak audit invoice ini (siapa melakukan apa dan kapan)." />
              <ol className="divide-y divide-line">
                {history.length === 0 && <li className="p-5 text-sm text-muted">Belum ada riwayat.</li>}
                {history.map((h) => (
                  <li key={h.id} className="px-5 py-3 text-sm">
                    <p className="font-medium">{ACTION_LABELS[h.action] ?? h.action}</p>
                    <p className="text-muted">{formatDateTime(h.createdAt)} · {h.actorName ?? h.actorEmail ?? "sistem"}{h.summary ? ` — ${h.summary}` : ""}</p>
                    {h.reason && <p className="text-muted">Alasan: {h.reason}</p>}
                  </li>
                ))}
              </ol>
            </Card>
          )}
        </div>

        <aside className="xl:sticky xl:top-6 xl:self-start">
          <Card>
            <CardHeader title="Ringkasan biaya" />
            <dl className="space-y-2 p-5 text-sm">
              <Line label="Nilai bruto transaksi" value={R(a.gross)} />
              {a.discount > 0 && <Line label="Diskon (baris + tambahan)" value={`-${R(a.discount)}`} />}
              <Line label="Subtotal" value={R(a.subtotal - a.extraDiscount)} />
              {a.taxBase > 0 && <Line label="Dasar pengenaan pajak (DPP)" value={R(a.taxBase)} muted />}
              <Line label="Pajak" value={R(a.tax)} />
              {a.includedTax > 0 && <Line label="Pajak sudah termasuk harga" value={R(a.includedTax)} muted />}
              <Line label="Transport" value={R(a.transport)} />
              <Line label="Administrasi" value={R(a.admin)} />
              <div className="border-t border-dashed border-ink/40 pt-2"><Line label="Nett Total" value={R(a.total)} strong /></div>
              <p className="text-xs italic text-muted">{terbilang(a.total)}</p>
              <div className="border-t border-line pt-2" />
              <Line label={isDraft ? "DP (dicatat saat terbit)" : "Dibayar"} value={R(isDraft ? a.downPayment : a.paid)} />
              <Line label="Sisa tagihan" value={R(a.balance)} strong tone={inv.isOverdue ? "red" : undefined} />
            </dl>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function Info({ label, value, className }: { label: string; value: string; className?: string }) {
  return <div className={className}><dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt><dd className="mt-0.5 whitespace-pre-line text-ink">{value}</dd></div>;
}
function Line({ label, value, strong, muted, tone }: { label: string; value: string; strong?: boolean; muted?: boolean; tone?: "red" }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3", muted && "text-muted")}>
      <dt className={cn(strong ? "font-semibold" : "text-ink-soft")}>{label}</dt>
      <dd className={cn("tabular", strong && "text-lg font-semibold", tone === "red" && "text-brand-700")}>{value}</dd>
    </div>
  );
}
