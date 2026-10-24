import { route } from "@/server/http";
import { submitInvoice } from "@/server/services/invoices";
import { uuid } from "@/lib/validation/common";

export const POST = route<{ id: string }>(async ({ actor, params }) => submitInvoice(actor, uuid.parse(params.id)));
