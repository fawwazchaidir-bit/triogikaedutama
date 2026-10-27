import { z } from "zod";
import { readJson, route } from "@/server/http";
import { previewStatementCsv } from "@/server/services/bank-reconciliation";

export const POST = route(async ({ req, actor }) => previewStatementCsv(actor, await readJson(req, z.unknown(), 2_000_000)));
