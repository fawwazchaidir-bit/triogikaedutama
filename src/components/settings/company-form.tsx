"use client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, Notice } from "@/components/ui/card";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import { formatRupiah } from "@/lib/finance/money";
import type { CompanySettingsDto } from "@/lib/types";

type FileField = "logoFileId" | "stampFileId" | "signatureFileId";
const FILE_KIND: Record<FileField, "LOGO" | "STAMP" | "SIGNATURE"> = { logoFileId: "LOGO", stampFileId: "STAMP", signatureFileId: "SIGNATURE" };

export function CompanyForm({ initial, readOnly }: { initial: CompanySettingsDto; readOnly: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [s, setS] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<FileField | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const set = (p: Partial<CompanySettingsDto>) => setS((x) => ({ ...x, ...p }));
  const dis = readOnly;

  async function upload(field: FileField, file: File | undefined) {
    if (!file) return;
    setUploading(field); setError(null);
    try {
      const fd = new FormData(); fd.append("file", file); fd.append("kind", FILE_KIND[field]);
      const res = await fetch("/api/settings/files", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok) throw new ApiClientError(j.error?.message ?? "Gagal mengunggah.", res.status, j.error?.code ?? "UNKNOWN");
      set({ [field]: j.data.id } as Partial<CompanySettingsDto>);
      toast.success("File diunggah. Klik Simpan untuk menerapkan.");
    } catch (e) { setError(errorMessage(e)); } finally { setUploading(null); }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setFe({});
    try {
      const { invoiceNumberFormat: _a, invoiceNumberPrefix: _b, invoiceNumberReset: _c, invoiceNumberStart: _d, invoiceNumberConfirmedAt: _e, ...body } = s;
      void [_a, _b, _c, _d, _e];
      await api("/api/settings", { method: "PATCH", body });
      toast.success("Pengaturan disimpan.");
      router.refresh();
    } catch (err) { setError(errorMessage(err)); if (err instanceof ApiClientError) setFe(err.fieldErrors); } finally { setBusy(false); }
  }

  const asset = (field: FileField, label: string, hint: string, showKey: "showLogo" | "showStamp" | "showSignature") => (
    <div className="rounded-md border border-line p-3">
      <p className="text-sm font-medium">{label}</p>
      <div className="mt-2 flex items-center gap-3">
        <div className="grid size-20 shrink-0 place-items-center overflow-hidden rounded bg-canvas">
          {s[field] ? <Image src={`/api/files/${s[field]}`} alt={label} width={80} height={80} unoptimized className="size-20 object-contain" /> : <span className="text-xs text-muted">Belum ada</span>}
        </div>
        <div className="space-y-2 text-sm">
          {!dis && <input type="file" accept="image/png,image/jpeg" aria-label={`Unggah ${label}`} disabled={uploading === field} onChange={(e) => void upload(field, e.target.files?.[0])} className="block w-52 text-xs file:mr-2 file:rounded file:border file:border-line file:bg-white file:px-2 file:py-1" />}
          <label className="flex items-center gap-2"><input type="checkbox" disabled={dis} checked={s[showKey]} onChange={(e) => set({ [showKey]: e.target.checked } as Partial<CompanySettingsDto>)} />Tampilkan di invoice</label>
          <p className="text-xs text-muted">{hint}</p>
        </div>
      </div>
    </div>
  );

  return (
    <form onSubmit={save} className="space-y-5">
      {error && <Notice tone="danger">{error}</Notice>}
      {dis && <Notice tone="info">Anda hanya dapat melihat pengaturan ini. Perubahan dilakukan oleh Administrator.</Notice>}
      <Card>
        <CardHeader title="Identitas lembaga" description="Dicetak pada setiap invoice baru. Invoice yang sudah terbit tetap memakai identitas saat diterbitkan." />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <TextField label="Nama lembaga" required disabled={dis} value={s.name} onChange={(e) => set({ name: e.target.value })} error={fe.name} />
          <TextField label="Tagline" disabled={dis} value={s.tagline ?? ""} onChange={(e) => set({ tagline: e.target.value })} error={fe.tagline} />
          <TextAreaField label="Alamat" required className="sm:col-span-2" rows={2} disabled={dis} value={s.address} onChange={(e) => set({ address: e.target.value })} error={fe.address} hint="Tekan Enter untuk memecah baris pada invoice." />
          <TextField label="Telepon" disabled={dis} value={s.phone ?? ""} onChange={(e) => set({ phone: e.target.value })} error={fe.phone} />
          <TextField label="Email" type="email" disabled={dis} value={s.email ?? ""} onChange={(e) => set({ email: e.target.value })} error={fe.email} />
          <TextField label="NPWP" disabled={dis} value={s.npwp ?? ""} onChange={(e) => set({ npwp: e.target.value })} error={fe.npwp} />
          <TextField label="Website" disabled={dis} value={s.website ?? ""} onChange={(e) => set({ website: e.target.value })} error={fe.website} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Penandatangan" />
        <div className="grid gap-4 p-5 sm:grid-cols-3">
          <TextField label="Nama penandatangan" required disabled={dis} value={s.signerName} onChange={(e) => set({ signerName: e.target.value })} error={fe.signerName} />
          <TextField label="Jabatan" required disabled={dis} value={s.signerTitle} onChange={(e) => set({ signerTitle: e.target.value })} error={fe.signerTitle} />
          <TextField label="Teks penutup" required disabled={dis} value={s.closingText} onChange={(e) => set({ closingText: e.target.value })} error={fe.closingText} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Logo, cap & tanda tangan" description="PNG atau JPEG, maksimal 3 MB. Berkas lama tetap tersimpan sehingga invoice terdahulu tidak berubah." />
        <div className="grid gap-4 p-5 lg:grid-cols-3">
          {asset("logoFileId", "Logo perusahaan", "Tampil di pojok kiri atas invoice.", "showLogo")}
          {asset("stampFileId", "Cap / stempel", "Hanya tercetak pada invoice yang diterbitkan.", "showStamp")}
          {asset("signatureFileId", "Tanda tangan", "Hanya tercetak pada invoice yang diterbitkan.", "showSignature")}
        </div>
      </Card>

      <Card>
        <CardHeader title="Ketentuan pembayaran default" />
        <div className="grid gap-4 p-5 sm:grid-cols-3">
          <TextField label="Metode pembayaran default" required disabled={dis} value={s.defaultPaymentMethod} onChange={(e) => set({ defaultPaymentMethod: e.target.value })} error={fe.defaultPaymentMethod} />
          <TextField label="Jangka waktu default (hari)" required inputMode="numeric" disabled={dis} value={String(s.defaultPaymentTermDays)} onChange={(e) => set({ defaultPaymentTermDays: Number(e.target.value.replace(/\D/g, "") || 0) })} error={fe.defaultPaymentTermDays} />
          <SelectField label="Hitungan hari" disabled={dis} value={s.defaultDueDateBasis} onChange={(e) => set({ defaultDueDateBasis: e.target.value as typeof s.defaultDueDateBasis })}>
            <option value="CALENDAR_DAYS">Hari kalender</option><option value="BUSINESS_DAYS">Hari kerja (Senin–Jumat)</option>
          </SelectField>
          <TextAreaField label="Catatan pembayaran (di bawah rekening)" className="sm:col-span-3" rows={2} disabled={dis} value={s.paymentNote ?? ""} onChange={(e) => set({ paymentNote: e.target.value })} error={fe.paymentNote} placeholder="mis. Mohon cantumkan nomor invoice pada berita transfer." />
          <TextAreaField label="Footer dokumen" className="sm:col-span-3" rows={2} disabled={dis} value={s.footerNote ?? ""} onChange={(e) => set({ footerNote: e.target.value })} error={fe.footerNote} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Tampilan dokumen" />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <SelectField label="Format Rupiah" disabled={dis} value={s.rupiahStyle} onChange={(e) => set({ rupiahStyle: e.target.value as typeof s.rupiahStyle })} hint={`Contoh: ${formatRupiah(14_000_000, s.rupiahStyle)}`}>
            <option value="REFERENCE">Gaya invoice referensi — Rp. 14.000.000,-</option><option value="PLAIN">Rp 14.000.000</option><option value="DECIMAL">Rp 14.000.000,00</option>
          </SelectField>
          <SelectField label="Sumber terbilang (Inword)" disabled={dis} value={s.terbilangSource} onChange={(e) => set({ terbilangSource: e.target.value as typeof s.terbilangSource })} hint="Standar: total invoice. 'Sisa tagihan' = total dikurangi DP.">
            <option value="TOTAL">Total invoice (Nett Total)</option><option value="BALANCE">Sisa tagihan setelah DP</option>
          </SelectField>
        </div>
        {!dis && <div className="flex justify-end border-t border-line bg-canvas/60 px-5 py-3"><Button type="submit" variant="primary" loading={busy}>Simpan pengaturan</Button></div>}
      </Card>
    </form>
  );
}
