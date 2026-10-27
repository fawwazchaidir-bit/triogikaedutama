import { z } from "zod";
import { route } from "@/server/http";
import { parseQuery } from "@/server/query";
import { runStatement, statementQuerySchema } from "@/server/services/finance-statements";
import { TABLE_FORMATS, tableResponse } from "@/server/export-response";
import { writeAudit } from "@/server/audit";
import { prisma } from "@/server/db";

const query = statementQuerySchema.extend({ format: z.enum(["json", ...TABLE_FORMATS]).default("json") });

/** `format=json` → tabel untuk UI; `csv|xlsx|pdf` → unduhan (tercatat di audit). `compare=previous|year` menambah kolom pembanding (laba rugi, neraca, arus kas). */
export const GET = route<{ type: string }>(async ({ req, actor, params }) => {
  const { format, ...filters } = parseQuery(req, query);
  const table = await runStatement(actor, params.type, filters);
  if (format === "json") return table;
  await writeAudit(prisma, actor, { action: "export.statement", entityType: "Export", summary: `Ekspor ${table.title} (${format.toUpperCase()})`, after: { type: params.type, filters } });
  return tableResponse(table, format, params.type, actor);
});
