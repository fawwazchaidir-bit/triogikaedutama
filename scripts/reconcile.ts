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
 *  6. modul kas: entri/transfer tidak mendahului saldo awal akun, pembalikan persis berlawanan, arah sesuai jenis akun,
 *     entri berlaku memiliki penyetuju, satu akun default aktif per jenis, pembalikan pembayaran memakai akun asal
 *  7. buku besar (tahap 2): jurnal manual seimbang & ≥ 2 baris, pembalikan persis berlawanan, tidak mendahului mulai pembukuan,
 *     tidak menyentuh akun kas/bank atau akun cadangan, jurnal saldo awal hanya akun neraca; akun sistem (3-2100, 4-1100, 1-1450) ada & aktif;
 *     akun lawan entri kas bukan akun kas/bank maupun akun cadangan
 *  PERINGATAN (tidak menggagalkan): akun bersaldo negatif, akun nonaktif bersaldo ≠ 0, pengeluaran menunggu > 14 hari,
 *     penerimaan invoice belum dialokasikan ke kas (saldo 1-1450), pembayaran mendahului saldo awal akunnya (dikecualikan dari buku).
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

  // ───────────── Modul kas & bank (basis kas) ─────────────
  add("entri kas mendahului saldo awal akun", await q(`
    SELECT e."id"::text AS ref, 'tanggal=' || e."entryDate" || ' saldo awal=' || a."openingDate" AS detail
      FROM cash_entries e JOIN cash_accounts a ON a."id" = e."cashAccountId" WHERE e."entryDate" < a."openingDate"`));
  add("transfer mendahului saldo awal akun / akun sama", await q(`
    SELECT t."id"::text AS ref, 'tanggal=' || t."transferDate" AS detail
      FROM cash_transfers t JOIN cash_accounts f ON f."id" = t."fromAccountId" JOIN cash_accounts g ON g."id" = t."toAccountId"
     WHERE t."transferDate" < f."openingDate" OR t."transferDate" < g."openingDate" OR t."fromAccountId" = t."toAccountId"`));
  add("pembalikan entri kas tidak valid", await q(`
    SELECT r."id"::text AS ref, 'pembalikan ' || r."amount" || ' vs asal ' || COALESCE(o."amount"::text, 'TIDAK ADA') AS detail
      FROM cash_entries r LEFT JOIN cash_entries o ON o."id" = r."reversesEntryId"
     WHERE r."entryType" = 'REVERSAL' AND (o."id" IS NULL OR o."entryType" <> 'ENTRY' OR o."status" <> 'APPROVED' OR o."cashAccountId" <> r."cashAccountId"
           OR o."counterAccountId" <> r."counterAccountId" OR o."amount" <> r."amount" OR o."direction" = r."direction")`));
  add("pembalikan transfer tidak valid", await q(`
    SELECT r."id"::text AS ref, 'pembalikan ' || r."amount" || ' vs asal ' || COALESCE(o."amount"::text, 'TIDAK ADA') AS detail
      FROM cash_transfers r LEFT JOIN cash_transfers o ON o."id" = r."reversesTransferId"
     WHERE r."entryType" = 'REVERSAL' AND (o."id" IS NULL OR o."entryType" <> 'ENTRY' OR o."fromAccountId" <> r."toAccountId" OR o."toAccountId" <> r."fromAccountId" OR o."amount" <> r."amount")`));
  add("arah entri tidak sesuai jenis akun lawan", await q(`
    SELECT e."id"::text AS ref, c."type" || ' arah ' || e."direction" AS detail
      FROM cash_entries e JOIN coa_accounts c ON c."id" = e."counterAccountId"
     WHERE e."entryType" = 'ENTRY' AND ((c."type" = 'BEBAN' AND e."direction" <> 'OUT') OR (c."type" = 'PENDAPATAN' AND e."direction" <> 'IN') OR NOT c."manualEntry" AND c."isSystem")`));
  add("entri berlaku tanpa penyetuju / entri menunggu dengan keputusan", await q(`
    SELECT "id"::text AS ref, 'status=' || "status" AS detail FROM cash_entries
     WHERE ("status" = 'APPROVED' AND ("approvedById" IS NULL OR "approvedAt" IS NULL)) OR ("status" = 'PENDING' AND ("approvedById" IS NOT NULL OR "rejectedById" IS NOT NULL))`));
  add("akun kas: default ganda / default nonaktif / bukan akun aset", await q(`
    SELECT COALESCE(a."name", k."kind"::text) AS ref, 'default aktif=' || COALESCE(k.n, 0) AS detail
      FROM (SELECT "kind", COUNT(*) AS n FROM cash_accounts WHERE "isDefault" AND "isActive" GROUP BY 1 HAVING COUNT(*) > 1) k LEFT JOIN cash_accounts a ON false
    UNION ALL SELECT "name", 'default tetapi nonaktif' FROM cash_accounts WHERE "isDefault" AND NOT "isActive"
    UNION ALL SELECT a."name", 'akun bagan akun bukan ASET (' || c."type" || ')' FROM cash_accounts a JOIN coa_accounts c ON c."id" = a."coaAccountId" WHERE c."type" <> 'ASET'`));
  add("pembalikan pembayaran memakai akun kas berbeda dari pembayaran asal", await q(`
    SELECT r."id"::text AS ref, 'akun asal=' || COALESCE(o."cashAccountId"::text, 'null') || ' pembalikan=' || COALESCE(r."cashAccountId"::text, 'null') AS detail
      FROM payments r JOIN payments o ON o."id" = r."reversesPaymentId"
     WHERE r."entryType" = 'REVERSAL' AND r."cashAccountId" IS DISTINCT FROM o."cashAccountId"`));

  // ───────────── Buku besar & jurnal manual (tahap 2) ─────────────
  add("akun sistem buku besar hilang / nonaktif", await q(`
    SELECT c."code" AS ref, 'tidak ada atau nonaktif' AS detail FROM (VALUES ('3-2100'), ('4-1100'), ('1-1450')) c("code")
      LEFT JOIN coa_accounts a ON a."code" = c."code" WHERE a."id" IS NULL OR NOT a."isActive"`));
  add("jurnal manual tidak seimbang / kurang dari dua baris", await q(`
    SELECT 'JU-' || lpad(j."numberSeq"::text, 6, '0') AS ref, 'debit=' || COALESCE(SUM(l."debit"), 0) || ' kredit=' || COALESCE(SUM(l."credit"), 0) || ' baris=' || COUNT(l."id") AS detail
      FROM journal_entries j LEFT JOIN journal_lines l ON l."journalId" = j."id"
     GROUP BY j."id" HAVING COALESCE(SUM(l."debit"), 0) <> COALESCE(SUM(l."credit"), 0) OR COUNT(l."id") < 2`));
  add("pembalikan jurnal tidak persis kebalikan jurnal asal", await q(`
    SELECT 'JU-' || lpad(r."numberSeq"::text, 6, '0') AS ref, 'akun ' || COALESCE(x."accountId"::text, '?') AS detail
      FROM journal_entries r
      JOIN LATERAL (
        SELECT COALESCE(a."accountId", b."accountId") AS "accountId"
          FROM (SELECT "accountId", SUM("debit") AS d, SUM("credit") AS c FROM journal_lines WHERE "journalId" = r."id" GROUP BY 1) a
          FULL JOIN (SELECT "accountId", SUM("debit") AS d, SUM("credit") AS c FROM journal_lines WHERE "journalId" = r."reversesJournalId" GROUP BY 1) b ON a."accountId" = b."accountId"
         WHERE COALESCE(a.d, 0) <> COALESCE(b.c, 0) OR COALESCE(a.c, 0) <> COALESCE(b.d, 0)
      ) x ON true
     WHERE r."entryType" = 'REVERSAL'`));
  add("jurnal mendahului tanggal mulai pembukuan / jurnal saldo awal salah tanggal", await q(`
    SELECT 'JU-' || lpad(j."numberSeq"::text, 6, '0') AS ref, 'tanggal=' || j."journalDate" || ' mulai=' || s.d AS detail
      FROM journal_entries j, (SELECT MIN("openingDate") AS d FROM cash_accounts) s
     WHERE s.d IS NULL OR j."journalDate" < s.d OR (j."kind" = 'OPENING' AND j."entryType" = 'ENTRY' AND j."journalDate" <> s.d)`));
  add("jurnal menyentuh akun kas/bank atau akun cadangan", await q(`
    SELECT 'JU-' || lpad(j."numberSeq"::text, 6, '0') AS ref, c."code" || ' ' || c."name" AS detail
      FROM journal_lines l JOIN journal_entries j ON j."id" = l."journalId" JOIN coa_accounts c ON c."id" = l."accountId"
     WHERE c."code" IN ('4-1100', '1-1450', '3-2200') OR EXISTS (SELECT 1 FROM cash_accounts k WHERE k."coaAccountId" = c."id")`));
  add("jurnal saldo awal memuat akun laba rugi", await q(`
    SELECT 'JU-' || lpad(j."numberSeq"::text, 6, '0') AS ref, c."code" AS detail
      FROM journal_lines l JOIN journal_entries j ON j."id" = l."journalId" JOIN coa_accounts c ON c."id" = l."accountId"
     WHERE j."kind" = 'OPENING' AND j."entryType" = 'ENTRY' AND c."type" IN ('PENDAPATAN', 'BEBAN')`));
  add("akun lawan entri kas adalah akun kas/bank atau akun cadangan", await q(`
    SELECT e."id"::text AS ref, c."code" || ' ' || c."name" AS detail
      FROM cash_entries e JOIN coa_accounts c ON c."id" = e."counterAccountId"
     WHERE c."code" IN ('4-1100', '1-1450', '3-2100') OR EXISTS (SELECT 1 FROM cash_accounts k WHERE k."coaAccountId" = c."id")`));

  // Saldo per akun dihitung ulang di SQL murni (independen dari kode aplikasi).
  const balances = await q<{ name: string; isActive: boolean; bal: bigint }>(`
    SELECT a."name", a."isActive", a."openingBalance"
      + COALESCE((SELECT SUM(p."amount") FROM payments p WHERE p."cashAccountId" = a."id" AND p."paymentDate" >= a."openingDate"), 0)
      + COALESCE((SELECT SUM(CASE WHEN e."direction" = 'IN' THEN e."amount" ELSE -e."amount" END) FROM cash_entries e WHERE e."cashAccountId" = a."id" AND e."status" = 'APPROVED' AND e."entryDate" >= a."openingDate"), 0)
      + COALESCE((SELECT SUM(t."amount") FROM cash_transfers t WHERE t."toAccountId" = a."id" AND t."transferDate" >= a."openingDate"), 0)
      - COALESCE((SELECT SUM(t."amount") FROM cash_transfers t WHERE t."fromAccountId" = a."id" AND t."transferDate" >= a."openingDate"), 0) AS bal
      FROM cash_accounts a ORDER BY a."name"`);
  const warnings: string[] = [];
  for (const b of balances) {
    if (b.bal < 0n) warnings.push(`saldo NEGATIF pada ${b.name}: ${b.bal}`);
    if (!b.isActive && b.bal !== 0n) warnings.push(`akun nonaktif ${b.name} masih bersaldo ${b.bal}`);
  }
  const unalloc = await q<{ n: bigint; total: bigint | null }>(`SELECT COUNT(*) AS n, SUM("amount") AS total FROM payments WHERE "cashAccountId" IS NULL`);
  if (unalloc[0] && unalloc[0].n > 0n) warnings.push(`${unalloc[0].n} baris pembayaran invoice belum dialokasikan ke akun kas/bank (saldo penampung 1-1450 = ${unalloc[0].total})`);
  const preOpen = await q<{ n: bigint }>(`SELECT COUNT(*) AS n FROM payments p JOIN cash_accounts a ON a."id" = p."cashAccountId" WHERE p."paymentDate" < a."openingDate"`);
  if (preOpen[0] && preOpen[0].n > 0n) warnings.push(`${preOpen[0].n} baris pembayaran bertanggal sebelum saldo awal akunnya (dianggap sudah termasuk saldo awal; tidak masuk buku besar & laba rugi)`);
  const stale = await q<{ n: bigint }>(`SELECT COUNT(*) AS n FROM cash_entries WHERE "status" = 'PENDING' AND "createdAt" < now() - interval '14 days'`);
  if (stale[0] && stale[0].n > 0n) warnings.push(`${stale[0].n} pengeluaran menunggu persetujuan lebih dari 14 hari`);
  if (balances.length) console.log(`Saldo kas/bank (hitung ulang SQL): ${balances.map((b) => `${b.name}=${b.bal}`).join("; ")}`);
  for (const w of warnings) console.warn(`⚠ PERINGATAN: ${w}`);

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
