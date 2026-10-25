import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { requirePagePermission } from "@/server/auth/current";
import { listCashAccountOptions, listCashAccounts } from "@/server/services/cash-accounts";
import { listTransfers } from "@/server/services/cash-entries";
import { listCoaAccounts } from "@/server/services/finance-coa";
import { getAccountLedger, getFinanceWarnings } from "@/server/services/finance-statements";
import { env } from "@/server/env";
import { Card, CardHeader, EmptyState, Notice, PageHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FilterBar, FilterField, filterInput } from "@/components/filter-bar";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { EntryCreate } from "@/components/expense-forms";
import { TransferCreate, TransferReverseButton } from "@/components/cash-forms";
import { can } from "@/lib/permissions";
import { formatRupiah } from "@/lib/finance/money";
import { formatDateShort, todayIso } from "@/lib/format";
import { isoDate } from "@/lib/validation/common";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Kas & Bank" };
export const dynamic = "force-dynamic";

const schema = z.object({ account: z.string().uuid().optional(), from: isoDate.optional(), to: isoDate.optional() });

export default async function CashPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePagePermission("finance:view");
  const sp = await searchParams;
  const f = schema.safeParse(Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v))).data ?? {};
  const today = todayIso(env().APP_TIMEZONE);
  const canRecord = can(user.role, "cash:record");
  const [accounts, warnings, transfers, options, coa] = await Promise.all([
    listCashAccounts(user), getFinanceWarnings(user), listTransfers(user, { pageSize: 10 }),
    canRecord ? listCashAccountOptions(user) : Promise.resolve([]), canRecord ? listCoaAccounts(user) : Promise.resolve([]),
  ]);
  const selected = accounts.find((a) => a.id === f.account) ?? accounts[0];
  const from = f.from ?? `${today.slice(0, 4)}-01-01`;
  const to = f.to ?? today;
  const ledger = selected ? await getAccountLedger(user, { accountId: selected.id, from, to }) : null;
  const total = accounts.filter((a) => a.isActive || a.balance !== 0).reduce((s, a) => s + a.balance, 0);

  return (
    <div>
      <PageHeader title="Kas & Bank" description="Saldo = saldo awal (diinput Administrator) + mutasi sejak tanggal saldo awal. Hanya entri yang sudah berlaku yang dihitung."
        actions={canRecord ? <><TransferCreate accounts={options} /><EntryCreate mode="other" accounts={options} categories={coa} /></> : undefined} />

      {warnings.negativeAccounts.length > 0 && <div className="mb-3"><Notice tone="danger"><strong>Saldo negatif:</strong> {warnings.negativeAccounts.map((a) => `${a.name} (${formatRupiah(a.balance, "PLAIN")})`).join(", ")}. Periksa apakah ada penerimaan yang belum dicatat atau salah input.</Notice></div>}
      {warnings.unallocatedPayments > 0 && <div className="mb-3"><Notice tone="warn"><strong>{warnings.unallocatedPayments} pembayaran invoice belum dialokasikan ke akun kas/bank</strong> (dicatat sebelum akun dikonfigurasi atau akun default nonaktif). Pembayaran ini masuk laba rugi tetapi tidak masuk saldo.</Notice></div>}
      {warnings.pendingExpenses > 0 && <div className="mb-3"><Notice tone="info">{warnings.pendingExpenses} pengeluaran menunggu persetujuan <Link className="underline" href="/expenses?status=PENDING">(tinjau)</Link> — belum dihitung dalam saldo.</Notice></div>}

      {accounts.length === 0 ? (
        <Card><EmptyState title="Belum ada akun kas/bank" description={can(user.role, "finance:manage") ? "Tambahkan akun beserta saldo awal di Pengaturan → Keuangan." : "Administrator perlu menambahkan akun dan saldo awal di Pengaturan → Keuangan."}
          action={can(user.role, "finance:manage") ? <Link href="/settings?tab=finance" className="inline-flex h-10 items-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white">Buka Pengaturan Keuangan</Link> : undefined} /></Card>
      ) : (
        <>
          <section aria-label="Saldo akun" className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-lg border border-line bg-surface p-4 shadow-sm"><p className="text-xs font-medium uppercase tracking-wide text-muted">Total kas & bank</p><p className="tabular mt-1 text-xl font-semibold">{formatRupiah(total, "PLAIN")}</p><p className="mt-1 text-xs text-muted">per {formatDateShort(today)}</p></div>
            {accounts.map((a) => (
              <Link key={a.id} href={`/cash?account=${a.id}`} className={cn("rounded-lg border bg-surface p-4 shadow-sm hover:bg-canvas", a.id === selected?.id ? "border-ink" : "border-line")}>
                <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">{a.name}{!a.isActive && <Badge>Nonaktif</Badge>}{a.isDefault && <Badge tone="blue">Default</Badge>}</p>
                <p className={cn("tabular mt-1 text-xl font-semibold", a.balance < 0 && "text-brand-700")}>{formatRupiah(a.balance, "PLAIN")}</p>
                <p className="mt-1 text-xs text-muted">{a.kind === "KAS" ? "Kas" : "Bank"} · saldo awal {formatRupiah(a.openingBalance, "PLAIN")} ({formatDateShort(a.openingDate)})</p>
              </Link>
            ))}
          </section>

          {ledger && (
            <Card className="mb-5">
              <CardHeader title={`Buku kas — ${ledger.account.name}`} description="Seluruh mutasi (pembayaran invoice, pengeluaran & entri kas berlaku, transfer) dengan saldo berjalan." />
              <div className="px-5 pt-4">
                <FilterBar action="/cash" resetHref={`/cash?account=${selected!.id}`}>
                  <input type="hidden" name="account" value={selected!.id} />
                  <FilterField label="Dari tanggal"><input type="date" name="from" defaultValue={from} className={filterInput} /></FilterField>
                  <FilterField label="Sampai tanggal"><input type="date" name="to" defaultValue={to} className={filterInput} /></FilterField>
                </FilterBar>
              </div>
              <TableWrap>
                <Table>
                  <thead><tr><Th>Tanggal</Th><Th>Uraian</Th><Th align="right">Masuk</Th><Th align="right">Keluar</Th><Th align="right">Saldo</Th></tr></thead>
                  <tbody>
                    <tr className="bg-canvas/60"><Td>{formatDateShort(from)}</Td><Td className="italic text-muted">Saldo awal periode</Td><Td /><Td /><Td align="right" className="tabular font-medium">{formatRupiah(ledger.opening, "PLAIN")}</Td></tr>
                    {ledger.rows.map((r, i) => (
                      <tr key={`${r.ref}-${i}`}>
                        <Td>{formatDateShort(r.date)}</Td><Td className="max-w-md">{r.description}</Td>
                        <Td align="right" className="tabular text-emerald-700">{r.signed > 0 ? formatRupiah(r.signed, "PLAIN") : ""}</Td>
                        <Td align="right" className="tabular">{r.signed < 0 ? formatRupiah(-r.signed, "PLAIN") : ""}</Td>
                        <Td align="right" className={cn("tabular font-medium", r.balance < 0 && "text-brand-700")}>{formatRupiah(r.balance, "PLAIN")}</Td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-ink/20 font-semibold"><Td /><Td>Saldo akhir periode</Td><Td /><Td /><Td align="right" className="tabular">{formatRupiah(ledger.closing, "PLAIN")}</Td></tr>
                  </tbody>
                </Table>
              </TableWrap>
            </Card>
          )}

          <Card>
            <CardHeader title="Transfer antar akun terbaru" description="Pembalikan membuat transfer pembalik bertanggal hari ini; transfer asli tetap tercatat." />
            {transfers.items.length === 0 ? <EmptyState title="Belum ada transfer" /> : (
              <TableWrap>
                <Table>
                  <thead><tr><Th>Tanggal</Th><Th>Dari</Th><Th>Ke</Th><Th align="right">Nominal</Th><Th>Keterangan</Th><Th>Status</Th>{can(user.role, "expense:void") && <Th align="right">Aksi</Th>}</tr></thead>
                  <tbody>
                    {transfers.items.map((t) => (
                      <tr key={t.id} className={cn(t.entryType === "REVERSAL" && "bg-brand-50/40")}>
                        <Td>{formatDateShort(t.transferDate)}</Td><Td>{t.fromName}</Td><Td>{t.toName}</Td>
                        <Td align="right" className="tabular">{formatRupiah(t.amount, "PLAIN")}</Td>
                        <Td>{t.description ?? "—"}{t.reason && <span className="block text-xs text-muted">Alasan: {t.reason}</span>}</Td>
                        <Td>{t.entryType === "REVERSAL" ? <Badge tone="red">Pembalikan</Badge> : t.reversedByTransferId ? <Badge>Sudah dibalik</Badge> : <Badge tone="green">Berlaku</Badge>}</Td>
                        {can(user.role, "expense:void") && <Td align="right">{t.entryType === "ENTRY" && !t.reversedByTransferId ? <TransferReverseButton id={t.id} label={`${t.fromName} → ${t.toName} ${formatRupiah(t.amount, "PLAIN")}`} /> : null}</Td>}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableWrap>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
