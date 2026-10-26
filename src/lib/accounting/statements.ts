/**
 * Penghitung laporan keuangan BASIS KAS — fungsi MURNI (tanpa IO) agar dapat diuji tuntas.
 * Input dimuat service dari database; angka di sini hanya hasil penjumlahan bilangan bulat Rupiah.
 *
 * Aturan inti (diuji):
 *  • Saldo akun pada tanggal D = saldo awal + Σ mutasi bertanggal [tanggalSaldoAwal, D]. Sebelum tanggal saldo awal, akun belum berlaku.
 *  • Arus kas: saldo awal periode + saldo awal akun yang mulai dalam periode + arus operasi/investasi/pendanaan = saldo akhir periode
 *    (= Σ saldo akhir tiap akun). Transfer antar akun tidak mengubah total.
 *  • Laba rugi (basis kas): penerimaan invoice (neto pembalikan) + pendapatan lain − beban (neto pembalikan). Pendapatan DIAKUI SAAT UANG DITERIMA.
 */

export interface StmtAccount { id: string; name: string; kind: "KAS" | "BANK"; openingBalance: number; openingDate: string }

export interface StmtCounter { id: string; code: string; name: string; type: "ASET" | "KEWAJIBAN" | "EKUITAS" | "PENDAPATAN" | "BEBAN"; section: "OPERASI" | "INVESTASI" | "PENDANAAN" }

/** Pembayaran invoice (BERTANDA: pembalikan negatif). */
export interface StmtPayment { date: string; amount: number; accountId: string | null; onTaxedInvoice?: boolean }
/** Entri kas manual yang DISETUJUI (termasuk pembalikan). */
export interface StmtEntry { date: string; direction: "IN" | "OUT"; amount: number; accountId: string; counter: StmtCounter }
export interface StmtTransfer { date: string; fromId: string; toId: string; amount: number }

export interface StmtData { accounts: StmtAccount[]; payments: StmtPayment[]; entries: StmtEntry[]; transfers: StmtTransfer[] }

export interface Line { code: string | null; name: string; amount: number }

export interface AccountFlow {
  id: string; name: string; kind: "KAS" | "BANK";
  beginning: number; newOpening: number;
  invoiceReceipts: number; otherIn: number; otherOut: number; transferIn: number; transferOut: number;
  ending: number;
}

export interface CashFlowReport {
  from: string; to: string;
  beginning: number;
  newOpening: number;
  operating: { invoiceReceipts: number; otherIncome: Line[]; expenses: Line[]; net: number };
  investing: { lines: Line[]; net: number };
  financing: { lines: Line[]; net: number };
  netChange: number;
  ending: number;
  accounts: AccountFlow[];
  /** Penerimaan invoice dalam periode yang TIDAK masuk saldo akun mana pun (belum dialokasikan / mendahului saldo awal). */
  notInBalances: number;
}

const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const inRange = (date: string, from: string, to: string) => date >= from && date <= to;

/** Jumlahkan baris per akun lawan (kunci = id akun), mempertahankan urutan kode. */
function groupByCounter(rows: { counter: StmtCounter; signed: number }[]): Line[] {
  const map = new Map<string, { counter: StmtCounter; amount: number }>();
  for (const r of rows) {
    const cur = map.get(r.counter.id) ?? { counter: r.counter, amount: 0 };
    cur.amount += r.signed;
    map.set(r.counter.id, cur);
  }
  return [...map.values()]
    .filter((v) => v.amount !== 0)
    .sort((a, b) => a.counter.code.localeCompare(b.counter.code))
    .map((v) => ({ code: v.counter.code, name: v.counter.name, amount: v.amount }));
}

const sumLines = (lines: Line[]) => lines.reduce((a, l) => a + l.amount, 0);

/** Saldo satu akun pada akhir hari `asOf` (0 bila akun belum mulai). Hanya mutasi bertanggal ≥ tanggal saldo awal. */
export function accountBalance(acc: StmtAccount, data: StmtData, asOf: string): number {
  if (asOf < acc.openingDate) return 0;
  let bal = acc.openingBalance;
  for (const p of data.payments) if (p.accountId === acc.id && inRange(p.date, acc.openingDate, asOf)) bal += p.amount;
  for (const e of data.entries) if (e.accountId === acc.id && inRange(e.date, acc.openingDate, asOf)) bal += e.direction === "IN" ? e.amount : -e.amount;
  for (const t of data.transfers) {
    if (t.toId === acc.id && inRange(t.date, acc.openingDate, asOf)) bal += t.amount;
    if (t.fromId === acc.id && inRange(t.date, acc.openingDate, asOf)) bal -= t.amount;
  }
  return bal;
}

export function buildCashFlow(data: StmtData, from: string, to: string): CashFlowReport {
  const acc = new Map(data.accounts.map((a) => [a.id, a]));
  const counts = (accountId: string | null, date: string): boolean => {
    if (!accountId) return false;
    const a = acc.get(accountId);
    return !!a && date >= a.openingDate;
  };

  let invoiceReceipts = 0;
  let notInBalances = 0;
  for (const p of data.payments) {
    if (!inRange(p.date, from, to)) continue;
    if (counts(p.accountId, p.date)) invoiceReceipts += p.amount;
    else notInBalances += p.amount;
  }

  const entryRows = data.entries.filter((e) => inRange(e.date, from, to) && counts(e.accountId, e.date))
    .map((e) => ({ counter: e.counter, signed: e.direction === "IN" ? e.amount : -e.amount }));
  const otherIncome = groupByCounter(entryRows.filter((r) => r.counter.type === "PENDAPATAN"));
  const expenses = groupByCounter(entryRows.filter((r) => r.counter.type === "BEBAN"));
  const rest = entryRows.filter((r) => r.counter.type !== "PENDAPATAN" && r.counter.type !== "BEBAN");
  const investing = groupByCounter(rest.filter((r) => r.counter.section === "INVESTASI"));
  const financing = groupByCounter(rest.filter((r) => r.counter.section !== "INVESTASI"));

  const operatingNet = invoiceReceipts + sumLines(otherIncome) + sumLines(expenses);
  const investingNet = sumLines(investing);
  const financingNet = sumLines(financing);
  const netChange = operatingNet + investingNet + financingNet;

  const dayBefore = addDays(from, -1);
  const accounts: AccountFlow[] = data.accounts.map((a) => {
    const beginning = a.openingDate < from ? accountBalance(a, data, dayBefore) : 0;
    const newOpening = inRange(a.openingDate, from, to) ? a.openingBalance : 0;
    const lo = a.openingDate > from ? a.openingDate : from;
    const within = (d: string) => inRange(d, lo, to);
    let receipts = 0, otherIn = 0, otherOut = 0, tIn = 0, tOut = 0;
    for (const p of data.payments) if (p.accountId === a.id && within(p.date)) receipts += p.amount;
    for (const e of data.entries) if (e.accountId === a.id && within(e.date)) { if (e.direction === "IN") otherIn += e.amount; else otherOut += e.amount; }
    for (const t of data.transfers) {
      if (t.toId === a.id && within(t.date)) tIn += t.amount;
      if (t.fromId === a.id && within(t.date)) tOut += t.amount;
    }
    return {
      id: a.id, name: a.name, kind: a.kind, beginning, newOpening,
      invoiceReceipts: receipts, otherIn, otherOut, transferIn: tIn, transferOut: tOut,
      ending: accountBalance(a, data, to),
    };
  });

  const beginning = accounts.reduce((s, a) => s + a.beginning, 0);
  const newOpening = accounts.reduce((s, a) => s + a.newOpening, 0);
  const ending = accounts.reduce((s, a) => s + a.ending, 0);

  return {
    from, to, beginning, newOpening,
    operating: { invoiceReceipts, otherIncome, expenses, net: operatingNet },
    investing: { lines: investing, net: investingNet },
    financing: { lines: financing, net: financingNet },
    netChange, ending, accounts, notInBalances,
  };
}

export interface IncomeStatement {
  from: string; to: string;
  revenue: number;
  directCosts: Line[]; totalDirectCosts: number;
  grossProfit: number;
  operatingCosts: Line[]; totalOperatingCosts: number;
  operatingProfit: number;
  otherIncome: Line[]; totalOtherIncome: number;
  netProfitBeforeTax: number;
  /** Penerimaan atas invoice yang memuat pajak — BELUM dipisah dari pendapatan (menunggu tahap pajak). */
  receiptsOnTaxedInvoices: number;
}

/** Kelompok beban menurut digit pertama kode akun: 5 = beban langsung program; lainnya = beban operasional. */
export const isDirectCost = (code: string) => code.startsWith("5");

export function buildIncomeStatement(data: StmtData, from: string, to: string): IncomeStatement {
  // Penerimaan yang mendahului tanggal saldo awal akunnya adalah PRA-PEMBUKUAN (sudah termasuk saldo awal) — tidak menjadi pendapatan periode pembukuan.
  const open = new Map(data.accounts.map((a) => [a.id, a.openingDate]));
  const counted = data.payments.filter((p) => inRange(p.date, from, to) && !(p.accountId && open.has(p.accountId) && p.date < open.get(p.accountId)!));
  const revenue = counted.reduce((s, p) => s + p.amount, 0);
  const receiptsOnTaxedInvoices = counted.filter((p) => p.onTaxedInvoice).reduce((s, p) => s + p.amount, 0);
  const rows = data.entries.filter((e) => inRange(e.date, from, to)).map((e) => ({ counter: e.counter, signed: e.direction === "IN" ? e.amount : -e.amount }));
  // Beban dilaporkan POSITIF (pengeluaran neto pembalikan).
  const costs = groupByCounter(rows.filter((r) => r.counter.type === "BEBAN")).map((l) => ({ ...l, amount: -l.amount }));
  const directCosts = costs.filter((l) => isDirectCost(l.code ?? ""));
  const operatingCosts = costs.filter((l) => !isDirectCost(l.code ?? ""));
  const otherIncome = groupByCounter(rows.filter((r) => r.counter.type === "PENDAPATAN"));
  const totalDirectCosts = sumLines(directCosts);
  const totalOperatingCosts = sumLines(operatingCosts);
  const totalOtherIncome = sumLines(otherIncome);
  const grossProfit = revenue - totalDirectCosts;
  const operatingProfit = grossProfit - totalOperatingCosts;
  return {
    from, to, revenue, directCosts, totalDirectCosts, grossProfit, operatingCosts, totalOperatingCosts,
    operatingProfit, otherIncome, totalOtherIncome, netProfitBeforeTax: operatingProfit + totalOtherIncome, receiptsOnTaxedInvoices,
  };
}

// ───────────────────────────── Buku kas per akun (mutasi + saldo berjalan) ─────────────────────────────

export interface LedgerMovement {
  date: string; order: string; kind: "INVOICE_PAYMENT" | "ENTRY" | "TRANSFER_IN" | "TRANSFER_OUT";
  description: string; signed: number; ref: string;
}
export interface LedgerRow extends LedgerMovement { balance: number }

/** Mutasi akun pada [from,to] dengan saldo berjalan. `movements` = SEMUA mutasi akun (urut tidak diasumsikan). */
export function buildAccountLedger(acc: StmtAccount, movements: LedgerMovement[], from: string, to: string): { opening: number; rows: LedgerRow[]; closing: number } {
  const valid = movements.filter((m) => m.date >= acc.openingDate).sort((a, b) => a.date.localeCompare(b.date) || a.order.localeCompare(b.order));
  const before = from <= acc.openingDate ? acc.openingBalance : acc.openingBalance + valid.filter((m) => m.date < from).reduce((s, m) => s + m.signed, 0);
  let running = from <= acc.openingDate ? acc.openingBalance : before;
  const rows: LedgerRow[] = [];
  for (const m of valid) {
    if (m.date < from || m.date > to) continue;
    running += m.signed;
    rows.push({ ...m, balance: running });
  }
  return { opening: before, rows, closing: running };
}
