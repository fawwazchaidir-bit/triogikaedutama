import { z } from "zod";
import { readJson, route } from "@/server/http";
import { matchLine } from "@/server/services/bank-reconciliation";
import { uuid } from "@/lib/validation/common";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => { await matchLine(actor, uuid.parse(params.id), await readJson(req, z.unknown())); return { ok: true }; });
