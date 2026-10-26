import { route } from "@/server/http";
import { parseQuery } from "@/server/query";
import { z } from "zod";
import { getJournalBook } from "@/server/services/finance-ledger";
import { isoDate } from "@/lib/validation/common";

const query = z.object({ from: isoDate.optional(), to: isoDate.optional(), source: z.enum(["OPENING_CASH", "INVOICE_PAYMENT", "CASH_ENTRY", "TRANSFER", "MANUAL"]).optional(), page: z.coerce.number().int().min(1).optional(), pageSize: z.coerce.number().int().min(1).max(100).optional() });
/** Buku Jurnal: seluruh jurnal (otomatis dari kas + manual). */
export const GET = route(({ req, actor }) => getJournalBook(actor, parseQuery(req, query)));
