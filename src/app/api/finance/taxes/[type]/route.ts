import { z } from "zod";
import { route } from "@/server/http";
import { parseQuery } from "@/server/query";
import { getCorporateTax, getVatSummary, getWithholdingRegister, runTaxReport } from "@/server/services/finance-tax";
import { exportFilename, toCsv, toXlsx } from "@/server/export";
import { writeAudit } from "@/server/audit";
import { prisma } from "@/server/db";
import { Errors } from "@/server/errors";
import { isoDate } from "@/lib/validation/common";

const TYPES = { vat: "vat-summary", pph23: "pph23-register", corporate: "corporate-tax" } as const;
const query = z.object({ from: isoDate.optional(), to: isoDate.optional(), year: z.coerce.number().int().optional(), month: z.coerce.number().int().optional(), format: z.enum(["json", "csv", "xlsx"]).default("json") });

/** `format=json` → objek bertipe untuk UI; `csv|xlsx` → tabel ekspor (tercatat di audit). */
export const GET = route<{ type: string }>(async ({ req, actor, params }) => {
  const kind = TYPES[params.type as keyof typeof TYPES];
  if (!kind) throw Errors.notFound("Laporan pajak");
  const { format, ...filters } = parseQuery(req, query);
  if (format === "json") {
    if (params.type === "vat") return getVatSummary(actor, filters);
    if (params.type === "pph23") return getWithholdingRegister(actor, filters);
    return getCorporateTax(actor, filters);
  }
  const table = await runTaxReport(actor, kind, filters);
  await writeAudit(prisma, actor, { action: "export.tax", entityType: "Export", summary: `Ekspor ${table.title} (${format.toUpperCase()})`, after: { type: kind, filters } });
  const body = format === "csv" ? Buffer.from(toCsv(table), "utf8") : await toXlsx(table);
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${exportFilename(kind, format, table.periodLabel)}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    },
  });
});
