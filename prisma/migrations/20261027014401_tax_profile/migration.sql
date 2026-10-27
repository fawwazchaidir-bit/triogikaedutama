-- CreateEnum
CREATE TYPE "CorporateTaxRegime" AS ENUM ('NONE', 'GENERAL', 'FINAL');

-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "corporateTaxRateBps" INTEGER,
ADD COLUMN     "corporateTaxRegime" "CorporateTaxRegime" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "isPkp" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "tax_year_inputs" (
    "year" INTEGER NOT NULL,
    "fiscalCorrection" BIGINT NOT NULL DEFAULT 0,
    "lossCompensation" BIGINT NOT NULL DEFAULT 0,
    "facilityReduction" BIGINT NOT NULL DEFAULT 0,
    "note" TEXT,
    "updatedById" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_year_inputs_pkey" PRIMARY KEY ("year")
);

-- AddForeignKey
ALTER TABLE "tax_year_inputs" ADD CONSTRAINT "tax_year_inputs_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_tax_profile" CHECK (
  ("corporateTaxRateBps" IS NULL OR ("corporateTaxRateBps" >= 0 AND "corporateTaxRateBps" <= 10000))
  AND ("corporateTaxRegime" = 'NONE' OR "corporateTaxRateBps" IS NOT NULL)
);
ALTER TABLE "tax_year_inputs" ADD CONSTRAINT "tax_year_inputs_values" CHECK ("year" BETWEEN 2000 AND 2200 AND "lossCompensation" >= 0 AND "facilityReduction" >= 0);

-- Nomor bukti potong biasanya baru diterima belakangan: SATU-SATUNYA perubahan yang diizinkan pada pembayaran adalah mengisi withholdingRef
-- (dari kosong) pada pembayaran yang memang memuat PPh dipotong; kolom lain tidak berubah. Selebihnya tetap append-only.
DROP TRIGGER "payments_append_only" ON "payments";
CREATE FUNCTION trg_payments_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."entryType" = 'PAYMENT' AND OLD."withholdingAmount" > 0 AND OLD."withholdingRef" IS NULL
     AND NEW."withholdingRef" IS NOT NULL AND length(btrim(NEW."withholdingRef")) > 0
     AND (to_jsonb(NEW) - 'withholdingRef') = (to_jsonb(OLD) - 'withholdingRef') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% bersifat append-only: % dilarang (gunakan pembalikan/koreksi baru)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "payments_append_only" BEFORE UPDATE OR DELETE ON "payments" FOR EACH ROW EXECUTE FUNCTION trg_payments_guard();
