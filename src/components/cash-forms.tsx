"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { Notice } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, api, errorMessage } from "@/lib/api-client";
import type { CashAccountOptionDto } from "@/lib/finance-types";

const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

/** Transfer antar akun kas/bank (tidak memengaruhi laba rugi). */
export function TransferCreate({ accounts }: { accounts: CashAccountOptionDto[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} disabled={accounts.length < 2}><ArrowLeftRight className="size-4" />Transfer antar akun</Button>
      {open && <TransferDialog accounts={accounts} onClose={() => setOpen(false)} />}
    </>
  );
}

function TransferDialog({ accounts, onClose }: { accounts: CashAccountOptionDto[]; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [f, setF] = useState({ date: today(), from: accounts[0]?.id ?? "", to: accounts[1]?.id ?? "", amount: null as number | null, description: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  async function submit() {
    setBusy(true); setError(null); setFe({});
    try {
      await api("/api/finance/transfers", { body: { transferDate: f.date, fromAccountId: f.from, toAccountId: f.to, amount: f.amount ?? 0, description: f.description } });
      toast.success("Transfer dicatat."); onClose(); router.refresh();
    } catch (e) { const fieldErrs = e instanceof ApiClientError ? e.fieldErrors : {}; setFe(fieldErrs); setError(Object.keys(fieldErrs).length ? null : errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <Dialog open onClose={() => !busy && onClose()} title="Transfer antar akun" size="md"
      description="Memindahkan dana antar kas/bank. Total kas tidak berubah dan laba rugi tidak terpengaruh."
      footer={<><Button onClick={onClose} disabled={busy}>Batal</Button><Button variant="primary" loading={busy} onClick={() => void submit()}>Simpan transfer</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {error && <div className="sm:col-span-2"><Notice tone="danger">{error}</Notice></div>}
        <TextField label="Tanggal" type="date" required value={f.date} max={today()} onChange={(e) => setF({ ...f, date: e.target.value })} error={fe.transferDate} />
        <MoneyInput label="Nominal" required value={f.amount} onChange={(v) => setF({ ...f, amount: v })} error={fe.amount} />
        <SelectField label="Dari akun" required value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} error={fe.fromAccountId}>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </SelectField>
        <SelectField label="Ke akun" required value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} error={fe.toAccountId}>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </SelectField>
        <TextField label="Keterangan" className="sm:col-span-2" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Opsional, mis. Isi kas kecil" error={fe.description} />
      </div>
    </Dialog>
  );
}

export function TransferReverseButton({ id, label }: { id: string; label: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  async function submit() {
    setBusy(true); setError(null); setFe({});
    try { await api(`/api/finance/transfers/${id}/reverse`, { body: { reason } }); toast.success("Transfer dibalikkan."); setOpen(false); setReason(""); router.refresh(); }
    catch (e) { const fieldErrs = e instanceof ApiClientError ? e.fieldErrors : {}; setFe(fieldErrs); setError(Object.keys(fieldErrs).length ? null : errorMessage(e)); } finally { setBusy(false); }
  }
  return (
    <>
      <Button size="sm" variant="danger" onClick={() => setOpen(true)}>Balikkan</Button>
      <ConfirmDialog open={open} onClose={() => !busy && setOpen(false)} onConfirm={() => void submit()} loading={busy} tone="danger" confirmLabel="Balikkan transfer"
        title="Balikkan transfer?" description={`${label} — dibuat transfer pembalik bertanggal hari ini; transfer asli tetap tercatat.`}>
        <div className="space-y-3">
          <TextAreaField label="Alasan pembalikan" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} error={fe.reason} />
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      </ConfirmDialog>
    </>
  );
}
