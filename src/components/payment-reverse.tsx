"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { TextAreaField } from "@/components/ui/field";
import { Notice } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import { formatRupiah } from "@/lib/finance/money";

/** Pembalikan pembayaran: menambah baris koreksi (histori asli tidak dihapus) dengan alasan wajib. */
export function PaymentReverseButton({ paymentId, amount, invoiceNumber }: { paymentId: string; amount: number; invoiceNumber: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});

  async function submit() {
    setBusy(true); setError(null); setFe({});
    try {
      await api(`/api/payments/${paymentId}/reverse`, { body: { reason } });
      toast.success("Pembayaran dibalikkan.");
      setOpen(false); setReason("");
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiClientError) setFe(e.fieldErrors);
    } finally { setBusy(false); }
  }
  return (
    <>
      <Button size="sm" variant="danger" onClick={() => setOpen(true)}>Balikkan</Button>
      <ConfirmDialog open={open} onClose={() => !busy && setOpen(false)} onConfirm={submit} loading={busy} tone="danger" confirmLabel="Balikkan pembayaran"
        title="Balikkan pembayaran?" description={`Pembayaran ${formatRupiah(amount, "PLAIN")} pada invoice ${invoiceNumber ?? ""} akan dibalikkan. Catatan asli tetap tersimpan; sisa tagihan bertambah kembali.`}>
        <TextAreaField label="Alasan pembalikan" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} error={fe.reason} placeholder="mis. Salah input nominal" />
        {error && <div className="mt-3"><Notice tone="danger">{error}</Notice></div>}
      </ConfirmDialog>
    </>
  );
}
