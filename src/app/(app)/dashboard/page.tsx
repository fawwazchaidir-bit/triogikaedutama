import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/server/auth/current";
import { getDashboard, dashboardQuerySchema } from "@/server/services/dashboard";
import { listCustomers } from "@/server/services/customers";
import { Card, CardHeader, Notice, PageHeader } from "@/components/ui/card";
import { FilterBar, FilterField, filterInput } from "@/components/filter-bar";
import { TrendChart } from "@/components/trend-chart";
import { formatRupiah } from "@/lib/finance/money";
import { formatDateLong, todayIso } from "@/lib/format";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function Tile({ label, value, hint, href, tone }: { label: string; value: string; hint?: string; href?: string; tone?: "red" }) {
  const body = (
    <div className={cn("h-full rounded-lg border border-line bg-surface p-4 shadow-sm transition-colors", href && "hover:border-brand-200 hover:bg-brand-50/30")}>
      <p className="text-sm text-muted">{label}</p>
      <p className={cn("tabular mt-1 text-2xl font-semibold tracking-tight", tone === "red" ? "text-brand-700" : "text-ink")}>{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
  return href ? <Link href={href} className="block">{body}</Link> : body;
}

export default async function DashboardPage({ searchParams }: { searchParams: SP }) {
  const user = await requirePagePermission("dashboard:view");
  const sp = await searchParams;
  const raw = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, first(v)]).filter(([, v]) => v));
  const parsed = dashboardQuerySchema.safeParse(raw);
  let error: string | null = null;
  let dash: Awaited<ReturnType<typeof getDashboard>> | null = null;
  try {
    dash = await getDashboard(user, parsed.success ? parsed.data : {});
  } catch (e) {
    error = e instanceof AppError ? e.message : "Gagal memuat dashboard.";
  }
  const customers = await listCustomers(user, { status: "all", pageSize: 100 });
  const f = parsed.success ? parsed.data : {};
  const today = todayIso(env().APP_TIMEZONE);
  const yr = today.slice(0, 4);

  const q = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ ...(dash ? { from: dash.period.from, to: dash.period.to } : {}), ...(f.customerId ? { customerId: f.customerId } : {}), ...extra });
    return `/invoices?${p.toString()}`;
  };
  const R = (n: number) => formatRupiah(n, "PLAIN");

  return (
    <div>
      <PageHeader title="Dashboard" description="Gambaran penagihan & piutang. Semua angka dihitung langsung dari database." />

      <div className="mb-3 flex flex-wrap gap-2 text-sm">
        {[
          ["Bulan ini", `${today.slice(0, 7)}-01`, today],
          ["30 hari terakhir", new Date(Date.parse(today) - 29 * 86_400_000).toISOString().slice(0, 10), today],
          ["Tahun ini", `${yr}-01-01`, today],
          ["Tahun lalu", `${Number(yr) - 1}-01-01`, `${Number(yr) - 1}-12-31`],
        ].map(([label, from, to]) => (
          <Link key={label} href={`/dashboard?from=${from}&to=${to}`} className="rounded-full border border-line bg-white px-3 py-1 text-ink-soft hover:bg-canvas">{label}</Link>
        ))}
      </div>

      <FilterBar action="/dashboard" resetHref="/dashboard">
        <FilterField label="Dari tanggal"><input type="date" name="from" defaultValue={dash?.period.from} className={filterInput} /></FilterField>
        <FilterField label="Sampai tanggal"><input type="date" name="to" defaultValue={dash?.period.to} className={filterInput} /></FilterField>
        <FilterField label="Pelanggan">
          <select name="customerId" defaultValue={f.customerId ?? ""} className={cn(filterInput, "min-w-44")}>
            <option value="">Semua pelanggan</option>
            {customers.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </FilterField>
        <FilterField label="Status invoice">
          <select name="status" defaultValue={f.status ?? ""} className={filterInput}>
            <option value="">Semua</option><option value="ISSUED">Diterbitkan</option><option value="SUBMITTED">Menunggu verifikasi</option><option value="DRAFT">Draft</option><option value="CANCELLED">Dibatalkan</option>
          </select>
        </FilterField>
        <FilterField label="Status pembayaran">
          <select name="paymentStatus" defaultValue={f.paymentStatus ?? ""} className={filterInput}>
            <option value="">Semua</option><option value="UNPAID">Belum dibayar</option><option value="PARTIALLY_PAID">Dibayar sebagian</option>
            <option value="PAID">Lunas</option><option value="OVERDUE">Jatuh tempo</option>
          </select>
        </FilterField>
        <FilterField label="Nomor invoice"><input type="search" name="q" defaultValue={f.q} placeholder="mis. 00434" className={cn(filterInput, "w-32")} /></FilterField>
      </FilterBar>

      {error && <Notice tone="danger">{error}</Notice>}
      {dash && (
        <>
          <p className="mb-3 text-sm text-muted">Periode {formatDateLong(dash.period.from)} – {formatDateLong(dash.period.to)}</p>

          <section aria-label="Ringkasan keuangan" className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Tile label="Nilai invoice terbit" value={R(dash.invoicedAmount)} hint={`${dash.issuedCount} invoice · menurut tanggal invoice`} href={q({ status: "ISSUED" })} />
            <Tile label="Penerimaan kas" value={R(dash.receivedAmount)} hint="Pembayaran masuk (termasuk DP), menurut tanggal bayar" href="/payments" />
            <Tile label="Piutang belum dibayar" value={R(dash.outstandingAmount)} hint="Sisa tagihan invoice terbit pada periode ini" href={q({ status: "ISSUED" })} tone={dash.outstandingAmount > 0 ? "red" : undefined} />
          </section>

          <section aria-label="Sebaran status" className="mb-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-7">
            <Tile label="Belum dibayar" value={String(dash.unpaidCount)} href={q({ paymentStatus: "UNPAID" })} />
            <Tile label="Dibayar sebagian" value={String(dash.partialCount)} href={q({ paymentStatus: "PARTIALLY_PAID" })} />
            <Tile label="Lunas" value={String(dash.paidCount)} href={q({ paymentStatus: "PAID" })} />
            <Tile label="Jatuh tempo" value={String(dash.overdueCount)} hint={dash.overdueCount ? `${R(dash.overdueAmount)} belum dibayar` : undefined} href={q({ paymentStatus: "OVERDUE" })} tone={dash.overdueCount ? "red" : undefined} />
            <Tile label="Dibatalkan" value={String(dash.cancelledCount)} href={q({ status: "CANCELLED" })} />
            <Tile label="Menunggu verifikasi" value={String(dash.pendingCount)} hint={dash.pendingCount ? "Perlu persetujuan Finance Manager" : undefined} href={q({ status: "SUBMITTED" })} tone={dash.pendingCount ? "red" : undefined} />
            <Tile label="Draft" value={String(dash.draftCount)} href={q({ status: "DRAFT" })} />
          </section>

          <section aria-label="Kalender" className="mb-4 grid gap-3 sm:grid-cols-2">
            <Tile label="Nilai invoice bulan berjalan" value={R(dash.monthInvoiced)} hint={`Bulan ${today.slice(0, 7)}`} />
            <Tile label="Nilai invoice tahun berjalan" value={R(dash.yearInvoiced)} hint={`Tahun ${yr}`} />
          </section>

          <Card className="mb-4">
            <CardHeader title="Tren per bulan" description="Nilai invoice terbit dan penerimaan kas pada periode terpilih." />
            <div className="p-5"><TrendChart data={dash.trend} /></div>
          </Card>

          <Card>
            <details>
              <summary className="cursor-pointer px-5 py-3 text-sm font-medium text-ink-soft">Definisi angka (agar tidak terjadi hitung ganda)</summary>
              <dl className="grid gap-3 px-5 pb-5 text-sm text-ink-soft sm:grid-cols-3">
                <div><dt className="font-semibold text-ink">Nilai invoice</dt><dd>Total invoice berstatus <em>Diterbitkan</em>. Draft, invoice menunggu verifikasi, dan invoice batal tidak dihitung. DP/pembayaran <strong>tidak</strong> mengurangi nilai ini.</dd></div>
                <div><dt className="font-semibold text-ink">Penerimaan kas</dt><dd>Jumlah baris pembayaran (termasuk DP, dikurangi pembalikan) menurut tanggal bayar. Satu rupiah hanya dihitung sekali.</dd></div>
                <div><dt className="font-semibold text-ink">Piutang</dt><dd>Nilai invoice terbit dikurangi pembayaran yang tercatat. Invoice lunas bernilai 0 namun tetap ada di histori.</dd></div>
              </dl>
              <p className="border-t border-line px-5 py-3 text-xs text-muted">Ini ringkasan operasional penagihan, bukan laporan akuntansi (tanpa jurnal atau pengakuan pendapatan).</p>
            </details>
          </Card>
        </>
      )}
    </div>
  );
}
