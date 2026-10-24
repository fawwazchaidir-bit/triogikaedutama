import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePagePermission } from "@/server/auth/current";
import { getCustomer } from "@/server/services/customers";
import { listInvoices } from "@/server/services/invoices";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui/card";
import { Badge, InvoiceStatusBadge, PaymentStatusBadge } from "@/components/ui/badge";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { can } from "@/lib/permissions";
import { formatRupiah } from "@/lib/finance/money";
import { formatDateShort } from "@/lib/format";
import { uuid } from "@/lib/validation/common";
import { AppError } from "@/server/errors";

export const metadata: Metadata = { title: "Detail Pelanggan" };
export const dynamic = "force-dynamic";

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePagePermission("customer:view");
  const id = uuid.safeParse((await params).id);
  if (!id.success) notFound();
  const c = await getCustomer(user, id.data).catch((e: unknown) => { if (e instanceof AppError && e.code === "NOT_FOUND") notFound(); throw e; });
  const invoices = can(user.role, "invoice:view") ? await listInvoices(user, { customerId: c.id, pageSize: 50 }) : null;
  const R = (n: number) => formatRupiah(n, "PLAIN");
  return (
    <div>
      <PageHeader title={c.name} description={[c.city, c.contactName && `Kontak: ${c.contactName}${c.contactTitle ? ` (${c.contactTitle})` : ""}`].filter(Boolean).join(" · ")}
        actions={<><Link href="/customers" className="inline-flex h-10 items-center rounded-md border border-line bg-white px-4 text-sm hover:bg-canvas">← Semua pelanggan</Link>
          {can(user.role, "invoice:create") && c.isActive && <Link href="/invoices/new" className="inline-flex h-10 items-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700">Buat invoice</Link>}</>} />
      <section className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Ringkasan transaksi">
        {[["Jumlah invoice terbit", String(c.invoiceCount)], ["Nilai transaksi", R(c.invoicedAmount)], ["Sudah dibayar", R(c.paidAmount)], ["Piutang", R(c.outstandingAmount)]].map(([l, v], i) => (
          <div key={l} className="rounded-lg border border-line bg-surface p-4 shadow-sm"><p className="text-sm text-muted">{l}</p><p className={`tabular mt-1 text-2xl font-semibold ${i === 3 && c.outstandingAmount > 0 ? "text-brand-700" : ""}`}>{v}</p></div>
        ))}
      </section>
      <div className="grid gap-5 xl:grid-cols-[22rem_1fr]">
        <Card>
          <CardHeader title="Data pelanggan" actions={c.isActive ? <Badge tone="green">Aktif</Badge> : <Badge>Diarsipkan</Badge>} />
          <dl className="space-y-3 p-5 text-sm">
            {[["Alamat", c.address], ["Telepon", c.phone], ["Email", c.email], ["NPWP", c.npwp], ["Catatan internal", c.internalNote]].map(([l, v]) => (
              <div key={l}><dt className="text-xs font-medium uppercase tracking-wide text-muted">{l}</dt><dd className="mt-0.5 whitespace-pre-line">{v || "—"}</dd></div>
            ))}
          </dl>
        </Card>
        <Card className="min-w-0">
          <CardHeader title="Riwayat invoice" description="Termasuk draft dan invoice batal." />
          {!invoices || invoices.items.length === 0 ? <EmptyState title="Belum ada invoice" /> : (
            <TableWrap><Table>
              <thead><tr><Th>Nomor</Th><Th>Tanggal</Th><Th align="right">Total</Th><Th align="right">Sisa</Th><Th>Status</Th><Th>Pembayaran</Th></tr></thead>
              <tbody>{invoices.items.map((i) => (
                <tr key={i.id} className="hover:bg-canvas/60">
                  <Td mono><Link href={`/invoices/${i.id}`} className="font-semibold hover:text-brand-700 hover:underline">{i.number ?? "DRAFT"}</Link></Td>
                  <Td>{formatDateShort(i.invoiceDate)}</Td><Td align="right">{R(i.totalAmount)}</Td>
                  <Td align="right">{i.status === "ISSUED" ? R(i.balanceAmount) : "—"}</Td>
                  <Td><InvoiceStatusBadge status={i.status} /></Td><Td><PaymentStatusBadge status={i.paymentStatus} overdue={i.isOverdue} invoiceStatus={i.status} /></Td>
                </tr>))}</tbody>
            </Table></TableWrap>
          )}
        </Card>
      </div>
    </div>
  );
}
