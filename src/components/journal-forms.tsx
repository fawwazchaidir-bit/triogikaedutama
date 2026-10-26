"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { Notice } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, api, errorMessage } from "@/lib/api-client";
import { formatRupiah } from "@/lib/finance/money";
import type { CoaAccountDto } from "@/lib/finance-types";

const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
interface Row { key: number; accountId: string; debit: number | null; credit: number | null; memo: string }
let k = 0;
const blank = (): Row => ({ key: ++k, accountId: "", debit: null, credit: null, memo: "" });

/** Jurnal manual: penyesuaian (penyusutan, koreksi, pajak) atau saldo awal akun non-kas. Akun kas/bank & akun cadangan tidak ditawarkan. */
export function JournalCreate({ accounts, startDate }: { accounts: CoaAccountDto[]; startDate: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)} disabled={!startDate}><Plus className="size-4" />Catat jurnal</Button>
      {open && <JournalDialog accounts={accounts} startDate={startDate!} onClose={() => setOpen(false)} />}
    </>
  );
}

function JournalDialog({ accounts, startDate, onClose }: { accounts: CoaAccountDto[]; startDate: string; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [kind, setKind] = useState<"GENERAL" | "OPENING">("GENERAL");
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [rows, setRows] = useState<Row[]>([blank(), blank()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const usable = accounts.filter((a) => a.isActive && (kind === "GENERAL" || (a.type !== "PENDAPATAN" && a.type !== "BEBAN")));
  const totalDebit = rows.reduce((s, r) => s + (r.debit ?? 0), 0);
  const totalCredit = rows.reduce((s, r) => s + (r.credit ?? 0), 0);
  const diff = totalDebit - totalCredit;
  const set = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function submit() {
    setBusy(true); setError(null); setFe({});
    try {
      await api("/api/finance/journals", { body: {
        kind, journalDate: kind === "OPENING" ? startDate : date, description, reference,
        lines: rows.filter((r) => r.accountId || r.debit || r.credit).map((r) => ({ accountId: r.accountId, debit: r.debit ?? 0, credit: r.credit ?? 0, memo: r.memo })),
      } });
      toast.success("Jurnal dicatat."); onClose(); router.refresh();
    } catch (e) {
      const f = e instanceof ApiClientError ? e.fieldErrors : {};
      setFe(f); setError(Object.keys(f).length ? null : errorMessage(e));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open onClose={() => !busy && onClose()} title="Catat jurnal manual" size="xl"
      description="Debit harus sama dengan kredit. Akun kas/bank dicatat lewat modul Kas & Bank. Setelah dicatat jurnal tidak dapat diubah (koreksi lewat pembalikan)."
      footer={<><Button onClick={onClose} disabled={busy}>Batal</Button><Button variant="primary" loading={busy} disabled={diff !== 0 || totalDebit === 0} onClick={() => void submit()}>Simpan jurnal</Button></>}>
      <div className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="grid gap-4 sm:grid-cols-3">
          <SelectField label="Jenis" value={kind} onChange={(e) => setKind(e.target.value as "GENERAL" | "OPENING")} hint={kind === "OPENING" ? `Saldo awal akun non-kas; bertanggal ${startDate}` : "Penyesuaian / koreksi"}>
            <option value="GENERAL">Jurnal umum (penyesuaian)</option><option value="OPENING">Jurnal saldo awal (non-kas)</option>
          </SelectField>
          <TextField label="Tanggal" type="date" required value={kind === "OPENING" ? startDate : date} disabled={kind === "OPENING"} max={today()} min={startDate} onChange={(e) => setDate(e.target.value)} error={fe.journalDate} />
          <TextField label="Referensi" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Opsional" error={fe.reference} />
        </div>
        <TextAreaField label="Keterangan" required rows={2} value={description} onChange={(e) => setDescription(e.target.value)} error={fe.description} placeholder="mis. Penyusutan peralatan Oktober 2026" />
        {fe.lines && <p role="alert" className="text-xs font-medium text-brand-700">{fe.lines}</p>}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-sm">
            <thead><tr className="text-left text-xs uppercase tracking-wide text-muted"><th className="py-1 pr-2">Akun</th><th className="py-1 pr-2 w-44">Debit</th><th className="py-1 pr-2 w-44">Kredit</th><th className="py-1 pr-2">Catatan</th><th className="w-8" /></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.key} className="align-top">
                  <td className="py-1 pr-2">
                    <select aria-label={`Akun baris ${i + 1}`} value={r.accountId} onChange={(e) => set(r.key, { accountId: e.target.value })} className="h-10 w-full rounded-md border border-line bg-white px-2 text-sm">
                      <option value="">Pilih akun…</option>
                      {usable.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                    </select>
                    {fe[`lines.${i}.accountId`] && <p role="alert" className="mt-1 text-xs font-medium text-brand-700">{fe[`lines.${i}.accountId`]}</p>}
                    {fe[`lines.${i}`] && <p role="alert" className="mt-1 text-xs font-medium text-brand-700">{fe[`lines.${i}`]}</p>}
                  </td>
                  <td className="py-1 pr-2"><MoneyInput label={`Debit baris ${i + 1}`} className="[&>label]:sr-only" value={r.debit} onChange={(v) => set(r.key, { debit: v, ...(v ? { credit: null } : {}) })} /></td>
                  <td className="py-1 pr-2"><MoneyInput label={`Kredit baris ${i + 1}`} className="[&>label]:sr-only" value={r.credit} onChange={(v) => set(r.key, { credit: v, ...(v ? { debit: null } : {}) })} /></td>
                  <td className="py-1 pr-2"><input aria-label={`Catatan baris ${i + 1}`} value={r.memo} onChange={(e) => set(r.key, { memo: e.target.value })} className="h-10 w-full rounded-md border border-line bg-white px-2 text-sm" placeholder="Opsional" /></td>
                  <td className="py-1"><button type="button" aria-label={`Hapus baris ${i + 1}`} disabled={rows.length <= 2} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} className="rounded p-2 text-brand-700 hover:bg-brand-50 disabled:opacity-30"><Trash2 className="size-4" /></button></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-line font-semibold">
                <td className="py-2"><Button size="sm" onClick={() => setRows((rs) => [...rs, blank()])}><Plus className="size-4" />Tambah baris</Button></td>
                <td className="tabular py-2 pr-2" aria-label="Total debit">{formatRupiah(totalDebit, "PLAIN")}</td>
                <td className="tabular py-2 pr-2" aria-label="Total kredit">{formatRupiah(totalCredit, "PLAIN")}</td>
                <td colSpan={2} className={diff === 0 && totalDebit > 0 ? "py-2 text-emerald-700" : "py-2 text-brand-700"} role="status">
                  {totalDebit === 0 ? "Isi nominal" : diff === 0 ? "Seimbang ✓" : `Selisih ${formatRupiah(Math.abs(diff), "PLAIN")} (${diff > 0 ? "debit lebih besar" : "kredit lebih besar"})`}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </Dialog>
  );
}

export function JournalReverseButton({ id, label }: { id: string; label: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  async function submit() {
    setBusy(true); setError(null); setFe({});
    try { await api(`/api/finance/journals/${id}/reverse`, { body: { reason } }); toast.success("Jurnal dibalikkan."); setOpen(false); setReason(""); router.refresh(); }
    catch (e) { const f = e instanceof ApiClientError ? e.fieldErrors : {}; setFe(f); setError(Object.keys(f).length ? null : errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <>
      <Button size="sm" variant="danger" onClick={() => setOpen(true)}>Balikkan</Button>
      <ConfirmDialog open={open} onClose={() => !busy && setOpen(false)} onConfirm={() => void submit()} loading={busy} tone="danger" confirmLabel="Balikkan jurnal"
        title="Balikkan jurnal?" description={`${label} — dibuat jurnal pembalik bertanggal hari ini (debit ↔ kredit); jurnal asli tetap tercatat.`}>
        <div className="space-y-3">
          <TextAreaField label="Alasan pembalikan" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} error={fe.reason} />
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      </ConfirmDialog>
    </>
  );
}
