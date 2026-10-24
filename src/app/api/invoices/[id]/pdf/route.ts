import { route } from "@/server/http";
import { renderInvoicePdf } from "@/server/pdf/render";
import { writeAudit } from "@/server/audit";
import { prisma } from "@/server/db";
import { uuid } from "@/lib/validation/common";

/** GET /api/invoices/:id/pdf            → pratinjau inline
 *  GET /api/invoices/:id/pdf?download=1 → unduh (dicatat di audit log) */
export const GET = route<{ id: string }>(async ({ req, actor, params }) => {
  const id = uuid.parse(params.id);
  const { buffer, doc } = await renderInvoicePdf(actor, id);
  const download = new URL(req.url).searchParams.get("download") === "1";
  if (download && doc.status !== "DRAFT") {
    await writeAudit(prisma, actor, { action: "invoice.pdf_download", entityType: "Invoice", entityId: id, summary: `PDF invoice ${doc.number} diunduh` });
  }
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(buffer.byteLength),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${doc.filename}"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
