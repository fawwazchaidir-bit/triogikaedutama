import { route } from "@/server/http";
import { getInvoiceHistory } from "@/server/services/audit";
import { getInvoice } from "@/server/services/invoices";
import { uuid } from "@/lib/validation/common";

export const GET = route<{ id: string }>(async ({ actor, params }) => {
  const id = uuid.parse(params.id);
  await getInvoice(actor, id); // memastikan invoice ada & boleh dilihat
  return getInvoiceHistory(actor, id);
});
