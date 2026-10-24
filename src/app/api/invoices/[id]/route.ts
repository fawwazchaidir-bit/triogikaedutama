import { z } from "zod";
import { readJson, route } from "@/server/http";
import { deleteDraft, getInvoice, updateDraft } from "@/server/services/invoices";
import { uuid } from "@/lib/validation/common";

type P = { id: string };
export const GET = route<P>(({ actor, params }) => getInvoice(actor, uuid.parse(params.id)));
export const PUT = route<P>(async ({ req, actor, params }) => updateDraft(actor, uuid.parse(params.id), await readJson(req, z.unknown())));
export const DELETE = route<P>(async ({ actor, params }) => {
  await deleteDraft(actor, uuid.parse(params.id));
  return { ok: true };
});
