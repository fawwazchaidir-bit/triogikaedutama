import type { Metadata } from "next";
import { requirePagePermission } from "@/server/auth/current";
import { listPeriods } from "@/server/services/periods";
import { Card, CardHeader, EmptyState, Notice, PageHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { BooksLockPanel } from "@/components/books-lock-panel";
import { ClosePeriodButton, ReopenPeriodButton } from "@/components/closing-forms";
import { can } from "@/lib/permissions";
import { formatRupiah } from "@/lib/finance/money";
import { formatDateShort } from "@/lib/format";
import type { PeriodDto } from "@/lib/accounting/periods";

export const metadata: Metadata = { title: "Tutup Buku" };
export const dynamic = "force-dynamic";

const R = (n: number) => formatRupiah(n, "PLAIN");
const STATE: Record<PeriodDto["state"], { label: string; tone: "green" | "gray" | "amber" | "blue" }> = {
  CLOSED: { label: "Ditutup", tone: "green" }, REOPENED: { label: "Dibuka kembali", tone: "amber" }, OPEN: { label: "Belum ditutup", tone: "gray" },
  CURRENT: { label: "Berjalan", tone: "blue" }, BEFORE_START: { label: "Sebelum pembukuan", tone: "gray" },
};

export default async function ClosingPage() {
  const user = await requirePagePermission("finance:view");
  const { periods, lockedThrough, lockConsistent } = await listPeriods(user);
  const canLock = can(user.role, "books:lock");
  const tampered = periods.filter((p) => p.verified === false);
  return (
    <div>
      <PageHeader title="Tutup Buku" description="Tutup bulan satu per satu secara berurutan setelah pembukuannya final. Penutupan menyimpan foto neraca saldo + hash dan mengunci transaksi bertanggal sampai akhir bulan itu." />
      <div className="mb-4"><BooksLockPanel lockedThrough={lockedThrough} /></div>
      {!lockConsistent && (
        <div className="mb-4"><Notice tone="danger">Tanggal kunci buku tidak sesuai dengan periode yang ditutup — kunci diubah di luar prosedur. Periksa audit log dan jalankan <code>npm run db:reconcile</code>.</Notice></div>
      )}
      {tampered.length > 0 && (
        <div className="mb-4"><Notice tone="danger">Foto penutupan {tampered.map((p) => p.label).join(", ")} TIDAK cocok dengan perhitungan ulang buku besar. Angka periode tertutup berubah di luar prosedur — periksa audit log dan jalankan <code>npm run db:reconcile</code>.</Notice></div>
      )}
      <Card>
        <CardHeader title="Periode" description="Urut dari terbaru. Bulan baru dapat ditutup bila bulan sebelumnya sudah ditutup dan bulan itu telah berakhir." />
        {periods.length === 0 ? <EmptyState title="Belum ada periode" description="Tambahkan akun kas/bank beserta saldo awal di Pengaturan → Keuangan; periode dimulai dari bulan saldo awal paling awal." /> : (
          <TableWrap>
            <Table>
              <thead><tr><Th>Periode</Th><Th>Status</Th><Th align="right">Total aset</Th><Th align="right">Laba sebelum pajak</Th><Th>Penutupan</Th><Th align="right">Aksi</Th></tr></thead>
              <tbody>
                {periods.map((p) => {
                  const s = STATE[p.state];
                  return (
                    <tr key={p.key} data-testid="period-row" data-period={p.key} data-state={p.state}>
                      <Td className="font-medium">{p.label}</Td>
                      <Td>
                        <div className="flex flex-col items-start gap-1">
                          <Badge tone={s.tone}>{s.label}</Badge>
                          {p.verified !== null && (p.verified ? <Badge tone="green">Foto cocok</Badge> : <Badge tone="red">Foto berubah!</Badge>)}
                        </div>
                      </Td>
                      <Td align="right">{p.snapshot ? R(p.snapshot.assets) : "—"}</Td>
                      <Td align="right">{p.snapshot ? R(p.snapshot.profitBeforeTax) : "—"}</Td>
                      <Td className="max-w-64 text-xs text-ink-soft">
                        {p.state === "CLOSED" && <>
                          <p>{p.closedByName ?? "—"} · {p.closedAt ? formatDateShort(p.closedAt.slice(0, 10)) : "—"}</p>
                          {p.note && <p className="text-muted">{p.note}</p>}
                          {p.acknowledged.length > 0 && <p className="text-amber-700">Diakui: {p.acknowledged.map((a) => a.label).join("; ")}</p>}
                        </>}
                        {p.state === "REOPENED" && <p>Dibuka kembali{p.reopenedAt ? ` ${formatDateShort(p.reopenedAt.slice(0, 10))}` : ""}: {p.reopenReason}</p>}
                      </Td>
                      <Td align="right">
                        <div className="flex justify-end gap-2">
                          {canLock && p.canClose && <ClosePeriodButton year={p.year} month={p.month} label={p.label} />}
                          {canLock && p.canReopen && <ReopenPeriodButton year={p.year} month={p.month} label={p.label} />}
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
