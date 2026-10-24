import type { Metadata } from "next";
import Link from "next/link";
import { Download } from "lucide-react";
import { requirePageUser } from "@/server/auth/current";
import { REPORT_META, REPORT_TYPES, reportQuerySchema, runReport, type ReportType } from "@/server/services/reports";
import { listCustomers } from "@/server/services/customers";
import { Card, CardHeader, EmptyState, Notice, PageHeader } from "@/components/ui/card";
import { FilterBar, FilterField, filterInput } from "@/components/filter-bar";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { buildQuery } from "@/lib/invoice-can";
import { formatRupiah, formatNumberId } from "@/lib/finance/money";
import { formatDateShort, formatDateTime, todayIso } from "@/lib/format";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Laporan" };
export const dynamic = "force-dynamic";

const GROUPS: { label: string; types: ReportType[] }[] = [
  { label: "Penerbitan invoice", types: ["invoices", "by-customer", "by-product", "paid", "cancelled"] },
  { label: "Penerimaan kas", types: ["payments", "monthly"] },
  { label: "Piutang", types: ["receivables", "overdue"] },
];

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePageUser();
  const sp = Object.fromEntries(Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v)) as Record<string, string>;
  const type = ((REPORT_TYPES as readonly string[]).includes(sp.type ?? "") ? sp.type : "invoices") as ReportType;
  const parsed = reportQuerySchema.safeParse(sp);
  const filters = parsed.success ? parsed.data : {};
  let error: string | null = parsed.success ? null : "Filter tidak valid.";
  let table: Awaited<ReturnType<typeof runReport>> | null = null;
  try {
    table = await runReport(user, type, filters);
  } catch (e) {
    error = e instanceof AppError ? e.message : "Gagal membuat laporan.";
  }
  const customers = await listCustomers(user, { status: "all", pageSize: 100 });
  const asOf = type === "receivables" || type === "overdue";
  const today = todayIso(env().APP_TIMEZONE);
  const exportHref = (format: "csv" | "xlsx") => `/api/reports/${type}${buildQuery({ ...filters, format })}`;

  return (
    <div>
      <PageHeader title="Laporan" description="Laporan operasional penagihan. Laporan penerbitan invoice dan penerimaan kas dipisahkan dan tidak boleh dijumlahkan." />
      <nav aria-label="Jenis laporan" className="mb-4 space-y-2">
        {GROUPS.map((g) => (
          <div key={g.label} className="flex flex-wrap items-center gap-2">
            <span className="w-36 text-xs font-semibold uppercase tracking-wide text-muted">{g.label}</span>
            {g.types.map((t) => (
              <Link key={t} href={`/reports${buildQuery({ ...filters, type: t })}`} aria-current={t === type ? "page" : undefined}
                className={cn("rounded-full border px-3 py-1 text-sm", t === type ? "border-brand-600 bg-brand-600 text-white" : "border-line bg-white text-ink-soft hover:bg-canvas")}>
                {REPORT_META[t].title}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      <FilterBar action="/reports" resetHref={`/reports?type=${type}`}>
        <input type="hidden" name="type" value={type} />
        {!asOf && <>
          <FilterField label="Dari tanggal"><input type="date" name="from" defaultValue={filters.from ?? `${today.slice(0, 4)}-01-01`} className={filterInput} /></FilterField>
          <FilterField label="Sampai tanggal"><input type="date" name="to" defaultValue={filters.to ?? today} className={filterInput} /></FilterField>
        </>}
        <FilterField label="Pelanggan">
          <select name="customerId" defaultValue={filters.customerId ?? ""} className={cn(filterInput, "min-w-48")}>
            <option value="">Semua pelanggan</option>{customers.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </FilterField>
      </FilterBar>

      {error && <div className="mb-4"><Notice tone="danger">{error}</Notice></div>}
      {table && (
        <Card>
          <CardHeader title={table.title} description={`${table.description} · Periode: ${table.periodLabel}`}
            actions={<>
              <a href={exportHref("csv")} className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-medium hover:bg-canvas"><Download className="size-4" />CSV</a>
              <a href={exportHref("xlsx")} className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-medium hover:bg-canvas"><Download className="size-4" />Excel</a>
            </>} />
          {table.rows.length === 0 ? <EmptyState title="Tidak ada data" description="Tidak ada transaksi pada periode/filter ini." /> : (
            <TableWrap>
              <Table>
                <thead><tr>{table.columns.map((c) => <Th key={c.key} align={c.type === "money" || c.type === "number" ? "right" : "left"}>{c.label}</Th>)}</tr></thead>
                <tbody>
                  {table.rows.map((r, i) => {
                    const isYear = typeof r[table.columns[0]!.key] === "string" && String(r[table.columns[0]!.key]).startsWith("TOTAL");
                    return (
                      <tr key={i} className={cn("hover:bg-canvas/60", isYear && "bg-canvas font-semibold")}>
                        {table.columns.map((c) => {
                          const v = r[c.key];
                          const shown = v === null || v === undefined ? "—" : c.type === "money" ? formatRupiah(Number(v), "PLAIN") : c.type === "number" ? formatNumberId(Number(v)) : c.type === "date" ? formatDateShort(String(v)) : c.type === "datetime" ? formatDateTime(String(v)) : String(v);
                          return <Td key={c.key} align={c.type === "money" || c.type === "number" ? "right" : "left"}>{shown}</Td>;
                        })}
                      </tr>
                    );
                  })}
                  {table.totals && (
                    <tr className="bg-canvas font-semibold">
                      {table.columns.map((c, i) => {
                        const v = table.totals![c.key];
                        const shown = v === null || v === undefined ? (i === 0 ? "TOTAL" : "") : c.type === "money" ? formatRupiah(Number(v), "PLAIN") : c.type === "number" ? formatNumberId(Number(v)) : String(v);
                        return <Td key={c.key} align={c.type === "money" || c.type === "number" ? "right" : "left"}>{shown}</Td>;
                      })}
                    </tr>
                  )}
                </tbody>
              </Table>
            </TableWrap>
          )}
          <p className="border-t border-line px-5 py-3 text-xs text-muted">{table.disclaimer} Dibuat {formatDateTime(table.generatedAt)}.</p>
        </Card>
      )}
    </div>
  );
}
