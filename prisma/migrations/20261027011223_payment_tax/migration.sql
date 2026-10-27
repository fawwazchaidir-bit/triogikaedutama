-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "vatAmount" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "withholdingAmount" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "withholdingRef" TEXT;

-- ═══════════ Pajak pada pembayaran invoice (PPN keluaran & PPh dipotong pelanggan) ═══════════
-- Pembayaran invoice = uang masuk (amount) + PPh yang dipotong pelanggan (withholdingAmount, tanpa uang) → keduanya melunasi invoice.
-- vatAmount = bagian PPN dari (amount + withholdingAmount), dibekukan saat dicatat; sisanya pendapatan.

-- Backfill PPN untuk pembayaran lama: kumulatif proporsional terhadap pajak invoice (selisih pembulatan pada pembayaran terakhir), pembalikan = cermin.
ALTER TABLE "payments" DISABLE TRIGGER "payments_append_only";
WITH base AS (
  SELECT p."id", p."invoiceId", p."createdAt", p."amount", i."taxAmount" AS tax, i."totalAmount" AS total,
         LEAST(SUM(p."amount") OVER (PARTITION BY p."invoiceId" ORDER BY p."createdAt", p."id"), i."totalAmount") AS cum
    FROM "payments" p JOIN "invoices" i ON i."id" = p."invoiceId"
   WHERE p."entryType" = 'PAYMENT' AND i."taxAmount" > 0 AND i."totalAmount" > 0
), tgt AS (
  SELECT "id", "invoiceId", "createdAt", "amount",
         CASE WHEN cum >= total THEN tax ELSE floor(cum::numeric * tax / total)::bigint END AS target
    FROM base
), v AS (
  SELECT "id", "amount", GREATEST(target - COALESCE(LAG(target) OVER (PARTITION BY "invoiceId" ORDER BY "createdAt", "id"), 0), 0) AS vat FROM tgt
)
UPDATE "payments" p SET "vatAmount" = LEAST(v.vat, p."amount") FROM v WHERE v."id" = p."id";
UPDATE "payments" r SET "vatAmount" = -o."vatAmount" FROM "payments" o WHERE r."entryType" = 'REVERSAL' AND o."id" = r."reversesPaymentId";
ALTER TABLE "payments" ENABLE TRIGGER "payments_append_only";

ALTER TABLE "payments" DROP CONSTRAINT "payments_entry_shape";
ALTER TABLE "payments" ADD CONSTRAINT "payments_entry_shape" CHECK (
  ("entryType" = 'PAYMENT' AND "amount" > 0 AND "reversesPaymentId" IS NULL
     AND "withholdingAmount" >= 0 AND "vatAmount" >= 0 AND "vatAmount" <= "amount" + "withholdingAmount")
  OR
  ("entryType" = 'REVERSAL' AND "amount" < 0 AND "reversesPaymentId" IS NOT NULL
     AND "reason" IS NOT NULL AND length(btrim("reason")) > 0
     AND "withholdingAmount" <= 0 AND "vatAmount" <= 0 AND -"vatAmount" <= -"amount" - "withholdingAmount")
);
ALTER TABLE "payments" ADD CONSTRAINT "payments_withholding_ref" CHECK ("withholdingRef" IS NULL OR ("withholdingAmount" <> 0 AND length(btrim("withholdingRef")) > 0));

-- Pembalikan harus cermin persis: nominal, PPh dipotong, dan PPN (berlawanan tanda), akun kas sama.
CREATE OR REPLACE FUNCTION trg_payments_reversal_check() RETURNS trigger AS $$
DECLARE orig RECORD; acct_active boolean;
BEGIN
  IF NEW."entryType" = 'REVERSAL' THEN
    SELECT "invoiceId", "amount", "entryType", "cashAccountId", "withholdingAmount", "vatAmount" INTO orig FROM "payments" WHERE "id" = NEW."reversesPaymentId";
    IF NOT FOUND OR orig."entryType" <> 'PAYMENT' THEN
      RAISE EXCEPTION 'Pembalikan harus merujuk pembayaran (PAYMENT) yang ada';
    END IF;
    IF orig."invoiceId" <> NEW."invoiceId" THEN
      RAISE EXCEPTION 'Pembalikan harus berada pada invoice yang sama dengan pembayaran asal';
    END IF;
    IF NEW."amount" <> -orig."amount" OR NEW."withholdingAmount" <> -orig."withholdingAmount" OR NEW."vatAmount" <> -orig."vatAmount" THEN
      RAISE EXCEPTION 'Nominal pembalikan (uang, PPh dipotong, PPN) harus sama persis dengan pembayaran asal (berlawanan tanda)';
    END IF;
    IF NEW."cashAccountId" IS DISTINCT FROM orig."cashAccountId" THEN
      RAISE EXCEPTION 'Pembalikan harus memakai akun kas/bank yang sama dengan pembayaran asal' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."cashAccountId" IS NOT NULL THEN
    SELECT "isActive" INTO acct_active FROM "cash_accounts" WHERE "id" = NEW."cashAccountId";
    IF NOT FOUND OR NOT acct_active THEN
      RAISE EXCEPTION 'Akun kas/bank penerima tidak aktif' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Akun pajak. Akun sistem boleh sekaligus "boleh dipilih pada entri kas" (untuk mencatat SETORAN pajak: kas keluar, Dr utang pajak).
ALTER TABLE "coa_accounts" DROP CONSTRAINT "coa_system_not_manual";
INSERT INTO "coa_accounts" ("id", "code", "name", "type", "section", "manualEntry", "isSystem", "isActive", "updatedAt") VALUES
  (gen_random_uuid(), '1-1410', 'PPN Masukan (dapat dikreditkan)', 'ASET', 'OPERASI', false, true, true, now()),
  (gen_random_uuid(), '2-1210', 'Utang PPN (PPN Keluaran)', 'KEWAJIBAN', 'OPERASI', true, true, true, now()),
  (gen_random_uuid(), '2-1230', 'Utang PPh Badan (angsuran PPh 25 / PPh 29)', 'KEWAJIBAN', 'OPERASI', true, true, true, now())
ON CONFLICT ("code") DO NOTHING;
UPDATE "coa_accounts" SET "name" = 'Utang Pajak Lainnya (PPh 21/23/4(2) yang dipotong)' WHERE "code" = '2-1200';
