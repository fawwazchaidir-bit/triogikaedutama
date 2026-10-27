import "server-only";
import { z } from "zod";
import { prisma, transaction, type Tx } from "../db";
import { env } from "../env";
import { Errors } from "../errors";
import { parseInput } from "../validate";
import { assertCan, type Actor } from "../actor";
import { writeAudit } from "../audit";
import { dateToIso, isoToDate } from "../json";
import type { ReportTable } from "../export";
import { loadGl } from "./finance-ledger";
import { createEntry } from "./cash-entries";
import { createJournalTx, getJournalDto, journalInputSchema } from "./journals";
import { getBooksLock } from "./books-lock";
import { glIncome, type GlLine } from "@/lib/accounting/ledger";
import {
  CODE_PPH_BADAN_EXPENSE, CODE_PPH_BADAN_PAYABLE, CODE_PPH_CREDIT, CODE_VAT_OUT,
  corporateTax, type CorporateTaxEstimate, type CorporateTaxRegimeValue,
} from "@/lib/accounting/tax";
import { formatDateLong, todayIso } from "@/lib/format";
import { isoDate, optionalText, requiredText, rupiah, uuid } from "@/lib/validation/common";

/**
 * ═══════════ PAJAK (PPN keluaran, PPh dipotong pelanggan, estimasi PPh badan) ═══════════
 * Sistem TIDAK mengasumsikan tarif atau aturan pajak: PPN mengikuti pajak yang tercetak pada invoice; PPh yang dipotong pelanggan diinput dari bukti
 * potong; tarif PPh badan, koreksi fiskal, kompensasi rugi, dan fasilitas diisi Admin/Finance Manager/akuntan. Semua keluaran adalah ESTIMASI manajemen
 * (bukan SPT) dan wajib ditinjau konsultan pajak sebelum dilaporkan.
 */
export const TAX_DISCLAIMER =
  "Rekap pajak ini ESTIMASI manajemen dari pembukuan basis kas — bukan SPT dan bukan nasihat pajak. Tarif, koreksi fiskal, kompensasi kerugian, dan fasilitas pajak adalah masukan Anda; " +
  "PPN dihitung dari penerimaan kas (kewajiban PPN menurut faktur pajak bisa lebih awal — lihat PPN atas invoice yang belum dilunasi). Tinjau bersama konsultan pajak sebelum melapor.";

const CTAX_REGIMES = ["NONE", "GENERAL", "FINAL"] as const;

// ───────────────────────────── Profil pajak ─────────────────────────────
export interface TaxProfileDto { isPkp: boolean; regime: CorporateTaxRegimeValue; rateBps: number | null }

export async function getTaxProfile(actor: Actor): Promise<TaxProfileDto> {
  assertCan(actor, "finance:view");
  return readProfile();
}
async function readProfile(db: Pick<typeof prisma, "companySettings"> = prisma): Promise<TaxProfileDto> {
  const s = await db.companySettings.findUnique({ where: { id: 1 }, select: { isPkp: true, corporateTaxRegime: true, corporateTaxRateBps: true } });
  return { isPkp: s?.isPkp ?? false, regime: s?.corporateTaxRegime ?? "NONE", rateBps: s?.corporateTaxRateBps ?? null };
}

export const taxProfileSchema = z.object({
  isPkp: z.boolean(),
  regime: z.enum(CTAX_REGIMES),
  rateBps: z.preprocess((v) => (v === "" || v === undefined ? null : v), z.number({ error: "Tarif harus berupa angka" }).int("Tarif dalam basis poin (bilangan bulat)").min(0).max(10_000, "Tarif maksimal 100%").nullable()),
});

export async function updateTaxProfile(actor: Actor, raw: unknown): Promise<TaxProfileDto> {
  assertCan(actor, "finance:manage");
  const input = parseInput(taxProfileSchema, raw);
  if (input.regime !== "NONE" && input.rateBps === null) throw Errors.validation("Tarif wajib diisi bila estimasi PPh badan diaktifkan.", { rateBps: "Wajib diisi" });
  const before = await readProfile();
  await transaction(async (tx) => {
    await tx.companySettings.update({ where: { id: 1 }, data: { isPkp: input.isPkp, corporateTaxRegime: input.regime, corporateTaxRateBps: input.rateBps } });
    await writeAudit(tx, actor, { action: "tax.profile", entityType: "CompanySettings", entityId: "1", summary: "Profil pajak diperbarui", before, after: input });
  });
  return readProfile();
}

// ───────────────────────────── Input tahunan PPh badan ─────────────────────────────
export interface TaxYearInputDto { year: number; fiscalCorrection: number; lossCompensation: number; facilityReduction: number; note: string | null }

async function readYearInput(year: number, db: Pick<typeof prisma, "taxYearInput"> = prisma): Promise<TaxYearInputDto> {
  const r = await db.taxYearInput.findUnique({ where: { year } });
  return { year, fiscalCorrection: Number(r?.fiscalCorrection ?? 0n), lossCompensation: Number(r?.lossCompensation ?? 0n), facilityReduction: Number(r?.facilityReduction ?? 0n), note: r?.note ?? null };
}

const yearSchema = z.coerce.number().int().min(2000).max(2200);
export const taxYearInputSchema = z.object({
  year: yearSchema,
  fiscalCorrection: z.number({ error: "Koreksi fiskal harus berupa angka" }).int("Bilangan bulat Rupiah").min(-999_999_999_999_999).max(999_999_999_999_999),
  lossCompensation: rupiah("Kompensasi kerugian"),
  facilityReduction: rupiah("Pengurang pajak"),
  note: optionalText(300, "Catatan"),
});

export async function saveTaxYearInput(actor: Actor, raw: unknown): Promise<TaxYearInputDto> {
  assertCan(actor, "journal:record");
  const input = parseInput(taxYearInputSchema, raw);
  const lock = await getBooksLock();
  if (lock && `${input.year}-12-31` <= lock) throw Errors.conflict(`Tahun ${input.year} sudah ditutup (buku ditutup sampai ${formatDateLong(lock)}). Buka kembali periode lebih dulu.`);
  const before = await readYearInput(input.year);
  await transaction(async (tx) => {
    await tx.taxYearInput.upsert({
      where: { year: input.year },
      create: { year: input.year, fiscalCorrection: BigInt(input.fiscalCorrection), lossCompensation: BigInt(input.lossCompensation), facilityReduction: BigInt(input.facilityReduction), note: input.note, updatedById: actor.userId },
      update: { fiscalCorrection: BigInt(input.fiscalCorrection), lossCompensation: BigInt(input.lossCompensation), facilityReduction: BigInt(input.facilityReduction), note: input.note, updatedById: actor.userId },
    });
    await writeAudit(tx, actor, { action: "tax.year_input", entityType: "TaxYearInput", entityId: String(input.year), summary: `Input pajak tahun ${input.year} diperbarui`, before, after: input });
  });
  return readYearInput(input.year);
}

// ───────────────────────────── Util buku besar ─────────────────────────────
const inRange = (l: GlLine, from: string, to: string) => l.date >= from && l.date <= to;
const lastDay = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);
function months(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4)), endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) { out.push(`${y}-${String(m).padStart(2, "0")}`); if (++m > 12) { m = 1; y++; } }
  return out;
}

const periodSchema = z.object({ from: isoDate.optional(), to: isoDate.optional() });
function period(raw: unknown): { from: string; to: string } {
  const f = parseInput(periodSchema, raw ?? {});
  const today = todayIso(env().APP_TIMEZONE);
  const to = f.to ?? today;
  const from = f.from ?? `${to.slice(0, 4)}-01-01`;
  if (from > to) throw Errors.validation("Tanggal awal tidak boleh setelah tanggal akhir.", { from: "Harus ≤ tanggal akhir" });
  if (to > today) throw Errors.validation("Tanggal akhir tidak boleh di masa depan.", { to: "Tidak boleh di masa depan" });
  if (months(from, to).length > 36) throw Errors.validation("Rentang maksimal 36 bulan.", { to: "Terlalu panjang" });
  return { from, to };
}

// ───────────────────────────── Rekap PPN ─────────────────────────────
export interface VatMonthRow {
  month: string;
  invoiceCount: number; invoiceBase: number; invoiceVat: number;
  vatReceived: number; vatRemitted: number; vatAdjustments: number; endingLiability: number;
}
export interface VatSummary {
  from: string; to: string; isPkp: boolean; rows: VatMonthRow[];
  totals: { invoiceCount: number; invoiceBase: number; invoiceVat: number; vatReceived: number; vatRemitted: number; vatAdjustments: number };
  liabilityNow: number;
  /** PPN pada invoice terbit yang belum dilunasi: kewajiban menurut faktur sudah timbul, tetapi belum masuk buku (basis kas). */
  vatOnUnpaidInvoices: number;
}

export async function getVatSummary(actor: Actor, raw: unknown = {}): Promise<VatSummary> {
  assertCan(actor, "finance:view");
  const { from, to } = period(raw);
  const [{ lines, coa }, profile] = await Promise.all([loadGl(to), readProfile()]);
  const vatId = coa.find((a) => a.code === CODE_VAT_OUT)!.id;
  const vatLines = lines.filter((l) => l.accountId === vatId);
  const inv = await prisma.$queryRaw<{ m: string; n: bigint; base: bigint; vat: bigint }[]>`
    SELECT to_char("invoiceDate", 'YYYY-MM') AS m, COUNT(*) AS n, COALESCE(SUM("taxBaseAmount"), 0) AS base, COALESCE(SUM("taxAmount"), 0) AS vat
      FROM invoices WHERE "status" = 'ISSUED' AND "taxAmount" > 0 AND "invoiceDate" BETWEEN ${isoToDate(from)} AND ${isoToDate(to)} GROUP BY 1`;
  const unpaid = await prisma.$queryRaw<{ v: bigint | null }[]>`
    SELECT COALESCE(SUM(i."taxAmount" - COALESCE(p.v, 0)), 0) AS v
      FROM invoices i LEFT JOIN (SELECT "invoiceId", SUM("vatAmount") AS v FROM payments GROUP BY 1) p ON p."invoiceId" = i."id"
     WHERE i."status" = 'ISSUED' AND i."taxAmount" > 0`;
  const byInv = new Map(inv.map((r) => [r.m, r]));
  const rows: VatMonthRow[] = months(from, to).map((m) => {
    const lo = m === from.slice(0, 7) ? from : `${m}-01`, hi = m === to.slice(0, 7) ? to : lastDay(m);
    const mine = vatLines.filter((l) => inRange(l, lo, hi));
    const sum = (src: GlLine["source"]) => mine.filter((l) => l.source === src).reduce((s, l) => s + l.credit - l.debit, 0);
    const i = byInv.get(m);
    return {
      month: m, invoiceCount: Number(i?.n ?? 0n), invoiceBase: Number(i?.base ?? 0n), invoiceVat: Number(i?.vat ?? 0n),
      vatReceived: sum("INVOICE_PAYMENT"), vatRemitted: 0 - sum("CASH_ENTRY"), vatAdjustments: sum("MANUAL"),
      endingLiability: vatLines.filter((l) => l.date <= hi).reduce((s, l) => s + l.credit - l.debit, 0),
    };
  });
  const t = (k: keyof Omit<VatMonthRow, "month" | "endingLiability">) => rows.reduce((s, r) => s + r[k], 0);
  return {
    from, to, isPkp: profile.isPkp, rows,
    totals: { invoiceCount: t("invoiceCount"), invoiceBase: t("invoiceBase"), invoiceVat: t("invoiceVat"), vatReceived: t("vatReceived"), vatRemitted: t("vatRemitted"), vatAdjustments: t("vatAdjustments") },
    liabilityNow: vatLines.reduce((s, l) => s + l.credit - l.debit, 0),
    vatOnUnpaidInvoices: Number(unpaid[0]?.v ?? 0n),
  };
}

// ───────────────────────────── Register PPh dipotong pelanggan ─────────────────────────────
export interface WithholdingRow {
  paymentId: string; date: string; invoiceId: string; invoiceNumber: string | null; customer: string; customerNpwp: string | null;
  amount: number; entryType: "PAYMENT" | "REVERSAL"; ref: string | null;
}
export interface WithholdingRegister { from: string; to: string; rows: WithholdingRow[]; net: number; missingRef: number; missingRefAmount: number }

export async function getWithholdingRegister(actor: Actor, raw: unknown = {}): Promise<WithholdingRegister> {
  assertCan(actor, "finance:view");
  const { from, to } = period(raw);
  const rows = await prisma.payment.findMany({
    where: { withholdingAmount: { not: 0n }, paymentDate: { gte: isoToDate(from), lte: isoToDate(to) } },
    include: { invoice: { select: { id: true, number: true, customerNameSnapshot: true, customerSnapshot: true } } },
    orderBy: [{ paymentDate: "asc" }, { createdAt: "asc" }],
  });
  const out: WithholdingRow[] = rows.map((p) => ({
    paymentId: p.id, date: dateToIso(p.paymentDate), invoiceId: p.invoice.id, invoiceNumber: p.invoice.number, customer: p.invoice.customerNameSnapshot,
    customerNpwp: ((p.invoice.customerSnapshot as { npwp?: string | null } | null)?.npwp) ?? null,
    amount: Number(p.withholdingAmount), entryType: p.entryType, ref: p.withholdingRef,
  }));
  const missing = out.filter((r) => r.entryType === "PAYMENT" && !r.ref);
  return { from, to, rows: out, net: out.reduce((s, r) => s + r.amount, 0), missingRef: missing.length, missingRefAmount: missing.reduce((s, r) => s + r.amount, 0) };
}

export const withholdingRefSchema = z.object({ ref: requiredText(3, 60, "Nomor bukti potong") });
/** Melengkapi nomor bukti potong yang baru diterima (hanya dari kosong; satu-satunya perubahan yang diizinkan pada pembayaran). */
export async function setWithholdingRef(actor: Actor, paymentId: string, raw: unknown): Promise<void> {
  assertCan(actor, "payment:record");
  uuid.parse(paymentId);
  const { ref } = parseInput(withholdingRefSchema, raw);
  await transaction(async (tx) => {
    const p = await tx.payment.findUnique({ where: { id: paymentId }, include: { invoice: { select: { number: true } } } });
    if (!p) throw Errors.notFound("Pembayaran");
    if (p.entryType !== "PAYMENT" || p.withholdingAmount <= 0n) throw Errors.conflict("Pembayaran ini tidak memuat PPh yang dipotong pelanggan.");
    if (p.withholdingRef) throw Errors.conflict("Nomor bukti potong sudah terisi. Untuk koreksi, balikkan pembayaran lalu catat ulang.");
    const n = await tx.payment.updateMany({ where: { id: paymentId, withholdingRef: null }, data: { withholdingRef: ref } });
    if (n.count !== 1) throw Errors.conflict("Nomor bukti potong sudah terisi oleh pengguna lain.");
    await writeAudit(tx, actor, { action: "tax.withholding_ref", entityType: "Invoice", entityId: p.invoiceId, summary: `Nomor bukti potong ${ref} dilengkapi pada pembayaran invoice ${p.invoice.number}`, after: { paymentId, ref } });
  });
}

// ───────────────────────────── Estimasi PPh badan ─────────────────────────────
export interface CorporateTaxSuggestionLine { code: string; name: string; debit: number; credit: number }
export interface CorporateTaxReport {
  profile: TaxProfileDto;
  year: number; month: number | null; from: string; to: string; partial: boolean;
  input: TaxYearInputDto;
  commercialProfit: number; grossRevenue: number;
  estimate: CorporateTaxEstimate;
  booked: { taxExpense: number; credit1400: number; reclassed: number; account2230: number };
  /** Jurnal penyesuaian yang membawa pembukuan sesuai estimasi (null bila sudah sesuai / estimasi nonaktif). */
  suggestion: { date: string; description: string; lines: CorporateTaxSuggestionLine[] } | null;
}

const ctQuerySchema = z.object({ year: yearSchema, month: z.preprocess((v) => (v === null || v === "" ? undefined : v), z.coerce.number().int().min(1, "Bulan 1–12").max(12, "Bulan 1–12").optional()) });

/** Hitung estimasi tanpa pemeriksaan izin (untuk layanan lain, mis. daftar periksa tutup buku). */
export async function computeCorporateTax(raw: unknown, db: Tx | typeof prisma = prisma): Promise<CorporateTaxReport> {
  const q = parseInput(ctQuerySchema, raw ?? {});
  const profile = await readProfile(db);
  const today = todayIso(env().APP_TIMEZONE);
  if (profile.regime === "FINAL" && q.month === undefined) throw Errors.validation("PPh final dihitung per bulan: pilih bulan.", { month: "Wajib untuk PPh final" });
  const month = profile.regime === "FINAL" ? q.month! : null;
  const from = month ? `${q.year}-${String(month).padStart(2, "0")}-01` : `${q.year}-01-01`;
  const fullTo = month ? lastDay(`${q.year}-${String(month).padStart(2, "0")}`) : `${q.year}-12-31`;
  if (from > today) throw Errors.validation("Periode belum dimulai.", { year: "Tidak boleh di masa depan" });
  const to = fullTo < today ? fullTo : today;
  const { lines, coa } = await loadGl(to, db);
  const id = (code: string) => coa.find((a) => a.code === code)!.id;
  const mine = lines.filter((l) => inRange(l, from, to));
  const sum = (code: string, pred: (l: GlLine) => boolean, sign: 1 | -1) => mine.filter((l) => l.accountId === id(code) && pred(l)).reduce((s, l) => s + sign * (l.debit - l.credit), 0);
  const pl = glIncome(lines, coa, from, to);
  const input = month ? { year: q.year, fiscalCorrection: 0, lossCompensation: 0, facilityReduction: 0, note: null } : await readYearInput(q.year, db);
  const taxExpense = sum(CODE_PPH_BADAN_EXPENSE, () => true, 1);
  const credit1400 = sum(CODE_PPH_CREDIT, (l) => l.source === "INVOICE_PAYMENT", 1);
  const reclassed = sum(CODE_PPH_CREDIT, (l) => l.source === "MANUAL", -1);
  const installments = sum(CODE_PPH_BADAN_PAYABLE, (l) => l.source === "CASH_ENTRY", 1);
  const account2230 = 0 - sum(CODE_PPH_BADAN_PAYABLE, () => true, 1); // saldo kredit (utang) positif
  const estimate = corporateTax({
    regime: profile.regime, rateBps: profile.rateBps, commercialProfit: pl.profitBeforeTax, grossRevenue: pl.totalRevenue,
    fiscalCorrection: input.fiscalCorrection, lossCompensation: input.lossCompensation, facilityReduction: input.facilityReduction,
    withholdingCredit: credit1400, installmentsPaid: installments,
  });

  // Jurnal penyesuaian: (a) bebankan pajak terutang yang belum dibukukan; (b) pindahkan kredit PPh 23 yang sudah dipakai ke utang PPh badan.
  let suggestion: CorporateTaxReport["suggestion"] = null;
  if (profile.regime !== "NONE") {
    const accrual = estimate.taxDue - taxExpense;
    const reclass = profile.regime === "GENERAL" ? credit1400 - reclassed : 0;
    const net: Record<string, number> = { [CODE_PPH_BADAN_EXPENSE]: accrual, [CODE_PPH_BADAN_PAYABLE]: -accrual + reclass, [CODE_PPH_CREDIT]: -reclass };
    const names = new Map(coa.map((a) => [a.code, a.name]));
    const jl = Object.entries(net).filter(([, v]) => v !== 0).sort(([a], [b]) => a.localeCompare(b)).map(([code, v]) => ({ code, name: names.get(code)!, debit: v > 0 ? v : 0, credit: v < 0 ? -v : 0 }));
    if (jl.length >= 2) {
      suggestion = {
        date: to,
        description: month ? `PPh final ${q.year}-${String(month).padStart(2, "0")} (estimasi)` : `PPh badan tahun ${q.year}${fullTo > today ? " s.d. " + today : ""} (estimasi)`,
        lines: jl,
      };
    }
  }
  return { profile, year: q.year, month, from, to, partial: to < fullTo, input, commercialProfit: pl.profitBeforeTax, grossRevenue: pl.totalRevenue, estimate, booked: { taxExpense, credit1400, reclassed, account2230 }, suggestion };
}

export async function getCorporateTax(actor: Actor, raw: unknown): Promise<CorporateTaxReport> {
  assertCan(actor, "finance:view");
  return computeCorporateTax(raw);
}

const ctPostSchema = ctQuerySchema.extend({ date: isoDate.optional() });
/**
 * Catat jurnal penyesuaian PPh badan. Nominal dihitung ULANG di server (klien hanya memilih periode & tanggal), dan perhitungan + pencatatan
 * berlangsung dalam satu transaksi di bawah kunci advisory → klik ganda / dua pengguna tidak membukukan dua kali.
 */
export async function postCorporateTaxJournal(actor: Actor, raw: unknown) {
  assertCan(actor, "journal:record");
  const q = parseInput(ctPostSchema, raw);
  const id = await transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tax_journal'))`;
    const ctx = await computeCorporateTax({ year: q.year, month: q.month }, tx);
    if (!ctx.suggestion) throw Errors.conflict("Pembukuan PPh sudah sesuai dengan estimasi (atau estimasi dinonaktifkan di profil pajak).");
    const date = q.date ?? ctx.suggestion.date;
    if (date < ctx.from || date > ctx.to) throw Errors.validation(`Tanggal jurnal harus di dalam periode estimasi (${ctx.from} s.d. ${ctx.to}).`, { date: "Di luar periode" });
    const coa = await tx.coaAccount.findMany({ where: { code: { in: ctx.suggestion.lines.map((l) => l.code) } }, select: { id: true, code: true } });
    const idOf = new Map(coa.map((a) => [a.code, a.id]));
    const input = parseInput(journalInputSchema, {
      kind: "GENERAL", journalDate: date, description: ctx.suggestion.description, reference: `EST-PPH-${ctx.year}${ctx.month ? "-" + String(ctx.month).padStart(2, "0") : ""}`,
      lines: ctx.suggestion.lines.map((l) => ({ accountId: idOf.get(l.code)!, debit: l.debit, credit: l.credit, memo: null })),
    });
    return createJournalTx(tx, actor, input);
  });
  return getJournalDto(id);
}

// ───────────────────────────── Setoran pajak ─────────────────────────────
export const taxPaymentSchema = z.object({
  kind: z.enum(["PPN", "PPH_BADAN"]),
  /** Masa/tahun pajak yang disetor, mis. "2026-01" atau "2026". */
  taxPeriod: requiredText(4, 20, "Masa pajak"),
  entryDate: isoDate,
  cashAccountId: uuid,
  amount: rupiah("Nominal setoran").min(1, "Nominal harus lebih dari 0"),
  /** NTPN / ID billing. */
  reference: requiredText(3, 60, "NTPN / ID billing"),
  proofFileId: z.preprocess((v) => (v === "" ? null : v ?? undefined), uuid.optional()),
});

/** Setoran pajak = kas keluar dengan akun lawan utang pajak (utang berkurang; bukan beban). Aturan bukti > Rp1 juta tetap berlaku. */
export async function recordTaxPayment(actor: Actor, raw: unknown) {
  assertCan(actor, "cash:record");
  const input = parseInput(taxPaymentSchema, raw);
  const code = input.kind === "PPN" ? CODE_VAT_OUT : CODE_PPH_BADAN_PAYABLE;
  const acct = await prisma.coaAccount.findUnique({ where: { code }, select: { id: true } });
  if (!acct) throw Errors.conflict("Bagan akun belum siap: akun utang pajak tidak ditemukan.");
  return createEntry(actor, {
    entryDate: input.entryDate, cashAccountId: input.cashAccountId, counterAccountId: acct.id, direction: "OUT", amount: input.amount,
    description: `Setoran ${input.kind === "PPN" ? "PPN" : "PPh badan"} masa/tahun ${input.taxPeriod}`, reference: input.reference, payee: "Kas Negara", proofFileId: input.proofFileId,
  });
}

export interface TaxPaymentRow { id: string; date: string; kind: "PPN" | "PPH_BADAN"; amount: number; description: string; reference: string | null; accountName: string; entryType: "ENTRY" | "REVERSAL"; status: string }
export async function listTaxPayments(actor: Actor, limit = 50): Promise<TaxPaymentRow[]> {
  assertCan(actor, "finance:view");
  const rows = await prisma.cashEntry.findMany({
    where: { counterAccount: { code: { in: [CODE_VAT_OUT, CODE_PPH_BADAN_PAYABLE] } }, status: "APPROVED" },
    include: { counterAccount: { select: { code: true } }, cashAccount: { select: { name: true } } },
    orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }], take: limit,
  });
  return rows.map((e) => ({
    id: e.id, date: dateToIso(e.entryDate), kind: e.counterAccount.code === CODE_VAT_OUT ? "PPN" : "PPH_BADAN", amount: Number(e.amount) * (e.direction === "OUT" ? 1 : -1),
    description: e.description, reference: e.reference, accountName: e.cashAccount.name, entryType: e.entryType, status: e.status,
  }));
}

// ───────────────────────────── Ikhtisar ─────────────────────────────
export interface TaxOverview {
  profile: TaxProfileDto;
  vatLiability: number; pphCredit: number; pphBadanPayable: number; vatOnUnpaidInvoices: number;
  withholdingMissingRef: number;
}
export async function getTaxOverview(actor: Actor): Promise<TaxOverview> {
  assertCan(actor, "finance:view");
  const today = todayIso(env().APP_TIMEZONE);
  const [{ lines, coa }, profile, missing] = await Promise.all([loadGl(today), readProfile(), prisma.payment.count({ where: { entryType: "PAYMENT", withholdingAmount: { gt: 0n }, withholdingRef: null } })]);
  const bal = (code: string, sign: 1 | -1) => { const id = coa.find((a) => a.code === code)!.id; return 0 + sign * lines.filter((l) => l.accountId === id).reduce((s, l) => s + l.debit - l.credit, 0); };
  const unpaid = await prisma.$queryRaw<{ v: bigint | null }[]>`
    SELECT COALESCE(SUM(i."taxAmount" - COALESCE(p.v, 0)), 0) AS v FROM invoices i
      LEFT JOIN (SELECT "invoiceId", SUM("vatAmount") AS v FROM payments GROUP BY 1) p ON p."invoiceId" = i."id" WHERE i."status" = 'ISSUED' AND i."taxAmount" > 0`;
  return { profile, vatLiability: bal(CODE_VAT_OUT, -1), pphCredit: bal(CODE_PPH_CREDIT, 1), pphBadanPayable: bal(CODE_PPH_BADAN_PAYABLE, -1), vatOnUnpaidInvoices: Number(unpaid[0]?.v ?? 0n), withholdingMissingRef: missing };
}

// ───────────────────────────── Ekspor ─────────────────────────────
export const TAX_REPORT_TYPES = ["vat-summary", "pph23-register", "corporate-tax"] as const;
export async function runTaxReport(actor: Actor, type: string, raw: unknown = {}): Promise<ReportTable> {
  assertCan(actor, "finance:view");
  const base = { disclaimer: TAX_DISCLAIMER, generatedAt: new Date().toISOString() };
  const R = (n: number) => n;
  if (type === "vat-summary") {
    const v = await getVatSummary(actor, raw);
    return {
      type, title: "Rekap PPN Keluaran", description: "PPN menurut invoice terbit vs PPN dari penerimaan kas vs setoran, per bulan.", periodLabel: `${formatDateLong(v.from)} – ${formatDateLong(v.to)}`, ...base,
      columns: [
        { key: "month", label: "Masa", type: "text", width: 10 }, { key: "count", label: "Jumlah invoice ber-PPN", type: "number", width: 12 }, { key: "base", label: "DPP menurut invoice (Rp)", type: "money", width: 20 },
        { key: "invVat", label: "PPN menurut invoice (Rp)", type: "money", width: 20 }, { key: "received", label: "PPN dari penerimaan kas (Rp)", type: "money", width: 22 },
        { key: "remitted", label: "PPN disetor (Rp)", type: "money", width: 18 }, { key: "adj", label: "Penyesuaian jurnal (Rp)", type: "money", width: 18 }, { key: "ending", label: "Utang PPN akhir bulan (Rp)", type: "money", width: 22 },
      ],
      rows: v.rows.map((r) => ({ month: r.month, count: r.invoiceCount, base: R(r.invoiceBase), invVat: R(r.invoiceVat), received: R(r.vatReceived), remitted: R(r.vatRemitted), adj: R(r.vatAdjustments), ending: R(r.endingLiability) })),
      totals: { month: "TOTAL", count: v.totals.invoiceCount, base: v.totals.invoiceBase, invVat: v.totals.invoiceVat, received: v.totals.vatReceived, remitted: v.totals.vatRemitted, adj: v.totals.vatAdjustments, ending: v.liabilityNow },
    };
  }
  if (type === "pph23-register") {
    const r = await getWithholdingRegister(actor, raw);
    return {
      type, title: "Register PPh Dipotong Pelanggan", description: "Pembayaran yang dipotong PPh oleh pelanggan (kredit pajak); lengkapi nomor bukti potong.", periodLabel: `${formatDateLong(r.from)} – ${formatDateLong(r.to)}`, ...base,
      columns: [
        { key: "date", label: "Tanggal", type: "date", width: 13 }, { key: "invoice", label: "Invoice", type: "text", width: 14 }, { key: "customer", label: "Pelanggan", type: "text", width: 34 },
        { key: "npwp", label: "NPWP pelanggan", type: "text", width: 22 }, { key: "type", label: "Jenis", type: "text", width: 12 }, { key: "ref", label: "No. bukti potong", type: "text", width: 22 }, { key: "amount", label: "PPh dipotong (Rp)", type: "money", width: 18 },
      ],
      rows: r.rows.map((x) => ({ date: x.date, invoice: x.invoiceNumber, customer: x.customer, npwp: x.customerNpwp, type: x.entryType === "REVERSAL" ? "Pembalikan" : "Pembayaran", ref: x.ref, amount: x.amount })),
      totals: { date: "TOTAL NETO", amount: r.net },
    };
  }
  if (type === "corporate-tax") {
    const c = await computeCorporateTax(raw);
    const e = c.estimate;
    const row = (item: string, amount: number | null): Record<string, string | number | null> => ({ item, amount });
    return {
      type, title: `Estimasi PPh Badan${c.month ? " (final) " + c.year + "-" + String(c.month).padStart(2, "0") : " " + c.year}`, description: "Aritmetika dari pembukuan + masukan Anda. Bukan SPT.", periodLabel: `${formatDateLong(c.from)} – ${formatDateLong(c.to)}`, ...base,
      columns: [{ key: "item", label: "Uraian", type: "text", width: 62 }, { key: "amount", label: "Jumlah (Rp)", type: "money", width: 22 }],
      rows: [
        row(`Rezim: ${c.profile.regime}${c.profile.rateBps !== null ? ` · tarif ${(c.profile.rateBps / 100).toFixed(2)}%` : ""}`, null),
        row("Laba (rugi) sebelum pajak penghasilan menurut pembukuan", c.commercialProfit),
        ...(c.profile.regime === "GENERAL" ? [row("Koreksi fiskal neto (masukan)", c.input.fiscalCorrection), row("Kompensasi kerugian fiskal (masukan)", -c.input.lossCompensation)] : [row("Peredaran bruto di luar PPN", c.grossRevenue)]),
        row(c.profile.regime === "GENERAL" ? "Penghasilan kena pajak" : "Dasar pengenaan (peredaran bruto)", e.basis),
        row("Pajak sebelum pengurang", e.taxGross), row("Pengurang pajak / fasilitas (masukan)", -e.facilityReduction), row("PPh terutang (estimasi)", e.taxDue),
        row("Kredit PPh dipotong pelanggan", -e.credits), row("Angsuran / setoran PPh badan yang sudah dibayar", -e.installments),
        row(e.payable >= 0 ? "PPh kurang bayar (estimasi)" : "PPh lebih bayar (estimasi)", e.payable),
        row("Beban PPh yang sudah dibukukan (7-1100)", c.booked.taxExpense),
      ],
      totals: null,
    };
  }
  throw Errors.notFound("Laporan pajak");
}

