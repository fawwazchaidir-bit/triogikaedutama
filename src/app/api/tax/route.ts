import { z } from "zod";
import { created, readJson, route } from "@/server/http";
import { parseQuery } from "@/server/query";
import { createTaxConfig, listTaxConfigs } from "@/server/services/tax";

// Pembuat invoice memerlukan daftar pajak AKTIF; daftar lengkap hanya untuk pengelola pajak.
const query = z.object({ activeOnly: z.enum(["true", "false"]).optional() });
export const GET = route(({ req, actor }) => listTaxConfigs(actor, { activeOnly: parseQuery(req, query).activeOnly === "true" }));
export const POST = route(async ({ req, actor }) => created(await createTaxConfig(actor, await readJson(req, z.unknown()))));
