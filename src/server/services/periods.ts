import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma, transaction } from "../db";
import { env } from "../env";
import { Errors } from "../errors";
import { parseInput } from "../validate";
import { assertCan, type Actor } from "../actor";
import { writeAudit } from "../audit";
import { dateToIso, isoToDate } from "../json";
import { loadGl } from "./finance-ledger";
import { loadStmtData } from "./finance-data";
import { computeCorporateTax } from "./finance-tax";
import { balanceSheet, glIncome, trialBalance, CODE_UNALLOCATED } from "@/lib/accounting/ledger";
import { accountBalance } from "@/lib/accounting/statements";
import { nextPeriod, periodEnd, periodHasEnded, periodIndex, periodKey, periodLabel, periodStart, periodsBetween, prevPeriod, type CheckItem, type PeriodDto } from "@/lib/accounting/periods";
import { formatRupiah } from "@/lib/finance/money";
import { todayIso } from "@/lib/format";
import { requiredText } from "@/lib/validation/common";

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * ═══════════ TUTUP BUKU BULANAN ═══════════
 * Menutup bulan M (berurutan; M−1 harus sudah ditutup) setelah daftar periksa lolos:
 *  • WAJIB (menghalangi): bulan sudah berakhir, bulan sebelumnya ditutup, neraca saldo & neraca seimbang, saldo buku besar kas = modul kas,
 *    tidak ada pengeluaran menunggu persetujuan.
 *  • PERINGATAN (harus diakui + catatan): penerimaan belum dialokasikan, saldo kas negatif, rekonsiliasi bank belum final, bukti potong belum lengkap,
 *    invoice draft/diajukan bertanggal bulan itu, PPh badan belum dibukukan (Desember/rezim final).
 * Penutupan menyimpan "foto" neraca saldo + hash; pemeriksaan ulang mendeteksi perubahan diam-diam. Tanggal kunci buku dipelihara trigger dari periode CLOSED.
 */
interface Snapshot {
  version: 1; asOf: string; trialBalance: { code: string; net: number }[]; totalDebit: number; totalCredit: number;
  balanceSheet: { assets: number; liabilities: number; equity: number };
  month: { revenue: number; profitBeforeTax: number };
}
const R = (n: number) => formatRupiah(n, "PLAIN");
const hashTb = (asOf: string, rows: { code: string; net: number }[]) =>
  createHash("sha256").update(JSON.stringify({ asOf, rows: [...rows].sort((a, b) => a.code.localeCompare(b.code)).map((r) => [r.code, r.net]) })).digest("hex");

async function bookkeepingStartMonth(db: Client): Promise<{ year: number; month: number } | null> {
  const r = await db.cashAccount.aggregate({ _min: { openingDate: true } });
  if (!r._min.openingDate) return null;
  const iso = dateToIso(r._min.openingDate);
  return { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) };
}

async function computeChecks(db: Client, year: number, month: number): Promise<{ checks: CheckItem[]; snapshot: Snapshot }> {
  const today = todayIso(env().APP_TIMEZONE);
  const start = periodStart(year, month), end = periodEnd(year, month);
  const first = await bookkeepingStartMonth(db);
  const { lines, coa } = await loadGl(end, db);
  const tb = trialBalance(lines, coa, end);
  const bs = balanceSheet(lines, coa, end);
  const pl = glIncome(lines, coa, start, end);
  const checks: CheckItem[] = [];
  const add = (id: string, label: string, severity: "HARD" | "SOFT", ok: boolean, detail: string) => checks.push({ id, label, severity, ok, detail });

  add("ended", "Bulan sudah berakhir", "HARD", periodHasEnded(year, month, today), periodHasEnded(year, month, today) ? `Berakhir ${end}` : `Bulan berjalan (berakhir ${end}); tutup setelah bulan berganti`);
  const prev = prevPeriod(year, month);
  const prevClosed = first !== null && periodIndex(year, month) > periodIndex(first.year, first.month)
    ? (await db.accountingPeriod.findUnique({ where: { year_month: { year: prev.year, month: prev.month } } }))?.status === "CLOSED" : first !== null && periodIndex(year, month) === periodIndex(first.year, first.month);
  add("previous", "Bulan sebelumnya sudah ditutup", "HARD", !!prevClosed,
    first === null ? "Belum ada akun kas/bank" : periodIndex(year, month) < periodIndex(first.year, first.month) ? "Mendahului bulan mulai pembukuan" : prevClosed ? (periodIndex(year, month) === periodIndex(first.year, first.month) ? "Bulan pertama pembukuan" : `${periodLabel(prev.year, prev.month)} sudah ditutup`) : `${periodLabel(prev.year, prev.month)} belum ditutup`);
  // Periode yang sudah ditutup tidak boleh berubah diam-diam: hitung ulang neraca saldo tiap periode tertutup dan cocokkan dengan hash fotonya.
  const closedBefore = (await db.accountingPeriod.findMany({ where: { status: "CLOSED" } })).filter((p) => periodIndex(p.year, p.month) < periodIndex(year, month));
  const changed = closedBefore.filter((p) => {
    const pe = periodEnd(p.year, p.month);
    return hashTb(pe, trialBalance(lines, coa, pe).rows.map((r) => ({ code: r.code, net: r.net }))) !== p.snapshotHash;
  }).map((p) => periodLabel(p.year, p.month));
  add("snapshots", "Foto periode yang sudah ditutup masih cocok dengan buku besar", "HARD", changed.length === 0,
    changed.length === 0 ? `${closedBefore.length} periode tertutup terverifikasi` : `Angka ${changed.join(", ")} berubah sejak ditutup — periksa audit log sebelum melanjutkan`);
  add("trial-balance", "Neraca saldo seimbang", "HARD", tb.balanced, tb.balanced ? `Debit = kredit = ${R(tb.totalDebit)}` : `Debit ${R(tb.totalDebit)} ≠ kredit ${R(tb.totalCredit)}`);
  add("balance-sheet", "Neraca seimbang (aset = liabilitas + ekuitas)", "HARD", bs.balanced, bs.balanced ? `Aset ${R(bs.totalAssets)}` : `Selisih ${R(bs.difference)}`);

  // Saldo buku besar akun kas = saldo modul kas (dikelompokkan per akun bagan akun)
  const stmt = await loadStmtData(end, db);
  const gl = new Map(tb.rows.map((r) => [r.accountId, r.net]));
  const accts = await db.cashAccount.findMany({ select: { id: true, name: true, coaAccountId: true } });
  const byCoa = new Map<string, number>();
  for (const a of accts) byCoa.set(a.coaAccountId, (byCoa.get(a.coaAccountId) ?? 0) + accountBalance(stmt.accounts.find((x) => x.id === a.id)!, stmt, end));
  const drift = [...byCoa].filter(([coaId, bal]) => (gl.get(coaId) ?? 0) !== bal);
  add("cash-identity", "Saldo buku besar kas/bank = modul kas", "HARD", drift.length === 0, drift.length === 0 ? "Cocok untuk semua akun" : `${drift.length} akun bagan akun berselisih`);

  const pending = await db.cashEntry.count({ where: { status: "PENDING", entryDate: { lte: isoToDate(end) } } });
  add("pending-expenses", "Tidak ada pengeluaran menunggu persetujuan", "HARD", pending === 0, pending === 0 ? "Semua pengajuan sudah diputuskan" : `${pending} pengeluaran bertanggal ≤ ${end} menunggu persetujuan (setujui atau tolak)`);

  // PERINGATAN
  const unalloc = tb.rows.find((r) => r.code === CODE_UNALLOCATED)?.net ?? 0;
  add("unallocated", "Tidak ada penerimaan invoice yang belum dialokasikan ke kas/bank", "SOFT", unalloc === 0, unalloc === 0 ? "Bersih" : `Saldo penampung 1-1450 ${R(unalloc)}`);
  const negative = stmt.accounts.map((a) => ({ name: a.name, bal: accountBalance(a, stmt, end) })).filter((a) => a.bal < 0);
  add("negative-cash", "Tidak ada saldo kas/bank negatif", "SOFT", negative.length === 0, negative.length === 0 ? "Semua saldo ≥ 0" : negative.map((a) => `${a.name} ${R(a.bal)}`).join("; "));

  const bankAccts = await db.cashAccount.findMany({ where: { kind: "BANK", isActive: true }, select: { id: true, name: true, openingDate: true } });
  const unrec: string[] = [];
  for (const a of bankAccts) {
    const active = (await db.payment.count({ where: { cashAccountId: a.id, paymentDate: { gte: isoToDate(start), lte: isoToDate(end) } } }))
      + (await db.cashEntry.count({ where: { cashAccountId: a.id, status: "APPROVED", entryDate: { gte: isoToDate(start), lte: isoToDate(end) } } }))
      + (await db.cashTransfer.count({ where: { OR: [{ fromAccountId: a.id }, { toAccountId: a.id }], transferDate: { gte: isoToDate(start), lte: isoToDate(end) } } }));
    if (active === 0 || dateToIso(a.openingDate) > end) continue;
    const fin = await db.bankStatement.findFirst({ where: { cashAccountId: a.id, status: "FINALIZED", periodEnd: { gte: isoToDate(end) } } });
    if (!fin) unrec.push(a.name);
  }
  add("bank-recon", "Rekonsiliasi bank final sampai akhir bulan", "SOFT", unrec.length === 0, unrec.length === 0 ? "Semua rekening bank aktif sudah direkonsiliasi (atau tanpa mutasi)" : `Belum final: ${unrec.join(", ")}`);

  const missingRef = await db.payment.count({ where: { entryType: "PAYMENT", withholdingAmount: { gt: 0n }, withholdingRef: null, paymentDate: { lte: isoToDate(end) } } });
  add("withholding-ref", "Semua PPh dipotong pelanggan sudah punya nomor bukti potong", "SOFT", missingRef === 0, missingRef === 0 ? "Lengkap" : `${missingRef} pembayaran belum ada nomor bukti potong`);

  const drafts = await db.invoice.count({ where: { status: { in: ["DRAFT", "SUBMITTED"] }, invoiceDate: { lte: isoToDate(end) } } });
  add("draft-invoices", "Tidak ada invoice draft/diajukan bertanggal ≤ akhir bulan", "SOFT", drafts === 0, drafts === 0 ? "Bersih" : `${drafts} invoice belum terbit — invoice ber-PPN tidak dapat diterbitkan bertanggal di bulan tertutup (ubah tanggalnya)`);

  const profile = await db.companySettings.findUnique({ where: { id: 1 }, select: { corporateTaxRegime: true } });
  if (profile && profile.corporateTaxRegime !== "NONE" && (month === 12 || profile.corporateTaxRegime === "FINAL")) {
    try {
      const ct = await computeCorporateTax({ year, month: profile.corporateTaxRegime === "FINAL" ? month : undefined }, db);
      add("pph-badan", "Estimasi PPh badan sudah dibukukan", "SOFT", ct.suggestion === null, ct.suggestion === null ? "Sesuai estimasi" : "Ada jurnal penyesuaian PPh yang belum dicatat (halaman Pajak → Estimasi PPh badan)");
    } catch { /* estimasi tidak tersedia untuk periode ini */ }
  }

  const snapshot: Snapshot = {
    version: 1, asOf: end, trialBalance: tb.rows.map((r) => ({ code: r.code, net: r.net })), totalDebit: tb.totalDebit, totalCredit: tb.totalCredit,
    balanceSheet: { assets: bs.totalAssets, liabilities: bs.totalLiabilities, equity: bs.totalEquity }, month: { revenue: pl.totalRevenue, profitBeforeTax: pl.profitBeforeTax },
  };
  return { checks, snapshot };
}

// ───────────────────────────── Daftar periode ─────────────────────────────
export type { CheckItem, PeriodDto };

export interface PeriodList {
  periods: PeriodDto[];
  /** Tanggal kunci buku yang berlaku sekarang (`company_settings`). */
  lockedThrough: string | null;
  /** Kunci buku seharusnya = akhir bulan periode CLOSED terakhir; false bila ada yang mengubahnya di luar prosedur. */
  lockConsistent: boolean;
}

export async function listPeriods(actor: Actor): Promise<PeriodList> {
  assertCan(actor, "finance:view");
  const today = todayIso(env().APP_TIMEZONE);
  const first = await bookkeepingStartMonth(prisma);
  const cur = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
  const rows = await prisma.accountingPeriod.findMany({ include: { closedBy: { select: { name: true } } } });
  const byKey = new Map(rows.map((r) => [periodKey(r.year, r.month), r]));
  const lockedThrough = (await prisma.companySettings.findUnique({ where: { id: 1 }, select: { booksLockedThrough: true } }))?.booksLockedThrough;
  const out: PeriodDto[] = [];
  if (first) {
    const closedRows = rows.filter((r) => r.status === "CLOSED");
    const lastClosed = closedRows.length ? Math.max(...closedRows.map((r) => periodIndex(r.year, r.month))) : null;
    // verifikasi foto: satu kali muat buku besar sampai akhir periode tertutup terakhir
    let verify: ((end: string) => ReturnType<typeof trialBalance>) | null = null;
    if (lastClosed !== null) {
      const lastY = Math.floor((lastClosed - 1) / 12), lastM = ((lastClosed - 1) % 12) + 1;
      const { lines, coa } = await loadGl(periodEnd(lastY, lastM));
      verify = (end) => trialBalance(lines, coa, end);
    }
    for (const p of periodsBetween(first, cur)) {
      const k = periodKey(p.year, p.month);
      const r = byKey.get(k);
      const end = periodEnd(p.year, p.month);
      const snap = r?.snapshot as Snapshot | null | undefined;
      const prevOk = periodIndex(p.year, p.month) === periodIndex(first.year, first.month) || byKey.get(periodKey(prevPeriod(p.year, p.month).year, prevPeriod(p.year, p.month).month))?.status === "CLOSED";
      const closed = r?.status === "CLOSED";
      out.push({
        ...p, key: k, label: periodLabel(p.year, p.month), start: periodStart(p.year, p.month), end,
        state: closed ? "CLOSED" : r ? "REOPENED" : !periodHasEnded(p.year, p.month, today) ? "CURRENT" : "OPEN",
        closedAt: r?.closedAt?.toISOString() ?? null, closedByName: r?.closedBy?.name ?? null, note: r?.note ?? null,
        acknowledged: (r?.acknowledged as PeriodDto["acknowledged"] | null) ?? [],
        reopenReason: r?.reopenReason ?? null, reopenedAt: r?.reopenedAt?.toISOString() ?? null,
        verified: closed && snap && verify ? hashTb(end, verify(end).rows.map((x) => ({ code: x.code, net: x.net }))) === r!.snapshotHash : null,
        snapshot: snap ? { totalDebit: snap.totalDebit, assets: snap.balanceSheet.assets, liabilities: snap.balanceSheet.liabilities, equity: snap.balanceSheet.equity, revenue: snap.month.revenue, profitBeforeTax: snap.month.profitBeforeTax } : null,
        canClose: !closed && periodHasEnded(p.year, p.month, today) && prevOk,
        canReopen: closed && lastClosed === periodIndex(p.year, p.month),
      });
    }
  }
  const closedEnds = rows.filter((r) => r.status === "CLOSED").map((r) => periodEnd(r.year, r.month)).sort();
  const locked = lockedThrough ? dateToIso(lockedThrough) : null;
  return { periods: out.reverse(), lockedThrough: locked, lockConsistent: locked === (closedEnds.at(-1) ?? null) };
}

export const monthSchema = z.object({ year: z.coerce.number().int().min(2000).max(2200), month: z.coerce.number().int().min(1).max(12) });

export async function getPeriodChecklist(actor: Actor, raw: unknown): Promise<{ year: number; month: number; label: string; checks: CheckItem[]; closable: boolean }> {
  assertCan(actor, "finance:view");
  const { year, month } = parseInput(monthSchema, raw);
  const { checks } = await computeChecks(prisma, year, month);
  return { year, month, label: periodLabel(year, month), checks, closable: checks.filter((c) => c.severity === "HARD").every((c) => c.ok) };
}

// ───────────────────────────── Tutup & buka kembali ─────────────────────────────
export const closePeriodSchema = monthSchema.extend({
  /** id peringatan lunak yang diakui pengguna */
  acknowledge: z.array(z.string().max(40)).max(20).default([]),
  note: requiredText(5, 300, "Catatan penutupan"),
});

export async function closePeriod(actor: Actor, raw: unknown): Promise<PeriodDto> {
  assertCan(actor, "books:lock");
  const input = parseInput(closePeriodSchema, raw);
  await transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('books_lock'))`; // menunggu transaksi pencatatan yang sedang berjalan
    const existing = await tx.accountingPeriod.findUnique({ where: { year_month: { year: input.year, month: input.month } } });
    if (existing?.status === "CLOSED") throw Errors.conflict(`${periodLabel(input.year, input.month)} sudah ditutup.`);
    const { checks, snapshot } = await computeChecks(tx, input.year, input.month);
    const hard = checks.filter((c) => c.severity === "HARD" && !c.ok);
    if (hard.length) throw Errors.conflict(`Belum dapat ditutup: ${hard.map((c) => `${c.label} (${c.detail})`).join("; ")}.`);
    const soft = checks.filter((c) => c.severity === "SOFT" && !c.ok);
    const unack = soft.filter((c) => !input.acknowledge.includes(c.id));
    if (unack.length) throw Errors.validation(`Akui peringatan berikut sebelum menutup: ${unack.map((c) => c.label).join("; ")}.`, { acknowledge: "Ada peringatan yang belum diakui" });
    const ack = soft.map((c) => ({ id: c.id, label: c.label, detail: c.detail }));
    const hash = hashTb(snapshot.asOf, snapshot.trialBalance);
    const data = { status: "CLOSED" as const, closedAt: new Date(), closedById: actor.userId, note: input.note, acknowledged: ack as unknown as Prisma.InputJsonValue, snapshot: snapshot as unknown as Prisma.InputJsonValue, snapshotHash: hash };
    if (existing) await tx.accountingPeriod.update({ where: { id: existing.id }, data });
    else await tx.accountingPeriod.create({ data: { year: input.year, month: input.month, ...data } });
    await writeAudit(tx, actor, {
      action: "period.close", entityType: "AccountingPeriod", entityId: periodKey(input.year, input.month), summary: `${periodLabel(input.year, input.month)} ditutup`,
      after: { hash, totalDebit: snapshot.totalDebit, assets: snapshot.balanceSheet.assets, acknowledged: ack.map((a) => a.id) }, reason: input.note,
    });
  });
  return (await listPeriods(actor)).periods.find((p) => p.year === input.year && p.month === input.month)!;
}

export const reopenPeriodSchema = monthSchema.extend({ reason: z.string().trim().min(5, "Alasan minimal 5 karakter").max(300) });
export async function reopenPeriod(actor: Actor, raw: unknown): Promise<PeriodDto> {
  assertCan(actor, "books:lock");
  const input = parseInput(reopenPeriodSchema, raw);
  await transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('books_lock'))`;
    const r = await tx.accountingPeriod.findUnique({ where: { year_month: { year: input.year, month: input.month } } });
    if (!r || r.status !== "CLOSED") throw Errors.conflict(`${periodLabel(input.year, input.month)} belum ditutup.`);
    const later = await tx.accountingPeriod.findMany({ where: { status: "CLOSED" } });
    if (later.some((x) => periodIndex(x.year, x.month) > periodIndex(r.year, r.month))) throw Errors.conflict("Buka kembali dimulai dari periode terakhir yang ditutup.");
    await tx.accountingPeriod.update({ where: { id: r.id }, data: { status: "OPEN", reopenedAt: new Date(), reopenedById: actor.userId, reopenReason: input.reason } });
    await writeAudit(tx, actor, { action: "period.reopen", entityType: "AccountingPeriod", entityId: periodKey(input.year, input.month), summary: `${periodLabel(input.year, input.month)} dibuka kembali`, reason: input.reason });
  });
  return (await listPeriods(actor)).periods.find((p) => p.year === input.year && p.month === input.month)!;
}

export { nextPeriod };
