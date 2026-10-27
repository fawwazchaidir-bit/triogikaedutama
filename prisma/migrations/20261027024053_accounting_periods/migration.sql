-- CreateEnum
CREATE TYPE "PeriodStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "accounting_periods" (
    "id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "PeriodStatus" NOT NULL DEFAULT 'CLOSED',
    "closedAt" TIMESTAMP(3),
    "closedById" UUID,
    "note" TEXT,
    "acknowledged" JSONB,
    "snapshot" JSONB,
    "snapshotHash" TEXT,
    "reopenedAt" TIMESTAMP(3),
    "reopenedById" UUID,
    "reopenReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounting_periods_year_month_key" ON "accounting_periods"("year", "month");

-- AddForeignKey
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_reopenedById_fkey" FOREIGN KEY ("reopenedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════ Integritas penutupan periode ═══════════
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_values" CHECK (
  "month" BETWEEN 1 AND 12 AND "year" BETWEEN 2000 AND 2200
  AND (
    ("status" = 'CLOSED' AND "closedAt" IS NOT NULL AND "closedById" IS NOT NULL AND "snapshot" IS NOT NULL AND "snapshotHash" ~ '^[0-9a-f]{64}$')
    OR ("status" = 'OPEN' AND "reopenedAt" IS NOT NULL AND "reopenedById" IS NOT NULL AND "reopenReason" IS NOT NULL AND length(btrim("reopenReason")) >= 5)
  )
);

CREATE FUNCTION trg_accounting_periods_guard() RETURNS trigger AS $$
DECLARE this_month date; first_month date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Periode tidak dapat dihapus (buka kembali saja)' USING ERRCODE = 'restrict_violation';
  END IF;
  this_month := make_date(NEW."year", NEW."month", 1);
  IF TG_OP = 'INSERT' AND NEW."status" <> 'CLOSED' THEN
    RAISE EXCEPTION 'Periode baru harus langsung berstatus CLOSED' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."year" <> OLD."year" OR NEW."month" <> OLD."month" THEN
      RAISE EXCEPTION 'Tahun/bulan periode tidak dapat diubah' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" = NEW."status" THEN
      RAISE EXCEPTION 'Periode % tidak dapat diubah selain dengan membuka kembali / menutup', OLD."status" USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD."status" = 'CLOSED' THEN  -- dibuka kembali: hanya dari periode terakhir yang ditutup; isi snapshot tidak boleh diubah
      IF EXISTS (SELECT 1 FROM "accounting_periods" p WHERE p."status" = 'CLOSED' AND p."year" * 12 + p."month" > NEW."year" * 12 + NEW."month") THEN
        RAISE EXCEPTION 'Buka kembali dimulai dari periode terakhir yang ditutup' USING ERRCODE = 'restrict_violation';
      END IF;
      IF NEW."snapshot" IS DISTINCT FROM OLD."snapshot" OR NEW."snapshotHash" IS DISTINCT FROM OLD."snapshotHash" OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt" THEN
        RAISE EXCEPTION 'Foto penutupan tidak dapat diubah' USING ERRCODE = 'restrict_violation';
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  -- Menutup (INSERT baru atau OPEN → CLOSED)
  first_month := date_trunc('month', (SELECT MIN("openingDate") FROM "cash_accounts"))::date;
  IF first_month IS NULL THEN RAISE EXCEPTION 'Belum ada akun kas/bank: bulan mulai pembukuan belum ada' USING ERRCODE = 'check_violation'; END IF;
  IF this_month < first_month THEN RAISE EXCEPTION 'Periode mendahului bulan mulai pembukuan' USING ERRCODE = 'check_violation'; END IF;
  IF (this_month + interval '1 month' - interval '1 day')::date > CURRENT_DATE THEN RAISE EXCEPTION 'Periode belum berakhir' USING ERRCODE = 'check_violation'; END IF;
  IF this_month > first_month AND NOT EXISTS (
    SELECT 1 FROM "accounting_periods" p WHERE p."status" = 'CLOSED' AND p."year" * 12 + p."month" = NEW."year" * 12 + NEW."month" - 1
  ) THEN
    RAISE EXCEPTION 'Bulan sebelumnya belum ditutup: tutup berurutan' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "accounting_periods_guard" BEFORE INSERT OR UPDATE OR DELETE ON "accounting_periods" FOR EACH ROW EXECUTE FUNCTION trg_accounting_periods_guard();

-- Tanggal kunci buku = akhir bulan periode CLOSED terakhir (kosong bila tidak ada). Dipelihara di sini agar tidak mungkin menyimpang dari tabel periode.
CREATE FUNCTION trg_accounting_periods_sync_lock() RETURNS trigger AS $$
DECLARE last_end date;
BEGIN
  SELECT MAX((make_date("year", "month", 1) + interval '1 month' - interval '1 day')::date) INTO last_end FROM "accounting_periods" WHERE "status" = 'CLOSED';
  UPDATE "company_settings" SET "booksLockedThrough" = last_end WHERE "id" = 1;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "accounting_periods_sync_lock" AFTER INSERT OR UPDATE ON "accounting_periods" FOR EACH ROW EXECUTE FUNCTION trg_accounting_periods_sync_lock();
