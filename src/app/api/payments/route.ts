import { z } from "zod";
import { created, readJson, route } from "@/server/http";
import { parseQuery } from "@/server/query";
import { listPayments, recordPayment } from "@/server/services/payments";
import { isoDate } from "@/lib/validation/common";

const query = z.object({
  invoiceId: z.string().uuid().optional(), q: z.string().max(100).optional(), from: isoDate.optional(), to: isoDate.optional(),
  method: z.string().max(40).optional(), type: z.enum(["PAYMENT", "REVERSAL"]).optional(),
  page: z.coerce.number().int().min(1).optional(), pageSize: z.coerce.number().int().min(1).max(100).optional(),
});
export const GET = route(({ req, actor }) => listPayments(actor, parseQuery(req, query)));
export const POST = route(async ({ req, actor }) => created(await recordPayment(actor, await readJson(req, z.unknown()))));
