"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, Notice } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { SelectField, TextField } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { Badge } from "@/components/ui/badge";
import { Table, TableWrap, Td, Th } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import { formatRupiah } from "@/lib/finance/money";
import { formatDateShort } from "@/lib/format";
import type { CashAccountDto, CoaAccountDto } from "@/lib/finance-types";

const TYPE_LABEL: Record<CoaAccountDto["type"], string> = { ASET: "Aset", KEWAJIBAN: "Liabilitas", EKUITAS: "Ekuitas", PENDAPATAN: "Penghasilan", BEBAN: "Beban" };
const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

type AccountForm = { id: string | null; name: string; kind: "KAS" | "BANK"; coaAccountId: string; openingBalance: number | null; openingDate: string; isDefault: boolean; notes: string; reason: string; hasMovements: boolean };
type CoaForm = { id: string | null; code: string; name: string; type: CoaAccountDto["type"]; manualEntry: boolean; inUse: boolean; isSystem: boolean };

/** Pengaturan → Keuangan: akun kas/bank + saldo awal (manual) dan bagan akun. Hanya Administrator yang dapat mengubah. */
export function FinanceManager({ accounts, coa, canManage }: { accounts: CashAccountDto[]; coa: CoaAccountDto[]; canManage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [acct, setAcct] = useState<AccountForm | null>(null);
  const [cform, setCform] = useState<CoaForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const assets = coa.filter((c) => c.type === "ASET" && c.isActive);

  const reset = () => { setError(null); setFe({}); };
  async function run(fn: () => Promise<unknown>, ok: string, done: () => void) {
    setBusy(true); reset();
    try { await fn(); toast.success(ok); done(); router.refresh(); }
    catch (e) { const fieldErrs = e instanceof ApiClientError ? e.fieldErrors : {}; setFe(fieldErrs); setError(Object.keys(fieldErrs).length ? null : errorMessage(e)); } finally { setBusy(false); }
  }
  const saveAccount = () => acct && run(() => acct.id
    ? api(`/api/finance/cash-accounts/${acct.id}`, { method: "PATCH", body: {
        name: acct.name, notes: acct.notes, isDefault: acct.isDefault, openingBalance: acct.openingBalance ?? 0,
        ...(acct.hasMovements ? {} : { openingDate: acct.openingDate }), ...(acct.reason ? { reason: acct.reason } : {}),
      } })
    : api("/api/finance/cash-accounts", { body: { name: acct.name, kind: acct.kind, coaAccountId: acct.coaAccountId, openingBalance: acct.openingBalance ?? 0, openingDate: acct.openingDate, isDefault: acct.isDefault, notes: acct.notes } }),
    "Akun disimpan.", () => setAcct(null));
  const saveCoa = () => cform && run(() => cform.id
    ? api(`/api/finance/coa/${cform.id}`, { method: "PATCH", body: { name: cform.name, manualEntry: cform.manualEntry, ...(cform.inUse || cform.isSystem ? {} : { code: cform.code, type: cform.type }) } })
    : api("/api/finance/coa", { body: { code: cform.code, name: cform.name, type: cform.type, manualEntry: cform.manualEntry } }),
    "Akun bagan akun disimpan.", () => setCform(null));
  const toggle = (path: string, active: boolean, ok: string) => run(() => api(path, { method: "PATCH", body: { isActive: active } }), ok, () => undefined);

  return (
    <div className="space-y-5">
      {!canManage && <Notice tone="info">Anda hanya dapat melihat pengaturan keuangan. Perubahan dilakukan Administrator.</Notice>}
      <Card>
        <CardHeader title="Akun kas & bank" description="Saldo awal diinput manual per akun dan terkunci tanggalnya setelah ada mutasi. Pembayaran invoice masuk ke akun default menurut metode (Tunai → kas, lainnya → bank) kecuali dipilih lain."
          actions={canManage ? <Button variant="primary" onClick={() => { reset(); setAcct({ id: null, name: "", kind: "BANK", coaAccountId: assets.find((a) => a.code === "1-1200")?.id ?? assets[0]?.id ?? "", openingBalance: 0, openingDate: today(), isDefault: false, notes: "", reason: "", hasMovements: false }); }}><Plus className="size-4" />Tambah akun</Button> : undefined} />
        <TableWrap>
          <Table>
            <thead><tr><Th>Nama</Th><Th>Jenis</Th><Th>Akun bagan akun</Th><Th align="right">Saldo awal</Th><Th>Tanggal saldo awal</Th><Th align="right">Saldo kini</Th><Th>Status</Th>{canManage && <Th align="right">Aksi</Th>}</tr></thead>
            <tbody>
              {accounts.length === 0 && <tr><Td className="text-muted" >Belum ada akun. Tambahkan akun kas/bank beserta saldo awalnya.</Td></tr>}
              {accounts.map((a) => (
                <tr key={a.id}>
                  <Td className="font-semibold">{a.name}</Td><Td>{a.kind === "KAS" ? "Kas" : "Bank"}</Td><Td><span className="font-mono text-xs">{a.coaCode}</span> {a.coaName}</Td>
                  <Td align="right" className="tabular">{formatRupiah(a.openingBalance, "PLAIN")}</Td><Td>{formatDateShort(a.openingDate)}</Td>
                  <Td align="right" className="tabular">{formatRupiah(a.balance, "PLAIN")}</Td>
                  <Td>{a.isDefault && <Badge tone="blue" className="mr-1">Default</Badge>}{a.isActive ? <Badge tone="green">Aktif</Badge> : <Badge>Nonaktif</Badge>}</Td>
                  {canManage && <Td align="right"><div className="flex justify-end gap-2">
                    <Button size="sm" onClick={() => { reset(); setAcct({ id: a.id, name: a.name, kind: a.kind, coaAccountId: a.coaAccountId, openingBalance: a.openingBalance, openingDate: a.openingDate, isDefault: a.isDefault, notes: a.notes ?? "", reason: "", hasMovements: a.hasMovements }); }}>Edit</Button>
                    {a.isActive ? <Button size="sm" variant="danger" onClick={() => void toggle(`/api/finance/cash-accounts/${a.id}`, false, "Akun dinonaktifkan.")}>Nonaktifkan</Button> : <Button size="sm" onClick={() => void toggle(`/api/finance/cash-accounts/${a.id}`, true, "Akun diaktifkan.")}>Aktifkan</Button>}
                  </div></Td>}
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
        {error && !acct && !cform && <div className="p-4"><Notice tone="danger">{error}</Notice></div>}
      </Card>

      <Card>
        <CardHeader title="Bagan akun (usulan SAK EMKM)" description="Kategori pengeluaran & penerimaan. Ini usulan awal — tinjau bersama akuntan. Akun bertanda sistem dicadangkan untuk tahap akuntansi berikutnya."
          actions={canManage ? <Button variant="primary" onClick={() => { reset(); setCform({ id: null, code: "", name: "", type: "BEBAN", manualEntry: true, inUse: false, isSystem: false }); }}><Plus className="size-4" />Tambah akun</Button> : undefined} />
        <TableWrap>
          <Table>
            <thead><tr><Th>Kode</Th><Th>Nama</Th><Th>Jenis</Th><Th>Arus kas</Th><Th>Dapat dipilih manual</Th><Th>Status</Th>{canManage && <Th align="right">Aksi</Th>}</tr></thead>
            <tbody>
              {coa.map((c) => (
                <tr key={c.id}>
                  <Td mono>{c.code}</Td><Td className="font-medium">{c.name}</Td><Td>{TYPE_LABEL[c.type]}</Td><Td>{c.section === "OPERASI" ? "Operasi" : c.section === "INVESTASI" ? "Investasi" : "Pendanaan"}</Td>
                  <Td>{c.manualEntry ? "Ya" : "—"}</Td>
                  <Td>{c.isSystem && <Badge tone="blue" className="mr-1">Sistem</Badge>}{c.isActive ? <Badge tone="green">Aktif</Badge> : <Badge>Nonaktif</Badge>}</Td>
                  {canManage && <Td align="right"><div className="flex justify-end gap-2">
                    <Button size="sm" onClick={() => { reset(); setCform({ id: c.id, code: c.code, name: c.name, type: c.type, manualEntry: c.manualEntry, inUse: c.inUse, isSystem: c.isSystem }); }}>Edit</Button>
                    {!c.isSystem && (c.isActive ? <Button size="sm" variant="danger" onClick={() => void toggle(`/api/finance/coa/${c.id}`, false, "Akun dinonaktifkan.")}>Nonaktifkan</Button> : <Button size="sm" onClick={() => void toggle(`/api/finance/coa/${c.id}`, true, "Akun diaktifkan.")}>Aktifkan</Button>)}
                  </div></Td>}
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      </Card>

      <Dialog open={!!acct} onClose={() => !busy && setAcct(null)} title={acct?.id ? "Edit akun kas/bank" : "Tambah akun kas/bank"} size="md"
        footer={<><Button onClick={() => setAcct(null)} disabled={busy}>Batal</Button><Button variant="primary" loading={busy} onClick={() => void saveAccount()}>Simpan</Button></>}>
        {acct && <div className="grid gap-4 sm:grid-cols-2">
          {error && <div className="sm:col-span-2"><Notice tone="danger">{error}</Notice></div>}
          <TextField label="Nama akun" required className="sm:col-span-2" value={acct.name} onChange={(e) => setAcct({ ...acct, name: e.target.value })} error={fe.name} placeholder="mis. Bank Mandiri IDR atau Kas Kecil" />
          {!acct.id && <SelectField label="Jenis" value={acct.kind} onChange={(e) => setAcct({ ...acct, kind: e.target.value as "KAS" | "BANK" })}><option value="BANK">Bank</option><option value="KAS">Kas</option></SelectField>}
          {!acct.id && <SelectField label="Akun bagan akun (aset)" value={acct.coaAccountId} onChange={(e) => setAcct({ ...acct, coaAccountId: e.target.value })} error={fe.coaAccountId}>{assets.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</SelectField>}
          <MoneyInput label="Saldo awal" required value={acct.openingBalance} onChange={(v) => setAcct({ ...acct, openingBalance: v })} error={fe.openingBalance} hint="Saldo per awal hari pada tanggal di samping" />
          <TextField label="Tanggal saldo awal" type="date" required value={acct.openingDate} max={today()} disabled={acct.hasMovements} onChange={(e) => setAcct({ ...acct, openingDate: e.target.value })} error={fe.openingDate} hint={acct.hasMovements ? "Terkunci: akun sudah memiliki mutasi" : "Mutasi sebelum tanggal ini tidak dihitung"} />
          {acct.id && acct.hasMovements && <TextField label="Alasan mengubah saldo awal" className="sm:col-span-2" value={acct.reason} onChange={(e) => setAcct({ ...acct, reason: e.target.value })} error={fe.reason} hint="Wajib bila saldo awal diubah (tercatat di audit log)" />}
          <TextField label="Catatan" className="sm:col-span-2" value={acct.notes} onChange={(e) => setAcct({ ...acct, notes: e.target.value })} error={fe.notes} placeholder="Opsional" />
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={acct.isDefault} onChange={(e) => setAcct({ ...acct, isDefault: e.target.checked })} />Jadikan akun default untuk jenis ini (penerimaan pembayaran otomatis masuk ke sini)</label>
        </div>}
      </Dialog>

      <Dialog open={!!cform} onClose={() => !busy && setCform(null)} title={cform?.id ? "Edit akun" : "Tambah akun bagan akun"} size="md"
        footer={<><Button onClick={() => setCform(null)} disabled={busy}>Batal</Button><Button variant="primary" loading={busy} onClick={() => void saveCoa()}>Simpan</Button></>}>
        {cform && <div className="grid gap-4 sm:grid-cols-2">
          {error && <div className="sm:col-span-2"><Notice tone="danger">{error}</Notice></div>}
          <TextField label="Kode" required value={cform.code} disabled={!!cform.id && (cform.inUse || cform.isSystem)} onChange={(e) => setCform({ ...cform, code: e.target.value })} error={fe.code} placeholder="d-dddd, mis. 6-1250" hint="Digit pertama: 1 aset, 2 liabilitas, 3 ekuitas, 4 penghasilan, 5–7 beban" />
          <SelectField label="Jenis" value={cform.type} disabled={!!cform.id && (cform.inUse || cform.isSystem)} onChange={(e) => setCform({ ...cform, type: e.target.value as CoaAccountDto["type"] })} error={fe.type}>
            {(Object.keys(TYPE_LABEL) as CoaAccountDto["type"][]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </SelectField>
          <TextField label="Nama" required className="sm:col-span-2" value={cform.name} onChange={(e) => setCform({ ...cform, name: e.target.value })} error={fe.name} />
          {!cform.isSystem && <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={cform.manualEntry} onChange={(e) => setCform({ ...cform, manualEntry: e.target.checked })} />Dapat dipilih pada pencatatan kas manual</label>}
        </div>}
      </Dialog>
    </div>
  );
}
