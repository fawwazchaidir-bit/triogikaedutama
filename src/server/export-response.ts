import "server-only";
import { prisma } from "./db";
import type { Actor } from "./actor";
import { exportFilename, toCsv, toXlsx, type ReportTable } from "./export";
import { renderReportPdf } from "./pdf/render";

export type TableFormat = "csv" | "xlsx" | "pdf";
export const TABLE_FORMATS = ["csv", "xlsx", "pdf"] as const;

const MIME: Record<TableFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

/** Respons unduhan laporan dalam CSV / Excel / PDF dari satu `ReportTable` (angka identik di semua format). */
export async function tableResponse(table: ReportTable, format: TableFormat, filenameType: string, actor: Actor): Promise<Response> {
  let body: Buffer;
  if (format === "csv") body = Buffer.from(toCsv(table), "utf8");
  else if (format === "xlsx") body = await toXlsx(table);
  else {
    const company = await prisma.companySettings.findUnique({ where: { id: 1 }, select: { name: true } });
    body = await renderReportPdf(table, { companyName: company?.name ?? "Trilogika Edutama", printedBy: actor.name });
  }
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": MIME[format],
      "Content-Disposition": `attachment; filename="${exportFilename(filenameType, format, table.periodLabel)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
