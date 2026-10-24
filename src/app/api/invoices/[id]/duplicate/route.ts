import { created, route } from "@/server/http";
import { duplicateInvoice } from "@/server/services/invoices";
import { uuid } from "@/lib/validation/common";

export const POST = route<{ id: string }>(async ({ actor, params }) => created(await duplicateInvoice(actor, uuid.parse(params.id))));
