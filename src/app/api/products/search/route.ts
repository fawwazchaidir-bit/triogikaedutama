import { z } from "zod";
import { route } from "@/server/http";
import { parseQuery } from "@/server/query";
import { searchProducts } from "@/server/services/products";

const query = z.object({ q: z.string().max(100).default(""), limit: z.coerce.number().int().min(1).max(30).optional() });
export const GET = route(({ req, actor }) => {
  const { q, limit } = parseQuery(req, query);
  return searchProducts(actor, q, limit);
});
