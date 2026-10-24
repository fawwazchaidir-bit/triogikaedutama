"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, Notice } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import type { BankAccountDto } from "@/lib/types";

export function BanksManager({ items, canManage }: { items: BankAccountDto[]; canManage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [edit, setEdit] = useState<null | { id: string | null; label: string; accountNumber: string; accountName: string }>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});

  async function save() {
    if (!edit) return;
    setBusy(true); setError(null); setFe({});
    try {
      const body = { label: edit.label, accountNumber: edit.accountNumber, accountName: edit.accountName };
      if (edit.id) await api(`/api/settings/banks/${edit.id}`, { method: "PATCH", body }); else await api("/api/settings/banks", { body });
      toast.success("Rekening disimpan."); setEdit(null); router.refresh();
    } catch (e) { setError(errorMessage(e)); if (e instanceof ApiClientError) setFe(e.fieldErrors); } finally { setBusy(false); }
  }
  async function patch(b: BankAccountDto, body: Partial<BankAccountDto>, msg: string) {
    try { await api(`/api/settings/banks/${b.id}`, { method: "PATCH", body }); toast.success(msg); router.refresh(); } catch (e) { toast.error(errorMessage(e)); }
  }

  return (
    <Card>
      <CardHeader title="Rekening bank" description="Dicetak pada blok “Transfer Via”. Rekening yang dinonaktifkan tidak muncul di invoice baru; invoice lama tetap memakai rekening saat diterbitkan."
        actions={canManage ? <Button variant="primary" onClick={() => { setError(null); setFe({}); setEdit({ id: null, label: "", accountNumber: "", accountName: "" }); }}><Plus className="size-4" />Tambah rekening</Button> : undefined} />
      <TableWrap>
        <Table>
          <thead><tr><Th>Label</Th><Th>Nomor rekening</Th><Th>Atas nama</Th><Th>Status</Th>{canManage && <Th align="right">Aksi</Th>}</tr></thead>
          <tbody>
            {items.map((b) => (
              <tr key={b.id}>
                <Td className="font-semibold">{b.label}</Td><Td mono>{b.accountNumber}</Td><Td>{b.accountName}</Td>
                <Td>{b.isDefault && <Badge tone="blue" className="mr-1">Default</Badge>}{b.isActive ? <Badge tone="green">Aktif</Badge> : <Badge>Nonaktif</Badge>}</Td>
                {canManage && <Td align="right"><div className="flex justify-end gap-2">
                  <Button size="sm" onClick={() => { setError(null); setFe({}); setEdit({ id: b.id, label: b.label, accountNumber: b.accountNumber, accountName: b.accountName }); }}>Edit</Button>
                  {b.isActive && !b.isDefault && <Button size="sm" onClick={() => void patch(b, { isDefault: true }, "Rekening default diubah.")}>Jadikan default</Button>}
                  {b.isActive ? <Button size="sm" variant="danger" onClick={() => void patch(b, { isActive: false }, "Rekening dinonaktifkan.")}>Nonaktifkan</Button> : <Button size="sm" onClick={() => void patch(b, { isActive: true }, "Rekening diaktifkan.")}>Aktifkan</Button>}
                </div></Td>}
              </tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
      <Dialog open={!!edit} onClose={() => !busy && setEdit(null)} title={edit?.id ? "Edit rekening" : "Tambah rekening"} size="sm"
        footer={<><Button onClick={() => setEdit(null)} disabled={busy}>Batal</Button><Button variant="primary" loading={busy} onClick={() => void save()}>Simpan</Button></>}>
        {edit && <div className="space-y-4">
          {error && <Notice tone="danger">{error}</Notice>}
          <TextField label="Label bank" required value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} error={fe.label} placeholder="mis. MANDIRI-IDR" />
          <TextField label="Nomor rekening" required value={edit.accountNumber} onChange={(e) => setEdit({ ...edit, accountNumber: e.target.value })} error={fe.accountNumber} />
          <TextField label="Nama pemilik rekening" required value={edit.accountName} onChange={(e) => setEdit({ ...edit, accountName: e.target.value })} error={fe.accountName} />
        </div>}
      </Dialog>
    </Card>
  );
}
