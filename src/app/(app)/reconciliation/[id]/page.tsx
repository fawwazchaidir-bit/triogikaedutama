import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePagePermission } from "@/server/auth/current";
import { getStatementWorkspace } from "@/server/services/bank-reconciliation";
import { listCoaAccounts } from "@/server/services/finance-coa";
import { AppError } from "@/server/errors";
import { Card, CardHeader, Notice, PageHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { LineActions, StatementActions, StatusBadge } from "@/components/bank-forms";
import { ExportLinks } from "@/components/export-links";
import { can } from "@/lib/permissions";
import { formatRupiah } from "@/lib/finance/money";
import { formatDateShort } from "@/lib/format";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Rekonsiliasi Bank" };
export const dynamic = "force-dynamic";
const R = (n: number) => formatRupiah(n, "PLAIN");

export default async function StatementPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePagePermission("finance:view");
  const { id } = await params;
  let ws;
  try { ws = await getStatementWorkspace(user, id); } catch (e) { if (e instanceof AppError || (e instanceof Error && e.name === "ZodError")) notFound(); throw e; }
  const canAct = can(user.role, "bank:reconcile");
  const categories = canAct ? await listCoaAccounts(user) : [];
  const s = ws.statement, sum = ws.summary;
  const draft = s.status === "DRAFT";
  return (
    <div>
      <PageHeader title={`Rekonsiliasi ${s.accountName}`} description={`${formatDateShort(s.periodStart)} – ${formatDateShort(s.periodEnd)}${s.label ? ` · ${s.label}` : ""}`}
        actions={<><ExportLinks base={`/api/finance/bank/statements/${s.id}`} /><Link href="/reconciliation" className="inline-flex h-10 items-center rounded-md border border-line bg-white px-3 text-sm hover:bg-canvas">Kembali</Link><StatusBadge status={s.status} /></>} />
      {s.reopenReason && draft && <div className="mb-3"><Notice tone="info">Dibuka kembali: {s.reopenReason}</Notice></div>}
      <Card className="mb-4">
        <dl className="grid gap-3 px-5 py-4 text-sm sm:grid-cols-2 lg:grid-cols-5">
          <div><dt className="text-muted">Saldo akhir bank</dt><dd className="tabular text-lg font-semibold">{R(sum.closing)}</dd></div>
          <div><dt className="text-muted">+ Transaksi buku beredar</dt><dd className="tabular text-lg font-semibold">{R(sum.outstandingNet)}</dd><dd className="text-xs text-muted">{ws.outstanding.length} transaksi belum cocok</dd></div>
          <div><dt className="text-muted">= Saldo bank disesuaikan</dt><dd className="tabular text-lg font-semibold">{R(sum.adjustedBank)}</dd></div>
          <div><dt className="text-muted">Saldo buku</dt><dd className="tabular text-lg font-semibold">{R(sum.bookBalance)}</dd></div>
          <div><dt className="text-muted">Selisih</dt><dd role="status" className={cn("tabular text-lg font-semibold", sum.difference === 0 ? "text-emerald-700" : "text-brand-700")}>{R(sum.difference)}{sum.difference === 0 ? " ✓" : ""}</dd></div>
        </dl>
        {draft && sum.problems.length > 0 && <p className="border-t border-line px-5 py-3 text-sm text-muted">Belum dapat difinalisasi: {sum.problems.join("; ")}.</p>}
        <div className="border-t border-line px-5 py-3"><StatementActions ws={ws} canAct={canAct} /></div>
      </Card>

      <Card className="mb-4">
        <CardHeader title="Mutasi rekening koran" description={`${ws.lines.length} baris · saldo awal ${R(s.openingBalance)} → saldo akhir ${R(s.closingBalance)}`} />
        <TableWrap>
          <Table>
            <thead><tr><Th>Tanggal</Th><Th>Uraian</Th><Th align="right">Jumlah</Th><Th>Dicocokkan dengan</Th><Th align="right">Aksi</Th></tr></thead>
            <tbody>
              {ws.lines.map((l) => {
                const full = l.matched === l.amount;
                return (
                  <tr key={l.id} data-testid="bank-line" className={cn(!full && draft && "bg-amber-50/50")}>
                    <Td>{formatDateShort(l.txDate)}</Td>
                    <Td className="max-w-xs"><span className="block truncate">{l.description}</span>{l.reference && <span className="block text-xs text-muted">{l.reference}</span>}</Td>
                    <Td align="right" className={cn(l.amount < 0 && "text-brand-700")}>{R(l.amount)}</Td>
                    <Td>{l.matches.length === 0 ? <Badge tone="amber">Belum cocok</Badge> : (
                      <ul className="space-y-0.5 text-xs">{l.matches.map((m) => <li key={m.id}>{m.label} <span className="text-muted">({m.method === "AUTO" ? "otomatis" : "manual"})</span></li>)}{!full && <li className="text-brand-700">Sisa {R(l.amount - l.matched)}</li>}</ul>
                    )}</Td>
                    <Td align="right"><LineActions line={l} outstanding={ws.outstanding} categories={categories} locked={!canAct || !draft} /></Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>
      </Card>

      <Card>
        <CardHeader title="Transaksi buku yang beredar" description="Ada di buku sampai akhir periode tetapi belum muncul di rekening koran (setoran/cek dalam perjalanan, atau salah catat)." />
        {ws.outstanding.length === 0 ? <p className="px-5 py-6 text-center text-sm text-muted">Tidak ada transaksi beredar.</p> : (
          <TableWrap>
            <Table>
              <thead><tr><Th>Tanggal</Th><Th>Uraian</Th><Th align="right">Jumlah</Th><Th>Keterangan</Th></tr></thead>
              <tbody>{ws.outstanding.map((i) => (
                <tr key={`${i.type}:${i.id}`}><Td>{formatDateShort(i.date)}</Td><Td>{i.label}</Td><Td align="right" className={cn(i.amount < 0 && "text-brand-700")}>{R(i.amount)}</Td><Td>{i.matchedIn === "LATER" ? <Badge tone="blue">Dicocokkan di periode berikutnya</Badge> : <Badge>Belum dicocokkan</Badge>}</Td></tr>
              ))}</tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
