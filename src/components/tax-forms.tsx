"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { Notice } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, api, errorMessage } from "@/lib/api-client";
import type { CashAccountOptionDto } from "@/lib/finance-types";

const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

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
  /** Pesan untuk dialog tanpa kolom per-field: galat umum, atau galat kolom pertama bila server menyebutnya. */
  const message = error ?? Object.values(fe)[0] ?? null;
  return { busy, error, fe, message, run, reset: () => { setError(null); setFe({}); } };
}

/** Profil pajak (Admin): status PKP, rezim PPh badan, tarif (basis poin). Tarif TIDAK diisi sistem. */
export function TaxProfileButton({ profile }: { profile: { isPkp: boolean; regime: "NONE" | "GENERAL" | "FINAL"; rateBps: number | null } }) {
  const [open, setOpen] = useState(false);
  const a = useAction("Profil pajak disimpan.");
  const [isPkp, setPkp] = useState(profile.isPkp);
  const [regime, setRegime] = useState(profile.regime);
  const [rate, setRate] = useState(profile.rateBps === null ? "" : String(profile.rateBps / 100));
  const bps = rate.trim() === "" ? null : Math.round(Number(rate.replace(",", ".")) * 100);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Ubah profil pajak</Button>
      {open && (
        <Dialog open onClose={() => !a.busy && setOpen(false)} title="Profil pajak" description="Sistem tidak mengasumsikan tarif. Isi sesuai arahan konsultan pajak; hasil hanya estimasi."
          footer={<><Button onClick={() => setOpen(false)} disabled={a.busy}>Batal</Button><Button variant="primary" loading={a.busy} onClick={async () => { if (await a.run(() => api("/api/finance/taxes/profile", { method: "PUT", body: { isPkp, regime, rateBps: regime === "NONE" && bps === null ? null : bps } }))) setOpen(false); }}>Simpan</Button></>}>
          <div className="space-y-4">
            {a.error && <Notice tone="danger">{a.error}</Notice>}
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={isPkp} onChange={(e) => setPkp(e.target.checked)} /> Perusahaan adalah Pengusaha Kena Pajak (PKP)</label>
            <SelectField label="Rezim PPh badan" value={regime} onChange={(e) => setRegime(e.target.value as typeof regime)} error={a.fe.regime}
              hint={regime === "GENERAL" ? "Tarif atas penghasilan kena pajak tahunan (laba + koreksi fiskal − kompensasi rugi)" : regime === "FINAL" ? "Tarif atas peredaran bruto bulanan (di luar PPN)" : "Estimasi PPh badan tidak dihitung"}>
              <option value="NONE">Tidak dihitung</option><option value="GENERAL">Tarif umum (tahunan)</option><option value="FINAL">PPh final (peredaran bruto bulanan)</option>
            </SelectField>
            {regime !== "NONE" && <TextField label="Tarif (%)" required inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} error={a.fe.rateBps} hint="Contoh: isi sesuai ketentuan yang berlaku bagi perusahaan Anda (2 desimal)" />}
          </div>
        </Dialog>
      )}
    </>
  );
}

/** Masukan tahunan estimasi PPh badan (koreksi fiskal, kompensasi rugi, pengurang pajak). */
export function TaxYearInputButton({ year, input }: { year: number; input: { fiscalCorrection: number; lossCompensation: number; facilityReduction: number; note: string | null } }) {
  const [open, setOpen] = useState(false);
  const a = useAction("Masukan pajak tahunan disimpan.");
  const [fc, setFc] = useState<number | null>(input.fiscalCorrection);
  const [neg, setNeg] = useState(input.fiscalCorrection < 0);
  const [lc, setLc] = useState<number | null>(input.lossCompensation);
  const [fr, setFr] = useState<number | null>(input.facilityReduction);
  const [note, setNote] = useState(input.note ?? "");
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Masukan tahun {year}</Button>
      {open && (
        <Dialog open onClose={() => !a.busy && setOpen(false)} title={`Masukan pajak tahun ${year}`} description="Angka yang tidak dapat diturunkan dari pembukuan — dari akuntan/konsultan pajak. Tercatat di audit."
          footer={<><Button onClick={() => setOpen(false)} disabled={a.busy}>Batal</Button><Button variant="primary" loading={a.busy} onClick={async () => { if (await a.run(() => api("/api/finance/taxes/year-input", { method: "PUT", body: { year, fiscalCorrection: (fc ?? 0) * (neg ? -1 : 1), lossCompensation: lc ?? 0, facilityReduction: fr ?? 0, note } }))) setOpen(false); }}>Simpan</Button></>}>
          <div className="space-y-4">
            {a.error && <Notice tone="danger">{a.error}</Notice>}
            <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
              <MoneyInput label="Koreksi fiskal neto" value={fc} onChange={setFc} error={a.fe.fiscalCorrection} hint="Positif menambah, negatif mengurangi penghasilan kena pajak" />
              <label className="mt-7 flex items-center gap-2 text-sm"><input type="checkbox" checked={neg} onChange={(e) => setNeg(e.target.checked)} /> Negatif (mengurangi)</label>
            </div>
            <MoneyInput label="Kompensasi kerugian fiskal yang dipakai" value={lc} onChange={setLc} error={a.fe.lossCompensation} />
            <MoneyInput label="Pengurang pajak terutang (fasilitas)" value={fr} onChange={setFr} error={a.fe.facilityReduction} hint="Dihitung akuntan; tidak melebihi pajak sebelum pengurang" />
            <TextAreaField label="Catatan" rows={2} value={note} onChange={(e) => setNote(e.target.value)} error={a.fe.note} />
          </div>
        </Dialog>
      )}
    </>
  );
}

/** Catat jurnal penyesuaian PPh badan (nominal dihitung ulang di server). */
export function PostTaxJournalButton({ year, month, description }: { year: number; month: number | null; description: string }) {
  const [open, setOpen] = useState(false);
  const a = useAction("Jurnal PPh dicatat.");
  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>Catat jurnal penyesuaian</Button>
      <ConfirmDialog open={open} onClose={() => !a.busy && setOpen(false)} loading={a.busy} confirmLabel="Ya, catat jurnal" title="Catat jurnal PPh?"
        description={`${description}. Nominal dihitung ulang server dari pembukuan dan masukan terakhir. Koreksi lewat pembalikan.`}
        onConfirm={async () => { if (await a.run(() => api("/api/finance/taxes/corporate-journal", { body: { year, ...(month ? { month } : {}) } }))) setOpen(false); }}>
        {a.message && <Notice tone="danger">{a.message}</Notice>}
      </ConfirmDialog>
    </>
  );
}

/** Setoran PPN / PPh badan (kas keluar; utang pajak berkurang). */
export function TaxPaymentButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>Catat setoran pajak</Button>
      {open && <TaxPaymentDialog onClose={() => setOpen(false)} />}
    </>
  );
}
function TaxPaymentDialog({ onClose }: { onClose: () => void }) {
  const a = useAction("Setoran pajak dicatat.");
  const [accounts, setAccounts] = useState<CashAccountOptionDto[]>([]);
  useEffect(() => { let live = true; api<CashAccountOptionDto[]>("/api/finance/cash-accounts/options").then((x) => { if (live) setAccounts(x); }, () => undefined); return () => { live = false; }; }, []);
  const [f, setF] = useState({ kind: "PPN", taxPeriod: "", entryDate: today(), cashAccountId: "", amount: null as number | null, reference: "" });
  const [proof, setProof] = useState<File | null>(null);
  async function submit() {
    let proofFileId: string | null = null;
    if (proof) {
      const fd = new FormData(); fd.append("file", proof);
      const res = await fetch("/api/finance/proof", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok) throw new ApiClientError(j.error?.message ?? "Gagal mengunggah bukti.", res.status, j.error?.code ?? "UNKNOWN", j.error?.fieldErrors);
      proofFileId = j.data.id;
    }
    await api("/api/finance/taxes/payments", { body: { ...f, amount: f.amount ?? 0, cashAccountId: f.cashAccountId || accounts[0]?.id, proofFileId } });
  }
  return (
    <Dialog open onClose={() => !a.busy && onClose()} title="Catat setoran pajak" description="Uang keluar untuk membayar pajak yang sudah dititipkan (bukan beban). Bukti (billing/NTPN) wajib untuk nominal di atas Rp1.000.000."
      footer={<><Button onClick={onClose} disabled={a.busy}>Batal</Button><Button variant="primary" loading={a.busy} onClick={async () => { if (await a.run(submit)) onClose(); }}>Simpan</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {a.error && <div className="sm:col-span-2"><Notice tone="danger">{a.error}</Notice></div>}
        <SelectField label="Jenis" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="PPN">PPN (kurangi utang PPN)</option><option value="PPH_BADAN">PPh badan (angsuran / kurang bayar)</option></SelectField>
        <TextField label="Masa / tahun pajak" required value={f.taxPeriod} onChange={(e) => setF({ ...f, taxPeriod: e.target.value })} placeholder="2026-01 atau 2026" error={a.fe.taxPeriod} />
        <TextField label="Tanggal setor" type="date" required value={f.entryDate} max={today()} onChange={(e) => setF({ ...f, entryDate: e.target.value })} error={a.fe.entryDate} />
        <SelectField label="Dibayar dari" value={f.cashAccountId} onChange={(e) => setF({ ...f, cashAccountId: e.target.value })} error={a.fe.cashAccountId}>
          {accounts.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </SelectField>
        <MoneyInput label="Nominal" required value={f.amount} onChange={(v) => setF({ ...f, amount: v })} error={a.fe.amount} />
        <TextField label="NTPN / ID billing" required value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} error={a.fe.reference} />
        <div className="sm:col-span-2">
          <label htmlFor="taxproof" className="mb-1.5 block text-sm font-medium text-ink-soft">Bukti setor (wajib di atas Rp 1.000.000)</label>
          <input id="taxproof" type="file" accept="image/png,image/jpeg,application/pdf" onChange={(e) => setProof(e.target.files?.[0] ?? null)} className="block w-full text-sm" />
          {a.fe.proofFileId && <p role="alert" className="mt-1 text-xs font-medium text-brand-700">{a.fe.proofFileId}</p>}
        </div>
      </div>
    </Dialog>
  );
}

/** Lengkapi nomor bukti potong yang baru diterima. */
export function WithholdingRefButton({ paymentId }: { paymentId: string }) {
  const [open, setOpen] = useState(false);
  const [ref, setRef] = useState("");
  const a = useAction("Nomor bukti potong disimpan.");
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Isi nomor</Button>
      {open && (
        <Dialog open onClose={() => !a.busy && setOpen(false)} title="Nomor bukti potong" description="Hanya dapat diisi sekali. Untuk koreksi, balikkan pembayaran lalu catat ulang."
          footer={<><Button onClick={() => setOpen(false)} disabled={a.busy}>Batal</Button><Button variant="primary" loading={a.busy} onClick={async () => { if (await a.run(() => api(`/api/payments/${paymentId}/withholding-ref`, { method: "PUT", body: { ref } }))) setOpen(false); }}>Simpan</Button></>}>
          <div className="space-y-3">
            {a.error && <Notice tone="danger">{a.error}</Notice>}
            <TextField label="Nomor bukti potong" required value={ref} onChange={(e) => setRef(e.target.value)} error={a.fe.ref} />
          </div>
        </Dialog>
      )}
    </>
  );
}
