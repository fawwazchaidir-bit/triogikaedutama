import { z } from "zod";
import { route } from "@/server/http";
import { parseQuery } from "@/server/query";
import { invoiceListQuerySchema } from "@/server/invoice-query";
import { exportInvoiceList } from "@/server/services/export-invoices";

const query = invoiceListQuerySchema.extend({ format: z.enum(["csv", "xlsx"]).default("xlsx") });

/** Ekspor daftar invoice sesuai filter yang sedang aktif (hanya invoice yang boleh dilihat pengguna). */
export const GET = route(async ({ req, actor }) => {
  const { format, ...filters } = parseQuery(req, query);
  const file = await exportInvoiceList(actor, filters, format);
  return new Response(new Uint8Array(file.body), {
    headers: { "Content-Type": file.contentType, "Content-Disposition": `attachment; filename="${file.filename}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
});
