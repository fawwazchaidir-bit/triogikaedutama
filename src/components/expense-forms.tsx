"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { Notice } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, api, errorMessage } from "@/lib/api-client";
import { PROOF_REQUIRED_ABOVE } from "@/lib/accounting/limits";
import { formatRupiah } from "@/lib/finance/money";
import type { CashAccountOptionDto, CashEntryDto, CoaAccountDto } from "@/lib/finance-types";

const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

/**
 * Dialog pencatatan entri kas. `mode="expense"` = pengeluaran (kategori beban, arah keluar); `mode="other"` = penerimaan lain,
 * investasi, pendanaan (hanya Finance Manager/Admin). Isi dialog dipasang HANYA saat terbuka agar state selalu bersih.
 */
export function EntryCreate({ mode, accounts, categories, label }: { mode: "expense" | "other"; accounts: CashAccountOptionDto[]; categories: CoaAccountDto[]; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}><Plus className="size-4" />{label ?? (mode === "expense" ? "Catat pengeluaran" : "Catat penerimaan / non-operasional")}</Button>
      {open && <EntryDialog mode={mode} accounts={accounts} categories={categories} onClose={() => setOpen(false)} />}
    </>
  );
}

function EntryDialog({ mode, accounts, categories, onClose }: { mode: "expense" | "other"; accounts: CashAccountOptionDto[]; categories: CoaAccountDto[]; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const cats = categories.filter((c) => c.isActive && c.manualEntry && (mode === "expense" ? c.type === "BEBAN" : c.type !== "BEBAN"));
  const [f, setF] = useState({
    date: today(), cashAccountId: accounts.find((a) => a.isDefault && a.kind === "BANK")?.id ?? accounts[0]?.id ?? "", counterAccountId: "",
    direction: "OUT" as "IN" | "OUT", amount: null as number | null, payee: "", description: "", reference: "",
  });
  const [proof, setProof] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const counter = cats.find((c) => c.id === f.counterAccountId);
  const lockedDirection = mode === "expense" ? "OUT" : counter?.type === "PENDAPATAN" ? "IN" : null;
  const direction = lockedDirection ?? f.direction;

  const proofRequired = direction === "OUT" && (f.amount ?? 0) > PROOF_REQUIRED_ABOVE;

  async function submit() {
    setError(null); setFe({});
    if (proofRequired && !proof) {
      setFe({ proofFileId: `Bukti wajib untuk pengeluaran di atas ${formatRupiah(PROOF_REQUIRED_ABOVE, "PLAIN")}` });
      return;
    }
    setBusy(true);
    try {
      let proofFileId: string | null = null;
      if (proof) {
        const fd = new FormData(); fd.append("file", proof);
        const res = await fetch("/api/finance/proof", { method: "POST", body: fd });
        const j = await res.json();
        if (!res.ok) throw new ApiClientError(j.error?.message ?? "Gagal mengunggah bukti.", res.status, j.error?.code ?? "UNKNOWN", j.error?.fieldErrors);
        proofFileId = j.data.id;
      }
      const e = await api<CashEntryDto>("/api/finance/entries", {
        body: { entryDate: f.date, cashAccountId: f.cashAccountId, counterAccountId: f.counterAccountId, direction, amount: f.amount ?? 0, description: f.description, payee: f.payee, reference: f.reference, proofFileId },
      });
      toast.success(e.status === "PENDING" ? "Pengeluaran diajukan; menunggu persetujuan Finance Manager." : "Entri kas dicatat.");
      onClose(); router.refresh();
    } catch (e) {
      const fieldErrs = e instanceof ApiClientError ? e.fieldErrors : {}; setFe(fieldErrs); setError(Object.keys(fieldErrs).length ? null : errorMessage(e));
    } finally { setBusy(false); }
  }

  return (
    <Dialog open onClose={() => !busy && onClose()} title={mode === "expense" ? "Catat pengeluaran" : "Catat penerimaan / non-operasional"}
      description={mode === "expense" ? "Pengeluaran staff menunggu persetujuan Finance Manager sebelum masuk saldo dan laporan." : "Penerimaan lain, pembelian/penjualan aset, modal, prive, dan pinjaman. Langsung berlaku."}
      footer={<><Button onClick={onClose} disabled={busy}>Batal</Button><Button variant="primary" loading={busy} onClick={() => void submit()}>Simpan</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {error && <div className="sm:col-span-2"><Notice tone="danger">{error}</Notice></div>}
        <TextField label="Tanggal" type="date" required value={f.date} max={today()} onChange={(e) => setF({ ...f, date: e.target.value })} error={fe.entryDate} />
        <SelectField label={mode === "expense" ? "Dibayar dari" : "Akun kas/bank"} required value={f.cashAccountId} onChange={(e) => setF({ ...f, cashAccountId: e.target.value })} error={fe.cashAccountId}>
          {accounts.length === 0 && <option value="">Belum ada akun kas/bank</option>}
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </SelectField>
        <SelectField label="Kategori" required className="sm:col-span-2" value={f.counterAccountId} onChange={(e) => setF({ ...f, counterAccountId: e.target.value })} error={fe.counterAccountId}>
          <option value="">Pilih kategori…</option>
          {cats.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
        </SelectField>
        {mode === "other" && (
          <SelectField label="Arah" value={direction} disabled={!!lockedDirection} onChange={(e) => setF({ ...f, direction: e.target.value as "IN" | "OUT" })} error={fe.direction}
            hint={lockedDirection ? "Pendapatan selalu masuk" : "Masuk = uang diterima; Keluar = uang dibayarkan"}>
            <option value="IN">Masuk (uang diterima)</option><option value="OUT">Keluar (uang dibayarkan)</option>
          </SelectField>
        )}
        <MoneyInput label="Nominal" required value={f.amount} onChange={(v) => setF({ ...f, amount: v })} error={fe.amount} />
        <TextField label={direction === "IN" ? "Pemberi" : "Penerima"} value={f.payee} onChange={(e) => setF({ ...f, payee: e.target.value })} error={fe.payee} placeholder="Opsional" />
        <TextField label="No. bukti / kuitansi" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} error={fe.reference} placeholder="Opsional" />
        <TextAreaField label="Keterangan" required rows={2} className="sm:col-span-2" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} error={fe.description} placeholder="mis. Honor asesor uji kompetensi Demi Chef" />
        <div className="sm:col-span-2">
          <label className="block text-sm font-medium text-ink-soft" htmlFor="expense-proof">{proofRequired ? "Bukti transaksi" : "Bukti (opsional)"}{proofRequired && <span className="text-brand-600" aria-hidden> *</span>}</label>
          <input id="expense-proof" type="file" accept="image/png,image/jpeg,application/pdf" onChange={(e) => setProof(e.target.files?.[0] ?? null)} className="mt-1.5 block w-full text-sm" />
          {fe.proofFileId && <p role="alert" className="mt-1 text-xs font-medium text-brand-700">{fe.proofFileId}</p>}
          <p className="mt-1 text-xs text-muted">PNG, JPEG, atau PDF. <strong>Wajib</strong> untuk pengeluaran di atas {formatRupiah(PROOF_REQUIRED_ABOVE, "PLAIN")}.</p>
        </div>
      </div>
    </Dialog>
  );
}

/** Aksi per entri: setujui, tolak (alasan), batalkan pengajuan sendiri, balikkan (koreksi, alasan). */
export function EntryActions({ entry, can }: { entry: CashEntryDto; can: { approve: boolean; cancel: boolean; reverse: boolean } }) {
  const router = useRouter();
  const toast = useToast();
  const [dlg, setDlg] = useState<null | "approve" | "reject" | "cancel" | "reverse">(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const close = () => { if (!busy) { setDlg(null); setError(null); setFe({}); setReason(""); } };
  async function run(fn: () => Promise<void>, ok: string) {
    setBusy(true); setError(null); setFe({});
    try { await fn(); toast.success(ok); setDlg(null); setReason(""); router.refresh(); }
    catch (e) { const fieldErrs = e instanceof ApiClientError ? e.fieldErrors : {}; setFe(fieldErrs); setError(Object.keys(fieldErrs).length ? null : errorMessage(e)); if (e instanceof ApiClientError && e.code === "CONFLICT") router.refresh(); }
    finally { setBusy(false); }
  }
  const pending = entry.status === "PENDING" && entry.entryType === "ENTRY";
  const reversible = entry.status === "APPROVED" && entry.entryType === "ENTRY" && !entry.reversedByEntryId;
  const label = `${entry.counterCode} ${entry.description}`;
  return (
    <div className="flex justify-end gap-2">
      {pending && can.approve && <Button size="sm" variant="primary" onClick={() => setDlg("approve")}>Setujui</Button>}
      {pending && can.approve && <Button size="sm" variant="danger" onClick={() => setDlg("reject")}>Tolak</Button>}
      {pending && can.cancel && <Button size="sm" onClick={() => setDlg("cancel")}>Batalkan</Button>}
      {reversible && can.reverse && <Button size="sm" variant="danger" onClick={() => setDlg("reverse")}>Balikkan</Button>}

      <ConfirmDialog open={dlg === "approve"} onClose={close} title="Setujui pengeluaran?" confirmLabel="Ya, setujui" loading={busy}
        description={`${label} — setelah disetujui masuk saldo dan laporan, dan tidak dapat diubah (koreksi lewat pembalikan).`}
        onConfirm={() => void run(() => api(`/api/finance/entries/${entry.id}/approve`, { body: {} }).then(() => undefined), "Pengeluaran disetujui.")}>
        {error && <Notice tone="danger">{error}</Notice>}
      </ConfirmDialog>
      <ConfirmDialog open={dlg === "cancel"} onClose={close} title="Batalkan pengajuan?" confirmLabel="Batalkan pengajuan" tone="danger" loading={busy}
        description="Pengajuan dihapus (tercatat di audit log). Catat ulang bila perlu."
        onConfirm={() => void run(() => api(`/api/finance/entries/${entry.id}`, { method: "DELETE" }).then(() => undefined), "Pengajuan dibatalkan.")}>
        {error && <Notice tone="danger">{error}</Notice>}
      </ConfirmDialog>
      <ConfirmDialog open={dlg === "reject"} onClose={close} title="Tolak pengeluaran?" confirmLabel="Tolak pengeluaran" tone="danger" loading={busy}
        description="Alasan wajib dan akan terlihat oleh pencatat. Pengeluaran yang ditolak tidak pernah masuk saldo/laporan."
        onConfirm={() => void run(() => api(`/api/finance/entries/${entry.id}/reject`, { body: { reason } }).then(() => undefined), "Pengeluaran ditolak.")}>
        <div className="space-y-3">
          <TextAreaField label="Alasan penolakan" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} error={fe.reason} />
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      </ConfirmDialog>
      <ConfirmDialog open={dlg === "reverse"} onClose={close} title="Balikkan entri?" confirmLabel="Balikkan entri" tone="danger" loading={busy}
        description="Dibuat baris pembalik bertanggal hari ini; entri asli dan laporan periode lampau tidak berubah."
        onConfirm={() => void run(() => api(`/api/finance/entries/${entry.id}/reverse`, { body: { reason } }).then(() => undefined), "Entri dibalikkan.")}>
        <div className="space-y-3">
          <TextAreaField label="Alasan pembalikan" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} error={fe.reason} />
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      </ConfirmDialog>
    </div>
  );
}
