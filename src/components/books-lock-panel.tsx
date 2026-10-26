"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Lock, LockOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextAreaField, TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, api, errorMessage } from "@/lib/api-client";
import { formatDateLong } from "@/lib/format";

const yesterday = () => new Date(Date.now() + 7 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);

/** Penutupan buku: transaksi bertanggal ≤ tanggal tutup ditolak; koreksi lewat pembalikan bertanggal hari ini. */
export function BooksLockPanel({ lockedThrough, canLock }: { lockedThrough: string | null; canLock: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(lockedThrough ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});

  async function save(next: string | null) {
    setBusy(true); setError(null); setFe({});
    try {
      await api("/api/finance/books-lock", { method: "PUT", body: { lockedThrough: next, reason } });
      toast.success(next ? "Buku ditutup." : "Penutupan buku dicabut.");
      setOpen(false); setReason(""); router.refresh();
    } catch (e) {
      const f = e instanceof ApiClientError ? e.fieldErrors : {};
      setFe(f); setError(Object.keys(f).length ? null : errorMessage(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
      {lockedThrough ? <Lock className="size-4 shrink-0 text-brand-700" aria-hidden /> : <LockOpen className="size-4 shrink-0 text-muted" aria-hidden />}
      <div className="min-w-0 flex-1">
        {lockedThrough
          ? <span><strong>Buku ditutup sampai {formatDateLong(lockedThrough)}.</strong> Transaksi bertanggal sampai tanggal itu ditolak; koreksi dilakukan lewat pembalikan bertanggal hari ini.</span>
          : <span><strong>Buku belum ditutup.</strong> Transaksi bertanggal mundur masih dapat mengubah laporan periode lalu. Tutup buku setelah laporan bulanan final.</span>}
      </div>
      {canLock && <Button size="sm" onClick={() => { setDate(lockedThrough ?? ""); setOpen(true); }}>{lockedThrough ? "Ubah penutupan" : "Tutup buku"}</Button>}
      {open && (
        <Dialog open onClose={() => !busy && setOpen(false)} title="Penutupan buku" description="Pilih tanggal terakhir periode yang dikunci (harus sebelum hari ini). Perubahan dicatat di audit beserta alasannya."
          footer={<>
            <Button onClick={() => setOpen(false)} disabled={busy}>Batal</Button>
            {lockedThrough && <Button variant="danger" loading={busy} disabled={reason.trim().length < 5} onClick={() => void save(null)}>Cabut penutupan</Button>}
            <Button variant="primary" loading={busy} disabled={!date || reason.trim().length < 5} onClick={() => void save(date)}>Simpan</Button>
          </>}>
          <div className="space-y-4">
            {error && <Notice tone="danger">{error}</Notice>}
            <TextField label="Buku ditutup sampai tanggal" type="date" required value={date} max={yesterday()} onChange={(e) => setDate(e.target.value)} error={fe.lockedThrough} hint="Contoh: 31 Oktober 2026 setelah laporan Oktober final" />
            <TextAreaField label="Alasan" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} error={fe.reason} placeholder="mis. Laporan Oktober 2026 sudah direview" />
          </div>
        </Dialog>
      )}
    </div>
  );
}
