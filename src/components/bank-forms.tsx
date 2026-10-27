"use client";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { Notice } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, api, errorMessage } from "@/lib/api-client";
import { formatRupiah } from "@/lib/finance/money";
import { formatDateShort } from "@/lib/format";
import type { CoaAccountDto } from "@/lib/finance-types";
import type { AccountReconOverview, CsvPreview, StatementLineDto, StatementWorkspace } from "@/lib/bank-types";

const R = (n: number) => formatRupiah(n, "PLAIN");

function useAction(done: string | null) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  async function run<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    setBusy(true); setError(null); setFe({});
    try { const value = await fn(); if (done) toast.success(done); router.refresh(); return { ok: true, value }; }
    catch (e) { const f = e instanceof ApiClientError ? e.fieldErrors : {}; setFe(f); setError(errorMessage(e)); return { ok: false }; }
    finally { setBusy(false); }
  }
  return { busy, error, fe, run };
}

// ───────────────────────────── Impor rekening koran ─────────────────────────────
const COLS = (n: number) => Array.from({ length: n }, (_, i) => i);
export function ImportStatementButton({ accounts }: { accounts: AccountReconOverview[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)} disabled={accounts.length === 0}>Impor rekening koran</Button>
      {open && <ImportDialog accounts={accounts} onClose={() => setOpen(false)} />}
    </>
  );
}
function ImportDialog({ accounts, onClose }: { accounts: AccountReconOverview[]; onClose: () => void }) {
  const router = useRouter();
  const a = useAction(null);
  const [acctId, setAcctId] = useState(accounts.find((x) => x.kind === "BANK")?.accountId ?? accounts[0]!.accountId);
  const acct = accounts.find((x) => x.accountId === acctId)!;
  const [periodStart, setStart] = useState(acct.nextStart);
  const [periodEnd, setEnd] = useState("");
  const [opening, setOpening] = useState<number | null>(acct.suggestedOpening);
  const [closing, setClosing] = useState<number | null>(null);
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [mapping, setMapping] = useState<CsvPreview["mapping"] | null>(null);
  function pickAccount(id: string) {
    const x = accounts.find((y) => y.accountId === id)!;
    setAcctId(id); setStart(x.nextStart); setOpening(x.suggestedOpening); setPreview(null);
  }

  async function readFile(f: File | undefined) { if (f) { setText(await f.text()); setPreview(null); setMapping(null); } }
  async function doPreview(m?: CsvPreview["mapping"]) {
    const r = await a.run(() => api<CsvPreview>("/api/finance/bank/statements/preview", { body: { text, ...(m ? { mapping: m } : {}) } }));
    if (r.ok) { setPreview(r.value); setMapping(r.value.mapping); if (r.value.firstDate && !periodEnd) setEnd(r.value.lastDate ?? ""); }
  }
  const check = preview && opening !== null && closing !== null ? opening + preview.sum - closing : null;
  async function submit() {
    const r = await a.run(() => api<{ id: string }>("/api/finance/bank/statements", { body: { cashAccountId: acctId, periodStart, periodEnd, openingBalance: opening ?? 0, closingBalance: closing ?? 0, label, csv: { text, mapping: mapping ?? undefined } } }));
    if (r.ok) { onClose(); router.push(`/reconciliation/${r.value.id}`); }
  }
  const cols = preview ? COLS(preview.headers.length) : [];
  const colSelect = (label: string, key: "date" | "description" | "reference" | "amount" | "debit" | "credit", nullable: boolean) => (
    <SelectField label={label} value={mapping?.[key] ?? ""} onChange={(e) => setMapping({ ...mapping!, [key]: e.target.value === "" ? null : Number(e.target.value) })}>
      {nullable && <option value="">— tidak ada —</option>}
      {cols.map((i) => <option key={i} value={i}>{preview!.headers[i] || `Kolom ${i + 1}`}</option>)}
    </SelectField>
  );
  return (
    <Dialog open onClose={() => !a.busy && onClose()} size="xl" title="Impor rekening koran" description="Unggah/tempel CSV mutasi dari internet banking. Kolom dideteksi otomatis dan dapat diubah."
      footer={<><Button onClick={onClose} disabled={a.busy}>Batal</Button>
        <Button onClick={() => void doPreview()} disabled={!text || a.busy}>Pratinjau</Button>
        <Button variant="primary" loading={a.busy} disabled={!preview || preview.errors.length > 0 || check !== 0 || !periodEnd} onClick={() => void submit()}>Impor</Button></>}>
      <div className="space-y-4">
        {a.error && <Notice tone="danger">{a.error}</Notice>}
        <div className="grid gap-4 sm:grid-cols-3">
          <SelectField label="Akun" value={acctId} onChange={(e) => pickAccount(e.target.value)}>{accounts.map((x) => <option key={x.accountId} value={x.accountId}>{x.name}</option>)}</SelectField>
          <TextField label="Awal periode" type="date" required value={periodStart} onChange={(e) => setStart(e.target.value)} error={a.fe.periodStart} />
          <TextField label="Akhir periode" type="date" required value={periodEnd} onChange={(e) => setEnd(e.target.value)} error={a.fe.periodEnd} />
          <MoneyInput label="Saldo awal menurut bank" required value={opening} onChange={setOpening} error={a.fe.openingBalance} hint={acct.suggestedOpening !== null ? "Diisi dari saldo akhir rekening koran sebelumnya" : undefined} />
          <MoneyInput label="Saldo akhir menurut bank" required value={closing} onChange={setClosing} error={a.fe.closingBalance} />
          <TextField label="Label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="mis. Mandiri Januari" error={a.fe.label} />
        </div>
        <div>
          <label htmlFor="csvfile" className="mb-1.5 block text-sm font-medium text-ink-soft">Berkas CSV</label>
          <input id="csvfile" type="file" accept=".csv,text/csv,text/plain" onChange={(e) => void readFile(e.target.files?.[0])} className="block w-full text-sm" />
          <TextAreaField label="atau tempel isi CSV" rows={4} value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} error={a.fe.csv} />
        </div>
        {preview && mapping && (
          <div className="space-y-3 rounded-md border border-line p-3">
            <p className="text-sm font-medium">{preview.lineCount} baris terbaca · jumlah mutasi {R(preview.sum)} · {preview.firstDate ?? "—"} s.d. {preview.lastDate ?? "—"}</p>
            <div className="grid gap-3 sm:grid-cols-4">
              <label className="flex items-center gap-2 text-sm sm:col-span-4"><input type="checkbox" checked={mapping.hasHeader} onChange={(e) => setMapping({ ...mapping, hasHeader: e.target.checked })} /> Baris pertama adalah judul kolom</label>
              {colSelect("Tanggal", "date", false)}{colSelect("Uraian", "description", false)}{colSelect("Referensi", "reference", true)}
              <SelectField label="Format tanggal" value={mapping.dateFormat} onChange={(e) => setMapping({ ...mapping, dateFormat: e.target.value as typeof mapping.dateFormat })}><option value="DMY">hari/bulan/tahun</option><option value="YMD">tahun-bulan-hari</option><option value="MDY">bulan/hari/tahun</option></SelectField>
              {colSelect("Jumlah (bertanda)", "amount", true)}{colSelect("Debit (keluar)", "debit", true)}{colSelect("Kredit (masuk)", "credit", true)}
              <SelectField label="Format angka" value={mapping.numberFormat} onChange={(e) => setMapping({ ...mapping, numberFormat: e.target.value as typeof mapping.numberFormat })}><option value="ID">1.234.567,00</option><option value="EN">1,234,567.00</option></SelectField>
            </div>
            <Button size="sm" onClick={() => void doPreview(mapping)} disabled={a.busy}>Terapkan pemetaan</Button>
            {preview.errors.length > 0 && <Notice tone="danger">{preview.errors.length} baris bermasalah: {preview.errors.slice(0, 3).map((e) => `baris ${e.row}: ${e.message}`).join("; ")}</Notice>}
            {check !== null && <Notice tone={check === 0 ? "info" : "danger"}>{check === 0 ? "Saldo awal + mutasi = saldo akhir ✓" : `Saldo awal + mutasi tidak sama dengan saldo akhir (selisih ${R(check)}). Periksa berkas lengkap / pemetaan.`}</Notice>}
            <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-left text-muted"><th className="pr-3">Tanggal</th><th className="pr-3">Uraian</th><th className="pr-3">Referensi</th><th className="text-right">Jumlah</th></tr></thead>
              <tbody>{preview.sample.map((l) => <tr key={l.lineNo} className="border-t border-line/60"><td className="pr-3">{l.txDate}</td><td className="pr-3">{l.description}</td><td className="pr-3">{l.reference ?? ""}</td><td className="tabular text-right">{R(l.amount)}</td></tr>)}</tbody></table></div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ───────────────────────────── Ruang kerja rekonsiliasi ─────────────────────────────
export function StatementActions({ ws, canAct }: { ws: StatementWorkspace; canAct: boolean }) {
  const router = useRouter();
  const draft = ws.statement.status === "DRAFT";
  const auto = useAction("Pencocokan otomatis selesai.");
  const fin = useAction("Rekonsiliasi difinalisasi.");
  const del = useAction("Rekening koran dihapus.");
  const reo = useAction("Rekonsiliasi dibuka kembali.");
  const [confirm, setConfirm] = useState<"final" | "delete" | "reopen" | null>(null);
  const [reason, setReason] = useState("");
  const [win, setWin] = useState("5");
  if (!canAct) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {draft && <>
        <label className="flex items-center gap-1 text-xs text-muted">Jendela ± <select value={win} onChange={(e) => setWin(e.target.value)} className="h-9 rounded-md border border-line bg-white px-2 text-sm">{[0, 1, 3, 5, 7, 14].map((n) => <option key={n} value={n}>{n} hari</option>)}</select></label>
        <Button loading={auto.busy} onClick={() => void auto.run(() => api(`/api/finance/bank/statements/${ws.statement.id}/auto-match`, { body: { windowDays: Number(win) } }))}>Pencocokan otomatis</Button>
        <Button variant="primary" disabled={!ws.summary.canFinalize} onClick={() => setConfirm("final")}>Finalisasi</Button>
        <Button variant="danger" onClick={() => setConfirm("delete")}>Hapus draft</Button>
      </>}
      {!draft && <Button onClick={() => setConfirm("reopen")}>Buka kembali</Button>}
      {auto.error && <span className="text-sm text-brand-700">{auto.error}</span>}
      <ConfirmDialog open={confirm === "final"} onClose={() => setConfirm(null)} loading={fin.busy} confirmLabel="Ya, finalisasi" title="Finalisasi rekonsiliasi?"
        description={`Saldo bank ${R(ws.summary.closing)} + transaksi beredar ${R(ws.summary.outstandingNet)} = saldo buku ${R(ws.summary.bookBalance)}. Setelah final, pencocokan tidak dapat diubah (kecuali dibuka kembali dengan alasan).`}
        onConfirm={async () => { const r = await fin.run(() => api(`/api/finance/bank/statements/${ws.statement.id}/finalize`, { body: {} })); if (r.ok) setConfirm(null); }}>
        {fin.error && <Notice tone="danger">{fin.error}</Notice>}
      </ConfirmDialog>
      <ConfirmDialog open={confirm === "delete"} onClose={() => setConfirm(null)} loading={del.busy} tone="danger" confirmLabel="Hapus draft" title="Hapus rekening koran draft?" description="Baris mutasi dan pencocokannya dihapus. Transaksi buku tidak terpengaruh."
        onConfirm={async () => { const r = await del.run(() => api(`/api/finance/bank/statements/${ws.statement.id}`, { method: "DELETE" })); if (r.ok) router.push("/reconciliation"); }}>
        {del.error && <Notice tone="danger">{del.error}</Notice>}
      </ConfirmDialog>
      <ConfirmDialog open={confirm === "reopen"} onClose={() => setConfirm(null)} loading={reo.busy} confirmLabel="Buka kembali" title="Buka kembali rekonsiliasi?" description="Hanya dapat untuk rekening koran terakhir yang difinalisasi pada akun ini. Alasan tercatat di audit."
        onConfirm={async () => { const r = await reo.run(() => api(`/api/finance/bank/statements/${ws.statement.id}/reopen`, { body: { reason } })); if (r.ok) { setConfirm(null); setReason(""); } }}>
        <div className="space-y-3"><TextAreaField label="Alasan" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} error={reo.fe.reason} />{reo.error && <Notice tone="danger">{reo.error}</Notice>}</div>
      </ConfirmDialog>
    </div>
  );
}

/** Aksi per baris mutasi: cocokkan manual (pilih transaksi), catat dari mutasi, lepas. */
export function LineActions({ line, outstanding, categories, locked }: { line: StatementLineDto; outstanding: StatementWorkspace["outstanding"]; categories: CoaAccountDto[]; locked: boolean }) {
  const [mode, setMode] = useState<"match" | "entry" | null>(null);
  const un = useAction("Pencocokan dilepas.");
  if (locked) return null;
  const remaining = line.amount - line.matched;
  return (
    <div className="flex flex-wrap gap-1">
      {remaining !== 0 && <><Button size="sm" onClick={() => setMode("match")}>Cocokkan</Button><Button size="sm" onClick={() => setMode("entry")}>Catat dari mutasi</Button></>}
      {line.matches.length > 0 && <Button size="sm" loading={un.busy} onClick={() => void un.run(() => api(`/api/finance/bank/lines/${line.id}/unmatch`, { body: {} }))}>Lepas</Button>}
      {mode === "match" && <MatchDialog line={line} items={outstanding.filter((i) => i.matchedIn === null)} remaining={remaining} onClose={() => setMode(null)} />}
      {mode === "entry" && <EntryDialog line={line} remaining={remaining} categories={categories} onClose={() => setMode(null)} />}
    </div>
  );
}
function MatchDialog({ line, items, remaining, onClose }: { line: StatementLineDto; items: StatementWorkspace["outstanding"]; remaining: number; onClose: () => void }) {
  const a = useAction("Pencocokan disimpan.");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const keyOf = (i: { type: string; id: string }) => `${i.type}:${i.id}`;
  const total = useMemo(() => items.filter((i) => sel.has(keyOf(i))).reduce((s, i) => s + i.amount, 0), [items, sel]);
  const sorted = [...items].sort((x, y) => Math.abs(x.amount - remaining) - Math.abs(y.amount - remaining) || x.date.localeCompare(y.date));
  return (
    <Dialog open onClose={() => !a.busy && onClose()} size="lg" title={`Cocokkan baris: ${line.description}`} description={`${formatDateShort(line.txDate)} · sisa ${R(remaining)}. Pilih transaksi buku yang jumlahnya persis sama dengan sisa.`}
      footer={<><Button onClick={onClose} disabled={a.busy}>Batal</Button><Button variant="primary" loading={a.busy} disabled={sel.size === 0 || total !== remaining}
        onClick={async () => { const r = await a.run(() => api(`/api/finance/bank/lines/${line.id}/match`, { body: { items: [...sel].map((k) => { const [type, id] = k.split(":"); return { type, id }; }) } })); if (r.ok) onClose(); }}>Cocokkan</Button></>}>
      <div className="space-y-3">
        {a.error && <Notice tone="danger">{a.error}</Notice>}
        {items.length === 0 ? <p className="text-sm text-muted">Tidak ada transaksi buku yang tersedia. Gunakan “Catat dari mutasi” bila transaksi ini belum ada di buku.</p> : (
          <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line text-sm">
            {sorted.map((i) => (
              <li key={keyOf(i)}><label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-canvas">
                <input type="checkbox" checked={sel.has(keyOf(i))} onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(keyOf(i)); else n.delete(keyOf(i)); return n; })} />
                <span className="w-24 shrink-0 text-xs text-muted">{formatDateShort(i.date)}</span><span className="min-w-0 flex-1 truncate">{i.label}</span>
                <span className={`tabular shrink-0 ${i.amount < 0 ? "text-brand-700" : ""}`}>{R(i.amount)}</span>
              </label></li>
            ))}
          </ul>
        )}
        <p className={`text-sm ${total === remaining && sel.size ? "text-emerald-700" : "text-muted"}`} role="status">Terpilih {R(total)} dari sisa {R(remaining)}{total === remaining && sel.size ? " ✓" : ""}</p>
      </div>
    </Dialog>
  );
}
function EntryDialog({ line, remaining, categories, onClose }: { line: StatementLineDto; remaining: number; categories: CoaAccountDto[]; onClose: () => void }) {
  const a = useAction("Entri kas dicatat dan dicocokkan.");
  const inflow = remaining > 0;
  const usable = categories.filter((c) => c.isActive && c.manualEntry && (inflow ? c.type !== "BEBAN" : c.type !== "PENDAPATAN"));
  const [counter, setCounter] = useState("");
  const [description, setDescription] = useState(line.description);
  const [proof, setProof] = useState<File | null>(null);
  async function submit() {
    let proofFileId: string | undefined;
    if (proof) {
      const fd = new FormData(); fd.append("file", proof);
      const res = await fetch("/api/finance/proof", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok) throw new ApiClientError(j.error?.message ?? "Gagal mengunggah bukti.", res.status, j.error?.code ?? "UNKNOWN", j.error?.fieldErrors);
      proofFileId = j.data.id;
    }
    await api(`/api/finance/bank/lines/${line.id}/entry`, { body: { counterAccountId: counter, description, proofFileId } });
  }
  return (
    <Dialog open onClose={() => !a.busy && onClose()} title="Catat dari mutasi bank" description={`${inflow ? "Uang masuk" : "Uang keluar"} ${R(Math.abs(remaining))} tanggal ${formatDateShort(line.txDate)} — dicatat sebagai entri kas lalu langsung dicocokkan.`}
      footer={<><Button onClick={onClose} disabled={a.busy}>Batal</Button><Button variant="primary" loading={a.busy} disabled={!counter} onClick={async () => { if ((await a.run(submit)).ok) onClose(); }}>Catat & cocokkan</Button></>}>
      <div className="space-y-4">
        {a.error && <Notice tone="danger">{a.error}</Notice>}
        <SelectField label="Kategori" required value={counter} onChange={(e) => setCounter(e.target.value)} error={a.fe.counterAccountId}>
          <option value="">Pilih kategori…</option>{usable.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
        </SelectField>
        <TextField label="Uraian" value={description} onChange={(e) => setDescription(e.target.value)} error={a.fe.description} />
        {!inflow && Math.abs(remaining) > 1_000_000 && (
          <div><label htmlFor="eproof" className="mb-1.5 block text-sm font-medium text-ink-soft">Bukti transaksi (wajib di atas Rp 1.000.000)</label>
            <input id="eproof" type="file" accept="image/png,image/jpeg,application/pdf" onChange={(e) => setProof(e.target.files?.[0] ?? null)} className="block w-full text-sm" />
            {a.fe.proofFileId && <p role="alert" className="mt-1 text-xs font-medium text-brand-700">{a.fe.proofFileId}</p>}</div>
        )}
      </div>
    </Dialog>
  );
}

export const StatusBadge = ({ status }: { status: "DRAFT" | "FINALIZED" }) => <Badge tone={status === "FINALIZED" ? "green" : "amber"}>{status === "FINALIZED" ? "Final" : "Draft"}</Badge>;
