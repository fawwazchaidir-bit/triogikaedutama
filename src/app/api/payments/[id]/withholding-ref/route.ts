import { z } from "zod";
import { readJson, route } from "@/server/http";
import { setWithholdingRef } from "@/server/services/finance-tax";
import { uuid } from "@/lib/validation/common";

export const PUT = route<{ id: string }>(async ({ req, actor, params }) => {
  await setWithholdingRef(actor, uuid.parse(params.id), await readJson(req, z.unknown()));
  return { ok: true };
});
