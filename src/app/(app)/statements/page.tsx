import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { Download } from "lucide-react";
import { requirePagePermission } from "@/server/auth/current";
import { STATEMENT_DISCLAIMER, getCashFlow, getFinanceWarnings, getIncomeStatement } from "@/server/services/finance-statements";
import { getBalanceSheet, getGeneralLedger, getGlIncomeStatement, getTrialBalance } from "@/server/services/finance-ledger";
import { listCoaAccounts } from "@/server/services/finance-coa";
import { env } from "@/server/env";
import { Card, CardHeader, Notice, PageHeader } from "@/components/ui/card";
import { FilterBar, FilterField, filterInput } from "@/components/filter-bar";
import { buildQuery } from "@/lib/invoice-can";
import { formatRupiah } from "@/lib/finance/money";
import { formatDateLong, formatDateShort, todayIso } from "@/lib/format";
import { isoDate } from "@/lib/validation/common";
import { AppError } from "@/server/errors";
import { cn } from "@/lib/cn";
import type { GlLineItem } from "@/lib/accounting/ledger";
import type { Line } from "@/lib/accounting/statements";

export const metadata: Metadata = { title: "Laporan Keuangan" };
export const dynamic = "force-dynamic";

const TYPES = ["income-statement", "cash-flow", "balance-sheet", "trial-balance", "general-ledger"] as const;
const LABEL: Record<(typeof TYPES)[number], string> = { "income-statement": "Laba Rugi", "cash-flow": "Arus Kas", "balance-sheet": "Neraca", "trial-balance": "Neraca Saldo", "general-ledger": "Buku Besar" };
const schema = z.object({ type: z.enum(TYPES).default("income-statement"), from: isoDate.optional(), to: isoDate.optional(), accountId: z.string().uuid().optional() });
const R = (n: number) => formatRupiah(n, "PLAIN");

function Row({ label, value, strong, indent, rule }: { label: string; value?: number; strong?: boolean; indent?: boolean; rule?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 py-1.5 text-sm", indent && "pl-5", strong && "font-semibold", rule && "border-t border-ink/30")}>
      <dt className={cn(!strong && "text-ink-soft")}>{label}</dt>
      {value !== undefined && <dd className={cn("tabular", value < 0 && "text-brand-700")}>{R(value)}</dd>}
    </div>
  );
}
const Lines = ({ lines }: { lines: (Line | GlLineItem)[] }) => <>{lines.map((l) => <Row key={`${l.code}${l.name}`} indent label={`${l.code ? `${l.code} ` : ""}${l.name}`} value={l.amount} />)}</>;

export default async function StatementsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePagePermission("finance:view");
  const sp = await searchParams;
  const f = schema.safeParse(Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v))).data ?? { type: "income-statement" as const };
  const today = todayIso(env().APP_TIMEZONE);
  const to = f.to ?? today;
  const from = f.from ?? `${to.slice(0, 4)}-01-01`;
  const q = { from, to };
  const asOfOnly = f.type === "balance-sheet" || f.type === "trial-balance";
  let error: string | null = null;
  let cf = null, pl = null, bs = null, tb = null, gl = null, vatNote = 0, whNote = 0;
  const accounts = f.type === "general-ledger" ? await listCoaAccounts(user) : [];
  try {
    if (f.type === "cash-flow") cf = await getCashFlow(user, q);
    else if (f.type === "income-statement") { pl = await getGlIncomeStatement(user, q); const s1 = await getIncomeStatement(user, q); vatNote = s1.vatCollected; whNote = s1.withheldByCustomers; }
    else if (f.type === "balance-sheet") bs = await getBalanceSheet(user, { to });
    else if (f.type === "trial-balance") tb = await getTrialBalance(user, { to });
    else if (f.accountId) gl = await getGeneralLedger(user, { accountId: f.accountId, ...q });
  } catch (e) { if (e instanceof AppError) error = e.message; else throw e; }
  const warnings = await getFinanceWarnings(user);
  const exp = (format: "csv" | "xlsx") => `/api/finance/statements/${f.type}${buildQuery({ ...q, accountId: f.accountId, format })}`;
  const tab = (id: (typeof TYPES)[number]) => (
    <Link key={id} href={`/statements${buildQuery({ type: id, ...q, accountId: f.accountId })}`} aria-current={f.type === id ? "page" : undefined}
      className={cn("rounded-md px-3 py-1.5 text-sm font-medium", f.type === id ? "bg-ink text-white" : "text-ink-soft hover:bg-black/5")}>{LABEL[id]}</Link>
  );
  return (
    <div>
      <PageHeader title="Laporan Keuangan" description="Basis kas dari buku besar: pendapatan diakui saat uang diterima, beban saat dibayar. Hanya entri yang sudah berlaku (disetujui) yang dihitung."
        actions={!error && (f.type !== "general-ledger" || f.accountId) && <>
          <a href={exp("csv")} className="inline-flex h-10 items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-medium shadow-sm hover:bg-canvas"><Download className="size-4" />CSV</a>
          <a href={exp("xlsx")} className="inline-flex h-10 items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-medium shadow-sm hover:bg-canvas"><Download className="size-4" />Excel</a>
        </>} />
      <nav aria-label="Jenis laporan" className="mb-4 flex flex-wrap gap-2 border-b border-line pb-3">{TYPES.map(tab)}</nav>
      <FilterBar action="/statements" resetHref={`/statements?type=${f.type}`}>
        <input type="hidden" name="type" value={f.type} />
        {!asOfOnly && <FilterField label="Dari tanggal"><input type="date" name="from" defaultValue={from} className={filterInput} /></FilterField>}
        <FilterField label={asOfOnly ? "Per tanggal" : "Sampai tanggal"}><input type="date" name="to" defaultValue={to} max={today} className={filterInput} /></FilterField>
        {f.type === "general-ledger" && (
          <FilterField label="Akun">
            <select name="accountId" defaultValue={f.accountId ?? ""} className={cn(filterInput, "min-w-64")}>
              <option value="">Pilih akun…</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
            </select>
          </FilterField>
        )}
      </FilterBar>
      {error && <Notice tone="danger">{error}</Notice>}
      {warnings.unallocatedPayments > 0 && <div className="mb-3"><Notice tone="warn">{warnings.unallocatedPayments} pembayaran invoice belum dialokasikan ke akun kas/bank — dihitung sebagai pendapatan dan tampil di neraca sebagai <em>Penerimaan Invoice Belum Dialokasikan</em> (1-1450), bukan saldo kas.</Notice></div>}
      {warnings.pendingExpenses > 0 && <div className="mb-3"><Notice tone="info">{warnings.pendingExpenses} pengeluaran masih menunggu persetujuan dan belum dihitung.</Notice></div>}

      {pl && (
        <Card>
          <CardHeader title="Laporan Laba Rugi (Basis Kas)" description={`${formatDateLong(pl.from)} – ${formatDateLong(pl.to)}`} />
          <dl className="max-w-3xl px-5 py-4">
            <Row strong label="Pendapatan usaha" />
            <Lines lines={pl.revenue} />
            <Row label="Jumlah pendapatan usaha" value={pl.totalRevenue} rule />
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
            <Row strong label="Laba (rugi) bersih sebelum pajak penghasilan" value={pl.profitBeforeTax} rule />
            {pl.incomeTax.length > 0 && <><Row strong label="Beban pajak penghasilan" /><Lines lines={pl.incomeTax} /><Row strong label="Laba (rugi) bersih setelah pajak penghasilan" value={pl.netProfit} rule /></>}
          </dl>
          {(vatNote !== 0 || whNote !== 0) && (
            <p className="border-t border-line px-5 py-3 text-xs text-muted">
              {vatNote !== 0 && <>PPN yang diterima pada periode ini ({R(vatNote)}) dikeluarkan dari pendapatan dan dicatat sebagai utang PPN (2-1210). </>}
              {whNote !== 0 && <>PPh yang dipotong pelanggan ({R(whNote)}) termasuk pendapatan dan dicatat sebagai kredit pajak (1-1400), bukan uang masuk.</>}
            </p>
          )}
        </Card>
      )}

      {bs && (
        <Card>
          <CardHeader title="Laporan Posisi Keuangan / Neraca (Basis Kas)" description={`Per ${formatDateLong(bs.asOf)}`} />
          <div className="grid gap-x-10 px-5 py-4 lg:grid-cols-2">
            <dl>
              <Row strong label="ASET" />
              <Row label="Aset lancar" strong />
              <Lines lines={bs.currentAssets} />
              {bs.fixedAssets.length > 0 && <><Row label="Aset tetap" strong /><Lines lines={bs.fixedAssets} /></>}
              {bs.otherAssets.length > 0 && <><Row label="Aset lainnya" strong /><Lines lines={bs.otherAssets} /></>}
              <Row strong label="Jumlah aset" value={bs.totalAssets} rule />
            </dl>
            <dl>
              <Row strong label="LIABILITAS" />
              {bs.shortTermLiabilities.length > 0 && <><Row label="Liabilitas jangka pendek" strong /><Lines lines={bs.shortTermLiabilities} /></>}
              {bs.longTermLiabilities.length > 0 && <><Row label="Liabilitas jangka panjang" strong /><Lines lines={bs.longTermLiabilities} /></>}
              {bs.otherLiabilities.length > 0 && <Lines lines={bs.otherLiabilities} />}
              <Row strong label="Jumlah liabilitas" value={bs.totalLiabilities} rule />
              <Row strong label="EKUITAS" />
              <Lines lines={bs.equity} />
              <Row indent label="Saldo laba tahun-tahun sebelumnya (hasil usaha)" value={bs.retainedEarningsPrior} />
              <Row indent label="Laba (rugi) tahun berjalan" value={bs.currentYearProfit} />
              <Row strong label="Jumlah ekuitas" value={bs.totalEquity} rule />
              <Row strong label="Jumlah liabilitas dan ekuitas" value={bs.totalLiabilities + bs.totalEquity} rule />
            </dl>
          </div>
          <p className={cn("border-t border-line px-5 py-3 text-sm", bs.balanced ? "text-emerald-700" : "font-semibold text-brand-700")} role="status">
            {bs.balanced ? "Neraca seimbang ✓ (aset = liabilitas + ekuitas)" : `NERACA TIDAK SEIMBANG — selisih ${R(bs.difference)}. Hubungi Administrator.`}
          </p>
        </Card>
      )}

      {tb && (
        <Card>
          <CardHeader title="Neraca Saldo" description={`Per ${formatDateLong(tb.asOf)} — total debit harus sama dengan total kredit`} />
          <div className="overflow-x-auto px-5 py-4">
            <table className="w-full min-w-[40rem] text-sm">
              <thead><tr className="text-left text-xs uppercase tracking-wide text-muted"><th className="py-1 pr-3">Kode</th><th className="py-1 pr-3">Akun</th><th className="py-1 pr-3 text-right">Debit</th><th className="py-1 text-right">Kredit</th></tr></thead>
              <tbody>
                {tb.rows.map((r) => (
                  <tr key={r.accountId} className="border-t border-line/60"><td className="py-1.5 pr-3 font-mono text-xs">{r.code}</td><td className="py-1.5 pr-3">{r.name}</td><td className="tabular py-1.5 pr-3 text-right">{r.debit ? R(r.debit) : ""}</td><td className="tabular py-1.5 text-right">{r.credit ? R(r.credit) : ""}</td></tr>
                ))}
                <tr className="border-t-2 border-ink/30 font-semibold"><td /><td className="py-2">Total</td><td className="tabular py-2 pr-3 text-right">{R(tb.totalDebit)}</td><td className="tabular py-2 text-right">{R(tb.totalCredit)}</td></tr>
              </tbody>
            </table>
          </div>
          <p className={cn("border-t border-line px-5 py-3 text-sm", tb.balanced ? "text-emerald-700" : "font-semibold text-brand-700")} role="status">{tb.balanced ? "Seimbang ✓" : "TIDAK SEIMBANG — hubungi Administrator"}</p>
        </Card>
      )}

      {f.type === "general-ledger" && !f.accountId && !error && <Notice tone="info">Pilih akun untuk melihat buku besarnya.</Notice>}
      {gl && (
        <Card>
          <CardHeader title={`Buku Besar — ${gl.account.code} ${gl.account.name}`} description={`${formatDateLong(gl.from)} – ${formatDateLong(gl.to)} · saldo menurut sisi normal akun`} />
          <div className="overflow-x-auto px-5 py-4">
            <table className="w-full min-w-[48rem] text-sm">
              <thead><tr className="text-left text-xs uppercase tracking-wide text-muted"><th className="py-1 pr-3">Tanggal</th><th className="py-1 pr-3">Sumber</th><th className="py-1 pr-3">Uraian</th><th className="py-1 pr-3 text-right">Debit</th><th className="py-1 pr-3 text-right">Kredit</th><th className="py-1 text-right">Saldo</th></tr></thead>
              <tbody>
                <tr className="bg-canvas/60"><td className="py-1.5 pr-3">{formatDateShort(gl.from)}</td><td colSpan={4} className="italic text-muted">Saldo awal periode</td><td className="tabular py-1.5 text-right font-medium">{R(gl.opening)}</td></tr>
                {gl.rows.map((r, i) => (
                  <tr key={i} className="border-t border-line/60"><td className="py-1.5 pr-3">{formatDateShort(r.date)}</td><td className="py-1.5 pr-3">{r.sourceLabel}</td><td className="py-1.5 pr-3 max-w-md">{r.description}</td><td className="tabular py-1.5 pr-3 text-right">{r.debit ? R(r.debit) : ""}</td><td className="tabular py-1.5 pr-3 text-right">{r.credit ? R(r.credit) : ""}</td><td className="tabular py-1.5 text-right font-medium">{R(r.balance)}</td></tr>
                ))}
                <tr className="border-t-2 border-ink/30 font-semibold"><td /><td /><td className="py-2">Total & saldo akhir</td><td className="tabular py-2 pr-3 text-right">{R(gl.totalDebit)}</td><td className="tabular py-2 pr-3 text-right">{R(gl.totalCredit)}</td><td className="tabular py-2 text-right">{R(gl.closing)}</td></tr>
              </tbody>
            </table>
          </div>
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
