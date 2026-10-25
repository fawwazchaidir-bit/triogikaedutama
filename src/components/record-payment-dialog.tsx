"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { Notice } from "@/components/ui/card";
import { ApiClientError, api, errorMessage } from "@/lib/api-client";
import { formatRupiah } from "@/lib/finance/money";
import type { CashAccountOptionDto } from "@/lib/finance-types";

const METHODS = ["Transfer", "Tunai", "QRIS", "Virtual Account", "Cek/Giro", "Lainnya"];
// Tanggal awal tampilan (WIB). Server tetap memvalidasi tanggal pembayaran.
const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

export interface PayableInvoice { id: string; number: string | null; customerName: string; balanceAmount: number }

/**
 * Dialog pencatatan pembayaran (dipakai di daftar/detail invoice dan halaman Pembayaran).
 * Isi dialog dipasang HANYA saat terbuka, sehingga setiap pembukaan mulai dari state bersih
 * (tanpa efek yang me-reset state).
 */
export function RecordPaymentDialog(props: { open: boolean; onClose: () => void; invoice: PayableInvoice | null; onDone: () => void }) {
  return props.open && props.invoice ? <PaymentDialogBody {...props} invoice={props.invoice} /> : null;
}

function PaymentDialogBody({ onClose, invoice, onDone }: { open: boolean; onClose: () => void; invoice: PayableInvoice; onDone: () => void }) {
  const [pay, setPay] = useState({ date: today(), amount: invoice.balanceAmount as number | null, method: "Transfer", reference: "", note: "", cashAccountId: "" });
  const [accounts, setAccounts] = useState<CashAccountOptionDto[]>([]);
  useEffect(() => {
    let live = true;
    api<CashAccountOptionDto[]>("/api/finance/cash-accounts/options").then((a) => { if (live) setAccounts(a); }, () => undefined);
    return () => { live = false; };
  }, []);
  const autoAccount = accounts.find((a) => a.isDefault && a.kind === (pay.method === "Tunai" ? "KAS" : "BANK"));
  const [proof, setProof] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});

  async function submit() {
    setBusy(true); setError(null); setFe({});
    try {
      let proofFileId: string | null = null;
      if (proof) {
        const fd = new FormData(); fd.append("file", proof);
        const res = await fetch("/api/payments/proof", { method: "POST", body: fd });
        const j = await res.json();
        if (!res.ok) throw new ApiClientError(j.error?.message ?? "Gagal mengunggah bukti.", res.status, j.error?.code ?? "UNKNOWN", j.error?.fieldErrors);
        proofFileId = j.data.id;
      }
      await api("/api/payments", { body: { invoiceId: invoice.id, paymentDate: pay.date, amount: pay.amount ?? 0, method: pay.method, reference: pay.reference, note: pay.note, proofFileId, cashAccountId: pay.cashAccountId || null } });
      setBusy(false);
      onDone();
    } catch (e) {
      setBusy(false);
      setError(errorMessage(e));
      if (e instanceof ApiClientError) setFe(e.fieldErrors);
    }
  }

  return (
    <Dialog open onClose={() => !busy && onClose()} title={`Catat pembayaran${invoice.number ? ` — ${invoice.number}` : ""}`}
      description={`${invoice.customerName} · Sisa tagihan ${formatRupiah(invoice.balanceAmount, "PLAIN")}`}
      footer={<><Button onClick={onClose} disabled={busy}>Batal</Button><Button variant="primary" loading={busy} onClick={submit}>Simpan pembayaran</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Tanggal pembayaran" type="date" required value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} error={fe.paymentDate} />
        <MoneyInput label="Nominal" required value={pay.amount} onChange={(v) => setPay({ ...pay, amount: v })} error={fe.amount} hint="Tidak boleh melebihi sisa tagihan" />
        <SelectField label="Metode" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })} error={fe.method}>{METHODS.map((m) => <option key={m}>{m}</option>)}</SelectField>
        {accounts.length > 0 && (
          <SelectField label="Diterima di" className="sm:col-span-2" value={pay.cashAccountId} onChange={(e) => setPay({ ...pay, cashAccountId: e.target.value })} error={fe.cashAccountId}
            hint="Menentukan akun kas/bank yang saldonya bertambah">
            <option value="">Otomatis{autoAccount ? ` — ${autoAccount.name}` : " (belum ada akun default untuk metode ini)"}</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </SelectField>
        )}
        <TextField label="Referensi transfer" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} error={fe.reference} placeholder="No. referensi / berita transfer" />
        <TextAreaField className="sm:col-span-2" label="Catatan" rows={2} value={pay.note} onChange={(e) => setPay({ ...pay, note: e.target.value })} error={fe.note} />
        <div className="sm:col-span-2">
          <label className="mb-1.5 block text-sm font-medium text-ink-soft" htmlFor="proof">Bukti pembayaran (opsional)</label>
          <input id="proof" type="file" accept="image/png,image/jpeg,application/pdf" onChange={(e) => setProof(e.target.files?.[0] ?? null)} className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-white file:px-3 file:py-1.5 file:text-sm" />
          <p className="mt-1 text-xs text-muted">PNG, JPEG, atau PDF — maksimal 3 MB.</p>
        </div>
      </div>
      {error && <div className="mt-4"><Notice tone="danger">{error}</Notice></div>}
    </Dialog>
  );
}
