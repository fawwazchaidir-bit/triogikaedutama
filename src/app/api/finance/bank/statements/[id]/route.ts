import { z } from "zod";
import { route } from "@/server/http";
import { parseQuery } from "@/server/query";
import { deleteStatement, getStatementWorkspace, runReconciliationReport } from "@/server/services/bank-reconciliation";
import { TABLE_FORMATS, tableResponse } from "@/server/export-response";
import { writeAudit } from "@/server/audit";
import { prisma } from "@/server/db";
import { uuid } from "@/lib/validation/common";

const query = z.object({ format: z.enum(["json", ...TABLE_FORMATS]).default("json") });

/** `format=json` → ruang kerja rekonsiliasi; `csv|xlsx|pdf` → laporan rekonsiliasi (tercatat di audit). */
export const GET = route<{ id: string }>(async ({ req, actor, params }) => {
  const id = uuid.parse(params.id);
  const { format } = parseQuery(req, query);
  if (format === "json") return getStatementWorkspace(actor, id);
  const table = await runReconciliationReport(actor, id);
  await writeAudit(prisma, actor, { action: "export.bank_reconciliation", entityType: "BankStatement", entityId: id, summary: `Ekspor ${table.title} (${format.toUpperCase()})` });
  return tableResponse(table, format, "rekonsiliasi-bank", actor);
});
export const DELETE = route<{ id: string }>(async ({ actor, params }) => { await deleteStatement(actor, uuid.parse(params.id)); return { ok: true }; });
