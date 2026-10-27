import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/server/auth/current";
import { getReconOverview, listStatements } from "@/server/services/bank-reconciliation";
import { Card, CardHeader, EmptyState, Notice, PageHeader } from "@/components/ui/card";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { ImportStatementButton, StatusBadge } from "@/components/bank-forms";
import { can } from "@/lib/permissions";
import { formatRupiah } from "@/lib/finance/money";
import { formatDateShort } from "@/lib/format";

export const metadata: Metadata = { title: "Rekonsiliasi Bank" };
export const dynamic = "force-dynamic";
const R = (n: number) => formatRupiah(n, "PLAIN");

export default async function ReconciliationPage() {
  const user = await requirePagePermission("finance:view");
  const [overview, statements] = await Promise.all([getReconOverview(user), listStatements(user)]);
  const canAct = can(user.role, "bank:reconcile");
  return (
    <div>
      <PageHeader title="Rekonsiliasi Bank" description="Cocokkan rekening koran dengan transaksi buku. Selisih harus nol sebelum difinalisasi; biaya admin dan bunga yang hanya ada di bank dicatat langsung dari mutasi."
        actions={canAct ? <ImportStatementButton accounts={overview} /> : undefined} />
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {overview.map((o) => (
          <div key={o.accountId} className="rounded-lg border border-line bg-surface p-4">
            <p className="font-medium">{o.name}</p>
            <p className="mt-1 text-sm text-muted">{o.lastFinalizedEnd ? <>Terakhir direkonsiliasi sampai <strong className="text-ink">{formatDateShort(o.lastFinalizedEnd)}</strong> (saldo bank {R(o.lastClosing ?? 0)})</> : "Belum pernah direkonsiliasi"}</p>
            {o.draftCount > 0 && <p className="mt-1 text-xs text-amber-700">{o.draftCount} rekening koran draft</p>}
            <p className="mt-2 text-xs text-muted">Periode berikutnya mulai {formatDateShort(o.nextStart)}</p>
          </div>
        ))}
      </div>
      {overview.length === 0 && <Notice tone="info">Belum ada akun kas/bank. Tambahkan di Pengaturan → Keuangan.</Notice>}
      <Card>
        <CardHeader title="Rekening koran" description="Terbaru dahulu" />
        {statements.length === 0 ? <EmptyState title="Belum ada rekening koran" description="Impor CSV mutasi dari internet banking untuk mulai merekonsiliasi." /> : (
          <TableWrap>
            <Table>
              <thead><tr><Th>Akun</Th><Th>Periode</Th><Th align="right">Saldo awal</Th><Th align="right">Saldo akhir</Th><Th align="right">Baris</Th><Th align="right">Belum cocok</Th><Th>Status</Th></tr></thead>
              <tbody>
                {statements.map((s) => (
                  <tr key={s.id} className="hover:bg-canvas/60">
                    <Td><Link href={`/reconciliation/${s.id}`} className="font-medium hover:text-brand-700 hover:underline">{s.accountName}</Link>{s.label && <span className="block text-xs text-muted">{s.label}</span>}</Td>
                    <Td>{formatDateShort(s.periodStart)} – {formatDateShort(s.periodEnd)}</Td>
                    <Td align="right">{R(s.openingBalance)}</Td><Td align="right">{R(s.closingBalance)}</Td>
                    <Td align="right">{s.lineCount}</Td><Td align="right" className={s.unmatchedLines > 0 && s.status === "DRAFT" ? "font-medium text-brand-700" : ""}>{s.status === "DRAFT" ? s.unmatchedLines : "—"}</Td>
                    <Td><StatusBadge status={s.status} /></Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
