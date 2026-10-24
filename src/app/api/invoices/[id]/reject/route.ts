import { z } from "zod";
import { readJson, route } from "@/server/http";
import { rejectInvoice } from "@/server/services/invoices";
import { uuid } from "@/lib/validation/common";

export const POST = route<{ id: string }>(async ({ req, actor, params }) =>
  rejectInvoice(actor, uuid.parse(params.id), await readJson(req, z.unknown())));
