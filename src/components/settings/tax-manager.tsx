"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, EmptyState, Notice } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import type { TaxConfigDto } from "@/lib/types";

type Form = { id: string | null; code: string; name: string; ratePercent: string; dppNumerator: string; dppDenominator: string; method: "EXCLUSIVE" | "INCLUSIVE"; note: string; isActive: boolean };
const blank: Form = { id: null, code: "", name: "", ratePercent: "11", dppNumerator: "1", dppDenominator: "1", method: "EXCLUSIVE", note: "", isActive: true };
const fromDto = (t: TaxConfigDto): Form => ({ id: t.id, code: t.code, name: t.name, ratePercent: String(t.rateBps / 100), dppNumerator: String(t.dppNumerator), dppDenominator: String(t.dppDenominator), method: t.method, note: t.note ?? "", isActive: t.isActive });
const pct = (bps: number) => `${(bps / 100).toLocaleString("id-ID", { maximumFractionDigits: 2 })}%`;

export function TaxManager({ items, canManage }: { items: TaxConfigDto[]; canManage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [f, setF] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const set = (p: Partial<Form>) => setF((x) => (x ? { ...x, ...p } : x));

  async function save() {
    if (!f) return;
    setBusy(true); setError(null); setFe({});
    try {
      const body = { code: f.code, name: f.name, ratePercent: Number(f.ratePercent.replace(",", ".")), dppNumerator: Number(f.dppNumerator), dppDenominator: Number(f.dppDenominator), method: f.method, note: f.note, isActive: f.isActive };
      if (f.id) { const { code: _c, ...rest } = body; void _c; await api(`/api/tax/${f.id}`, { method: "PATCH", body: rest }); } else await api("/api/tax", { body });
      toast.success("Konfigurasi pajak disimpan."); setF(null); router.refresh();
    } catch (e) { setError(errorMessage(e)); if (e instanceof ApiClientError) setFe(e.fieldErrors); } finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHeader title="Konfigurasi pajak" description="Tarif, DPP, dan metode tidak ditanamkan di kode. Pajak dipilih per baris invoice; invoice terbit menyimpan snapshot tarif yang dipakai."
        actions={canManage ? <Button variant="primary" onClick={() => { setError(null); setFe({}); setF(blank); }}><Plus className="size-4" />Tambah pajak</Button> : undefined} />
      <div className="border-b border-line p-4"><Notice tone="info">Belum ada tarif yang diasumsikan. Tambahkan konfigurasi sesuai ketentuan perpajakan lembaga (mis. PPN atau pajak lain) — sesuaikan dengan konsultan pajak Anda. Dasar pengenaan pajak (DPP) dapat berupa pecahan, mis. 11/12 untuk DPP Nilai Lain.</Notice></div>
      {items.length === 0 ? <EmptyState title="Belum ada konfigurasi pajak" description="Semua baris invoice saat ini bebas pajak." /> : (
        <TableWrap>
          <Table>
            <thead><tr><Th>Kode</Th><Th>Nama</Th><Th align="right">Tarif</Th><Th align="right">Faktor DPP</Th><Th>Metode</Th><Th>Status</Th>{canManage && <Th align="right">Aksi</Th>}</tr></thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <Td mono>{t.code}</Td><Td>{t.name}{t.note && <span className="block text-xs text-muted">{t.note}</span>}</Td>
                  <Td align="right">{pct(t.rateBps)}</Td><Td align="right">{t.dppNumerator}/{t.dppDenominator}</Td>
                  <Td>{t.method === "EXCLUSIVE" ? "Ditambahkan ke harga" : "Sudah termasuk harga"}</Td>
                  <Td>{t.isActive ? <Badge tone="green">Aktif</Badge> : <Badge>Nonaktif</Badge>}</Td>
                  {canManage && <Td align="right"><Button size="sm" onClick={() => { setError(null); setFe({}); setF(fromDto(t)); }}>Edit</Button></Td>}
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
      <Dialog open={!!f} onClose={() => !busy && setF(null)} title={f?.id ? "Edit konfigurasi pajak" : "Tambah konfigurasi pajak"} size="md"
        description={f?.id ? "Perubahan hanya berlaku untuk draft dan invoice baru; invoice terbit tidak berubah." : undefined}
        footer={<><Button onClick={() => setF(null)} disabled={busy}>Batal</Button><Button variant="primary" loading={busy} onClick={() => void save()}>Simpan</Button></>}>
        {f && <div className="grid gap-4 sm:grid-cols-2">
          {error && <div className="sm:col-span-2"><Notice tone="danger">{error}</Notice></div>}
          <TextField label="Kode" required disabled={!!f.id} value={f.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} error={fe.code} hint={f.id ? "Kode tidak dapat diubah" : "mis. PPN11"} />
          <TextField label="Nama" required value={f.name} onChange={(e) => set({ name: e.target.value })} error={fe.name} />
          <TextField label="Tarif (%)" required inputMode="decimal" value={f.ratePercent} onChange={(e) => set({ ratePercent: e.target.value })} error={fe.ratePercent} hint="Maksimal 2 desimal" />
          <SelectField label="Metode" value={f.method} onChange={(e) => set({ method: e.target.value as Form["method"] })} hint="Termasuk harga: pajak diekstrak dari harga, tidak menambah total.">
            <option value="EXCLUSIVE">Ditambahkan ke harga</option><option value="INCLUSIVE">Sudah termasuk harga</option>
          </SelectField>
          <TextField label="Faktor DPP — pembilang" inputMode="numeric" value={f.dppNumerator} onChange={(e) => set({ dppNumerator: e.target.value.replace(/\D/g, "") })} error={fe.dppNumerator} />
          <TextField label="Faktor DPP — penyebut" inputMode="numeric" value={f.dppDenominator} onChange={(e) => set({ dppDenominator: e.target.value.replace(/\D/g, "") })} error={fe.dppDenominator} hint="1/1 = DPP sama dengan harga" />
          <TextAreaField label="Catatan" className="sm:col-span-2" rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} error={fe.note} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isActive} onChange={(e) => set({ isActive: e.target.checked })} />Aktif (dapat dipilih pada invoice)</label>
        </div>}
      </Dialog>
    </Card>
  );
}
