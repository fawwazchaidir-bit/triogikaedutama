"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { TextAreaField } from "@/components/ui/field";
import { Menu } from "@/components/ui/menu";
import { Notice } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { RecordPaymentDialog } from "@/components/record-payment-dialog";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import { formatRupiah } from "@/lib/finance/money";

export interface InvoiceActionTarget {
  id: string;
  number: string | null;
  status: "DRAFT" | "SUBMITTED" | "ISSUED" | "CANCELLED";
  customerName: string;
  totalAmount: number;
  balanceAmount: number;
}

export interface InvoiceCan {
  edit: boolean; submit: boolean; recall: boolean; approve: boolean; reject: boolean;
  cancel: boolean; pay: boolean; pdf: boolean; duplicate: boolean; remove: boolean;
}


/** Seluruh aksi invoice. `bar` = tombol-tombol (halaman detail); `menu` = menu titik tiga (baris tabel). */
export function InvoiceActions({ inv, can, variant = "menu", onDone, initialDialog }: { inv: InvoiceActionTarget; can: InvoiceCan; variant?: "menu" | "bar"; onDone?: () => void; initialDialog?: "preview" }) {
  const router = useRouter();
  const toast = useToast();
  const [dlg, setDlg] = useState<null | "submit" | "recall" | "approve" | "reject" | "cancel" | "pay" | "preview" | "delete">(initialDialog ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const close = () => { if (!busy) { setDlg(null); setError(null); setFieldErrors({}); } };
  const done = (msg: string, to?: string) => {
    toast.success(msg);
    setDlg(null); setBusy(false);
    if (to) router.push(to);
    router.refresh();
    onDone?.();
  };
  const fail = (e: unknown) => {
    setBusy(false);
    // Kesalahan per-field ditampilkan di bawah kolomnya; banner hanya untuk kesalahan umum (hindari pesan ganda).
    const fe = e instanceof ApiClientError ? e.fieldErrors : {};
    setFieldErrors(fe);
    setError(Object.keys(fe).length ? null : errorMessage(e));
    // Konflik (mis. sudah diterbitkan di tab lain): segarkan data di belakang dialog.
    if (e instanceof ApiClientError && e.code === "CONFLICT") router.refresh();
  };
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(null); setFieldErrors({}); try { await fn(); } catch (e) { fail(e); } };

  // ── form state ──
  const [reason, setReason] = useState("");
  const [replacement, setReplacement] = useState(true);

  const label = inv.number ?? "draft";
  const pdfBase = `/api/invoices/${inv.id}/pdf`;
  const canPdfNow = can.pdf;
  const unissued = inv.status === "DRAFT" || inv.status === "SUBMITTED";

  const items = [
    { label: "Lihat detail", href: `/invoices/${inv.id}` },
    { label: "Edit draft", href: `/invoices/${inv.id}/edit`, hidden: !(inv.status === "DRAFT" && can.edit) },
    { label: "Ajukan untuk verifikasi…", onSelect: () => setDlg("submit"), hidden: !can.submit },
    { label: "Setujui & terbitkan…", onSelect: () => setDlg("approve"), hidden: !can.approve },
    { label: "Kembalikan ke staff…", onSelect: () => setDlg("reject"), hidden: !can.reject },
    { label: "Tarik kembali pengajuan…", onSelect: () => setDlg("recall"), hidden: !can.recall },
    { label: unissued ? "Preview PDF (draft)" : "Preview PDF", onSelect: () => setDlg("preview"), hidden: !canPdfNow },
    { label: "Unduh PDF", href: `${pdfBase}?download=1`, download: true, hidden: !canPdfNow || unissued },
    { label: "Catat pembayaran…", onSelect: () => setDlg("pay"), hidden: !(inv.status === "ISSUED" && inv.balanceAmount > 0 && can.pay) },
    { label: "Duplikasi", onSelect: () => run(async () => { const d = await api<{ id: string }>(`/api/invoices/${inv.id}/duplicate`, { method: "POST", body: {} }); done("Draft baru dibuat dari invoice ini.", `/invoices/${d.id}/edit`); }), hidden: !can.duplicate },
    "sep" as const,
    { label: "Batalkan invoice…", onSelect: () => setDlg("cancel"), danger: true, hidden: !(inv.status === "ISSUED" && can.cancel) },
    { label: "Hapus draft…", onSelect: () => setDlg("delete"), danger: true, hidden: !(inv.status === "DRAFT" && can.remove) },
  ];

  return (
    <>
      {variant === "menu" ? <Menu items={items} label={`Aksi invoice ${label}`} /> : (
        <div className="flex flex-wrap items-center gap-2">
          {inv.status === "DRAFT" && can.edit && <Link href={`/invoices/${inv.id}/edit`} className="inline-flex h-10 items-center rounded-md border border-line bg-white px-4 text-sm font-medium shadow-sm hover:bg-canvas">Edit draft</Link>}
          {canPdfNow && <Button onClick={() => setDlg("preview")}>{unissued ? "Preview PDF (draft)" : "Preview PDF"}</Button>}
          {canPdfNow && !unissued && <a href={`${pdfBase}?download=1`} className="inline-flex h-10 items-center rounded-md border border-line bg-white px-4 text-sm font-medium shadow-sm hover:bg-canvas">Unduh PDF</a>}
          {can.submit && <Button variant="primary" onClick={() => setDlg("submit")}>Ajukan untuk verifikasi</Button>}
          {can.approve && <Button variant="primary" onClick={() => setDlg("approve")}>Setujui &amp; terbitkan</Button>}
          {can.reject && <Button variant="danger" onClick={() => setDlg("reject")}>Kembalikan ke staff</Button>}
          {can.recall && <Button onClick={() => setDlg("recall")}>Tarik kembali</Button>}
          {inv.status === "ISSUED" && inv.balanceAmount > 0 && can.pay && <Button variant="primary" onClick={() => setDlg("pay")}>Catat pembayaran</Button>}
          <Menu items={items.filter((i) => i === "sep" || ["Duplikasi", "Batalkan invoice…", "Hapus draft…"].includes(i.label))} label="Aksi lainnya" />
        </div>
      )}

      {/* Pratinjau PDF: iframe ke endpoint yang memakai SNAPSHOT tersimpan, bukan input browser. */}
      <Dialog open={dlg === "preview"} onClose={close} title={`Preview invoice ${label}`} size="xl"
        footer={<>
          {canPdfNow && !unissued && <a href={`${pdfBase}?download=1`} className="inline-flex h-10 items-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700">Unduh PDF</a>}
          <Button onClick={close}>Tutup</Button></>}>
        {unissued && <p className="mb-2 text-xs text-muted">Dokumen berwatermark <b>DRAFT</b> — belum bernomor, tanpa tanda tangan &amp; cap. Belum untuk dikirim ke pelanggan; versi resmi baru tersedia setelah diverifikasi Finance Manager.</p>}
        <iframe title={`Pratinjau PDF ${label}`} src={`${pdfBase}#toolbar=0&navpanes=0`} className="h-[68vh] w-full rounded border border-line bg-canvas" />
      </Dialog>

      <ConfirmDialog open={dlg === "submit"} onClose={close} title="Ajukan untuk verifikasi?" confirmLabel="Ya, ajukan" loading={busy}
        description="Isi invoice akan dikunci dan dikirim ke Finance Manager untuk diperiksa. Selama menunggu, dokumen tetap berwatermark DRAFT (tanpa nomor, tanda tangan, dan cap). Anda dapat menarik kembali pengajuan selama belum diverifikasi."
        onConfirm={() => run(async () => { await api(`/api/invoices/${inv.id}/submit`, { method: "POST", body: {} }); done("Invoice diajukan untuk verifikasi.", `/invoices/${inv.id}`); })}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Pelanggan</dt><dd className="font-medium">{inv.customerName}</dd>
          <dt className="text-muted">Total invoice</dt><dd className="tabular font-semibold">{formatRupiah(inv.totalAmount, "PLAIN")}</dd>
        </dl>
        {error && <div className="mt-3"><Notice tone="danger">{error}</Notice></div>}
      </ConfirmDialog>

      <ConfirmDialog open={dlg === "recall"} onClose={close} title="Tarik kembali pengajuan?" confirmLabel="Ya, tarik kembali" loading={busy}
        description="Invoice kembali menjadi draft sehingga dapat Anda edit lagi. Ajukan ulang setelah selesai."
        onConfirm={() => run(async () => { await api(`/api/invoices/${inv.id}/recall`, { method: "POST", body: {} }); done("Pengajuan ditarik kembali.", `/invoices/${inv.id}`); })}>
        {error && <Notice tone="danger">{error}</Notice>}
      </ConfirmDialog>

      <ConfirmDialog open={dlg === "reject"} onClose={close} title="Kembalikan ke staff?" confirmLabel="Kembalikan" tone="danger" loading={busy}
        description="Invoice kembali menjadi draft dan dapat diperbaiki staff. Alasan wajib diisi dan akan ditampilkan kepada staff."
        onConfirm={() => run(async () => { await api(`/api/invoices/${inv.id}/reject`, { method: "POST", body: { reason } }); setReason(""); done("Pengajuan dikembalikan ke staff.", `/invoices/${inv.id}`); })}>
        <div className="space-y-3">
          <TextAreaField label="Alasan / catatan perbaikan" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} error={fieldErrors.reason} placeholder="mis. Nama peserta belum lengkap; periksa harga satuan" />
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      </ConfirmDialog>

      <ConfirmDialog open={dlg === "approve"} onClose={close} title="Setujui & terbitkan invoice?" confirmLabel="Ya, setujui & terbitkan" loading={busy}
        description="Nomor invoice akan dialokasikan, dokumen dibekukan, dan tanda tangan Finance Manager beserta cap muncul pada PDF resmi. Setelah terbit, isi tidak dapat diubah — koreksi dilakukan lewat pembatalan dan penerbitan ulang."
        onConfirm={() => run(async () => { const r = await api<{ number: string }>(`/api/invoices/${inv.id}/issue`, { body: { expectedTotalAmount: inv.totalAmount } }); done(`Invoice ${r.number} disetujui dan diterbitkan.`, `/invoices/${inv.id}`); })}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Pelanggan</dt><dd className="font-medium">{inv.customerName}</dd>
          <dt className="text-muted">Total invoice</dt><dd className="tabular font-semibold">{formatRupiah(inv.totalAmount, "PLAIN")}</dd>
        </dl>
        {error && <div className="mt-3"><Notice tone="danger">{error}</Notice></div>}
      </ConfirmDialog>

      <ConfirmDialog open={dlg === "delete"} onClose={close} title="Hapus draft?" confirmLabel="Hapus draft" tone="danger" loading={busy}
        description="Draft belum memiliki nomor dan akan dihapus permanen (tercatat di audit log)."
        onConfirm={() => run(async () => { await api(`/api/invoices/${inv.id}`, { method: "DELETE" }); done("Draft dihapus.", "/invoices"); })}>
        {error && <Notice tone="danger">{error}</Notice>}
      </ConfirmDialog>

      <ConfirmDialog open={dlg === "cancel"} onClose={close} title={`Batalkan invoice ${label}?`} confirmLabel="Batalkan invoice" tone="danger" loading={busy}
        description="Invoice tetap tersimpan dengan statusnya (nomor tidak dipakai ulang). Tindakan ini tidak dapat dibatalkan."
        onConfirm={() => run(async () => {
          const r = await api<{ replacementId: string | null }>(`/api/invoices/${inv.id}/cancel`, { body: { reason, createReplacement: replacement } });
          done("Invoice dibatalkan.", r.replacementId ? `/invoices/${r.replacementId}/edit` : undefined);
        })}>
        <div className="space-y-3">
          <TextAreaField label="Alasan pembatalan" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} error={fieldErrors.reason} placeholder="mis. Salah nama pelanggan" />
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={replacement} onChange={(e) => setReplacement(e.target.checked)} />Buat draft pengganti (salinan) untuk diperbaiki dan diterbitkan ulang</label>
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      </ConfirmDialog>

      <RecordPaymentDialog open={dlg === "pay"} onClose={close} invoice={inv} onDone={() => done("Pembayaran dicatat.")} />
    </>
  );
}
