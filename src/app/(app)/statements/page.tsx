import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { Download } from "lucide-react";
import { requirePagePermission } from "@/server/auth/current";
import { STATEMENT_DISCLAIMER, getCashFlow, getFinanceWarnings, getIncomeStatement } from "@/server/services/finance-statements";
import { env } from "@/server/env";
import { Card, CardHeader, Notice, PageHeader } from "@/components/ui/card";
import { FilterBar, FilterField, filterInput } from "@/components/filter-bar";
import { buildQuery } from "@/lib/invoice-can";
import { formatRupiah } from "@/lib/finance/money";
import { formatDateLong, todayIso } from "@/lib/format";
import { isoDate } from "@/lib/validation/common";
import { AppError } from "@/server/errors";
import { cn } from "@/lib/cn";
import type { Line } from "@/lib/accounting/statements";

export const metadata: Metadata = { title: "Laporan Keuangan" };
export const dynamic = "force-dynamic";

const schema = z.object({ type: z.enum(["cash-flow", "income-statement"]).default("income-statement"), from: isoDate.optional(), to: isoDate.optional() });
const R = (n: number) => formatRupiah(n, "PLAIN");

function Row({ label, value, strong, indent, rule }: { label: string; value?: number; strong?: boolean; indent?: boolean; rule?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 py-1.5 text-sm", indent && "pl-5", strong && "font-semibold", rule && "border-t border-ink/30")}>
      <dt className={cn(!strong && "text-ink-soft")}>{label}</dt>
      {value !== undefined && <dd className={cn("tabular", value < 0 && "text-brand-700")}>{R(value)}</dd>}
    </div>
  );
}
const Lines = ({ lines }: { lines: Line[] }) => <>{lines.map((l) => <Row key={`${l.code}${l.name}`} indent label={`${l.code ? `${l.code} ` : ""}${l.name}`} value={l.amount} />)}</>;

export default async function StatementsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePagePermission("finance:view");
  const sp = await searchParams;
  const f = schema.safeParse(Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v))).data ?? { type: "income-statement" as const };
  const today = todayIso(env().APP_TIMEZONE);
  const from = f.from ?? `${today.slice(0, 4)}-01-01`;
  const to = f.to ?? today;
  const q = { from, to };
  let error: string | null = null;
  let cf = null, pl = null;
  try {
    if (f.type === "cash-flow") cf = await getCashFlow(user, q); else pl = await getIncomeStatement(user, q);
  } catch (e) { if (e instanceof AppError) error = e.message; else throw e; }
  const warnings = await getFinanceWarnings(user);
  const exp = (format: "csv" | "xlsx") => `/api/finance/statements/${f.type}${buildQuery({ ...q, format })}`;
  const tab = (id: string, label: string) => (
    <Link href={`/statements${buildQuery({ type: id, ...q })}`} aria-current={f.type === id ? "page" : undefined}
      className={cn("rounded-md px-3 py-1.5 text-sm font-medium", f.type === id ? "bg-ink text-white" : "text-ink-soft hover:bg-black/5")}>{label}</Link>
  );
  return (
    <div>
      <PageHeader title="Laporan Keuangan" description="Basis kas: pendapatan diakui saat uang diterima, beban saat dibayar. Hanya entri yang sudah berlaku (disetujui) yang dihitung."
        actions={!error && <>
          <a href={exp("csv")} className="inline-flex h-10 items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-medium shadow-sm hover:bg-canvas"><Download className="size-4" />CSV</a>
          <a href={exp("xlsx")} className="inline-flex h-10 items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-medium shadow-sm hover:bg-canvas"><Download className="size-4" />Excel</a>
        </>} />
      <nav aria-label="Jenis laporan" className="mb-4 flex flex-wrap gap-2 border-b border-line pb-3">{tab("income-statement", "Laba Rugi")}{tab("cash-flow", "Arus Kas")}</nav>
      <FilterBar action="/statements" resetHref={`/statements?type=${f.type}`}>
        <input type="hidden" name="type" value={f.type} />
        <FilterField label="Dari tanggal"><input type="date" name="from" defaultValue={from} className={filterInput} /></FilterField>
        <FilterField label="Sampai tanggal"><input type="date" name="to" defaultValue={to} max={today} className={filterInput} /></FilterField>
      </FilterBar>
      {error && <Notice tone="danger">{error}</Notice>}
      {warnings.unallocatedPayments > 0 && <div className="mb-3"><Notice tone="warn">{warnings.unallocatedPayments} pembayaran invoice belum dialokasikan ke akun kas/bank — dihitung sebagai pendapatan tetapi tidak masuk saldo kas.</Notice></div>}
      {warnings.pendingExpenses > 0 && <div className="mb-3"><Notice tone="info">{warnings.pendingExpenses} pengeluaran masih menunggu persetujuan dan belum dihitung.</Notice></div>}

      {pl && (
        <Card>
          <CardHeader title="Laporan Laba Rugi (Basis Kas)" description={`${formatDateLong(pl.from)} – ${formatDateLong(pl.to)}`} />
          <dl className="max-w-3xl px-5 py-4">
            <Row strong label="Pendapatan usaha (penerimaan invoice, neto pembalikan)" value={pl.revenue} />
            <Row strong label="Beban langsung program" />
            <Lines lines={pl.directCosts} />
            <Row label="Jumlah beban langsung program" value={pl.totalDirectCosts} rule />
            <Row strong label="Laba kotor program" value={pl.grossProfit} rule />
            <Row strong label="Beban operasional" />
            <Lines lines={pl.operatingCosts} />
            <Row label="Jumlah beban operasional" value={pl.totalOperatingCosts} rule />
            <Row strong label="Laba (rugi) usaha" value={pl.operatingProfit} rule />
            <Row strong label="Pendapatan lain-lain" />
            <Lines lines={pl.otherIncome} />
            <Row strong label="Laba (rugi) bersih sebelum pajak penghasilan" value={pl.netProfitBeforeTax} rule />
          </dl>
          {pl.receiptsOnTaxedInvoices !== 0 && <p className="border-t border-line px-5 py-3 text-xs text-muted">Catatan: {R(pl.receiptsOnTaxedInvoices)} dari pendapatan berasal dari invoice yang memuat pajak; pajaknya belum dipisahkan dari pendapatan (menunggu tahap pajak).</p>}
        </Card>
      )}

      {cf && (
        <Card>
          <CardHeader title="Laporan Arus Kas (Basis Kas)" description={`${formatDateLong(cf.from)} – ${formatDateLong(cf.to)}`} />
          <dl className="max-w-3xl px-5 py-4">
            <Row strong label="Arus kas dari aktivitas operasi" />
            <Row indent label="Penerimaan dari invoice (neto pembalikan)" value={cf.operating.invoiceReceipts} />
            <Lines lines={cf.operating.otherIncome} />
            <Lines lines={cf.operating.expenses} />
            <Row strong label="Kas neto dari aktivitas operasi" value={cf.operating.net} rule />
            <Row strong label="Arus kas dari aktivitas investasi" />
            <Lines lines={cf.investing.lines} />
            <Row strong label="Kas neto dari aktivitas investasi" value={cf.investing.net} rule />
            <Row strong label="Arus kas dari aktivitas pendanaan" />
            <Lines lines={cf.financing.lines} />
            <Row strong label="Kas neto dari aktivitas pendanaan" value={cf.financing.net} rule />
            <Row strong label="Kenaikan (penurunan) kas neto" value={cf.netChange} rule />
            <Row label="Saldo kas & bank awal periode" value={cf.beginning} />
            {cf.newOpening !== 0 && <Row label="Saldo awal akun yang mulai dicatat dalam periode" value={cf.newOpening} />}
            <Row strong label="Saldo kas & bank akhir periode" value={cf.ending} rule />
          </dl>
          <div className="border-t border-line px-5 py-4">
            <h3 className="mb-2 text-sm font-semibold">Rincian per akun</h3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead><tr className="text-left text-xs uppercase tracking-wide text-muted"><th className="py-1 pr-3">Akun</th><th className="py-1 pr-3 text-right">Awal</th><th className="py-1 pr-3 text-right">Penerimaan invoice</th><th className="py-1 pr-3 text-right">Entri masuk</th><th className="py-1 pr-3 text-right">Entri keluar</th><th className="py-1 pr-3 text-right">Transfer neto</th><th className="py-1 text-right">Akhir</th></tr></thead>
                <tbody>
                  {cf.accounts.map((a) => (
                    <tr key={a.id} className="border-t border-line/60">
                      <td className="py-1.5 pr-3 font-medium">{a.name}</td><td className="tabular py-1.5 pr-3 text-right">{R(a.beginning + a.newOpening)}</td>
                      <td className="tabular py-1.5 pr-3 text-right">{R(a.invoiceReceipts)}</td><td className="tabular py-1.5 pr-3 text-right">{R(a.otherIn)}</td>
                      <td className="tabular py-1.5 pr-3 text-right">{R(-a.otherOut)}</td><td className="tabular py-1.5 pr-3 text-right">{R(a.transferIn - a.transferOut)}</td>
                      <td className="tabular py-1.5 text-right font-semibold">{R(a.ending)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {cf.notInBalances !== 0 && <p className="border-t border-line px-5 py-3 text-xs text-muted">Catatan: {R(cf.notInBalances)} penerimaan invoice dalam periode tidak masuk saldo akun mana pun (belum dialokasikan atau mendahului tanggal saldo awal akun).</p>}
        </Card>
      )}
      <p className="mt-4 max-w-3xl text-xs text-muted">{STATEMENT_DISCLAIMER}</p>
    </div>
  );
}
