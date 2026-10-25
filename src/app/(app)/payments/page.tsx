import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { requirePagePermission } from "@/server/auth/current";
import { listPayments } from "@/server/services/payments";
import { Card, EmptyState, PageHeader } from "@/components/ui/card";
import { FilterBar, FilterField, filterInput } from "@/components/filter-bar";
import { Badge } from "@/components/ui/badge";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { PaymentCreate } from "@/components/payment-create";
import { PaymentReverseButton } from "@/components/payment-reverse";
import { can } from "@/lib/permissions";
import { buildQuery } from "@/lib/invoice-can";
import { formatRupiah } from "@/lib/finance/money";
import { formatDateShort } from "@/lib/format";
import { isoDate } from "@/lib/validation/common";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Pembayaran" };
export const dynamic = "force-dynamic";

const schema = z.object({ q: z.string().max(100).optional(), from: isoDate.optional(), to: isoDate.optional(), method: z.string().max(40).optional(), type: z.enum(["PAYMENT", "REVERSAL"]).optional(), page: z.coerce.number().int().min(1).optional() });

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePagePermission("payment:view");
  const sp = await searchParams;
  const f = schema.safeParse(Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v))).data ?? {};
  const list = await listPayments(user, { ...f, pageSize: 25 });
  const canRecord = can(user.role, "payment:record");
  const canReverse = can(user.role, "payment:reverse");
  return (
    <div>
      <PageHeader title="Pembayaran" description="Buku besar penerimaan. Catatan tidak pernah dihapus — kesalahan dikoreksi dengan pembalikan yang tercatat."
        actions={canRecord ? <PaymentCreate /> : undefined} />
      <FilterBar action="/payments" resetHref="/payments">
        <FilterField label="Invoice / pelanggan / referensi"><input type="search" name="q" defaultValue={f.q} placeholder="Cari…" className={cn(filterInput, "w-56")} /></FilterField>
        <FilterField label="Dari tanggal"><input type="date" name="from" defaultValue={f.from} className={filterInput} /></FilterField>
        <FilterField label="Sampai tanggal"><input type="date" name="to" defaultValue={f.to} className={filterInput} /></FilterField>
        <FilterField label="Jenis"><select name="type" defaultValue={f.type ?? ""} className={filterInput}><option value="">Semua</option><option value="PAYMENT">Pembayaran</option><option value="REVERSAL">Pembalikan</option></select></FilterField>
      </FilterBar>
      <Card>
        {list.items.length === 0 ? <EmptyState title="Belum ada pembayaran" description="Pembayaran yang dicatat pada invoice terbit akan muncul di sini." /> : (
          <TableWrap>
            <Table>
              <thead><tr><Th>Tanggal</Th><Th>Invoice</Th><Th>Pelanggan</Th><Th>Jenis</Th><Th>Metode / referensi</Th><Th>Diterima di</Th><Th align="right">Nominal</Th><Th>Dicatat oleh</Th><Th>Bukti</Th>{canReverse && <Th align="right">Aksi</Th>}</tr></thead>
              <tbody>
                {list.items.map((p) => (
                  <tr key={p.id} className={cn("hover:bg-canvas/60", p.entryType === "REVERSAL" && "bg-brand-50/40")}>
                    <Td>{formatDateShort(p.paymentDate)}</Td>
                    <Td mono><Link href={`/invoices/${p.invoiceId}`} className="font-semibold hover:text-brand-700 hover:underline">{p.invoiceNumber}</Link></Td>
                    <Td className="max-w-52 truncate">{p.customerName}</Td>
                    <Td>{p.entryType === "REVERSAL" ? <Badge tone="red">Pembalikan</Badge> : p.isDownPayment ? <Badge tone="blue">Down Payment</Badge> : <Badge>Pembayaran</Badge>}{p.reversedByPaymentId && <Badge className="ml-1">Sudah dibalik</Badge>}</Td>
                    <Td>{p.method}{p.reference ? ` · ${p.reference}` : ""}{p.reason && <span className="block text-xs text-muted">Alasan: {p.reason}</span>}</Td>
                    <Td>{p.cashAccountName ?? <span className="text-xs text-muted">belum dialokasikan</span>}</Td>
                    <Td align="right" className={cn(p.amount < 0 && "text-brand-700")}>{formatRupiah(p.amount, "PLAIN")}</Td>
                    <Td>{p.recordedByName}</Td>
                    <Td>{p.proofFileId ? <a className="text-brand-700 underline" href={`/api/files/${p.proofFileId}`}>Unduh</a> : "—"}</Td>
                    {canReverse && <Td align="right">{p.entryType === "PAYMENT" && !p.reversedByPaymentId ? <PaymentReverseButton paymentId={p.id} amount={p.amount} invoiceNumber={p.invoiceNumber} /> : null}</Td>}
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
        <Pagination page={list.page} pageCount={list.pageCount} total={list.total} hrefFor={(p) => `/payments${buildQuery({ ...f, page: p })}`} />
      </Card>
    </div>
  );
}
