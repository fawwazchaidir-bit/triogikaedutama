import { z } from "zod";
import { readJson, route } from "@/server/http";
import { createEntryForLine } from "@/server/services/bank-reconciliation";
import { uuid } from "@/lib/validation/common";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => { await createEntryForLine(actor, uuid.parse(params.id), await readJson(req, z.unknown())); return { ok: true }; });
