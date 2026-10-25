import { z } from "zod";
import { route } from "@/server/http";
import { parseQuery } from "@/server/query";
import { runStatement, statementQuerySchema } from "@/server/services/finance-statements";
import { exportFilename, toCsv, toXlsx } from "@/server/export";
import { writeAudit } from "@/server/audit";
import { prisma } from "@/server/db";

const query = statementQuerySchema.extend({ format: z.enum(["json", "csv", "xlsx"]).default("json") });

export const GET = route<{ type: string }>(async ({ req, actor, params }) => {
  const { format, ...filters } = parseQuery(req, query);
  const table = await runStatement(actor, params.type, filters);
  if (format === "json") return table;
  await writeAudit(prisma, actor, { action: "export.statement", entityType: "Export", summary: `Ekspor ${table.title} (${format.toUpperCase()})`, after: { type: params.type, filters } });
  const body = format === "csv" ? Buffer.from(toCsv(table), "utf8") : await toXlsx(table);
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${exportFilename(params.type, format, table.periodLabel)}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    },
  });
});
