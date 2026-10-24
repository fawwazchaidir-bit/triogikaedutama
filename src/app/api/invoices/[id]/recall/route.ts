import { route } from "@/server/http";
import { recallInvoice } from "@/server/services/invoices";
import { uuid } from "@/lib/validation/common";

export const POST = route<{ id: string }>(async ({ actor, params }) => recallInvoice(actor, uuid.parse(params.id)));
