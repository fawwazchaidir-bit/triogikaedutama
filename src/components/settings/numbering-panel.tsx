"use client";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, Notice } from "@/components/ui/card";
import { SelectField, TextField, TextAreaField } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import { formatInvoiceNumber, validateNumberFormat, type NumberReset } from "@/lib/finance/invoice-number";
import { formatDateTime } from "@/lib/format";
import type { NumberingStatus } from "@/server/services/numbering";

const RESET_LABEL: Record<NumberReset, string> = { NEVER: "Tidak pernah (nomor berlanjut terus)", YEARLY: "Setiap tahun", MONTHLY: "Setiap bulan" };

export function NumberingPanel({ status, canManage, today }: { status: NumberingStatus; canManage: boolean; today: string }) {
  const router = useRouter();
  const toast = useToast();
  const [cfg, setCfg] = useState({ format: status.format, prefix: status.prefix, reset: status.reset, start: String(status.start) });
  const [next, setNext] = useState(String(status.nextSeq));
  const [ack, setAck] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<null | "cfg" | "confirm" | "next">(null);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});

  const check = useMemo(() => validateNumberFormat(cfg.format, cfg.prefix), [cfg.format, cfg.prefix]);
  const sample = (seq: number) => (check.ok ? formatInvoiceNumber({ format: cfg.format, prefix: cfg.prefix, seq, date: today }) : "—");

  async function run(kind: "cfg" | "confirm" | "next", fn: () => Promise<unknown>, ok: string) {
    setBusy(kind); setError(null); setFe({});
    try { await fn(); toast.success(ok); router.refresh(); }
    catch (e) { setError(errorMessage(e)); if (e instanceof ApiClientError) setFe(e.fieldErrors); }
    finally { setBusy(null); }
  }

  return (
    <div className="space-y-5">
      {error && <Notice tone="danger">{error}</Notice>}
      {!status.confirmed ? (
        <Notice tone="warn">
          <strong>Penomoran belum diaktifkan.</strong> Invoice belum dapat diterbitkan sampai Administrator mengonfirmasi nomor berikutnya. Pastikan nomor yang Anda pilih <strong>belum pernah dipakai</strong> pada dokumen mana pun
          (contoh: invoice referensi bernomor <strong>00434</strong> — bila sudah terbit, mulai dari <strong>00435</strong>).
        </Notice>
      ) : (
        <Notice tone="success">Penomoran aktif sejak {formatDateTime(status.confirmedAt)}. Nomor berikutnya: <strong className="font-mono">{status.nextNumber}</strong> · terakhir terbit: <span className="font-mono">{status.lastIssuedNumber ?? "—"}</span></Notice>
      )}
      {status.collision && <Notice tone="danger">Nomor berikutnya ({status.nextNumber}) sudah dipakai invoice lain — ubah nomor berikutnya atau format.</Notice>}

      <Card>
        <CardHeader title="Format nomor" description="Token: {PREFIX} {YYYY} {YY} {MM} {SEQ:n}. Contoh: {SEQ:5} → 00434 · INV/TE/{YYYY}/{SEQ:4} → INV/TE/2026/0001" />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <TextField label="Format" required disabled={!canManage} value={cfg.format} onChange={(e) => setCfg({ ...cfg, format: e.target.value })} error={fe.invoiceNumberFormat ?? (check.ok ? undefined : check.error)} />
          <TextField label="Awalan {PREFIX}" disabled={!canManage} value={cfg.prefix} onChange={(e) => setCfg({ ...cfg, prefix: e.target.value })} error={fe.invoiceNumberPrefix} />
          <SelectField label="Reset urutan" disabled={!canManage} value={cfg.reset} onChange={(e) => setCfg({ ...cfg, reset: e.target.value as NumberReset })} hint="Reset mengikuti tanggal pada invoice.">
            {(Object.keys(RESET_LABEL) as NumberReset[]).map((r) => <option key={r} value={r}>{RESET_LABEL[r]}</option>)}
          </SelectField>
          <TextField label="Nomor awal untuk periode baru" inputMode="numeric" disabled={!canManage} value={cfg.start} onChange={(e) => setCfg({ ...cfg, start: e.target.value.replace(/\D/g, "") })} error={fe.invoiceNumberStart} hint="Dipakai saat sebuah scope (tahun/bulan) pertama kali dipakai." />
          <p className="sm:col-span-2 text-sm text-muted">Pratinjau: <span className="font-mono font-semibold text-ink">{sample(Number(cfg.start) || 1)}</span>, <span className="font-mono">{sample((Number(cfg.start) || 1) + 1)}</span>, <span className="font-mono">{sample((Number(cfg.start) || 1) + 2)}</span> …</p>
        </div>
        {canManage && <div className="flex justify-end border-t border-line bg-canvas/60 px-5 py-3"><Button variant="primary" disabled={!check.ok} loading={busy === "cfg"} onClick={() => void run("cfg", () => api("/api/settings/numbering", { method: "PATCH", body: { invoiceNumberFormat: cfg.format, invoiceNumberPrefix: cfg.prefix, invoiceNumberReset: cfg.reset, invoiceNumberStart: Number(cfg.start) || 1 } }), "Konfigurasi penomoran disimpan.")}>Simpan format</Button></div>}
      </Card>

      {canManage && !status.confirmed && (
        <Card>
          <CardHeader title="Aktivasi penomoran" description="Langkah wajib sebelum invoice pertama diterbitkan." />
          <div className="space-y-4 p-5">
            <TextField label="Nomor invoice berikutnya" required inputMode="numeric" value={next} onChange={(e) => setNext(e.target.value.replace(/\D/g, ""))} error={fe.nextNumber} hint={`Akan menjadi: ${sample(Number(next) || 1)}`} className="max-w-xs" />
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />Saya telah memeriksa bahwa nomor <strong className="font-mono">{sample(Number(next) || 1)}</strong> dan seterusnya belum pernah dipakai pada invoice/dokumen lain.</label>
            <Button variant="primary" disabled={!ack || !Number(next)} loading={busy === "confirm"} onClick={() => void run("confirm", () => api("/api/settings/numbering/confirm", { body: { nextNumber: Number(next), acknowledgeUnused: true } }), "Penomoran diaktifkan.")}>Aktifkan penomoran</Button>
          </div>
        </Card>
      )}

      {canManage && status.confirmed && (
        <Card>
          <CardHeader title="Naikkan nomor berikutnya" description="Mis. setelah menginput invoice lama secara manual. Nomor tidak boleh mundur; setiap perubahan tercatat di audit log." />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <TextField label="Urutan berikutnya" inputMode="numeric" value={next} onChange={(e) => setNext(e.target.value.replace(/\D/g, ""))} error={fe.nextNumber} hint={`Saat ini ${status.nextSeq} → ${sample(Number(next) || status.nextSeq)}`} />
            <TextAreaField label="Alasan" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} error={fe.reason} />
            <div className="sm:col-span-2"><Button loading={busy === "next"} disabled={reason.trim().length < 5} onClick={() => void run("next", () => api("/api/settings/numbering/next", { body: { nextNumber: Number(next), reason } }), "Nomor berikutnya diperbarui.")}>Terapkan</Button></div>
          </div>
        </Card>
      )}
    </div>
  );
}
