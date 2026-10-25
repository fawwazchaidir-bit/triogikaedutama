import { z } from "zod";
import { created, readJson, route } from "@/server/http";
import { parseQuery } from "@/server/query";
import { createTransfer, listTransfers } from "@/server/services/cash-entries";
import { isoDate } from "@/lib/validation/common";

const query = z.object({ from: isoDate.optional(), to: isoDate.optional(), page: z.coerce.number().int().min(1).optional(), pageSize: z.coerce.number().int().min(1).max(100).optional() });
export const GET = route(({ req, actor }) => listTransfers(actor, parseQuery(req, query)));
export const POST = route(async ({ req, actor }) => created(await createTransfer(actor, await readJson(req, z.unknown()))));
