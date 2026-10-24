import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import type { Actor } from "../actor";
import { loadInvoiceDocument, type InvoiceDocument } from "./document-data";
import { InvoicePdf } from "./InvoicePdf";

export async function renderInvoicePdf(actor: Actor, invoiceId: string): Promise<{ buffer: Buffer; doc: InvoiceDocument }> {
  const doc = await loadInvoiceDocument(actor, invoiceId);
  const buffer = await renderToBuffer(<InvoicePdf data={doc.data} />);
  return { buffer, doc };
}
