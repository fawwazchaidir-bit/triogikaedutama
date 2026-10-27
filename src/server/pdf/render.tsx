import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import type { Actor } from "../actor";
import { loadInvoiceDocument, type InvoiceDocument } from "./document-data";
import { InvoicePdf } from "./InvoicePdf";
import { ReportPdf } from "./ReportPdf";
import type { ReportTable } from "../export";
import { env } from "../env";
import { formatDateTime } from "@/lib/format";

export async function renderInvoicePdf(actor: Actor, invoiceId: string): Promise<{ buffer: Buffer; doc: InvoiceDocument }> {
  const doc = await loadInvoiceDocument(actor, invoiceId);
  const buffer = await renderToBuffer(<InvoicePdf data={doc.data} />);
  return { buffer, doc };
}

/** PDF laporan keuangan dari tabel yang sama dengan CSV/Excel. */
export async function renderReportPdf(table: ReportTable, ctx: { companyName: string; printedBy: string }): Promise<Buffer> {
  const printedAt = formatDateTime(new Date(table.generatedAt), env().APP_TIMEZONE);
  return renderToBuffer(<ReportPdf data={{ companyName: ctx.companyName, table, printedBy: ctx.printedBy, printedAt }} />);
}
