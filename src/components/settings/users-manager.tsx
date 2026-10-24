"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, Notice } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { SelectField, TextField } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import { ROLE_LABELS, type Role } from "@/lib/permissions";
import { formatDateTime } from "@/lib/format";
import type { UserDto } from "@/server/services/users";

export function UsersManager({ items, selfId }: { items: UserDto[]; selfId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [create, setCreate] = useState<null | { email: string; name: string; role: Role; password: string }>(null);
  const [reset, setReset] = useState<null | { id: string; name: string; password: string }>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const fail = (e: unknown) => { setError(errorMessage(e)); if (e instanceof ApiClientError) setFe(e.fieldErrors); };

  async function submit(fn: () => Promise<unknown>, ok: string, done: () => void) {
    setBusy(true); setError(null); setFe({});
    try { await fn(); toast.success(ok); done(); router.refresh(); } catch (e) { fail(e); } finally { setBusy(false); }
  }
  const patch = (u: UserDto, body: Record<string, unknown>, msg: string) => api(`/api/users/${u.id}`, { method: "PATCH", body }).then(() => { toast.success(msg); router.refresh(); }).catch((e) => toast.error(errorMessage(e)));

  return (
    <Card>
      <CardHeader title="Pengguna" description="Administrator membuat akun dan menetapkan peran (least privilege). Pengguna baru wajib mengganti password pada login pertama."
        actions={<Button variant="primary" onClick={() => { setError(null); setFe({}); setCreate({ email: "", name: "", role: "STAFF", password: "" }); }}><Plus className="size-4" />Tambah pengguna</Button>} />
      <TableWrap>
        <Table>
          <thead><tr><Th>Nama</Th><Th>Email</Th><Th>Peran</Th><Th>Login terakhir</Th><Th>Status</Th><Th align="right">Aksi</Th></tr></thead>
          <tbody>
            {items.map((u) => (
              <tr key={u.id}>
                <Td className="font-medium">{u.name}{u.id === selfId && <Badge className="ml-2">Anda</Badge>}</Td><Td>{u.email}</Td>
                <Td><select aria-label={`Peran ${u.name}`} value={u.role} disabled={u.id === selfId} onChange={(e) => void patch(u, { role: e.target.value }, "Peran diubah. Pengguna perlu login ulang.")} className="h-8 rounded-md border border-line bg-white px-2 text-sm disabled:bg-canvas">
                  {(Object.keys(ROLE_LABELS) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></Td>
                <Td>{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "Belum pernah"}</Td>
                <Td>{u.isActive ? <Badge tone="green">Aktif</Badge> : <Badge>Nonaktif</Badge>}{u.mustChangePassword && <Badge tone="amber" className="ml-1">Wajib ganti password</Badge>}</Td>
                <Td align="right"><div className="flex justify-end gap-2">
                  <Button size="sm" onClick={() => { setError(null); setFe({}); setReset({ id: u.id, name: u.name, password: "" }); }}>Reset password</Button>
                  {u.id !== selfId && (u.isActive ? <Button size="sm" variant="danger" onClick={() => void patch(u, { isActive: false }, "Pengguna dinonaktifkan.")}>Nonaktifkan</Button> : <Button size="sm" onClick={() => void patch(u, { isActive: true }, "Pengguna diaktifkan.")}>Aktifkan</Button>)}
                </div></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>

      <Dialog open={!!create} onClose={() => !busy && setCreate(null)} title="Tambah pengguna" size="sm"
        footer={<><Button onClick={() => setCreate(null)} disabled={busy}>Batal</Button><Button variant="primary" loading={busy} onClick={() => create && void submit(() => api("/api/users", { body: create }), "Pengguna dibuat.", () => setCreate(null))}>Buat akun</Button></>}>
        {create && <div className="space-y-4">
          {error && <Notice tone="danger">{error}</Notice>}
          <TextField label="Nama" required value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value })} error={fe.name} />
          <TextField label="Email" type="email" required value={create.email} onChange={(e) => setCreate({ ...create, email: e.target.value })} error={fe.email} />
          <SelectField label="Peran" value={create.role} onChange={(e) => setCreate({ ...create, role: e.target.value as Role })}>{(Object.keys(ROLE_LABELS) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</SelectField>
          <TextField label="Password sementara" type="text" autoComplete="off" required value={create.password} onChange={(e) => setCreate({ ...create, password: e.target.value })} error={fe.password} hint="Minimal 12 karakter. Sampaikan lewat kanal aman; pengguna wajib menggantinya." />
        </div>}
      </Dialog>
      <Dialog open={!!reset} onClose={() => !busy && setReset(null)} title={`Reset password — ${reset?.name ?? ""}`} size="sm"
        footer={<><Button onClick={() => setReset(null)} disabled={busy}>Batal</Button><Button variant="primary" loading={busy} onClick={() => reset && void submit(() => api(`/api/users/${reset.id}/password`, { body: { password: reset.password } }), "Password direset. Sesi pengguna diakhiri.", () => setReset(null))}>Reset</Button></>}>
        {reset && <div className="space-y-4">{error && <Notice tone="danger">{error}</Notice>}
          <TextField label="Password sementara baru" type="text" autoComplete="off" required value={reset.password} onChange={(e) => setReset({ ...reset, password: e.target.value })} error={fe.password} hint="Pengguna wajib menggantinya saat login berikutnya." /></div>}
      </Dialog>
    </Card>
  );
}
