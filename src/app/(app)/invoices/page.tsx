import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDown, ArrowUp, Download, Plus } from "lucide-react";
import { requirePagePermission } from "@/server/auth/current";
import { listInvoices } from "@/server/services/invoices";
import { invoiceListQuerySchema } from "@/server/invoice-query";
import { listCustomers } from "@/server/services/customers";
import { Card, EmptyState, Notice, PageHeader } from "@/components/ui/card";
import { FilterBar, FilterField, filterInput } from "@/components/filter-bar";
import { InvoiceStatusBadge, PaymentStatusBadge } from "@/components/ui/badge";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { InvoiceActions } from "@/components/invoice-actions";
import { buildQuery, invoiceCan } from "@/lib/invoice-can";
import { can } from "@/lib/permissions";
import { formatRupiah } from "@/lib/finance/money";
import { formatDateShort } from "@/lib/format";
import { cn } from "@/lib/cn";
import { AppError } from "@/server/errors";

export const metadata: Metadata = { title: "Invoice" };
export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function InvoicesPage({ searchParams }: { searchParams: SP }) {
  const user = await requirePagePermission(["invoice:view", "invoice:view_own"]);
  const sp = await searchParams;
  const raw = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, first(v)]).filter(([, v]) => v));
  const parsed = invoiceListQuerySchema.safeParse(raw);
  const f = parsed.success ? parsed.data : {};
  let error: string | null = parsed.success ? null : "Filter tidak valid; menampilkan semua data.";
  let list: Awaited<ReturnType<typeof listInvoices>> | null = null;
  try {
    list = await listInvoices(user, f);
  } catch (e) {
    error = e instanceof AppError ? e.message : "Gagal memuat invoice.";
  }
  const customers = can(user.role, "customer:view") ? await listCustomers(user, { status: "all", pageSize: 100 }) : null;

  const base = { q: f.q, from: f.from, to: f.to, customerId: f.customerId, status: f.status, paymentStatus: f.paymentStatus };
  const href = (o: Record<string, string | number | undefined>) => `/invoices${buildQuery({ ...base, sort: f.sort, dir: f.dir, ...o })}`;
  const sortHref = (key: "date" | "total" | "due" | "number") => {
    const active = (f.sort ?? "date") === key;
    const dir = active && (f.dir ?? "desc") === "desc" ? "asc" : "desc";
    return href({ sort: key, dir, page: 1 });
  };
  // Fungsi biasa (bukan komponen) yang mengembalikan JSX — dipanggil langsung agar tidak dibuat ulang tiap render.
  const sortTh = (k: "date" | "total" | "due" | "number", label: string, align?: "right") => {
    const active = (f.sort ?? "date") === k;
    const dir = f.dir ?? "desc";
    return (
      <Th key={k} align={align}>
        <Link href={sortHref(k)} className={cn("inline-flex items-center gap-1 hover:text-ink", active && "text-ink")} aria-label={`Urutkan berdasarkan ${label}`}>
          {label}{active && (dir === "desc" ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
        </Link>
      </Th>
    );
  };
  const exportHref = (format: "csv" | "xlsx") => `/api/invoices/export${buildQuery({ ...base, sort: f.sort, dir: f.dir, format })}`;
  const canCreate = can(user.role, "invoice:create");

  return (
    <div>
      <PageHeader
        title="Invoice"
        description={user.role === "STAFF" ? "Draft dan invoice yang Anda buat." : "Cari, pantau pembayaran, dan kelola seluruh invoice."}
        actions={<>
          <a href={exportHref("csv")} className="inline-flex h-10 items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-medium shadow-sm hover:bg-canvas"><Download className="size-4" />CSV</a>
          <a href={exportHref("xlsx")} className="inline-flex h-10 items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-medium shadow-sm hover:bg-canvas"><Download className="size-4" />Excel</a>
          {canCreate && <Link href="/invoices/new" className="inline-flex h-10 items-center gap-2 rounded-md bg-brand-600 px-4 text-sm font-medium text-white shadow-sm hover:bg-brand-700"><Plus className="size-4" />Buat invoice</Link>}
        </>}
      />

      <FilterBar action="/invoices" resetHref="/invoices">
        <FilterField label="Nomor / pelanggan"><input type="search" name="q" defaultValue={f.q} placeholder="Cari…" className={cn(filterInput, "w-48")} /></FilterField>
        <FilterField label="Dari tanggal"><input type="date" name="from" defaultValue={f.from} className={filterInput} /></FilterField>
        <FilterField label="Sampai tanggal"><input type="date" name="to" defaultValue={f.to} className={filterInput} /></FilterField>
        {customers && (
          <FilterField label="Pelanggan">
            <select name="customerId" defaultValue={f.customerId ?? ""} className={cn(filterInput, "min-w-44")}>
              <option value="">Semua pelanggan</option>
              {customers.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </FilterField>
        )}
        <FilterField label="Status invoice">
          <select name="status" defaultValue={f.status ?? ""} className={filterInput}>
            <option value="">Semua</option><option value="DRAFT">Draft</option><option value="ISSUED">Diterbitkan</option><option value="CANCELLED">Dibatalkan</option>
          </select>
        </FilterField>
        <FilterField label="Status pembayaran">
          <select name="paymentStatus" defaultValue={f.paymentStatus ?? ""} className={filterInput}>
            <option value="">Semua</option><option value="UNPAID">Belum dibayar</option><option value="PARTIALLY_PAID">Dibayar sebagian</option>
            <option value="PAID">Lunas</option><option value="OVERDUE">Jatuh tempo</option>
          </select>
        </FilterField>
      </FilterBar>

      {error && <div className="mb-4"><Notice tone="danger">{error}</Notice></div>}

      <Card>
        {list && list.items.length === 0 ? (
          <EmptyState
            title={Object.values(base).some(Boolean) ? "Tidak ada invoice yang cocok" : "Belum ada invoice"}
            description={Object.values(base).some(Boolean) ? "Ubah atau reset filter untuk melihat data lain." : "Buat invoice pertama Anda — pilih pelanggan, tambahkan produk, lalu terbitkan."}
            action={canCreate ? <Link href="/invoices/new" className="inline-flex h-10 items-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700">Buat invoice</Link> : undefined}
          />
        ) : list && (
          <>
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    {sortTh("number", "Nomor")}{sortTh("date", "Tanggal")}<Th>Pelanggan</Th>
                    {sortTh("total", "Total", "right")}<Th align="right">Dibayar</Th><Th align="right">Sisa</Th>
                    {sortTh("due", "Jatuh tempo")}<Th>Status</Th><Th>Pembayaran</Th><Th className="hidden 2xl:table-cell">Pembuat</Th><Th align="right" className="sticky right-0 bg-canvas shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.12)]">Aksi</Th>
                  </tr>
                </thead>
                <tbody>
                  {list.items.map((i) => (
                    <tr key={i.id} className="hover:bg-canvas/60">
                      <Td mono><Link href={`/invoices/${i.id}`} className="font-semibold text-ink hover:text-brand-700 hover:underline">{i.number ?? "DRAFT"}</Link></Td>
                      <Td>{formatDateShort(i.invoiceDate)}</Td>
                      <Td className="max-w-52 truncate"><span title={i.customerName}>{i.customerName}</span></Td>
                      <Td align="right">{formatRupiah(i.totalAmount, "PLAIN")}</Td>
                      <Td align="right">{i.status === "ISSUED" ? formatRupiah(i.paidAmount, "PLAIN") : "—"}</Td>
                      <Td align="right" className={cn(i.isOverdue && "font-semibold text-brand-700")}>{i.status === "ISSUED" ? formatRupiah(i.balanceAmount, "PLAIN") : "—"}</Td>
                      <Td className={cn(i.isOverdue && "font-semibold text-brand-700")}>{formatDateShort(i.dueDate)}</Td>
                      <Td><InvoiceStatusBadge status={i.status} /></Td>
                      <Td><PaymentStatusBadge status={i.paymentStatus} overdue={i.isOverdue} invoiceStatus={i.status} /></Td>
                      <Td className="hidden 2xl:table-cell">{i.createdByName}</Td>
                      <Td align="right" className="sticky right-0 bg-surface shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.12)]">
                        <InvoiceActions
                          inv={{ id: i.id, number: i.number, status: i.status, customerName: i.customerName, totalAmount: i.totalAmount, balanceAmount: i.balanceAmount }}
                          can={invoiceCan(user.role, user.userId, i)}
                        />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
            <Pagination page={list.page} pageCount={list.pageCount} total={list.total} hrefFor={(p) => href({ page: p })} />
          </>
        )}
      </Card>
    </div>
  );
}
