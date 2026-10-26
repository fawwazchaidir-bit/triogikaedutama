/**
 * BUKU BESAR (double-entry) BASIS KAS — fungsi MURNI.
 *
 * Jurnal dari kejadian kas TIDAK disimpan; diturunkan langsung dari tabel sumbernya setiap kali (sehingga tidak mungkin berselisih):
 *   • saldo awal akun kas        : Dr akun kas              / Cr 3-2100 Saldo Laba (ekuitas awal)
 *   • pembayaran invoice (+)      : Dr akun kas              / Cr 4-1100 Pendapatan Jasa        (pembalikan: kebalikannya)
 *       - belum dialokasikan      : Dr 1-1450 (penampung)    / Cr 4-1100
 *       - mendahului saldo awal   : dilewati (sudah termasuk saldo awal; pra-pembukuan)
 *   • entri kas manual disetujui  : uang keluar Dr akun lawan / Cr akun kas ; uang masuk Dr akun kas / Cr akun lawan
 *   • transfer antar akun         : Dr akun kas tujuan       / Cr akun kas asal
 *   • jurnal manual               : sebagaimana disimpan (seimbang, dijaga trigger DB)
 * Karena setiap jurnal seimbang, neraca saldo selalu seimbang dan Aset = Liabilitas + Ekuitas (diuji, termasuk fuzz).
 */
import type { StmtAccount } from "./statements";

export const CODE_REVENUE = "4-1100";
export const CODE_OPENING_EQUITY = "3-2100";
export const CODE_UNALLOCATED = "1-1450";
/** 3-2200 "Laba (Rugi) Tahun Berjalan" DIHITUNG dari akun laba rugi pada neraca — tidak pernah dijurnal. */
export const CODE_CURRENT_YEAR = "3-2200";
/** Akun yang tidak boleh dijurnal manual (dicatat atau dihitung otomatis). Dijaga juga oleh trigger database. */
export const RESERVED_JOURNAL_CODES: readonly string[] = [CODE_REVENUE, CODE_UNALLOCATED, CODE_CURRENT_YEAR];

export type CoaType = "ASET" | "KEWAJIBAN" | "EKUITAS" | "PENDAPATAN" | "BEBAN";
export interface GlAccount { id: string; code: string; name: string; type: CoaType }
export type GlSource = "OPENING_CASH" | "INVOICE_PAYMENT" | "CASH_ENTRY" | "TRANSFER" | "MANUAL";

export interface GlLine {
  date: string;
  /** Kunci urut stabil di dalam hari yang sama. */
  order: string;
  source: GlSource;
  sourceId: string;
  /** Label sumber untuk tampilan (mis. nomor invoice, JU-000012). */
  sourceLabel: string;
  description: string;
  accountId: string;
  debit: number;
  credit: number;
}

export interface GlCashAccount extends StmtAccount { coaAccountId: string }
export interface GlPayment { id: string; date: string; createdAt: string; amount: number; accountId: string | null; label: string }
export interface GlEntry { id: string; date: string; createdAt: string; direction: "IN" | "OUT"; amount: number; accountId: string; counterAccountId: string; description: string; entryType: "ENTRY" | "REVERSAL" }
export interface GlTransfer { id: string; date: string; createdAt: string; fromId: string; toId: string; amount: number; description: string }
export interface GlManualJournal { id: string; label: string; date: string; createdAt: string; description: string; lines: { accountId: string; debit: number; credit: number; memo: string | null }[] }

export interface GlInput {
  coa: GlAccount[];
  accounts: GlCashAccount[];
  payments: GlPayment[];
  entries: GlEntry[];
  transfers: GlTransfer[];
  manual: GlManualJournal[];
}

const byCode = (coa: GlAccount[], code: string): GlAccount => {
  const a = coa.find((x) => x.code === code);
  if (!a) throw new Error(`Akun sistem ${code} tidak ditemukan di bagan akun`);
  return a;
};

/** Turunkan SELURUH baris buku besar (urut tanggal lalu kunci urut). */
export function deriveLines(input: GlInput): GlLine[] {
  const { coa } = input;
  const revenue = byCode(coa, CODE_REVENUE).id;
  const openingEquity = byCode(coa, CODE_OPENING_EQUITY).id;
  const unallocated = byCode(coa, CODE_UNALLOCATED).id;
  const acct = new Map(input.accounts.map((a) => [a.id, a]));
  const lines: GlLine[] = [];
  const push = (l: Omit<GlLine, "debit" | "credit" | "accountId"> & { dr: string; cr: string; amount: number }) => {
    if (l.amount === 0) return;
    const { dr, cr, amount, ...base } = l;
    lines.push({ ...base, accountId: dr, debit: amount, credit: 0 });
    lines.push({ ...base, accountId: cr, debit: 0, credit: amount });
  };

  for (const a of input.accounts) {
    push({ date: a.openingDate, order: `0-${a.id}`, source: "OPENING_CASH", sourceId: a.id, sourceLabel: "Saldo awal", description: `Saldo awal ${a.name}`, dr: a.coaAccountId, cr: openingEquity, amount: a.openingBalance });
  }
  for (const p of input.payments) {
    let cashSide: string;
    if (p.accountId === null) cashSide = unallocated;
    else {
      const a = acct.get(p.accountId);
      if (!a) throw new Error(`Akun kas ${p.accountId} tidak ditemukan`);
      if (p.date < a.openingDate) continue; // pra-pembukuan: sudah termasuk saldo awal
      cashSide = a.coaAccountId;
    }
    const desc = `${p.amount < 0 ? "Pembalikan pembayaran" : "Pembayaran"} ${p.label}`;
    if (p.amount >= 0) push({ date: p.date, order: `1-${p.createdAt}${p.id}`, source: "INVOICE_PAYMENT", sourceId: p.id, sourceLabel: p.label, description: desc, dr: cashSide, cr: revenue, amount: p.amount });
    else push({ date: p.date, order: `1-${p.createdAt}${p.id}`, source: "INVOICE_PAYMENT", sourceId: p.id, sourceLabel: p.label, description: desc, dr: revenue, cr: cashSide, amount: -p.amount });
  }
  for (const e of input.entries) {
    const a = acct.get(e.accountId);
    if (!a) throw new Error(`Akun kas ${e.accountId} tidak ditemukan`);
    const base = { date: e.date, order: `2-${e.createdAt}${e.id}`, source: "CASH_ENTRY" as const, sourceId: e.id, sourceLabel: e.entryType === "REVERSAL" ? "Pembalikan kas" : "Entri kas", description: e.description, amount: e.amount };
    if (e.direction === "OUT") push({ ...base, dr: e.counterAccountId, cr: a.coaAccountId });
    else push({ ...base, dr: a.coaAccountId, cr: e.counterAccountId });
  }
  for (const t of input.transfers) {
    const f = acct.get(t.fromId), to = acct.get(t.toId);
    if (!f || !to) throw new Error("Akun transfer tidak ditemukan");
    push({ date: t.date, order: `3-${t.createdAt}${t.id}`, source: "TRANSFER", sourceId: t.id, sourceLabel: "Transfer", description: t.description, dr: to.coaAccountId, cr: f.coaAccountId, amount: t.amount });
  }
  for (const j of input.manual) {
    j.lines.forEach((l, i) => lines.push({
      date: j.date, order: `4-${j.createdAt}${j.id}${String(i).padStart(4, "0")}`, source: "MANUAL", sourceId: j.id, sourceLabel: j.label,
      description: l.memo ? `${j.description} — ${l.memo}` : j.description, accountId: l.accountId, debit: l.debit, credit: l.credit,
    }));
  }
  return lines.sort((a, b) => a.date.localeCompare(b.date) || a.order.localeCompare(b.order));
}

const debitNormal = (t: CoaType) => t === "ASET" || t === "BEBAN";
/** Saldo menurut sisi normal akun (aset/beban: debit − kredit; lainnya: kredit − debit). */
export const naturalBalance = (type: CoaType, debit: number, credit: number) => (debitNormal(type) ? debit - credit : credit - debit);

// ───────────────────────────── Neraca saldo ─────────────────────────────

export interface TrialRow { accountId: string; code: string; name: string; type: CoaType; debit: number; credit: number; /** saldo debit (+) / kredit (−) */ net: number }
export interface TrialBalance { asOf: string; rows: TrialRow[]; totalDebit: number; totalCredit: number; balanced: boolean }

/** Neraca saldo kumulatif sampai `asOf` (mutasi seluruh periode). Kolom debit/kredit = saldo akhir menurut sisi bersihnya. */
export function trialBalance(lines: GlLine[], coa: GlAccount[], asOf: string): TrialBalance {
  const tot = new Map<string, { d: number; c: number }>();
  for (const l of lines) {
    if (l.date > asOf) continue;
    const t = tot.get(l.accountId) ?? { d: 0, c: 0 };
    t.d += l.debit; t.c += l.credit; tot.set(l.accountId, t);
  }
  const rows: TrialRow[] = [];
  for (const a of [...coa].sort((x, y) => x.code.localeCompare(y.code))) {
    const t = tot.get(a.id);
    const net = t ? t.d - t.c : 0;
    if (net === 0) continue; // akun bersaldo nol (mis. sudah dibalikkan) tidak ditampilkan
    rows.push({ accountId: a.id, code: a.code, name: a.name, type: a.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0, net });
  }
  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  return { asOf, rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit };
}

// ───────────────────────────── Buku besar per akun ─────────────────────────────

export interface LedgerLine { date: string; sourceLabel: string; source: GlSource; sourceId: string; description: string; debit: number; credit: number; balance: number }
export interface GeneralLedger { account: GlAccount; from: string; to: string; opening: number; rows: LedgerLine[]; totalDebit: number; totalCredit: number; closing: number }

export function generalLedger(lines: GlLine[], account: GlAccount, from: string, to: string): GeneralLedger {
  let opening = 0;
  const rows: LedgerLine[] = [];
  let run = 0;
  let totalDebit = 0, totalCredit = 0;
  for (const l of lines) {
    if (l.accountId !== account.id || l.date > to) continue;
    const delta = naturalBalance(account.type, l.debit, l.credit);
    if (l.date < from) { opening += delta; run = opening; continue; }
    run += delta; totalDebit += l.debit; totalCredit += l.credit;
    rows.push({ date: l.date, sourceLabel: l.sourceLabel, source: l.source, sourceId: l.sourceId, description: l.description, debit: l.debit, credit: l.credit, balance: run });
  }
  return { account, from, to, opening, rows, totalDebit, totalCredit, closing: run };
}

// ───────────────────────────── Laba rugi dari buku besar ─────────────────────────────

export interface GlLineItem { code: string; name: string; amount: number }
export interface GlIncome {
  from: string; to: string;
  revenue: GlLineItem[]; totalRevenue: number;
  directCosts: GlLineItem[]; totalDirectCosts: number;
  grossProfit: number;
  operatingCosts: GlLineItem[]; totalOperatingCosts: number;
  operatingProfit: number;
  otherIncome: GlLineItem[]; totalOtherIncome: number;
  profitBeforeTax: number;
  incomeTax: GlLineItem[]; totalIncomeTax: number;
  netProfit: number;
}

/** Pendapatan usaha = akun penghasilan berkode 4-1xxx; penghasilan lain = 4-2xxx dst. Beban 5 = langsung, 6 = operasional, 7 = pajak penghasilan. */
export function glIncome(lines: GlLine[], coa: GlAccount[], from: string, to: string): GlIncome {
  const sums = new Map<string, number>();
  for (const l of lines) {
    if (l.date < from || l.date > to) continue;
    sums.set(l.accountId, (sums.get(l.accountId) ?? 0) + l.debit - l.credit);
  }
  const items = (pred: (a: GlAccount) => boolean, sign: 1 | -1): GlLineItem[] =>
    [...coa].filter((a) => pred(a)).sort((x, y) => x.code.localeCompare(y.code))
      .map((a) => ({ code: a.code, name: a.name, amount: sign * (sums.get(a.id) ?? 0) })).filter((i) => i.amount !== 0);
  const sum = (xs: GlLineItem[]) => xs.reduce((s, i) => s + i.amount, 0);
  const revenue = items((a) => a.type === "PENDAPATAN" && a.code.startsWith("4-1"), -1);
  const otherIncome = items((a) => a.type === "PENDAPATAN" && !a.code.startsWith("4-1"), -1);
  const directCosts = items((a) => a.type === "BEBAN" && a.code.startsWith("5"), 1);
  const operatingCosts = items((a) => a.type === "BEBAN" && a.code.startsWith("6"), 1);
  const incomeTax = items((a) => a.type === "BEBAN" && a.code.startsWith("7"), 1);
  const totalRevenue = sum(revenue), totalDirectCosts = sum(directCosts), totalOperatingCosts = sum(operatingCosts), totalOtherIncome = sum(otherIncome), totalIncomeTax = sum(incomeTax);
  const grossProfit = totalRevenue - totalDirectCosts;
  const operatingProfit = grossProfit - totalOperatingCosts;
  const profitBeforeTax = operatingProfit + totalOtherIncome;
  return { from, to, revenue, totalRevenue, directCosts, totalDirectCosts, grossProfit, operatingCosts, totalOperatingCosts, operatingProfit, otherIncome, totalOtherIncome, profitBeforeTax, incomeTax, totalIncomeTax, netProfit: profitBeforeTax - totalIncomeTax };
}

// ───────────────────────────── Neraca (Laporan Posisi Keuangan) ─────────────────────────────

export interface BalanceSheet {
  asOf: string;
  currentAssets: GlLineItem[]; fixedAssets: GlLineItem[]; otherAssets: GlLineItem[]; totalAssets: number;
  shortTermLiabilities: GlLineItem[]; longTermLiabilities: GlLineItem[]; otherLiabilities: GlLineItem[]; totalLiabilities: number;
  equity: GlLineItem[];
  /** Laba (rugi) bersih seluruh tahun-tahun SEBELUM tahun neraca (setelah pajak) — "tutup buku" dihitung, bukan disimpan. */
  retainedEarningsPrior: number;
  /** Laba (rugi) bersih 1 Jan s.d. tanggal neraca. */
  currentYearProfit: number;
  totalEquity: number;
  balanced: boolean;
  difference: number;
}

export function balanceSheet(lines: GlLine[], coa: GlAccount[], asOf: string): BalanceSheet {
  const yearStart = `${asOf.slice(0, 4)}-01-01`;
  const sums = new Map<string, number>(); // debit − kredit
  let prior = 0, current = 0; // laba bersih (kredit − debit semua akun laba rugi)
  const type = new Map(coa.map((a) => [a.id, a.type]));
  for (const l of lines) {
    if (l.date > asOf) continue;
    const t = type.get(l.accountId)!;
    const delta = l.debit - l.credit;
    if (t === "PENDAPATAN" || t === "BEBAN") { if (l.date < yearStart) prior -= delta; else current -= delta; continue; }
    sums.set(l.accountId, (sums.get(l.accountId) ?? 0) + delta);
  }
  const items = (t: CoaType, pred: (a: GlAccount) => boolean = () => true): GlLineItem[] =>
    coa.filter((a) => a.type === t && pred(a)).sort((x, y) => x.code.localeCompare(y.code))
      .map((a) => ({ code: a.code, name: a.name, amount: naturalBalance(t, Math.max(sums.get(a.id) ?? 0, 0), Math.max(-(sums.get(a.id) ?? 0), 0)) }))
      .filter((i) => i.amount !== 0);
  const sum = (xs: GlLineItem[]) => xs.reduce((s, i) => s + i.amount, 0);
  const currentAssets = items("ASET", (a) => a.code.startsWith("1-1"));
  const fixedAssets = items("ASET", (a) => a.code.startsWith("1-2"));
  const otherAssets = items("ASET", (a) => !a.code.startsWith("1-1") && !a.code.startsWith("1-2"));
  const shortTermLiabilities = items("KEWAJIBAN", (a) => a.code.startsWith("2-1"));
  const longTermLiabilities = items("KEWAJIBAN", (a) => a.code.startsWith("2-2"));
  const otherLiabilities = items("KEWAJIBAN", (a) => !a.code.startsWith("2-1") && !a.code.startsWith("2-2"));
  const equity = items("EKUITAS");
  const totalAssets = sum(currentAssets) + sum(fixedAssets) + sum(otherAssets);
  const totalLiabilities = sum(shortTermLiabilities) + sum(longTermLiabilities) + sum(otherLiabilities);
  const totalEquity = sum(equity) + prior + current;
  const difference = totalAssets - totalLiabilities - totalEquity;
  return {
    asOf, currentAssets, fixedAssets, otherAssets, totalAssets, shortTermLiabilities, longTermLiabilities, otherLiabilities, totalLiabilities,
    equity, retainedEarningsPrior: prior, currentYearProfit: current, totalEquity, balanced: difference === 0, difference,
  };
}

/** Kelompokkan baris buku besar per jurnal (sumber + id) untuk "Buku Jurnal". */
export interface JournalView { key: string; date: string; source: GlSource; sourceId: string; label: string; description: string; lines: { accountId: string; debit: number; credit: number }[] }
export function groupJournals(lines: GlLine[]): JournalView[] {
  const map = new Map<string, JournalView>();
  for (const l of lines) {
    const key = `${l.source}:${l.sourceId}`;
    const j = map.get(key) ?? { key, date: l.date, source: l.source, sourceId: l.sourceId, label: l.sourceLabel, description: l.description.split(" — ")[0]!, lines: [] };
    j.lines.push({ accountId: l.accountId, debit: l.debit, credit: l.credit });
    map.set(key, j);
  }
  return [...map.values()];
}
