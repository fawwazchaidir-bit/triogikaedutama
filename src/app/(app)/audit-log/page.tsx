import type { Metadata } from "next";
import { requirePagePermission } from "@/server/auth/current";
import { auditQuerySchema, listAuditLogs } from "@/server/services/audit";
import { Card, EmptyState, Notice, PageHeader } from "@/components/ui/card";
import { FilterBar, FilterField, filterInput } from "@/components/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { buildQuery } from "@/lib/invoice-can";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Audit Log" };
export const dynamic = "force-dynamic";

const ENTITIES = ["Invoice", "Customer", "Product", "TaxConfiguration", "BankAccount", "CompanySettings", "InvoiceNumberSequence", "User", "StoredFile", "Export"];

export default async function AuditLogPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePagePermission("audit:view");
  const sp = Object.fromEntries(Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v));
  const parsed = auditQuerySchema.safeParse(sp);
  const f = parsed.success ? parsed.data : {};
  const list = await listAuditLogs(user, f);
  return (
    <div>
      <PageHeader title="Audit Log" description="Jejak tindakan penting: siapa, kapan, apa, sebelum & sesudah. Catatan bersifat append-only (tidak dapat diubah atau dihapus, juga di level database)." />
      {!parsed.success && <div className="mb-4"><Notice tone="warn">Filter tidak valid; menampilkan semua catatan.</Notice></div>}
      <FilterBar action="/audit-log" resetHref="/audit-log">
        <FilterField label="Cari ringkasan / email / alasan"><input type="search" name="q" defaultValue={f.q} className={cn(filterInput, "w-56")} /></FilterField>
        <FilterField label="Aksi (awalan)"><input name="action" defaultValue={f.action} placeholder="mis. invoice. / payment." className={cn(filterInput, "w-40")} /></FilterField>
        <FilterField label="Objek"><select name="entityType" defaultValue={f.entityType ?? ""} className={filterInput}><option value="">Semua</option>{ENTITIES.map((e) => <option key={e}>{e}</option>)}</select></FilterField>
        <FilterField label="Dari"><input type="date" name="from" defaultValue={f.from} className={filterInput} /></FilterField>
        <FilterField label="Sampai"><input type="date" name="to" defaultValue={f.to} className={filterInput} /></FilterField>
      </FilterBar>
      <Card>
        {list.items.length === 0 ? <EmptyState title="Tidak ada catatan" /> : (
          <TableWrap>
            <Table>
              <thead><tr><Th>Waktu</Th><Th>Pelaku</Th><Th>Aksi</Th><Th>Ringkasan</Th><Th>Detail</Th></tr></thead>
              <tbody>
                {list.items.map((l) => (
                  <tr key={l.id} className="hover:bg-canvas/60">
                    <Td className="whitespace-nowrap">{formatDateTime(l.createdAt)}</Td>
                    <Td>{l.actorName ?? l.actorEmail ?? "sistem"}{l.actorRole && <span className="block text-xs text-muted">{l.actorRole}</span>}</Td>
                    <Td mono>{l.action}</Td>
                    <Td className="max-w-md">{l.summary ?? "—"}{l.reason && <span className="block text-xs text-muted">Alasan: {l.reason}</span>}</Td>
                    <Td>
                      {(l.before !== null || l.after !== null) ? (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-brand-700">Sebelum / sesudah</summary>
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            <pre className="max-h-48 overflow-auto rounded bg-canvas p-2">{JSON.stringify(l.before, null, 2) ?? "—"}</pre>
                            <pre className="max-h-48 overflow-auto rounded bg-canvas p-2">{JSON.stringify(l.after, null, 2) ?? "—"}</pre>
                          </div>
                        </details>
                      ) : "—"}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
        <Pagination page={list.page} pageCount={list.pageCount} total={list.total} hrefFor={(p) => `/audit-log${buildQuery({ ...f, page: p })}`} />
      </Card>
    </div>
  );
}
