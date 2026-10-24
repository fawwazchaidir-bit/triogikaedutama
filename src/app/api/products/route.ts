import { z } from "zod";
import { created, readJson, route } from "@/server/http";
import { parseQuery } from "@/server/query";
import { createProduct, listProducts } from "@/server/services/products";

const query = z.object({
  q: z.string().max(100).optional(),
  status: z.enum(["active", "archived", "all"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});
export const GET = route(({ req, actor }) => listProducts(actor, parseQuery(req, query)));
export const POST = route(async ({ req, actor }) => created(await createProduct(actor, await readJson(req, z.unknown()))));
