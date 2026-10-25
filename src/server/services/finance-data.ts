import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../db";
import { dateToIso, isoToDate } from "../json";
import type { StmtAccount, StmtData } from "@/lib/accounting/statements";

type Client = PrismaClient | Prisma.TransactionClient;

export interface LoadedAccount extends StmtAccount { isActive: boolean; isDefault: boolean }

/**
 * Muat seluruh data kas (≤ `upTo`) untuk perhitungan murni di `src/lib/accounting/statements.ts`.
 * Hanya entri kas DISETUJUI (termasuk pembalikan) yang dihitung; entri menunggu/ditolak tidak pernah masuk saldo.
 */
export async function loadStmtData(upTo: string, db: Client = prisma): Promise<StmtData & { accounts: LoadedAccount[] }> {
  const until = isoToDate(upTo);
  const [accounts, payments, entries, transfers] = await Promise.all([
    db.cashAccount.findMany({ orderBy: [{ kind: "asc" }, { name: "asc" }] }),
    db.payment.findMany({ where: { paymentDate: { lte: until } }, select: { paymentDate: true, amount: true, cashAccountId: true, invoice: { select: { taxAmount: true } } } }),
    db.cashEntry.findMany({
      where: { status: "APPROVED", entryDate: { lte: until } },
      select: { entryDate: true, direction: true, amount: true, cashAccountId: true, counterAccount: { select: { id: true, code: true, name: true, type: true, section: true } } },
    }),
    db.cashTransfer.findMany({ where: { transferDate: { lte: until } }, select: { transferDate: true, fromAccountId: true, toAccountId: true, amount: true } }),
  ]);
  return {
    accounts: accounts.map((a) => ({
      id: a.id, name: a.name, kind: a.kind, openingBalance: Number(a.openingBalance), openingDate: dateToIso(a.openingDate), isActive: a.isActive, isDefault: a.isDefault,
    })),
    payments: payments.map((p) => ({ date: dateToIso(p.paymentDate), amount: Number(p.amount), accountId: p.cashAccountId, onTaxedInvoice: Number(p.invoice.taxAmount) > 0 })),
    entries: entries.map((e) => ({ date: dateToIso(e.entryDate), direction: e.direction, amount: Number(e.amount), accountId: e.cashAccountId, counter: e.counterAccount })),
    transfers: transfers.map((t) => ({ date: dateToIso(t.transferDate), fromId: t.fromAccountId, toId: t.toAccountId, amount: Number(t.amount) })),
  };
}
