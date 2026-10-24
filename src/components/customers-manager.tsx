"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, ConfirmDialog } from "@/components/ui/dialog";
import { TextAreaField, TextField } from "@/components/ui/field";
import { EmptyState, Notice } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import { formatRupiah } from "@/lib/finance/money";
import type { CustomerSummaryDto } from "@/lib/types";

type Form = { name: string; city: string; contactName: string; contactTitle: string; address: string; phone: string; email: string; npwp: string; internalNote: string };
const blank: Form = { name: "", city: "", contactName: "", contactTitle: "", address: "", phone: "", email: "", npwp: "", internalNote: "" };
const fromDto = (c: CustomerSummaryDto): Form => ({
  name: c.name, city: c.city ?? "", contactName: c.contactName ?? "", contactTitle: c.contactTitle ?? "", address: c.address ?? "",
  phone: c.phone ?? "", email: c.email ?? "", npwp: c.npwp ?? "", internalNote: c.internalNote ?? "",
});

export function CustomersManager({ items, can, emptyHint }: { items: CustomerSummaryDto[]; can: { create: boolean; update: boolean; archive: boolean }; emptyHint?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<null | { id: string | null; form: Form }>(null);
  const [archiving, setArchiving] = useState<CustomerSummaryDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [dups, setDups] = useState<{ id: string; name: string; city: string | null; isActive: boolean }[] | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);

  const reset = () => { setError(null); setFe({}); setDups(null); setNeedsConfirm(false); };

  async function save(confirmDistinct = false) {
    if (!editing) return;
    setBusy(true); reset();
    try {
      const body = { ...editing.form, confirmDistinct };
      if (editing.id) await api(`/api/customers/${editing.id}`, { method: "PUT", body });
      else await api("/api/customers", { body });
      toast.success(editing.id ? "Pelanggan diperbarui." : "Pelanggan ditambahkan.");
      setEditing(null);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiClientError) {
        setFe(e.fieldErrors);
        setDups((e.details.duplicates as typeof dups) ?? null);
        setNeedsConfirm(Boolean(e.details.needsConfirmation));
      }
    } finally { setBusy(false); }
  }

  async function setActive(c: CustomerSummaryDto, isActive: boolean) {
    setBusy(true);
    try {
      await api(`/api/customers/${c.id}`, { method: "PATCH", body: { isActive } });
      toast.success(isActive ? "Pelanggan diaktifkan kembali." : "Pelanggan diarsipkan. Histori invoice tetap tersimpan.");
      setArchiving(null);
      router.refresh();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(false); }
  }

  const f = editing?.form;
  const set = (patch: Partial<Form>) => setEditing((s) => (s ? { ...s, form: { ...s.form, ...patch } } : s));

  return (
    <>
      {can.create && (
        <div className="flex justify-end p-4 pb-0">
          <Button variant="primary" onClick={() => { reset(); setEditing({ id: null, form: blank }); }}><Plus className="size-4" />Tambah pelanggan</Button>
        </div>
      )}
      {items.length === 0 ? <EmptyState title="Belum ada pelanggan" description={emptyHint ?? "Tambahkan pelanggan pertama untuk mulai membuat invoice."} /> : (
      <TableWrap>
        <Table>
          <thead><tr><Th>Pelanggan</Th><Th>Kontak</Th><Th align="right">Invoice</Th><Th align="right">Nilai invoice</Th><Th align="right">Dibayar</Th><Th align="right">Piutang</Th><Th>Status</Th><Th align="right">Aksi</Th></tr></thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id} className="hover:bg-canvas/60">
                <Td><Link href={`/customers/${c.id}`} className="font-semibold hover:text-brand-700 hover:underline">{c.name}</Link><span className="block text-xs text-muted">{[c.city, c.npwp && `NPWP ${c.npwp}`].filter(Boolean).join(" · ")}</span></Td>
                <Td>{c.contactName ?? "—"}<span className="block text-xs text-muted">{[c.phone, c.email].filter(Boolean).join(" · ")}</span></Td>
                <Td align="right">{c.invoiceCount}</Td>
                <Td align="right">{formatRupiah(c.invoicedAmount, "PLAIN")}</Td>
                <Td align="right">{formatRupiah(c.paidAmount, "PLAIN")}</Td>
                <Td align="right" className={c.outstandingAmount > 0 ? "font-semibold text-brand-700" : ""}>{formatRupiah(c.outstandingAmount, "PLAIN")}</Td>
                <Td>{c.isActive ? <Badge tone="green">Aktif</Badge> : <Badge>Diarsipkan</Badge>}</Td>
                <Td align="right">
                  <div className="flex justify-end gap-2">
                    {can.update && <Button size="sm" onClick={() => { reset(); setEditing({ id: c.id, form: fromDto(c) }); }}>Edit</Button>}
                    {can.archive && (c.isActive
                      ? <Button size="sm" variant="danger" onClick={() => setArchiving(c)}>Arsipkan</Button>
                      : <Button size="sm" onClick={() => void setActive(c, true)} loading={busy}>Aktifkan</Button>)}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
      )}

      <Dialog open={!!editing} onClose={() => !busy && setEditing(null)} title={editing?.id ? "Edit pelanggan" : "Tambah pelanggan"} size="lg"
        description={editing?.id ? "Perubahan hanya berlaku untuk invoice baru/draft. Invoice yang sudah terbit tidak berubah." : undefined}
        footer={<><Button onClick={() => setEditing(null)} disabled={busy}>Batal</Button>
          {needsConfirm && <Button onClick={() => void save(true)} loading={busy}>Tetap simpan sebagai pelanggan berbeda</Button>}
          <Button variant="primary" loading={busy} onClick={() => void save(false)}>Simpan</Button></>}>
        {f && (
          <div className="grid gap-4 sm:grid-cols-2">
            {error && <div className="sm:col-span-2"><Notice tone={needsConfirm ? "warn" : "danger"}>{error}
              {dups && dups.length > 0 && <ul className="mt-2 list-disc pl-5">{dups.map((d) => <li key={d.id}><Link className="underline" href={`/customers/${d.id}`}>{d.name}</Link>{d.city ? ` (${d.city})` : ""}{d.isActive ? "" : " — diarsipkan"}</li>)}</ul>}</Notice></div>}
            <TextField label="Nama perusahaan / instansi" required className="sm:col-span-2" value={f.name} onChange={(e) => set({ name: e.target.value })} error={fe.name} />
            <TextField label="Nama kontak person" value={f.contactName} onChange={(e) => set({ contactName: e.target.value })} error={fe.contactName} />
            <TextField label="Jabatan kontak" value={f.contactTitle} onChange={(e) => set({ contactTitle: e.target.value })} error={fe.contactTitle} />
            <TextAreaField label="Alamat" className="sm:col-span-2" rows={2} value={f.address} onChange={(e) => set({ address: e.target.value })} error={fe.address} />
            <TextField label="Kota" value={f.city} onChange={(e) => set({ city: e.target.value })} error={fe.city} />
            <TextField label="Telepon" value={f.phone} onChange={(e) => set({ phone: e.target.value })} error={fe.phone} />
            <TextField label="Email" type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} error={fe.email} />
            <TextField label="NPWP" value={f.npwp} onChange={(e) => set({ npwp: e.target.value })} error={fe.npwp} hint="Opsional" />
            <TextAreaField label="Catatan internal" className="sm:col-span-2" rows={2} value={f.internalNote} onChange={(e) => set({ internalNote: e.target.value })} error={fe.internalNote} />
          </div>
        )}
      </Dialog>

      <ConfirmDialog open={!!archiving} onClose={() => !busy && setArchiving(null)} loading={busy} tone="danger" confirmLabel="Arsipkan"
        title={`Arsipkan ${archiving?.name ?? ""}?`} description="Pelanggan tidak akan muncul di pilihan invoice baru. Seluruh histori invoice & pembayaran tetap tersimpan, dan dapat diaktifkan kembali kapan saja."
        onConfirm={() => archiving && void setActive(archiving, false)} />
    </>
  );
}
