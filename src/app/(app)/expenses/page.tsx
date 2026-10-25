import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { requirePagePermission } from "@/server/auth/current";
import { countPendingEntries, listEntries } from "@/server/services/cash-entries";
import { listCashAccountOptions } from "@/server/services/cash-accounts";
import { listCoaAccounts } from "@/server/services/finance-coa";
import { Card, EmptyState, Notice, PageHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FilterBar, FilterField, filterInput } from "@/components/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { EntryActions, EntryCreate } from "@/components/expense-forms";
import { can } from "@/lib/permissions";
import { buildQuery } from "@/lib/invoice-can";
import { formatRupiah } from "@/lib/finance/money";
import { formatDateShort } from "@/lib/format";
import { isoDate } from "@/lib/validation/common";
import { cn } from "@/lib/cn";
import type { CashEntryDto } from "@/lib/finance-types";

export const metadata: Metadata = { title: "Pengeluaran" };
export const dynamic = "force-dynamic";

const schema = z.object({
  q: z.string().max(100).optional(), from: isoDate.optional(), to: isoDate.optional(),
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(), kind: z.enum(["EXPENSE", "OTHER"]).optional(), page: z.coerce.number().int().min(1).optional(),
});

function StatusBadge({ e }: { e: CashEntryDto }) {
  if (e.entryType === "REVERSAL") return <Badge tone="red">Pembalikan</Badge>;
  if (e.status === "PENDING") return <Badge tone="amber">Menunggu persetujuan</Badge>;
  if (e.status === "REJECTED") return <Badge tone="dark">Ditolak</Badge>;
  return <>{<Badge tone="green">Berlaku</Badge>}{e.reversedByEntryId && <Badge className="ml-1">Sudah dibalik</Badge>}</>;
}

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePagePermission(["expense:record", "expense:view_own", "finance:view"]);
  const sp = await searchParams;
  const f = schema.safeParse(Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v))).data ?? {};
  const isFinance = can(user.role, "finance:view");
  const canApprove = can(user.role, "expense:approve");
  const canRecord = can(user.role, "expense:record");
  const base = { ...f, kind: isFinance ? f.kind : "EXPENSE" as const };
  const [list, accounts, coa, pending] = await Promise.all([
    listEntries(user, { ...base, pageSize: 25 }),
    canRecord ? listCashAccountOptions(user) : Promise.resolve([]),
    canRecord ? listCoaAccounts(user) : Promise.resolve([]),
    canApprove ? countPendingEntries(user) : Promise.resolve(0),
  ]);
  const href = (p: number) => `/expenses${buildQuery({ ...f, page: p })}`;
  return (
    <div>
      <PageHeader title="Pengeluaran" description={isFinance ? "Pengeluaran dan entri kas manual. Staff mengajukan, Finance Manager menyetujui; yang sudah berlaku tidak dapat diubah (koreksi lewat pembalikan)." : "Pengeluaran yang Anda catat. Setelah disetujui Finance Manager, pengeluaran masuk saldo dan laporan."}
        actions={canRecord ? <EntryCreate mode="expense" accounts={accounts} categories={coa} /> : undefined} />
      {canApprove && pending > 0 && (
        <div className="mb-4"><Notice tone="warn"><strong>{pending} pengeluaran menunggu persetujuan.</strong> <Link className="underline" href="/expenses?status=PENDING">Tinjau sekarang</Link></Notice></div>
      )}
      {accounts.length === 0 && canRecord && <div className="mb-4"><Notice tone="warn">Belum ada akun kas/bank aktif. Administrator perlu menambahkannya di Pengaturan → Keuangan.</Notice></div>}
      <FilterBar action="/expenses" resetHref="/expenses">
        <FilterField label="Keterangan / penerima / no. bukti"><input type="search" name="q" defaultValue={f.q} placeholder="Cari…" className={cn(filterInput, "w-56")} /></FilterField>
        <FilterField label="Dari tanggal"><input type="date" name="from" defaultValue={f.from} className={filterInput} /></FilterField>
        <FilterField label="Sampai tanggal"><input type="date" name="to" defaultValue={f.to} className={filterInput} /></FilterField>
        <FilterField label="Status"><select name="status" defaultValue={f.status ?? ""} className={filterInput}><option value="">Semua</option><option value="PENDING">Menunggu persetujuan</option><option value="APPROVED">Berlaku</option><option value="REJECTED">Ditolak</option></select></FilterField>
        {isFinance && <FilterField label="Jenis"><select name="kind" defaultValue={f.kind ?? ""} className={filterInput}><option value="">Semua entri kas</option><option value="EXPENSE">Pengeluaran</option><option value="OTHER">Penerimaan lain / non-operasional</option></select></FilterField>}
      </FilterBar>
      <Card>
        {list.items.length === 0 ? <EmptyState title="Belum ada data" description="Pengeluaran yang dicatat akan tampil di sini." /> : (
          <>
            <TableWrap>
              <Table>
                <thead><tr><Th>Tanggal</Th><Th>Kategori</Th><Th>Keterangan</Th><Th>Akun</Th><Th align="right">Nominal</Th><Th>Status</Th>{isFinance && <Th>Pencatat</Th>}<Th align="right">Aksi</Th></tr></thead>
                <tbody>
                  {list.items.map((e) => (
                    <tr key={e.id} className={cn(e.entryType === "REVERSAL" && "bg-brand-50/40")}>
                      <Td>{formatDateShort(e.entryDate)}</Td>
                      <Td><span className="font-mono text-xs text-muted">{e.counterCode}</span><span className="block">{e.counterName}</span></Td>
                      <Td className="max-w-72">
                        {e.description}
                        {(e.payee || e.reference) && <span className="block text-xs text-muted">{[e.payee, e.reference].filter(Boolean).join(" · ")}</span>}
                        {e.reason && <span className="block text-xs text-muted">Alasan: {e.reason}</span>}
                        {e.rejectionReason && <span className="block text-xs text-brand-700">Ditolak: {e.rejectionReason}</span>}
                        {e.proofFileId && <a className="block text-xs text-brand-700 underline" href={`/api/files/${e.proofFileId}`}>Unduh bukti</a>}
                      </Td>
                      <Td>{e.cashAccountName}</Td>
                      <Td align="right" className={cn("tabular", e.direction === "IN" ? "text-emerald-700" : "")}>{e.direction === "IN" ? "+" : "−"}{formatRupiah(e.amount, "PLAIN")}</Td>
                      <Td><StatusBadge e={e} /></Td>
                      {isFinance && <Td>{e.createdByName}</Td>}
                      <Td align="right"><EntryActions entry={e} can={{ approve: canApprove && e.createdById !== user.userId, cancel: canRecord && e.createdById === user.userId, reverse: can(user.role, "expense:void") }} /></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
            <Pagination page={list.page} pageCount={list.pageCount} total={list.total} hrefFor={href} />
          </>
        )}
      </Card>
    </div>
  );
}
