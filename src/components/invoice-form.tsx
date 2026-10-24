"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, Notice } from "@/components/ui/card";
import { Combobox } from "@/components/ui/combobox";
import { Dialog } from "@/components/ui/dialog";
import { Field, SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { MoneyCell, MoneyInput } from "@/components/ui/money-input";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError, errorMessage } from "@/lib/api-client";
import { calculateInvoice, CalcError, type CalcResult, type TaxRule } from "@/lib/finance/calculate";
import { computeDueDate } from "@/lib/finance/due-date";
import { formatRupiah } from "@/lib/finance/money";
import { terbilang } from "@/lib/finance/terbilang";
import { resolveRemark } from "@/lib/finance/remark";
import { formatDateShort } from "@/lib/format";
import type { BankAccountDto, CustomerDto, InvoiceDto, ProductDto, TaxConfigDto } from "@/lib/types";
import { cn } from "@/lib/cn";

interface LineState {
  key: string;
  productId: string | null;
  productLabel: string;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: number | null;
  discount: number | null;
  taxConfigId: string | null;
}

export interface InvoiceFormProps {
  mode: "create" | "edit";
  invoice?: InvoiceDto;
  defaults: { paymentMethod: string; paymentTermDays: number; dueDateBasis: "CALENDAR_DAYS" | "BUSINESS_DAYS"; today: string; banks: BankAccountDto[] };
  taxes: TaxConfigDto[];
  perms: { override: boolean; discount: boolean; createCustomer: boolean };
}

const PAYMENT_METHODS = ["Transfer", "Tunai", "QRIS", "Virtual Account", "Cek/Giro"];
let seq = 0;
const newKey = () => `l${++seq}`;
const emptyLine = (): LineState => ({ key: newKey(), productId: null, productLabel: "", description: "", quantity: "1", unit: "Pax", unitPrice: null, discount: null, taxConfigId: null });
const toRule = (t: TaxConfigDto): TaxRule => ({ key: t.id, code: t.code, name: t.name, rateBps: t.rateBps, dppNumerator: t.dppNumerator, dppDenominator: t.dppDenominator, method: t.method });

export function InvoiceForm({ mode, invoice, defaults, taxes, perms }: InvoiceFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [customer, setCustomer] = useState<{ id: string; name: string } | null>(invoice ? { id: invoice.customerId, name: invoice.customerName } : null);
  const [customerText, setCustomerText] = useState(invoice?.customerName ?? "");
  const [invoiceDate, setInvoiceDate] = useState(invoice?.invoiceDate ?? defaults.today);
  const [paymentMethod, setPaymentMethod] = useState(invoice?.paymentMethod ?? defaults.paymentMethod);
  const [term, setTerm] = useState<string>(String(invoice?.paymentTermDays ?? defaults.paymentTermDays));
  const [basis, setBasis] = useState(invoice?.dueDateBasis ?? defaults.dueDateBasis);
  const [reference, setReference] = useState(invoice?.reference ?? "");
  const [remark, setRemark] = useState(invoice?.remark ?? "");
  const [internalNote, setInternalNote] = useState(invoice?.internalNote ?? "");
  const [bankId, setBankId] = useState(invoice?.bankAccountId ?? defaults.banks.find((b) => b.isDefault)?.id ?? "");
  const [lines, setLines] = useState<LineState[]>(
    invoice?.lines.length
      ? invoice.lines.map((l) => ({
          key: newKey(), productId: l.productId, productLabel: l.productCode ?? "", description: l.description, quantity: l.quantity,
          unit: l.unit, unitPrice: l.unitPrice, discount: l.discountAmount || null, taxConfigId: l.taxConfigId,
        }))
      : [emptyLine()],
  );
  const [extraDiscount, setExtraDiscount] = useState<number | null>(invoice?.amounts.extraDiscount || null);
  const [transport, setTransport] = useState<number | null>(invoice?.amounts.transport || null);
  const [admin, setAdmin] = useState<number | null>(invoice?.amounts.admin || null);
  const [downPayment, setDownPayment] = useState<number | null>(invoice?.amounts.downPayment || null);

  const [saving, setSaving] = useState<null | "save" | "preview">(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);
  const touch = <T,>(set: (v: T) => void) => (v: T) => { set(v); setDirty(true); };

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const taxById = useMemo(() => new Map(taxes.map((t) => [t.id, t])), [taxes]);

  // ── Perhitungan langsung: modul yang SAMA dengan server (server tetap menghitung ulang secara otoritatif) ──
  const { calc, calcError } = useMemo((): { calc: CalcResult | null; calcError: string | null } => {
    const filled = lines.filter((l) => l.description.trim() || l.unitPrice !== null || l.productId);
    if (filled.length === 0) return { calc: null, calcError: null };
    try {
      const c = calculateInvoice({
        lines: filled.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice ?? 0, discount: l.discount ?? 0, tax: l.taxConfigId && taxById.get(l.taxConfigId) ? toRule(taxById.get(l.taxConfigId)!) : null })),
        extraDiscount: extraDiscount ?? 0, transport: transport ?? 0, admin: admin ?? 0, downPayment: downPayment ?? 0,
      });
      return { calc: c, calcError: null };
    } catch (e) {
      return { calc: null, calcError: e instanceof CalcError ? (e.lineIndex !== undefined ? `Baris ${e.lineIndex + 1}: ${e.message}` : e.message) : "Perhitungan tidak valid" };
    }
  }, [lines, extraDiscount, transport, admin, downPayment, taxById]);

  const termNum = /^\d+$/.test(term) ? Number(term) : null;
  const dueDate = useMemo(() => {
    try { return termNum !== null && invoiceDate ? computeDueDate(invoiceDate, termNum, basis) : null; } catch { return null; }
  }, [invoiceDate, termNum, basis]);

  const autoRemark = resolveRemark(null, lines.filter((l) => l.description.trim()).map((l) => l.description));

  // ── Handlers baris ──
  const patchLine = (key: string, patch: Partial<LineState>) => { setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l))); setDirty(true); };
  const moveLine = (i: number, d: -1 | 1) => setLines((ls) => { const j = i + d; if (j < 0 || j >= ls.length) return ls; const c = [...ls]; [c[i], c[j]] = [c[j]!, c[i]!]; setDirty(true); return c; });
  const removeLine = (key: string) => setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : ls));
  const applyProduct = (key: string, p: ProductDto) =>
    patchLine(key, { productId: p.id, productLabel: p.code, description: p.description, unit: p.unit, unitPrice: p.defaultPrice, taxConfigId: p.taxConfigId && taxById.has(p.taxConfigId) ? p.taxConfigId : null });

  const buildPayload = () => ({
    customerId: customer?.id ?? "",
    invoiceDate, paymentMethod, paymentTermDays: termNum ?? 0, dueDateBasis: basis,
    reference, remark, internalNote, bankAccountId: bankId || null,
    lines: lines.filter((l) => l.description.trim() || l.productId || l.unitPrice !== null).map((l) => ({
      productId: l.productId, description: l.description, quantity: l.quantity.replace(",", "."), unit: l.unit,
      unitPrice: l.unitPrice ?? 0, discount: l.discount ?? 0, taxConfigId: l.taxConfigId,
    })),
    extraDiscount: extraDiscount ?? 0, transport: transport ?? 0, admin: admin ?? 0, downPayment: downPayment ?? 0,
    ...(mode === "edit" && invoice ? { expectedVersion: invoice.version } : {}),
  });

  async function save(after: "stay" | "preview") {
    setError(null); setFieldErrors({});
    if (!customer) { setFieldErrors({ customerId: "Pilih pelanggan dari daftar" }); setError("Pilih pelanggan terlebih dahulu."); return; }
    if (termNum === null) { setFieldErrors({ paymentTermDays: "Isi jumlah hari (angka bulat)" }); setError("Jangka waktu pembayaran harus berupa angka hari."); return; }
    if (calcError) { setError(calcError); return; }
    if (!calc) { setError("Tambahkan minimal satu baris produk/layanan."); return; }
    setSaving(after === "preview" ? "preview" : "save");
    try {
      const saved = mode === "create"
        ? await api<InvoiceDto>("/api/invoices", { body: buildPayload() })
        : await api<InvoiceDto>(`/api/invoices/${invoice!.id}`, { method: "PUT", body: buildPayload() });
      setDirty(false);
      toast.success("Draft tersimpan.");
      router.push(`/invoices/${saved.id}${after === "preview" ? "?preview=1" : ""}`);
      router.refresh();
    } catch (e) {
      setSaving(null);
      setError(errorMessage(e));
      if (e instanceof ApiClientError) setFieldErrors(e.fieldErrors);
    }
  }

  const R = (n: number) => formatRupiah(n, "PLAIN");
  const lineErr = (i: number, f: string) => fieldErrors[`lines.${i}.${f}`] ?? fieldErrors[`lines.${i}`];

  return (
    <form onSubmit={(e) => { e.preventDefault(); void save("stay"); }} className="grid gap-5 xl:grid-cols-[1fr_22rem]" noValidate>
      <div className="min-w-0 space-y-5">
        {error && <Notice tone="danger">{error}</Notice>}

        <Card>
          <CardHeader title="Informasi utama" description="Nomor invoice dialokasikan otomatis oleh sistem saat diterbitkan." />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label="Pelanggan" required error={fieldErrors.customerId} className="sm:col-span-2" htmlFor="cust">
              <Combobox<CustomerDto>
                ariaLabel="Pelanggan" value={customerText} invalid={!!fieldErrors.customerId} placeholder="Ketik nama pelanggan…"
                onValueChange={(v) => { setCustomerText(v); if (customer) { setCustomer(null); } setDirty(true); }}
                search={(q) => api<CustomerDto[]>(`/api/customers/search?q=${encodeURIComponent(q)}`)}
                onSelect={(c) => { setCustomer({ id: c.id, name: c.name }); setCustomerText(c.name); setDirty(true); }}
                itemKey={(c) => c.id}
                renderItem={(c) => <div><p className="font-medium">{c.name}</p><p className="text-xs text-muted">{[c.city, c.contactName].filter(Boolean).join(" · ") || "—"}</p></div>}
                footer={perms.createCustomer ? <button type="button" className="font-medium text-brand-700 hover:underline" onMouseDown={(e) => { e.preventDefault(); setNewCustomerOpen(true); }}>+ Tambah pelanggan baru</button> : undefined}
              />
              {customer && <p className="mt-1 text-xs text-emerald-700">✓ Pelanggan terpilih — data alamat & NPWP diambil dari master saat invoice diterbitkan.</p>}
            </Field>
            <TextField label="Tanggal invoice" type="date" required value={invoiceDate} onChange={(e) => touch(setInvoiceDate)(e.target.value)} error={fieldErrors.invoiceDate} />
            <SelectField label="Metode pembayaran" value={paymentMethod} onChange={(e) => touch(setPaymentMethod)(e.target.value)}>
              {[...new Set([...PAYMENT_METHODS, paymentMethod])].map((m) => <option key={m}>{m}</option>)}
            </SelectField>
            <TextField label="Jangka waktu (hari)" inputMode="numeric" required value={term} onChange={(e) => touch(setTerm)(e.target.value.replace(/\D/g, ""))} error={fieldErrors.paymentTermDays} />
            <SelectField label="Hitungan hari" value={basis} onChange={(e) => touch(setBasis)(e.target.value as typeof basis)} hint="Hari kerja = Senin–Jumat (hari libur nasional belum dikecualikan)">
              <option value="CALENDAR_DAYS">Hari kalender</option><option value="BUSINESS_DAYS">Hari kerja</option>
            </SelectField>
            <Field label="Tanggal jatuh tempo" htmlFor="due" hint="Dihitung otomatis dari tanggal invoice dan jangka waktu">
              <output id="due" className="flex h-10 items-center rounded-md border border-line bg-canvas px-3 text-sm font-medium">{dueDate ? formatDateShort(dueDate) : "—"}</output>
            </Field>
            <TextField label="Referensi / No. kontrak" value={reference} onChange={(e) => touch(setReference)(e.target.value)} placeholder="Opsional" error={fieldErrors.reference} />
            {defaults.banks.length > 0 && (
              <SelectField label="Transfer ke rekening" value={bankId} onChange={(e) => touch(setBankId)(e.target.value)} className="sm:col-span-2">
                {defaults.banks.map((b) => <option key={b.id} value={b.id}>{b.label} — {b.accountNumber} a.n. {b.accountName}</option>)}
              </SelectField>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Rincian transaksi" description="Pilih produk — deskripsi, satuan, harga, dan pajak terisi otomatis dari data master."
            actions={<Button size="sm" onClick={() => { setLines((ls) => [...ls, emptyLine()]); setDirty(true); }}><Plus className="size-4" />Tambah baris</Button>} />
          <div className="divide-y divide-line">
            {lines.map((l, i) => {
              const gross = calc?.lines[lines.filter((x) => x.description.trim() || x.unitPrice !== null || x.productId).findIndex((x) => x.key === l.key)];
              const fromProduct = !!l.productId;
              const priceLocked = !perms.override;
              return (
                <div key={l.key} className="space-y-3 p-5" data-testid={`line-${i}`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-ink-soft">Baris {i + 1}</p>
                    <div className="flex gap-1">
                      <button type="button" aria-label={`Naikkan baris ${i + 1}`} disabled={i === 0} onClick={() => moveLine(i, -1)} className="rounded p-1.5 text-muted hover:bg-black/5 disabled:opacity-30"><ArrowUp className="size-4" /></button>
                      <button type="button" aria-label={`Turunkan baris ${i + 1}`} disabled={i === lines.length - 1} onClick={() => moveLine(i, 1)} className="rounded p-1.5 text-muted hover:bg-black/5 disabled:opacity-30"><ArrowDown className="size-4" /></button>
                      <button type="button" aria-label={`Hapus baris ${i + 1}`} disabled={lines.length === 1} onClick={() => removeLine(l.key)} className="rounded p-1.5 text-brand-700 hover:bg-brand-50 disabled:opacity-30"><Trash2 className="size-4" /></button>
                    </div>
                  </div>
                  <div className="grid gap-3 md:grid-cols-12">
                    <Field label="Produk / layanan" className="md:col-span-5" htmlFor={`prod-${l.key}`} error={lineErr(i, "productId")}>
                      <Combobox<ProductDto>
                        ariaLabel={`Produk baris ${i + 1}`} value={l.productLabel} placeholder={perms.override ? "Cari produk atau ketik bebas…" : "Cari produk…"}
                        onValueChange={(v) => patchLine(l.key, { productLabel: v, ...(l.productId ? { productId: null } : {}) })}
                        search={(q) => api<ProductDto[]>(`/api/products/search?q=${encodeURIComponent(q)}`)}
                        onSelect={(p) => applyProduct(l.key, p)} itemKey={(p) => p.id}
                        renderItem={(p) => <div><p className="font-medium">{p.name}{p.schemeName ? ` — ${p.schemeName}` : ""}</p><p className="text-xs text-muted">{p.code} · {formatRupiah(p.defaultPrice, "PLAIN")} / {p.unit}</p></div>}
                      />
                    </Field>
                    <TextField label="Qty" className="md:col-span-2" inputMode="decimal" value={l.quantity} onChange={(e) => patchLine(l.key, { quantity: e.target.value.replace(/[^\d.,]/g, "") })} error={lineErr(i, "quantity")} aria-label={`Kuantitas baris ${i + 1}`} />
                    <TextField label="Satuan" className="md:col-span-2" value={l.unit} onChange={(e) => patchLine(l.key, { unit: e.target.value })} error={lineErr(i, "unit")} />
                    <Field label="Harga satuan" className="md:col-span-3" htmlFor={`price-${l.key}`} error={lineErr(i, "unitPrice")} hint={priceLocked && fromProduct ? "Mengikuti harga master" : undefined}>
                      <MoneyCell ariaLabel={`Harga satuan baris ${i + 1}`} value={l.unitPrice} disabled={priceLocked} onChange={(v) => patchLine(l.key, { unitPrice: v })} />
                    </Field>
                    <TextAreaField label="Deskripsi (tampil di invoice)" className="md:col-span-7" rows={3} value={l.description} onChange={(e) => patchLine(l.key, { description: e.target.value })} error={lineErr(i, "description")} hint="Boleh disesuaikan untuk transaksi ini tanpa mengubah data master." />
                    <div className="grid gap-3 md:col-span-5 md:grid-cols-2">
                      {perms.discount && (
                        <Field label="Diskon baris" htmlFor={`disc-${l.key}`} error={lineErr(i, "discount")}>
                          <MoneyCell ariaLabel={`Diskon baris ${i + 1}`} value={l.discount} onChange={(v) => patchLine(l.key, { discount: v })} />
                        </Field>
                      )}
                      <SelectField label="Pajak" value={l.taxConfigId ?? ""} disabled={!perms.override} onChange={(e) => patchLine(l.key, { taxConfigId: e.target.value || null })}>
                        <option value="">Tanpa pajak</option>
                        {taxes.map((t) => <option key={t.id} value={t.id}>{t.name}{t.method === "INCLUSIVE" ? " (termasuk)" : ""}</option>)}
                      </SelectField>
                      <div className="md:col-span-2 flex items-baseline justify-between rounded-md bg-canvas px-3 py-2 text-sm">
                        <span className="text-muted">Jumlah bersih</span>
                        <span className="tabular font-semibold" aria-live="polite">{gross ? R(gross.netAmount) : "—"}</span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {!perms.override && <p className="border-t border-line px-5 py-3 text-xs text-muted">Harga dan pajak mengikuti data master. Perubahan harga memerlukan peran Finance/Administrator.</p>}
        </Card>

        <Card>
          <CardHeader title="Catatan" />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <TextAreaField label="Remark (dicetak pada invoice)" rows={3} value={remark} onChange={(e) => touch(setRemark)(e.target.value)} error={fieldErrors.remark}
              placeholder={autoRemark ?? "Kosongkan untuk otomatis"} hint={autoRemark && !remark ? "Kosong → otomatis memakai deskripsi baris" : undefined} />
            <TextAreaField label="Catatan internal (tidak dicetak)" rows={3} value={internalNote} onChange={(e) => touch(setInternalNote)(e.target.value)} error={fieldErrors.internalNote} />
          </div>
        </Card>
      </div>

      {/* ── Ringkasan biaya ── */}
      <aside className="xl:sticky xl:top-6 xl:self-start">
        <Card>
          <CardHeader title="Ringkasan biaya" />
          <div className="space-y-3 p-5 text-sm">
            <Row label="Subtotal produk/jasa" value={calc ? R(calc.subtotalAmount) : "—"} />
            {perms.discount && <MoneyInput label="Diskon tambahan" value={extraDiscount} onChange={touch(setExtraDiscount)} error={fieldErrors.extraDiscount} />}
            {calc && calc.taxGroups.map((g) => (
              <Row key={g.key} label={`${g.name}${g.method === "INCLUSIVE" ? " (termasuk)" : ""}`} value={R(g.taxAmount)} muted={!g.addedToTotal} />
            ))}
            {calc && calc.taxGroups.length === 0 && <Row label="Pajak" value="Rp 0" />}
            <MoneyInput label="Transport" value={transport} onChange={touch(setTransport)} error={fieldErrors.transport} />
            <MoneyInput label="Administrasi" value={admin} onChange={touch(setAdmin)} error={fieldErrors.admin} />
            <div className="border-t border-dashed border-ink/40 pt-3">
              <Row label="Nett Total" value={calc ? R(calc.totalAmount) : "—"} strong />
              {calc && <p className="mt-1 text-xs italic text-muted" aria-label="Terbilang">{terbilang(calc.totalAmount)}</p>}
            </div>
            <MoneyInput label="Down Payment (DP) diterima" value={downPayment} onChange={touch(setDownPayment)} error={fieldErrors.downPayment}
              hint="Dicatat sebagai pembayaran saat invoice terbit; mengurangi sisa tagihan, bukan nilai invoice." />
            <Row label="Sisa tagihan" value={calc ? R(calc.balanceAmount) : "—"} strong />
            {calcError && <Notice tone="warn">{calcError}</Notice>}
          </div>
          <div className="flex flex-col gap-2 border-t border-line bg-canvas/60 p-5">
            <Button type="submit" variant="primary" loading={saving === "save"} disabled={!!saving}>Simpan draft</Button>
            <Button onClick={() => void save("preview")} loading={saving === "preview"} disabled={!!saving}>Simpan & pratinjau PDF</Button>
            <Link href={mode === "edit" && invoice ? `/invoices/${invoice.id}` : "/invoices"} className="text-center text-sm text-muted hover:underline">Batal</Link>
          </div>
        </Card>
      </aside>

      <NewCustomerDialog open={newCustomerOpen} onClose={() => setNewCustomerOpen(false)} initialName={customerText}
        onCreated={(c) => { setCustomer({ id: c.id, name: c.name }); setCustomerText(c.name); setDirty(true); setNewCustomerOpen(false); toast.success(`Pelanggan ${c.name} ditambahkan.`); }} />
    </form>
  );
}

function Row({ label, value, strong, muted }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3", muted && "text-muted")}>
      <span className={cn(strong ? "font-semibold text-ink" : "text-ink-soft")}>{label}</span>
      <span className={cn("tabular", strong && "text-lg font-semibold text-ink")}>{value}</span>
    </div>
  );
}

function NewCustomerDialog({ open, onClose, onCreated, initialName }: { open: boolean; onClose: () => void; onCreated: (c: CustomerDto) => void; initialName: string }) {
  const [f, setF] = useState({ name: "", city: "", contactName: "", phone: "", email: "", address: "" });
  const [err, setErr] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [dups, setDups] = useState<{ id: string; name: string; city: string | null }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const wasOpen = useRef(false);
  useEffect(() => { if (open && !wasOpen.current) { setF((x) => ({ ...x, name: initialName })); setErr(null); setFe({}); setDups(null); } wasOpen.current = open; }, [open, initialName]);

  async function submit(confirmDistinct = false) {
    setBusy(true); setErr(null); setFe({});
    try {
      onCreated(await api<CustomerDto>("/api/customers", { body: { ...f, confirmDistinct } }));
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiClientError) {
        setFe(e.fieldErrors);
        setErr(e.message);
        const d = (e.details.duplicates ?? []) as { id: string; name: string; city: string | null }[];
        // needsConfirmation = mirip tetapi bukan identik → pengguna boleh menegaskan bahwa ini pelanggan berbeda.
        setDups(e.details.needsConfirmation ? d : null);
      } else setErr(errorMessage(e));
    }
  }
  return (
    <Dialog open={open} onClose={() => !busy && onClose()} title="Tambah pelanggan baru" size="md"
      footer={<><Button onClick={onClose} disabled={busy}>Batal</Button>
        {dups && dups.length > 0 && <Button onClick={() => void submit(true)} loading={busy}>Tetap simpan sebagai pelanggan baru</Button>}
        <Button variant="primary" loading={busy} onClick={() => void submit(false)}>Simpan</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {err && <div className="sm:col-span-2"><Notice tone="danger">{err}</Notice></div>}
        {dups && dups.length > 0 && <div className="sm:col-span-2"><Notice tone="warn">Pelanggan mirip yang sudah ada: {dups.map((d) => `${d.name}${d.city ? ` (${d.city})` : ""}`).join("; ")}. Tutup dialog dan pilih dari daftar bila sama.</Notice></div>}
        <TextField label="Nama perusahaan / instansi" required className="sm:col-span-2" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={fe.name} />
        <TextField label="Kota" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} error={fe.city} />
        <TextField label="Nama kontak" value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} error={fe.contactName} />
        <TextField label="Telepon" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} error={fe.phone} />
        <TextField label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} error={fe.email} />
        <TextAreaField label="Alamat" className="sm:col-span-2" rows={2} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} error={fe.address} />
      </div>
    </Dialog>
  );
}
