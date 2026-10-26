import type { Metadata } from "next";
import { z } from "zod";
import { requirePagePermission } from "@/server/auth/current";
import { getJournalBook } from "@/server/services/finance-ledger";
import { bookkeepingStart, listManualJournals } from "@/server/services/journals";
import { getBooksLock } from "@/server/services/books-lock";
import { RESERVED_JOURNAL_CODES } from "@/lib/accounting/ledger";
import { BooksLockPanel } from "@/components/books-lock-panel";
import { listCoaAccounts } from "@/server/services/finance-coa";
import { listCashAccounts } from "@/server/services/cash-accounts";
import { Card, EmptyState, Notice, PageHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FilterBar, FilterField, filterInput } from "@/components/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { JournalCreate, JournalReverseButton } from "@/components/journal-forms";
import { can } from "@/lib/permissions";
import { buildQuery } from "@/lib/invoice-can";
import { formatRupiah } from "@/lib/finance/money";
import { formatDateShort } from "@/lib/format";
import { isoDate } from "@/lib/validation/common";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Jurnal" };
export const dynamic = "force-dynamic";

const schema = z.object({
  from: isoDate.optional(), to: isoDate.optional(), page: z.coerce.number().int().min(1).optional(),
  source: z.enum(["OPENING_CASH", "INVOICE_PAYMENT", "CASH_ENTRY", "TRANSFER", "MANUAL"]).optional(),
});
const SOURCE_LABEL = { OPENING_CASH: "Saldo awal kas", INVOICE_PAYMENT: "Pembayaran invoice", CASH_ENTRY: "Entri kas", TRANSFER: "Transfer", MANUAL: "Jurnal manual" } as const;

export default async function JournalsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePagePermission("finance:view");
  const sp = await searchParams;
  const f = schema.safeParse(Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v))).data ?? {};
  const canRecord = can(user.role, "journal:record");
  const canVoid = can(user.role, "expense:void");
  const [book, manual, coa, cash, start, lock] = await Promise.all([
    getJournalBook(user, { ...f, from: f.from ?? "2000-01-01", pageSize: 25 }),
    listManualJournals(user, { pageSize: 100 }),
    listCoaAccounts(user), listCashAccounts(user), bookkeepingStart(), getBooksLock(),
  ]);
  const flags = new Map(manual.items.map((j) => [j.id, j]));
  const cashCoa = new Set(cash.map((c) => c.coaAccountId));
  const pickable = coa.filter((a) => !cashCoa.has(a.id) && !RESERVED_JOURNAL_CODES.includes(a.code));
  const href = (p: number) => `/journals${buildQuery({ ...f, page: p })}`;
  return (
    <div>
      <PageHeader title="Jurnal" description="Buku jurnal seluruh transaksi. Jurnal dari pembayaran, entri kas, dan transfer dibuat OTOMATIS dari modul kas (tidak dapat berselisih); jurnal manual untuk penyesuaian & saldo awal akun non-kas."
        actions={canRecord ? <JournalCreate accounts={pickable} startDate={start} /> : undefined} />
      {!start && <div className="mb-4"><Notice tone="warn">Belum ada akun kas/bank, sehingga tanggal mulai pembukuan belum ada. Tambahkan akun beserta saldo awal di Pengaturan → Keuangan.</Notice></div>}
      <div className="mb-4"><Notice tone="info">Saldo awal akun kas/bank dijurnal otomatis terhadap <strong>3-2100 Saldo Laba</strong>. Saldo awal aset tetap, utang, dan modal diinput lewat <strong>jurnal saldo awal</strong> (seimbang) bertanggal tepat pada tanggal mulai pembukuan{start ? ` (${formatDateShort(start)})` : ""}. Pajak (PPN, PPh) belum diotomasi.</Notice></div>
      <div className="mb-4"><BooksLockPanel lockedThrough={lock} canLock={can(user.role, "books:lock")} /></div>
      <FilterBar action="/journals" resetHref="/journals">
        <FilterField label="Dari tanggal"><input type="date" name="from" defaultValue={f.from} className={filterInput} /></FilterField>
        <FilterField label="Sampai tanggal"><input type="date" name="to" defaultValue={f.to} className={filterInput} /></FilterField>
        <FilterField label="Sumber"><select name="source" defaultValue={f.source ?? ""} className={filterInput}><option value="">Semua</option>{Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></FilterField>
      </FilterBar>
      <Card>
        {book.items.length === 0 ? <EmptyState title="Belum ada jurnal" description="Jurnal muncul otomatis setelah ada saldo awal, pembayaran, entri kas, atau jurnal manual." /> : (
          <>
            <ul className="divide-y divide-line">
              {book.items.map((j) => {
                const m = j.source === "MANUAL" ? flags.get(j.sourceId) : undefined;
                return (
                  <li key={j.key} className="px-5 py-4" data-testid="journal-item">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm"><span className="font-mono font-semibold">{j.number}</span> · {formatDateShort(j.date)} · <span className="font-medium">{j.description}</span></p>
                      <div className="flex items-center gap-2">
                        <Badge tone={j.source === "MANUAL" ? "blue" : "gray"}>{SOURCE_LABEL[j.source]}</Badge>
                        {m?.kind === "OPENING" && <Badge tone="amber">Saldo awal</Badge>}
                        {m?.entryType === "REVERSAL" && <Badge tone="red">Pembalikan</Badge>}
                        {m?.reversedByJournalId && <Badge>Sudah dibalik</Badge>}
                        {m && m.entryType === "ENTRY" && !m.reversedByJournalId && canVoid && <JournalReverseButton id={m.id} label={`${m.number} ${m.description}`} />}
                      </div>
                    </div>
                    <table className="mt-2 w-full max-w-3xl text-sm">
                      <tbody>
                        {j.lines.map((l, i) => (
                          <tr key={i}>
                            <td className={cn("py-0.5 pr-3", l.credit > 0 && "pl-8")}><span className="font-mono text-xs text-muted">{l.code}</span> {l.name}</td>
                            <td className="tabular w-36 py-0.5 text-right">{l.debit > 0 ? formatRupiah(l.debit, "PLAIN") : ""}</td>
                            <td className="tabular w-36 py-0.5 text-right">{l.credit > 0 ? formatRupiah(l.credit, "PLAIN") : ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </li>
                );
              })}
            </ul>
            <Pagination page={book.page} pageCount={book.pageCount} total={book.total} hrefFor={href} />
          </>
        )}
      </Card>
    </div>
  );
}
