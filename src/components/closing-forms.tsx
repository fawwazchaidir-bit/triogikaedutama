"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextAreaField } from "@/components/ui/field";
import { Notice } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, api, errorMessage } from "@/lib/api-client";
import type { CheckItem } from "@/lib/accounting/periods";

/** Pembungkus kecil: jalankan aksi API, tampilkan galat (banner atau per-kolom), segarkan halaman. */
function useAction(done: string) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  async function run(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true); setError(null); setFe({});
    try { await fn(); toast.success(done); router.refresh(); return true; }
    catch (e) { const f = e instanceof ApiClientError ? e.fieldErrors : {}; setFe(f); setError(Object.keys(f).length ? null : errorMessage(e)); return false; }
    finally { setBusy(false); }
  }
  return { busy, error, fe, run };
}

interface Checklist { label: string; checks: CheckItem[]; closable: boolean }

/** Tutup bulan: periksa daftar periksa langsung dari server, akui peringatan satu per satu, wajib catatan. */
export function ClosePeriodButton({ year, month, label }: { year: number; month: number; label: string }) {
  const [open, setOpen] = useState(false);
  const a = useAction(`${label} ditutup.`);
  const [list, setList] = useState<Checklist | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ack, setAck] = useState<string[]>([]);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api<Checklist>(`/api/finance/periods/checklist?year=${year}&month=${month}`)
      .then((r) => { if (!cancelled) { setList(r); setLoadError(null); } })
      .catch((e) => { if (!cancelled) setLoadError(errorMessage(e)); });
    return () => { cancelled = true; };
  }, [open, year, month]);

  const soft = list?.checks.filter((c) => c.severity === "SOFT" && !c.ok) ?? [];
  const allAcked = soft.every((c) => ack.includes(c.id));
  const toggle = (id: string) => setAck((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const ready = !!list?.closable && allAcked && note.trim().length >= 5;

  return (
    <>
      <Button size="sm" variant="primary" onClick={() => { setList(null); setLoadError(null); setAck([]); setNote(""); setOpen(true); }}>Tutup bulan</Button>
      {open && (
        <Dialog open size="lg" onClose={() => !a.busy && setOpen(false)} title={`Tutup buku ${label}`}
          description="Setelah ditutup, transaksi bertanggal sampai akhir bulan ini ditolak dan laporan bulan ini dibekukan (foto + hash). Koreksi dilakukan lewat pembalikan bertanggal hari ini."
          footer={<><Button onClick={() => setOpen(false)} disabled={a.busy}>Batal</Button>
            <Button variant="primary" loading={a.busy} disabled={!ready}
              onClick={async () => { if (await a.run(() => api("/api/finance/periods/close", { method: "POST", body: { year, month, acknowledge: ack, note } }))) setOpen(false); }}>Tutup {label}</Button></>}>
          <div className="space-y-4">
            {a.error && <Notice tone="danger">{a.error}</Notice>}
            {loadError && <Notice tone="danger">{loadError}</Notice>}
            {!list && !loadError && <p className="text-sm text-muted">Memeriksa pembukuan…</p>}
            {list && (
              <ul className="divide-y divide-line rounded-lg border border-line text-sm" aria-label="Daftar periksa penutupan">
                {list.checks.map((c) => (
                  <li key={c.id} className="flex items-start gap-3 px-4 py-3" data-check={c.id} data-ok={c.ok}>
                    {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-label="Lolos" />
                      : c.severity === "HARD" ? <XCircle className="mt-0.5 size-4 shrink-0 text-brand-700" aria-label="Menghalangi" />
                        : <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-label="Peringatan" />}
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{c.label}{c.severity === "SOFT" && <span className="ml-2 text-xs font-normal text-muted">peringatan</span>}</p>
                      <p className={c.ok ? "text-muted" : c.severity === "HARD" ? "text-brand-700" : "text-ink-soft"}>{c.detail}</p>
                      {!c.ok && c.severity === "SOFT" && (
                        <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" name={`ack-${c.id}`} checked={ack.includes(c.id)} onChange={() => toggle(c.id)} /> Saya sudah meninjau dan menerima ini</label>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {list && !list.closable && <Notice tone="warn">Ada syarat wajib yang belum terpenuhi. Selesaikan dulu, lalu buka dialog ini lagi.</Notice>}
            <TextAreaField label="Catatan penutupan" required rows={2} name="note" value={note} onChange={(e) => setNote(e.target.value)} error={a.fe.note}
              placeholder="mis. Laporan Oktober direview Finance Manager, rekonsiliasi BCA selesai" />
          </div>
        </Dialog>
      )}
    </>
  );
}

/** Buka kembali periode terakhir yang ditutup (alasan wajib; tercatat di audit). */
export function ReopenPeriodButton({ year, month, label }: { year: number; month: number; label: string }) {
  const [open, setOpen] = useState(false);
  const a = useAction(`${label} dibuka kembali.`);
  const [reason, setReason] = useState("");
  return (
    <>
      <Button size="sm" onClick={() => { setReason(""); setOpen(true); }}>Buka kembali</Button>
      {open && (
        <Dialog open onClose={() => !a.busy && setOpen(false)} title={`Buka kembali ${label}`}
          description="Hanya periode terakhir yang ditutup yang dapat dibuka. Foto penutupan lama tetap tercatat di audit; menutup ulang membuat foto baru."
          footer={<><Button onClick={() => setOpen(false)} disabled={a.busy}>Batal</Button>
            <Button variant="danger" loading={a.busy} disabled={reason.trim().length < 5}
              onClick={async () => { if (await a.run(() => api("/api/finance/periods/reopen", { method: "POST", body: { year, month, reason } }))) setOpen(false); }}>Buka kembali</Button></>}>
          <div className="space-y-4">
            {a.error && <Notice tone="danger">{a.error}</Notice>}
            <TextAreaField label="Alasan" required rows={2} name="reason" value={reason} onChange={(e) => setReason(e.target.value)} error={a.fe.reason} placeholder="mis. Koreksi akrual yang terlewat" />
          </div>
        </Dialog>
      )}
    </>
  );
}
