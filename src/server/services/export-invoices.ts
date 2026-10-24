import "server-only";
import { prisma } from "../db";
import { env } from "../env";
import { actorCan, type Actor } from "../actor";
import { Errors } from "../errors";
import { writeAudit } from "../audit";
import { exportFilename, toCsv, toXlsx, type ReportTable } from "../export";
import { listInvoicesForExport, type InvoiceListQuery } from "./invoices";
import { formatDateLong, todayIso } from "@/lib/format";

const STATUS_LABEL = { DRAFT: "Draft", ISSUED: "Diterbitkan", CANCELLED: "Dibatalkan" } as const;
const PAY_LABEL = { UNPAID: "Belum Dibayar", PARTIALLY_PAID: "Dibayar Sebagian", PAID: "Lunas" } as const;

export async function exportInvoiceList(actor: Actor, filters: InvoiceListQuery, format: "csv" | "xlsx") {
  if (!actorCan(actor, "invoice:view") && !actorCan(actor, "invoice:view_own")) throw Errors.forbidden();
  const items = await listInvoicesForExport(actor, filters);
  const today = todayIso(env().APP_TIMEZONE);
  const periodLabel = filters.from || filters.to
    ? `${filters.from ? formatDateLong(filters.from) : "awal"} – ${filters.to ? formatDateLong(filters.to) : formatDateLong(today)}`
    : `Semua tanggal (per ${formatDateLong(today)})`;
  const live = items.filter((i) => i.status === "ISSUED");
  const table: ReportTable = {
    type: "daftar-invoice", title: "Daftar Invoice", description: "Hasil filter daftar invoice", periodLabel,
    disclaimer: "Ekspor operasional dari sistem invoice — bukan laporan akuntansi. Total hanya menjumlahkan invoice berstatus Diterbitkan.",
    generatedAt: new Date().toISOString(),
    columns: [
      { key: "number", label: "Nomor", type: "text", width: 14 }, { key: "date", label: "Tanggal", type: "date" },
      { key: "customer", label: "Pelanggan", type: "text", width: 34 }, { key: "total", label: "Total Invoice", type: "money" },
      { key: "paid", label: "Total Dibayar", type: "money" }, { key: "balance", label: "Sisa Tagihan", type: "money" },
      { key: "due", label: "Jatuh Tempo", type: "date" }, { key: "status", label: "Status Invoice", type: "text", width: 14 },
      { key: "pay", label: "Status Pembayaran", type: "text", width: 18 }, { key: "creator", label: "Pembuat", type: "text", width: 20 },
    ],
    rows: items.map((i) => ({
      number: i.number ?? "(draft)", date: i.invoiceDate, customer: i.customerName, total: i.totalAmount, paid: i.paidAmount, balance: i.balanceAmount,
      due: i.dueDate, status: STATUS_LABEL[i.status], pay: i.status !== "ISSUED" ? "-" : i.isOverdue ? "Jatuh Tempo" : PAY_LABEL[i.paymentStatus], creator: i.createdByName,
    })),
    totals: { number: "TOTAL (invoice terbit)", total: live.reduce((a, i) => a + i.totalAmount, 0), paid: live.reduce((a, i) => a + i.paidAmount, 0), balance: live.reduce((a, i) => a + i.balanceAmount, 0) },
  };
  await writeAudit(prisma, actor, { action: "export.invoices", entityType: "Export", summary: `Ekspor daftar invoice (${items.length} baris, ${format.toUpperCase()})`, after: { filters, rows: items.length } });
  const filename = exportFilename("Daftar_Invoice", format, periodLabel);
  return format === "csv"
    ? { body: Buffer.from(toCsv(table), "utf8"), contentType: "text/csv; charset=utf-8", filename }
    : { body: await toXlsx(table), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename };
}
