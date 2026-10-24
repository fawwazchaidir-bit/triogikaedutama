import { z } from "zod";
import { readJson, route } from "@/server/http";
import { cancelInvoice } from "@/server/services/invoices";
import { uuid } from "@/lib/validation/common";

export const POST = route<{ id: string }>(async ({ req, actor, params }) =>
  cancelInvoice(actor, uuid.parse(params.id), await readJson(req, z.unknown())));
