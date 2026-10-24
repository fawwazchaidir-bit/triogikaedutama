"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { EmptyState, Notice } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import { DEFAULT_DESCRIPTION_TEMPLATE, findUnknownPlaceholders, renderDescription } from "@/lib/finance/description-template";
import { formatRupiah } from "@/lib/finance/money";
import type { ProductDto, TaxConfigDto } from "@/lib/types";

type Form = { code: string; name: string; category: string; fieldOfTraining: string; schemeName: string; descriptionTemplate: string; unit: string; defaultPrice: number | null; taxConfigId: string; isActive: boolean };
const blank: Form = { code: "", name: "", category: "", fieldOfTraining: "", schemeName: "", descriptionTemplate: DEFAULT_DESCRIPTION_TEMPLATE, unit: "Pax", defaultPrice: null, taxConfigId: "", isActive: true };
const fromDto = (p: ProductDto): Form => ({ code: p.code, name: p.name, category: p.category ?? "", fieldOfTraining: p.fieldOfTraining ?? "", schemeName: p.schemeName ?? "", descriptionTemplate: p.descriptionTemplate, unit: p.unit, defaultPrice: p.defaultPrice, taxConfigId: p.taxConfigId ?? "", isActive: p.isActive });
const UNITS = ["Pax", "Orang", "Paket", "Hari", "Unit", "Sesi", "Jam"];

export function ProductsManager({ items, taxes, canManage }: { items: ProductDto[]; taxes: TaxConfigDto[]; canManage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [editing, setEditing] = useState<null | { id: string | null; form: Form }>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const f = editing?.form;
  const set = (p: Partial<Form>) => setEditing((s) => (s ? { ...s, form: { ...s.form, ...p } } : s));
  const taxName = (id: string | null) => taxes.find((t) => t.id === id)?.name ?? "—";

  const preview = f ? renderDescription(f.descriptionTemplate, { name: f.name, code: f.code, category: f.category, field: f.fieldOfTraining, scheme: f.schemeName, unit: f.unit }) : "";
  const unknown = f ? findUnknownPlaceholders(f.descriptionTemplate) : [];

  async function save() {
    if (!editing) return;
    setBusy(true); setError(null); setFe({});
    try {
      const body = { ...editing.form, defaultPrice: editing.form.defaultPrice ?? 0, taxConfigId: editing.form.taxConfigId || null };
      if (editing.id) await api(`/api/products/${editing.id}`, { method: "PUT", body }); else await api("/api/products", { body });
      toast.success(editing.id ? "Produk diperbarui. Invoice lama tidak berubah." : "Produk ditambahkan.");
      setEditing(null); router.refresh();
    } catch (e) { setError(errorMessage(e)); if (e instanceof ApiClientError) setFe(e.fieldErrors); } finally { setBusy(false); }
  }

  return (
    <>
      {canManage && <div className="flex justify-end p-4 pb-0"><Button variant="primary" onClick={() => { setError(null); setFe({}); setEditing({ id: null, form: blank }); }}><Plus className="size-4" />Tambah produk</Button></div>}
      {items.length === 0 ? <EmptyState title="Belum ada produk" description="Tambahkan produk/layanan agar deskripsi dan harga terisi otomatis di invoice." /> : (
      <TableWrap>
        <Table>
          <thead><tr><Th>Kode</Th><Th>Produk / layanan</Th><Th>Bidang · Skema</Th><Th>Satuan</Th><Th align="right">Harga default</Th><Th>Pajak</Th><Th>Status</Th>{canManage && <Th align="right">Aksi</Th>}</tr></thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id} className="hover:bg-canvas/60">
                <Td mono>{p.code}</Td>
                <Td><span className="font-medium">{p.name}</span>{p.category && <span className="block text-xs text-muted">{p.category}</span>}</Td>
                <Td>{[p.fieldOfTraining, p.schemeName].filter(Boolean).join(" · ") || "—"}</Td>
                <Td>{p.unit}</Td><Td align="right">{formatRupiah(p.defaultPrice, "PLAIN")}</Td><Td>{taxName(p.taxConfigId)}</Td>
                <Td>{p.isActive ? <Badge tone="green">Aktif</Badge> : <Badge>Diarsipkan</Badge>}</Td>
                {canManage && <Td align="right"><Button size="sm" onClick={() => { setError(null); setFe({}); setEditing({ id: p.id, form: fromDto(p) }); }}>Edit</Button></Td>}
              </tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
      )}

      <Dialog open={!!editing} onClose={() => !busy && setEditing(null)} title={editing?.id ? "Edit produk" : "Tambah produk"} size="lg"
        description={editing?.id ? "Mengubah harga atau deskripsi tidak memengaruhi invoice yang sudah dibuat." : undefined}
        footer={<><Button onClick={() => setEditing(null)} disabled={busy}>Batal</Button><Button variant="primary" loading={busy} onClick={() => void save()}>Simpan</Button></>}>
        {f && (
          <div className="grid gap-4 sm:grid-cols-2">
            {error && <div className="sm:col-span-2"><Notice tone="danger">{error}</Notice></div>}
            <TextField label="Kode produk" required value={f.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} error={fe.code} hint="Unik, mis. DEMI-CHEF" />
            <TextField label="Nama produk / layanan" required value={f.name} onChange={(e) => set({ name: e.target.value })} error={fe.name} />
            <TextField label="Kategori layanan" value={f.category} onChange={(e) => set({ category: e.target.value })} error={fe.category} />
            <TextField label="Bidang pelatihan" value={f.fieldOfTraining} onChange={(e) => set({ fieldOfTraining: e.target.value })} error={fe.fieldOfTraining} />
            <TextField label="Nama skema sertifikasi" value={f.schemeName} onChange={(e) => set({ schemeName: e.target.value })} error={fe.schemeName} />
            <div className="grid grid-cols-2 gap-3">
              <SelectField label="Satuan" required value={f.unit} onChange={(e) => set({ unit: e.target.value })} error={fe.unit}>{[...new Set([...UNITS, f.unit])].map((u) => <option key={u}>{u}</option>)}</SelectField>
              <MoneyInput label="Harga default" required value={f.defaultPrice} onChange={(v) => set({ defaultPrice: v })} error={fe.defaultPrice} />
            </div>
            <SelectField label="Pengaturan pajak" value={f.taxConfigId} onChange={(e) => set({ taxConfigId: e.target.value })} error={fe.taxConfigId}>
              <option value="">Tanpa pajak</option>{taxes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </SelectField>
            <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={f.isActive} onChange={(e) => set({ isActive: e.target.checked })} />Produk aktif</label>
            <TextAreaField label="Template deskripsi invoice" className="sm:col-span-2" rows={3} value={f.descriptionTemplate} onChange={(e) => set({ descriptionTemplate: e.target.value })} error={fe.descriptionTemplate}
              hint="Placeholder: {name} {code} {category} {field} {scheme} {unit}. Baris yang placeholder-nya kosong otomatis dibuang." />
            <div className="sm:col-span-2 rounded-md border border-line bg-canvas p-3">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Pratinjau deskripsi pada invoice</p>
              {unknown.length > 0 ? <p className="text-sm text-brand-700">Placeholder tidak dikenal: {unknown.map((u) => `{${u}}`).join(", ")}</p> : <p className="whitespace-pre-line text-sm">{preview || "—"}</p>}
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
