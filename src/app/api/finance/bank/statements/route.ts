import { z } from "zod";
import { created, readJson, route } from "@/server/http";
import { parseQuery } from "@/server/query";
import { createStatement, listStatements } from "@/server/services/bank-reconciliation";
import { uuid } from "@/lib/validation/common";

const query = z.object({ cashAccountId: uuid.optional() });
export const GET = route(({ req, actor }) => listStatements(actor, parseQuery(req, query)));
export const POST = route(async ({ req, actor }) => created(await createStatement(actor, await readJson(req, z.unknown(), 2_000_000))));
