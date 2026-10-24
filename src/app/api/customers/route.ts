import { z } from "zod";
import { created, readJson, route } from "@/server/http";
import { parseQuery } from "@/server/query";
import { createCustomer, listCustomers } from "@/server/services/customers";

const query = z.object({
  q: z.string().max(100).optional(),
  status: z.enum(["active", "archived", "all"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export const GET = route(({ req, actor }) => listCustomers(actor, parseQuery(req, query)));
export const POST = route(async ({ req, actor }) => created(await createCustomer(actor, await readJson(req, z.unknown()))));
