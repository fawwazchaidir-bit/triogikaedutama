import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, demiChefInput, type Fixtures } from "../helpers/db";
import { cancelInvoice, createDraft, issueInvoice, submitInvoice } from "@/server/services/invoices";
import { recordPayment, reversePayment } from "@/server/services/payments";
import { getDashboard } from "@/server/services/dashboard";
import { runReport } from "@/server/services/reports";
import { listAuditLogs, getInvoiceHistory } from "@/server/services/audit";
import { exportInvoiceList } from "@/server/services/export-invoices";
import { toCsv, toXlsx, neutralize } from "@/server/export";
import { todayIso } from "@/lib/format";
import { AppError } from "@/server/errors";

let fx: Fixtures;
let customerB: string;
const today = todayIso("Asia/Jakarta");
const thisMonth = today.slice(0, 7);
const n2 = (v: unknown) => Number(v);
const err = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as AppError;

async function mk(over: Record<string, unknown> = {}, customerId = fx.customerId) {
  const d = await createDraft(fx.finance, demiChefInput(fx, { customerId, invoiceDate: today, paymentTermDays: 0, ...over }));
  return issueInvoice(fx.finance, d.id);
}
const pay = (invoiceId: string, amount: number, date = today) =>
  recordPayment(fx.finance, { invoiceId, paymentDate: date, amount, method: "Transfer", reference: "R" });

beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures();
  const b = await prisma.customer.create({ data: { name: "PT Beta Mandiri", normalizedName: "beta mandiri", cityKey: "", createdById: fx.admin.userId } });
  customerB = b.id;
});

describe("dashboard — definisi angka tidak tumpang tindih", () => {
  it("nilai invoice ≠ kas ≠ piutang; DP dihitung sekali; draft & batal tidak masuk", async () => {
    const a = await mk(); // 14 jt, DP 0
    const b = await mk({ downPayment: 4_000_000 }); // 14 jt, DP 4 jt dicatat sebagai pembayaran
    const c = await mk({}, customerB);
    await pay(a.id, 5_000_000);
    await pay(c.id, 14_000_000); // lunas
    const x = await mk(); // akan dibatalkan
    await cancelInvoice(fx.finance, x.id, { reason: "Salah input" });
    await createDraft(fx.finance, demiChefInput(fx)); // draft

    const d = await getDashboard(fx.finance, {});
    expect(d.issuedCount).toBe(3);
    expect(d.invoicedAmount).toBe(42_000_000); // 3 × 14 jt (batal & draft tidak dihitung)
    expect(d.monthInvoiced).toBe(42_000_000);
    expect(d.yearInvoiced).toBe(42_000_000);
    expect(d.receivedAmount).toBe(5_000_000 + 4_000_000 + 14_000_000); // kas: pembayaran + DP (sekali)
    expect(d.outstandingAmount).toBe(42_000_000 - 23_000_000); // piutang = nilai − kas
    expect(d.paidCount).toBe(1);
    expect(d.partialCount).toBe(2);
    expect(d.unpaidCount).toBe(0);
    expect(d.cancelledCount).toBe(1);
    expect(d.draftCount).toBe(1);
    expect(d.overdueCount).toBe(0); // jatuh tempo = hari ini → belum overdue (overdue = jatuh tempo < hari ini)
    const row = d.trend.find((t) => t.month === thisMonth)!;
    expect(row).toMatchObject({ invoiced: 42_000_000, received: 23_000_000 });
    expect(b.amounts.paid).toBe(4_000_000);
  });

  it("invoice menunggu verifikasi tidak masuk omzet, piutang, kas, maupun laporan — hanya terhitung sebagai antrean verifikasi", async () => {
    await mk(); // 14 jt terbit
    const waiting = await createDraft(fx.staff, demiChefInput(fx, { invoiceDate: today, paymentTermDays: 0 }));
    await submitInvoice(fx.staff, waiting.id);
    await createDraft(fx.staff, demiChefInput(fx)); // draft biasa

    const d = await getDashboard(fx.finance, {});
    expect(d).toMatchObject({ issuedCount: 1, invoicedAmount: 14_000_000, monthInvoiced: 14_000_000, yearInvoiced: 14_000_000, outstandingAmount: 14_000_000, pendingCount: 1, draftCount: 1 });
    expect(d.trend.find((t) => t.month === thisMonth)).toMatchObject({ invoiced: 14_000_000 });

    const inv = await runReport(fx.finance, "invoices", {});
    expect(inv.rows).toHaveLength(1);
    expect(inv.totals?.total).toBe(14_000_000);
    expect((await runReport(fx.finance, "receivables", {})).totals?.balance).toBe(14_000_000);
    expect((await runReport(fx.finance, "by-customer", {})).totals).toMatchObject({ total: 14_000_000 });

    const csv = (await exportInvoiceList(fx.finance, { status: "SUBMITTED" }, "csv")).body.toString("utf8");
    expect(csv).toContain("Menunggu Verifikasi");
    expect(csv).toContain("(draft)");
  });

  it("filter pelanggan, periode, status pembayaran, dan nomor", async () => {
    const a = await mk(); const c = await mk({}, customerB);
    await pay(c.id, 14_000_000);
    const byCust = await getDashboard(fx.finance, { customerId: customerB });
    expect(byCust).toMatchObject({ issuedCount: 1, invoicedAmount: 14_000_000, receivedAmount: 14_000_000, outstandingAmount: 0 });
    const byNumber = await getDashboard(fx.finance, { q: a.number! });
    expect(byNumber).toMatchObject({ issuedCount: 1, invoicedAmount: 14_000_000, receivedAmount: 0, outstandingAmount: 14_000_000 });
    const paidOnly = await getDashboard(fx.finance, { paymentStatus: "PAID" });
    expect(paidOnly).toMatchObject({ issuedCount: 1, invoicedAmount: 14_000_000 });
    const pastPeriod = await getDashboard(fx.finance, { from: "2020-01-01", to: "2020-12-31" });
    expect(pastPeriod).toMatchObject({ issuedCount: 0, invoicedAmount: 0, receivedAmount: 0 });
    expect(pastPeriod.trend).toHaveLength(12);
    expect((await err(getDashboard(fx.finance, { from: "kemarin" }))).code).toBe("VALIDATION");
  });

  it("overdue: jatuh tempo lampau & saldo > 0 dihitung; yang lunas atau belum jatuh tempo tidak", async () => {
    const late = await mk({ invoiceDate: "2020-06-01", paymentTermDays: 4 });
    const latePaid = await mk({ invoiceDate: "2020-06-02", paymentTermDays: 4 });
    await recordPayment(fx.finance, { invoiceId: latePaid.id, paymentDate: "2020-06-03", amount: 14_000_000, method: "Transfer" });
    await mk({ invoiceDate: "2020-06-03", paymentTermDays: 4, downPayment: 1_000_000 }); // sebagian & overdue
    await mk({ invoiceDate: "2099-06-01", paymentTermDays: 30 }); // belum jatuh tempo
    const d = await getDashboard(fx.finance, { from: "2020-01-01", to: "2099-12-31" });
    expect(d.overdueCount).toBe(2);
    expect(d.overdueAmount).toBe(14_000_000 + 13_000_000);
    expect(late.dueDate).toBe("2020-06-05");
    const od = await runReport(fx.finance, "overdue", {});
    expect(od.rows).toHaveLength(2);
    expect(od.rows.every((r) => n2(r.daysOverdue) > 90)).toBe(true);
  });

  it("pembalikan pembayaran mengurangi kas & menaikkan piutang pada bulan yang sama", async () => {
    const a = await mk();
    const p = await pay(a.id, 6_000_000);
    await reversePayment(fx.finance, p.id, { reason: "Salah rekening" });
    const d = await getDashboard(fx.finance, {});
    expect(d.receivedAmount).toBe(0);
    expect(d.outstandingAmount).toBe(14_000_000);
  });

  it("izin: hanya Admin & Finance", async () => {
    expect((await err(getDashboard(fx.staff, {}))).code).toBe("FORBIDDEN");
    await getDashboard(fx.admin, {});
  });
});

describe("laporan", () => {
  it("9 jenis laporan berjalan; total konsisten dengan dashboard; invoice batal tak ikut dijumlah", async () => {
    const a = await mk(); await mk({ downPayment: 4_000_000 }); const c = await mk({}, customerB);
    await pay(a.id, 5_000_000); await pay(c.id, 14_000_000);
    const x = await mk(); await cancelInvoice(fx.finance, x.id, { reason: "Salah input" });

    const inv = await runReport(fx.finance, "invoices", {});
    expect(inv.rows).toHaveLength(4); // 3 terbit + 1 batal
    expect(inv.totals?.total).toBe(42_000_000);
    expect(inv.rows.find((r) => r.status === "Dibatalkan")?.balance).toBe(0);

    const byCust = await runReport(fx.finance, "by-customer", {});
    expect(byCust.rows.map((r) => [r.customer, r.total])).toEqual([["CV Bima Satria Jaya", 28_000_000], ["PT Beta Mandiri", 14_000_000]]);
    expect(byCust.totals).toMatchObject({ total: 42_000_000, paid: 23_000_000, balance: 19_000_000 });

    const byProd = await runReport(fx.finance, "by-product", {});
    expect(byProd.rows[0]).toMatchObject({ code: "DEMI-CHEF", scheme: "Demi Chef", invoices: 3, qty: 21, net: 42_000_000 });

    const pays = await runReport(fx.finance, "payments", {});
    expect(pays.rows).toHaveLength(3); // 5jt, DP 4jt, 14jt
    expect(pays.totals?.amount).toBe(23_000_000);
    expect(pays.rows.filter((r) => r.type === "Down Payment")).toHaveLength(1);

    const rec = await runReport(fx.finance, "receivables", {});
    expect(rec.rows).toHaveLength(2);
    expect(rec.totals?.balance).toBe(19_000_000);
    const overdue = await runReport(fx.finance, "overdue", {});
    expect(overdue.rows.length).toBeLessThanOrEqual(2);
    expect((await runReport(fx.finance, "paid", {})).rows).toHaveLength(1);
    const canc = await runReport(fx.finance, "cancelled", {});
    expect(canc.rows[0]).toMatchObject({ number: x.number, reason: "Salah input", who: "Finance Uji" });

    const monthly = await runReport(fx.finance, "monthly", {});
    const m = monthly.rows.find((r) => r.invoiced === 42_000_000)!;
    expect(m).toMatchObject({ count: 3, cancelled: 1, received: 23_000_000, gap: 19_000_000 });
    expect(monthly.rows.at(-1)?.period).toMatch(/^TOTAL TAHUN/);

    const dash = await getDashboard(fx.finance, {});
    expect(dash.invoicedAmount).toBe(inv.totals?.total);
    expect(dash.receivedAmount).toBe(pays.totals?.amount);
    expect(dash.outstandingAmount).toBe(rec.totals?.balance);
    for (const t of [inv, byCust, pays, rec, monthly]) expect(t.disclaimer).toMatch(/BUKAN laporan akuntansi/);
  });

  it("filter periode & pelanggan; piutang umur; validasi", async () => {
    await mk({ invoiceDate: "2020-03-01", paymentTermDays: 4 }); // sangat terlambat
    await mk({}, customerB);
    const old = await runReport(fx.finance, "invoices", { from: "2020-01-01", to: "2020-12-31" });
    expect(old.rows).toHaveLength(1);
    const onlyB = await runReport(fx.finance, "invoices", { customerId: customerB });
    expect(onlyB.rows).toHaveLength(1);
    const rec = await runReport(fx.finance, "receivables", {});
    expect(rec.rows.find((r) => r.invoiceDate === "2020-03-01")?.aging).toBe("> 90 hari");
    expect((await err(runReport(fx.finance, "invoices", { from: "2026-02-01", to: "2026-01-01" }))).code).toBe("VALIDATION");
    expect((await err(runReport(fx.finance, "tidak-ada", {}))).code).toBe("NOT_FOUND");
    // staff operasional boleh melihat laporan — hasilnya identik dengan Finance Manager
    const asStaff = await runReport(fx.staff, "invoices", {});
    expect(asStaff.rows.length).toBeGreaterThan(0);
    expect(asStaff.rows).toEqual((await runReport(fx.finance, "invoices", {})).rows);
  });
});

describe("ekspor CSV & Excel", () => {
  it("menetralkan formula injection di CSV dan menjaga nominal sebagai angka", async () => {
    expect(neutralize("=HYPERLINK(\"http://x\")")).toBe("'=HYPERLINK(\"http://x\")");
    expect(neutralize("+1+1")).toBe("'+1+1");
    expect(neutralize("-2")).toBe("'-2");
    expect(neutralize("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(neutralize("Aman")).toBe("Aman");
    await prisma.customer.update({ where: { id: customerB }, data: { name: '=cmd|\' /C calc\'!A0' } });
    await mk({}, customerB);
    const table = await runReport(fx.finance, "invoices", {});
    const csv = toCsv(table);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("'=cmd|");
    expect(csv).not.toMatch(/,=cmd/);
    expect(csv).toContain(",14000000,"); // angka murni, bukan "Rp 14.000.000"
    expect(csv).toContain("TOTAL (invoice terbit)");
  });

  it("XLSX dapat dibaca kembali: header, angka, tanggal, total", async () => {
    await mk(); await mk({}, customerB);
    const buf = await toXlsx(await runReport(fx.finance, "invoices", {}));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const header = ws.getRow(5).values as unknown[];
    expect(header).toContain("Total Invoice");
    const first = ws.getRow(6);
    expect(first.getCell(4).value).toBe(14_000_000);
    expect(first.getCell(2).value).toBeInstanceOf(Date);
    expect(ws.getRow(8).getCell(4).value).toBe(28_000_000);
  });

  it("ekspor daftar invoice menghormati filter (staff melihat semua invoice, seperti Finance) dan tercatat di audit", async () => {
    await mk();
    await createDraft(fx.staff, demiChefInput(fx));
    const asFinance = await exportInvoiceList(fx.finance, {}, "csv");
    expect(asFinance.filename).toMatch(/^Laporan_Daftar_Invoice_.*\.csv$/);
    expect(asFinance.body.toString("utf8").split("\r\n").filter((l) => l.includes("CV Bima")).length).toBe(2);
    const asStaff = (await exportInvoiceList(fx.staff, {}, "csv")).body.toString("utf8");
    expect(asStaff.split("\r\n").filter((l) => l.includes("CV Bima")).length).toBe(2);
    expect(asStaff).toContain("(draft)");
    const onlyIssued = (await exportInvoiceList(fx.finance, { status: "ISSUED" }, "csv")).body.toString("utf8");
    expect(onlyIssued).not.toContain("(draft)");
    const xlsx = await exportInvoiceList(fx.finance, {}, "xlsx");
    expect(xlsx.contentType).toContain("spreadsheetml");
    expect(await prisma.auditLog.count({ where: { action: "export.invoices" } })).toBe(4);
  });
});

describe("audit log", () => {
  it("hanya Admin yang melihat audit log lengkap; Finance Manager & Staff melihat riwayat per invoice", async () => {
    const a = await mk();
    await pay(a.id, 1_000_000);
    const all = await listAuditLogs(fx.admin, { entityType: "Invoice", entityId: a.id });
    expect(all.items.map((l) => l.action)).toEqual(["payment.record", "invoice.issue", "invoice.create_draft"]);
    expect(all.items[1]).toMatchObject({ actorName: "Finance Uji", actorRole: "FINANCE" });
    expect((await err(listAuditLogs(fx.finance, {}))).code).toBe("FORBIDDEN");
    expect((await err(listAuditLogs(fx.staff, {}))).code).toBe("FORBIDDEN");
    const hist = await getInvoiceHistory(fx.finance, a.id);
    expect(hist.map((h) => h.action)).toEqual(["invoice.create_draft", "invoice.issue", "payment.record"]);
    expect((await getInvoiceHistory(fx.staff, a.id)).map((h) => h.action)).toEqual(hist.map((h) => h.action));
    const filtered = await listAuditLogs(fx.admin, { action: "payment.", q: "Pembayaran" });
    expect(filtered.total).toBe(1);
    expect((await err(listAuditLogs(fx.admin, { from: "bukan-tanggal" }))).code).toBe("VALIDATION");
  });
});
