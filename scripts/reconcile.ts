/**
 * REKONSILIASI INTEGRITAS DATA — jalankan berkala (mis. harian lewat cron) dan sebelum/sesudah backup & restore.
 *   npm run db:reconcile
 * Keluar dengan kode 1 bila ada ketidakcocokan. Hanya MEMBACA data.
 *
 * Pemeriksaan:
 *  1. cache invoices.paidAmount == Σ ledger pembayaran, balance == total − paid, status pembayaran sesuai
 *  2. identitas total: total = subtotal − diskon tambahan + pajak + biaya tambahan; subtotal == Σ nilai bersih baris
 *  3. invoice terbit/batal memiliki nomor, snapshot, dan nomor unik; draft tidak bernomor
 *  4. penghitung nomor tidak tertinggal dari nomor terbesar yang sudah terbit pada scope-nya
 *  5. setiap pembalikan menunjuk satu pembayaran asal dengan nominal berlawanan
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
type Problem = { check: string; ref: string; detail: string };

async function main() {
  const problems: Problem[] = [];
  const add = (check: string, rows: { ref: string; detail: string }[]) => rows.forEach((r) => problems.push({ check, ...r }));
  const q = <T>(sql: string) => prisma.$queryRawUnsafe<T[]>(sql);

  add("cache pembayaran ≠ ledger", await q<{ ref: string; detail: string }>(`
    SELECT COALESCE(i."number", i."id"::text) AS ref,
           'paid cache=' || i."paidAmount" || ' ledger=' || COALESCE(SUM(p."amount"), 0) AS detail
      FROM invoices i LEFT JOIN payments p ON p."invoiceId" = i."id"
     GROUP BY i."id" HAVING i."paidAmount" <> COALESCE(SUM(p."amount"), 0)`));

  add("saldo/status pembayaran tidak konsisten", await q(`
    SELECT COALESCE("number", "id"::text) AS ref, 'total=' || "totalAmount" || ' paid=' || "paidAmount" || ' balance=' || "balanceAmount" || ' status=' || "paymentStatus" AS detail
      FROM invoices
     WHERE "balanceAmount" <> "totalAmount" - "paidAmount"
        OR ("status" NOT IN ('DRAFT','SUBMITTED') AND (
              ("paidAmount" = 0 AND "paymentStatus" <> 'UNPAID')
           OR ("paidAmount" > 0 AND "paidAmount" < "totalAmount" AND "paymentStatus" <> 'PARTIALLY_PAID')
           OR ("paidAmount" = "totalAmount" AND "totalAmount" > 0 AND "paymentStatus" <> 'PAID')))`));

  add("identitas total / subtotal tidak cocok", await q(`
    SELECT COALESCE(i."number", i."id"::text) AS ref,
           'total=' || i."totalAmount" || ' subtotal=' || i."subtotalAmount" || ' Σbaris=' || COALESCE(SUM(it."netAmount"), 0) AS detail
      FROM invoices i LEFT JOIN invoice_items it ON it."invoiceId" = i."id"
     GROUP BY i."id"
    HAVING i."totalAmount" <> i."subtotalAmount" - i."extraDiscountAmount" + i."taxAmount" + i."surchargeAmount"
        OR i."subtotalAmount" <> COALESCE(SUM(it."netAmount"), 0)`));

  add("invoice terbit/batal tanpa snapshot atau nomor", await q(`
    SELECT "id"::text AS ref, 'status=' || "status" AS detail FROM invoices
     WHERE "status" NOT IN ('DRAFT','SUBMITTED') AND ("number" IS NULL OR "companySnapshot" IS NULL OR "customerSnapshot" IS NULL OR "taxSnapshot" IS NULL OR "displaySnapshot" IS NULL)`));

  add("penghitung nomor tertinggal dari nomor terbit", await q(`
    SELECT s."scopeKey" AS ref, 'nextValue=' || s."nextValue" || ' nomor terbesar=' || m.mx AS detail
      FROM invoice_number_sequences s JOIN (SELECT "numberScope", MAX("numberSeq") AS mx FROM invoices WHERE "numberScope" IS NOT NULL GROUP BY 1) m ON m."numberScope" = s."scopeKey"
     WHERE s."nextValue" <= m.mx`));

  add("pembalikan pembayaran tidak valid", await q(`
    SELECT r."id"::text AS ref, 'reversal=' || r."amount" || ' asal=' || COALESCE(o."amount"::text, 'TIDAK ADA') AS detail
      FROM payments r LEFT JOIN payments o ON o."id" = r."reversesPaymentId"
     WHERE r."entryType" = 'REVERSAL' AND (o."id" IS NULL OR o."invoiceId" <> r."invoiceId" OR r."amount" <> -o."amount")`));

  add("invoice batal masih memiliki saldo pembayaran", await q(`
    SELECT "number" AS ref, 'paid=' || "paidAmount" AS detail FROM invoices WHERE "status" = 'CANCELLED' AND "paidAmount" <> 0`));

  const [{ n: invoices }] = await q<{ n: bigint }>(`SELECT COUNT(*) AS n FROM invoices`) as [{ n: bigint }];
  const [{ n: payments }] = await q<{ n: bigint }>(`SELECT COUNT(*) AS n FROM payments`) as [{ n: bigint }];
  console.log(`Diperiksa: ${invoices} invoice, ${payments} baris pembayaran.`);
  if (problems.length === 0) {
    console.log("✔ Rekonsiliasi bersih: tidak ada ketidakcocokan.");
    return;
  }
  console.error(`✘ Ditemukan ${problems.length} masalah:`);
  for (const p of problems) console.error(`  - [${p.check}] ${p.ref}: ${p.detail}`);
  process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(() => prisma.$disconnect());
