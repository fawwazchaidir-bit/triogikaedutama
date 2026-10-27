import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { Download } from "lucide-react";
import { requirePagePermission } from "@/server/auth/current";
import { getCorporateTax, getTaxOverview, getVatSummary, getWithholdingRegister, listTaxPayments, TAX_DISCLAIMER } from "@/server/services/finance-tax";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { Card, CardHeader, Notice, PageHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FilterBar, FilterField, filterInput } from "@/components/filter-bar";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { PostTaxJournalButton, TaxPaymentButton, TaxProfileButton, TaxYearInputButton, WithholdingRefButton } from "@/components/tax-forms";
import { can } from "@/lib/permissions";
import { buildQuery } from "@/lib/invoice-can";
import { formatRupiah } from "@/lib/finance/money";
import { formatDateLong, formatDateShort, todayIso } from "@/lib/format";
import { isoDate } from "@/lib/validation/common";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Pajak" };
export const dynamic = "force-dynamic";

const TABS = ["ringkasan", "ppn", "pph23", "pph-badan", "setoran"] as const;
const LABEL: Record<(typeof TABS)[number], string> = { ringkasan: "Ringkasan", ppn: "PPN", pph23: "PPh dipotong pelanggan", "pph-badan": "Estimasi PPh badan", setoran: "Setoran pajak" };
const schema = z.object({ tab: z.enum(TABS).default("ringkasan"), from: isoDate.optional(), to: isoDate.optional(), year: z.coerce.number().int().optional(), month: z.coerce.number().int().min(1).max(12).optional() });
const R = (n: number) => formatRupiah(n, "PLAIN");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "warn" }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={cn("tabular mt-1 text-xl font-semibold", tone === "warn" && "text-brand-700")}>{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export default async function TaxesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePagePermission("finance:view");
  const sp = await searchParams;
  const f = schema.safeParse(Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v))).data ?? { tab: "ringkasan" as const };
  const today = todayIso(env().APP_TIMEZONE);
  const year = f.year ?? Number(today.slice(0, 4));
  const from = f.from ?? `${(f.to ?? today).slice(0, 4)}-01-01`;
  const to = f.to ?? today;
  const canManage = can(user.role, "finance:manage");
  const canRecordCash = can(user.role, "cash:record");
  const canJournal = can(user.role, "journal:record");
  const overview = await getTaxOverview(user);
  const prof = overview.profile;
  let error: string | null = null;
  let vat = null, reg = null, corp = null, payments = null;
  try {
    if (f.tab === "ppn") vat = await getVatSummary(user, { from, to });
    else if (f.tab === "pph23") reg = await getWithholdingRegister(user, { from, to });
    else if (f.tab === "pph-badan") corp = await getCorporateTax(user, { year, month: f.month ?? (prof.regime === "FINAL" ? Number(today.slice(5, 7)) : undefined) });
    else if (f.tab === "setoran") payments = await listTaxPayments(user);
  } catch (e) { if (e instanceof AppError) error = e.message; else throw e; }

  const tab = (id: (typeof TABS)[number]) => (
    <Link key={id} href={`/taxes${buildQuery({ tab: id })}`} aria-current={f.tab === id ? "page" : undefined}
      className={cn("rounded-md px-3 py-1.5 text-sm font-medium", f.tab === id ? "bg-ink text-white" : "text-ink-soft hover:bg-black/5")}>{LABEL[id]}</Link>
  );
  const exportHref = (kind: string, format: "csv" | "xlsx", extra: Record<string, string | number | undefined>) => `/api/finance/taxes/${kind}${buildQuery({ ...extra, format })}`;
  const exportLinks = (kind: string, extra: Record<string, string | number | undefined>) => (
    <div className="flex gap-2">
      {(["csv", "xlsx"] as const).map((fmt) => (
        <a key={fmt} href={exportHref(kind, fmt, extra)} className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-medium shadow-sm hover:bg-canvas"><Download className="size-4" />{fmt === "csv" ? "CSV" : "Excel"}</a>
      ))}
    </div>
  );

  return (
    <div>
      <PageHeader title="Pajak" description="Rekap PPN, PPh yang dipotong pelanggan, estimasi PPh badan, dan setoran pajak. Estimasi manajemen dari pembukuan basis kas — bukan SPT."
        actions={<>{canManage && <TaxProfileButton profile={prof} />}{canRecordCash && <TaxPaymentButton />}</>} />
      <nav aria-label="Bagian pajak" className="mb-4 flex flex-wrap gap-2 border-b border-line pb-3">{TABS.map(tab)}</nav>
      {error && <Notice tone="danger">{error}</Notice>}

      {f.tab === "ringkasan" && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Utang PPN (2-1210)" value={R(overview.vatLiability)} hint="PPN dari penerimaan kas yang belum disetor" />
            <Stat label="PPN atas invoice belum lunas" value={R(overview.vatOnUnpaidInvoices)} hint="Sudah timbul menurut faktur, belum masuk buku kas" tone={overview.vatOnUnpaidInvoices > 0 ? "warn" : undefined} />
            <Stat label="Kredit PPh dipotong (1-1400)" value={R(overview.pphCredit)} hint={overview.withholdingMissingRef ? `${overview.withholdingMissingRef} pembayaran belum ada nomor bukti potong` : "Semua bukti potong terisi"} tone={overview.withholdingMissingRef ? "warn" : undefined} />
            <Stat label="Utang PPh badan (2-1230)" value={R(overview.pphBadanPayable)} hint="Negatif = lebih bayar" />
          </div>
          <Card>
            <CardHeader title="Profil pajak" description="Diisi Administrator. Sistem tidak mengasumsikan tarif atau aturan pajak." />
            <dl className="grid gap-3 px-5 py-4 text-sm sm:grid-cols-3">
              <div><dt className="text-muted">Status PKP</dt><dd className="font-medium">{prof.isPkp ? "PKP" : "Bukan PKP / belum diisi"}</dd></div>
              <div><dt className="text-muted">Rezim PPh badan</dt><dd className="font-medium">{prof.regime === "NONE" ? "Tidak dihitung" : prof.regime === "GENERAL" ? "Tarif umum (tahunan)" : "PPh final (bulanan)"}</dd></div>
              <div><dt className="text-muted">Tarif</dt><dd className="font-medium">{prof.rateBps === null ? "—" : `${(prof.rateBps / 100).toFixed(2)}%`}</dd></div>
            </dl>
          </Card>
          <Notice tone="info">{TAX_DISCLAIMER}</Notice>
        </div>
      )}

      {f.tab !== "ringkasan" && (f.tab === "ppn" || f.tab === "pph23") && (
        <FilterBar action="/taxes" resetHref={`/taxes?tab=${f.tab}`}>
          <input type="hidden" name="tab" value={f.tab} />
          <FilterField label="Dari tanggal"><input type="date" name="from" defaultValue={from} className={filterInput} /></FilterField>
          <FilterField label="Sampai tanggal"><input type="date" name="to" defaultValue={to} max={today} className={filterInput} /></FilterField>
        </FilterBar>
      )}

      {vat && (
        <Card>
          <CardHeader title="Rekap PPN keluaran" description={`${formatDateLong(vat.from)} – ${formatDateLong(vat.to)}${vat.isPkp ? "" : " · profil belum menandai PKP"}`} actions={exportLinks("vat", { from, to })} />
          <TableWrap>
            <Table>
              <thead><tr><Th>Masa</Th><Th align="right">Invoice ber-PPN</Th><Th align="right">DPP (invoice)</Th><Th align="right">PPN (invoice)</Th><Th align="right">PPN diterima kas</Th><Th align="right">Disetor</Th><Th align="right">Penyesuaian</Th><Th align="right">Utang PPN akhir</Th></tr></thead>
              <tbody>
                {vat.rows.map((r) => (
                  <tr key={r.month}><Td>{MONTHS[Number(r.month.slice(5)) - 1]} {r.month.slice(0, 4)}</Td><Td align="right">{r.invoiceCount}</Td><Td align="right">{R(r.invoiceBase)}</Td><Td align="right">{R(r.invoiceVat)}</Td><Td align="right">{R(r.vatReceived)}</Td><Td align="right">{R(r.vatRemitted)}</Td><Td align="right">{R(r.vatAdjustments)}</Td><Td align="right" className="font-medium">{R(r.endingLiability)}</Td></tr>
                ))}
                <tr className="border-t-2 border-ink/30 font-semibold"><Td>Total</Td><Td align="right">{vat.totals.invoiceCount}</Td><Td align="right">{R(vat.totals.invoiceBase)}</Td><Td align="right">{R(vat.totals.invoiceVat)}</Td><Td align="right">{R(vat.totals.vatReceived)}</Td><Td align="right">{R(vat.totals.vatRemitted)}</Td><Td align="right">{R(vat.totals.vatAdjustments)}</Td><Td align="right">{R(vat.liabilityNow)}</Td></tr>
              </tbody>
            </Table>
          </TableWrap>
          <p className="border-t border-line px-5 py-3 text-xs text-muted">
            PPN menurut invoice = pajak pada invoice terbit bertanggal masa tersebut (acuan faktur pajak). PPN diterima kas = bagian PPN dari uang yang sudah masuk (dibukukan sebagai utang 2-1210).
            {vat.vatOnUnpaidInvoices > 0 && <> <strong>PPN pada invoice yang belum dilunasi: {R(vat.vatOnUnpaidInvoices)}</strong> — kewajiban menurut faktur sudah timbul walau uangnya belum diterima.</>}
          </p>
        </Card>
      )}

      {reg && (
        <Card>
          <CardHeader title="Register PPh dipotong pelanggan" description={`${formatDateLong(reg.from)} – ${formatDateLong(reg.to)} · neto ${R(reg.net)}${reg.missingRef ? ` · ${reg.missingRef} belum ada nomor bukti potong (${R(reg.missingRefAmount)})` : ""}`} actions={exportLinks("pph23", { from, to })} />
          {reg.rows.length === 0 ? <p className="px-5 py-8 text-center text-sm text-muted">Belum ada pembayaran yang dipotong PPh pada periode ini.</p> : (
            <TableWrap>
              <Table>
                <thead><tr><Th>Tanggal</Th><Th>Invoice</Th><Th>Pelanggan</Th><Th>NPWP</Th><Th>Jenis</Th><Th>No. bukti potong</Th><Th align="right">PPh dipotong</Th></tr></thead>
                <tbody>
                  {reg.rows.map((r) => (
                    <tr key={r.paymentId} className={cn(r.entryType === "REVERSAL" && "bg-brand-50/40")}>
                      <Td>{formatDateShort(r.date)}</Td><Td mono><Link href={`/invoices/${r.invoiceId}`} className="hover:underline">{r.invoiceNumber}</Link></Td><Td className="max-w-56 truncate">{r.customer}</Td><Td>{r.customerNpwp ?? "—"}</Td>
                      <Td>{r.entryType === "REVERSAL" ? <Badge tone="red">Pembalikan</Badge> : <Badge>Pembayaran</Badge>}</Td>
                      <Td>{r.ref ?? (r.entryType === "PAYMENT" ? <span className="flex items-center gap-2"><Badge tone="amber">Belum ada</Badge><WithholdingRefButton paymentId={r.paymentId} /></span> : "—")}</Td>
                      <Td align="right" className={cn(r.amount < 0 && "text-brand-700")}>{R(r.amount)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </Card>
      )}

      {f.tab === "pph-badan" && (
        <>
          <FilterBar action="/taxes" resetHref="/taxes?tab=pph-badan">
            <input type="hidden" name="tab" value="pph-badan" />
            <FilterField label="Tahun"><input type="number" name="year" defaultValue={year} min={2000} max={2200} className={filterInput} /></FilterField>
            {prof.regime === "FINAL" && <FilterField label="Bulan"><select name="month" defaultValue={f.month ?? Number(today.slice(5, 7))} className={filterInput}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></FilterField>}
          </FilterBar>
          {corp && prof.regime === "NONE" && <Notice tone="info">Estimasi PPh badan belum diaktifkan. {canManage ? "Atur rezim dan tarif lewat “Ubah profil pajak”." : "Minta Administrator mengaturnya di profil pajak."}</Notice>}
          {corp && prof.regime !== "NONE" && (
            <Card>
              <CardHeader title={`Estimasi PPh badan${corp.month ? ` (final) ${MONTHS[corp.month - 1]} ${corp.year}` : ` tahun ${corp.year}`}`}
                description={`${formatDateLong(corp.from)} – ${formatDateLong(corp.to)}${corp.partial ? " (berjalan)" : ""} · tarif ${((prof.rateBps ?? 0) / 100).toFixed(2)}%`}
                actions={<div className="flex flex-wrap gap-2">{canJournal && prof.regime === "GENERAL" && <TaxYearInputButton year={corp.year} input={corp.input} />}{exportLinks("corporate", { year: corp.year, month: corp.month ?? undefined })}</div>} />
              <dl className="max-w-3xl px-5 py-4 text-sm">
                {([
                  ["Laba (rugi) sebelum pajak penghasilan menurut pembukuan", corp.commercialProfit, false],
                  ...(prof.regime === "GENERAL" ? [["Koreksi fiskal neto (masukan)", corp.input.fiscalCorrection, false], ["Kompensasi kerugian fiskal (masukan)", -corp.input.lossCompensation, false]] as const : [["Peredaran bruto di luar PPN", corp.grossRevenue, false]] as const),
                  [prof.regime === "GENERAL" ? "Penghasilan kena pajak" : "Dasar pengenaan", corp.estimate.basis, true],
                  ["Pajak sebelum pengurang", corp.estimate.taxGross, false], ["Pengurang pajak (masukan)", -corp.estimate.facilityReduction, false], ["PPh terutang (estimasi)", corp.estimate.taxDue, true],
                  ["Kredit PPh dipotong pelanggan", -corp.estimate.credits, false], ["Angsuran / setoran PPh badan yang sudah dibayar", -corp.estimate.installments, false],
                  [corp.estimate.payable >= 0 ? "PPh kurang bayar (estimasi)" : "PPh lebih bayar (estimasi)", corp.estimate.payable, true],
                ] as const).map(([label, value, strong]) => (
                  <div key={label} className={cn("flex items-baseline justify-between gap-4 py-1.5", strong && "border-t border-ink/20 font-semibold")}><dt className={cn(!strong && "text-ink-soft")}>{label}</dt><dd className="tabular">{R(value)}</dd></div>
                ))}
              </dl>
              <div className="border-t border-line px-5 py-4 text-sm">
                <p className="text-muted">Sudah dibukukan: beban PPh (7-1100) {R(corp.booked.taxExpense)} · saldo utang PPh badan (2-1230) {R(corp.booked.account2230)}.</p>
                {corp.suggestion ? (
                  <div className="mt-3 rounded-md border border-line bg-canvas p-3">
                    <p className="font-medium">Jurnal penyesuaian yang disarankan — {corp.suggestion.description}</p>
                    <table className="mt-2 w-full max-w-xl text-sm"><tbody>{corp.suggestion.lines.map((l) => (
                      <tr key={l.code}><td className={cn("py-0.5", l.credit > 0 && "pl-8")}><span className="font-mono text-xs text-muted">{l.code}</span> {l.name}</td><td className="tabular w-32 text-right">{l.debit ? R(l.debit) : ""}</td><td className="tabular w-32 text-right">{l.credit ? R(l.credit) : ""}</td></tr>
                    ))}</tbody></table>
                    {canJournal && <div className="mt-3"><PostTaxJournalButton year={corp.year} month={corp.month} description={corp.suggestion.description} /></div>}
                  </div>
                ) : <p className="mt-2 text-emerald-700">Pembukuan PPh sudah sesuai dengan estimasi.</p>}
              </div>
            </Card>
          )}
        </>
      )}

      {payments && (
        <Card>
          <CardHeader title="Setoran pajak" description="Kas keluar yang mengurangi utang PPN (2-1210) atau utang PPh badan (2-1230); bukan beban." />
          {payments.length === 0 ? <p className="px-5 py-8 text-center text-sm text-muted">Belum ada setoran pajak tercatat.</p> : (
            <TableWrap>
              <Table>
                <thead><tr><Th>Tanggal</Th><Th>Jenis</Th><Th>Uraian</Th><Th>NTPN / ID billing</Th><Th>Dibayar dari</Th><Th align="right">Nominal</Th></tr></thead>
                <tbody>{payments.map((p) => (
                  <tr key={p.id} className={cn(p.entryType === "REVERSAL" && "bg-brand-50/40")}><Td>{formatDateShort(p.date)}</Td><Td><Badge tone="blue">{p.kind === "PPN" ? "PPN" : "PPh badan"}</Badge></Td><Td>{p.description}</Td><Td>{p.reference ?? "—"}</Td><Td>{p.accountName}</Td><Td align="right" className={cn(p.amount < 0 && "text-brand-700")}>{R(p.amount)}</Td></tr>
                ))}</tbody>
              </Table>
            </TableWrap>
          )}
        </Card>
      )}
    </div>
  );
}
