import { z } from "zod";
import { created, readJson, route } from "@/server/http";
import { parseQuery } from "@/server/query";
import { createEntry, listEntries } from "@/server/services/cash-entries";
import { isoDate } from "@/lib/validation/common";

const query = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED"]).optional(), accountId: z.string().uuid().optional(), counterId: z.string().uuid().optional(),
  from: isoDate.optional(), to: isoDate.optional(), q: z.string().max(100).optional(), kind: z.enum(["EXPENSE", "OTHER"]).optional(),
  page: z.coerce.number().int().min(1).optional(), pageSize: z.coerce.number().int().min(1).max(100).optional(),
});
export const GET = route(({ req, actor }) => listEntries(actor, parseQuery(req, query)));
export const POST = route(async ({ req, actor }) => created(await createEntry(actor, await readJson(req, z.unknown()))));
