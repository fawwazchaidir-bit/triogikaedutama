-- CreateEnum
CREATE TYPE "BankStatementStatus" AS ENUM ('DRAFT', 'FINALIZED');

-- CreateEnum
CREATE TYPE "BankMatchSource" AS ENUM ('PAYMENT', 'CASH_ENTRY', 'TRANSFER');

-- CreateEnum
CREATE TYPE "BankMatchMethod" AS ENUM ('AUTO', 'MANUAL');

-- CreateTable
CREATE TABLE "bank_statements" (
    "id" UUID NOT NULL,
    "cashAccountId" UUID NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "openingBalance" BIGINT NOT NULL,
    "closingBalance" BIGINT NOT NULL,
    "label" TEXT,
    "note" TEXT,
    "status" "BankStatementStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt" TIMESTAMP(3),
    "finalizedById" UUID,
    "reopenReason" TEXT,

    CONSTRAINT "bank_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_lines" (
    "id" UUID NOT NULL,
    "statementId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "txDate" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "amount" BIGINT NOT NULL,

    CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_matches" (
    "id" UUID NOT NULL,
    "statementId" UUID NOT NULL,
    "lineId" UUID NOT NULL,
    "cashAccountId" UUID NOT NULL,
    "sourceType" "BankMatchSource" NOT NULL,
    "sourceId" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "method" "BankMatchMethod" NOT NULL,
    "matchedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_matches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bank_statements_cashAccountId_periodEnd_idx" ON "bank_statements"("cashAccountId", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_statementId_lineNo_key" ON "bank_statement_lines"("statementId", "lineNo");

-- CreateIndex
CREATE INDEX "bank_matches_lineId_idx" ON "bank_matches"("lineId");

-- CreateIndex
CREATE INDEX "bank_matches_statementId_idx" ON "bank_matches"("statementId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_matches_cashAccountId_sourceType_sourceId_key" ON "bank_matches"("cashAccountId", "sourceType", "sourceId");

-- AddForeignKey
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "cash_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_finalizedById_fkey" FOREIGN KEY ("finalizedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "bank_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_matches" ADD CONSTRAINT "bank_matches_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "bank_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_matches" ADD CONSTRAINT "bank_matches_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "bank_statement_lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_matches" ADD CONSTRAINT "bank_matches_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "cash_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_matches" ADD CONSTRAINT "bank_matches_matchedById_fkey" FOREIGN KEY ("matchedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════ Integritas rekonsiliasi bank ═══════════
-- Rekening koran (DRAFT → FINALIZED), baris mutasi, dan pencocokan dengan transaksi buku. Setelah FINALIZED tidak ada yang dapat diubah
-- (kecuali dibuka kembali dengan alasan, hanya untuk rekening koran terakhir pada akun itu). Berlaku juga untuk SQL langsung.

ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_values" CHECK (
  "periodEnd" >= "periodStart"
  AND abs("openingBalance") <= 1000000000000000 AND abs("closingBalance") <= 1000000000000000
  AND (("status" = 'FINALIZED' AND "finalizedAt" IS NOT NULL AND "finalizedById" IS NOT NULL) OR ("status" = 'DRAFT' AND "finalizedAt" IS NULL AND "finalizedById" IS NULL))
);
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_values" CHECK (
  "lineNo" >= 1 AND "amount" <> 0 AND abs("amount") <= 10000000000000 AND length(btrim("description")) > 0
);
ALTER TABLE "bank_matches" ADD CONSTRAINT "bank_matches_values" CHECK ("amount" <> 0 AND abs("amount") <= 10000000000000);

-- Rekening koran baru: akun ada, periode tidak mendahului saldo awal akun dan tidak melewati hari ini, tidak tumpang tindih, saldo awal
-- menyambung dengan saldo akhir rekening koran tepat sebelumnya (bila periodenya bersambung).
CREATE FUNCTION trg_bank_statements_insert() RETURNS trigger AS $$
DECLARE acct RECORD; prev RECORD;
BEGIN
  SELECT "openingDate", "isActive" INTO acct FROM "cash_accounts" WHERE "id" = NEW."cashAccountId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Akun kas/bank tidak ditemukan' USING ERRCODE = 'foreign_key_violation'; END IF;
  IF NEW."status" <> 'DRAFT' THEN RAISE EXCEPTION 'Rekening koran baru harus berstatus DRAFT' USING ERRCODE = 'check_violation'; END IF;
  IF NEW."periodStart" < acct."openingDate" THEN
    RAISE EXCEPTION 'Periode (%) mendahului tanggal saldo awal akun (%)', NEW."periodStart", acct."openingDate" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."periodEnd" > CURRENT_DATE + 1 THEN RAISE EXCEPTION 'Periode rekening koran tidak boleh di masa depan' USING ERRCODE = 'check_violation'; END IF;
  IF EXISTS (SELECT 1 FROM "bank_statements" WHERE "cashAccountId" = NEW."cashAccountId" AND "periodStart" <= NEW."periodEnd" AND "periodEnd" >= NEW."periodStart") THEN
    RAISE EXCEPTION 'Periode tumpang tindih dengan rekening koran lain pada akun ini' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "closingBalance" INTO prev FROM "bank_statements" WHERE "cashAccountId" = NEW."cashAccountId" AND "periodEnd" = NEW."periodStart" - 1;
  IF FOUND AND prev."closingBalance" <> NEW."openingBalance" THEN
    RAISE EXCEPTION 'Saldo awal (%) harus sama dengan saldo akhir rekening koran sebelumnya (%)', NEW."openingBalance", prev."closingBalance" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "bank_statements_insert" BEFORE INSERT ON "bank_statements" FOR EACH ROW EXECUTE FUNCTION trg_bank_statements_insert();

CREATE FUNCTION trg_bank_statements_guard() RETURNS trigger AS $$
DECLARE sum_lines numeric; bad_lines int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN RAISE EXCEPTION 'Rekening koran yang sudah difinalisasi tidak dapat dihapus (buka kembali dulu)' USING ERRCODE = 'restrict_violation'; END IF;
    RETURN OLD;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."cashAccountId" <> OLD."cashAccountId" OR NEW."periodStart" <> OLD."periodStart" OR NEW."periodEnd" <> OLD."periodEnd"
     OR NEW."createdById" <> OLD."createdById" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'Akun dan periode rekening koran tidak dapat diubah' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'FINALIZED' THEN
    -- Satu-satunya perubahan yang diizinkan: dibuka kembali (alasan wajib), hanya bila belum ada rekening koran berikutnya yang difinalisasi.
    IF NEW."status" = 'DRAFT' AND NEW."reopenReason" IS NOT NULL AND length(btrim(NEW."reopenReason")) >= 5
       AND NEW."openingBalance" = OLD."openingBalance" AND NEW."closingBalance" = OLD."closingBalance"
       AND NEW."label" IS NOT DISTINCT FROM OLD."label" AND NEW."note" IS NOT DISTINCT FROM OLD."note" THEN
      IF EXISTS (SELECT 1 FROM "bank_statements" WHERE "cashAccountId" = OLD."cashAccountId" AND "status" = 'FINALIZED' AND "periodStart" > OLD."periodEnd") THEN
        RAISE EXCEPTION 'Sudah ada rekening koran berikutnya yang difinalisasi: buka kembali yang terakhir lebih dulu' USING ERRCODE = 'restrict_violation';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Rekening koran yang sudah difinalisasi tidak dapat diubah' USING ERRCODE = 'restrict_violation';
  END IF;
  -- DRAFT
  IF NEW."status" = 'FINALIZED' THEN
    IF NEW."openingBalance" <> OLD."openingBalance" OR NEW."closingBalance" <> OLD."closingBalance" OR NEW."label" IS DISTINCT FROM OLD."label" OR NEW."note" IS DISTINCT FROM OLD."note" THEN
      RAISE EXCEPTION 'Finalisasi tidak boleh sekaligus mengubah isi rekening koran' USING ERRCODE = 'restrict_violation';
    END IF;
    SELECT COALESCE(SUM("amount"), 0) INTO sum_lines FROM "bank_statement_lines" WHERE "statementId" = OLD."id";
    IF sum_lines <> NEW."closingBalance" - NEW."openingBalance" THEN
      RAISE EXCEPTION 'Mutasi (%) tidak sama dengan selisih saldo akhir − saldo awal (%)', sum_lines, NEW."closingBalance" - NEW."openingBalance" USING ERRCODE = 'check_violation';
    END IF;
    SELECT COUNT(*) INTO bad_lines FROM "bank_statement_lines" l
     WHERE l."statementId" = OLD."id" AND l."amount" <> COALESCE((SELECT SUM(m."amount") FROM "bank_matches" m WHERE m."lineId" = l."id"), 0);
    IF bad_lines > 0 THEN
      RAISE EXCEPTION '% baris mutasi belum dicocokkan penuh dengan transaksi buku', bad_lines USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "bank_statements_guard" BEFORE UPDATE OR DELETE ON "bank_statements" FOR EACH ROW EXECUTE FUNCTION trg_bank_statements_guard();

-- Baris mutasi: hanya selagi rekening koran DRAFT, tanggal di dalam periode, tidak pernah di-UPDATE.
CREATE FUNCTION trg_bank_lines_guard() RETURNS trigger AS $$
DECLARE st RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Baris mutasi tidak dapat diubah (hapus rekening koran DRAFT lalu impor ulang)' USING ERRCODE = 'restrict_violation'; END IF;
  SELECT "status", "periodStart", "periodEnd" INTO st FROM "bank_statements" WHERE "id" = COALESCE(NEW."statementId", OLD."statementId");
  IF NOT FOUND THEN RETURN COALESCE(NEW, OLD); END IF; -- hapus berantai dari rekening koran DRAFT yang sedang dihapus
  IF st."status" <> 'DRAFT' THEN RAISE EXCEPTION 'Rekening koran sudah difinalisasi: baris mutasi tidak dapat ditambah/dihapus' USING ERRCODE = 'restrict_violation'; END IF;
  IF TG_OP = 'INSERT' AND (NEW."txDate" < st."periodStart" OR NEW."txDate" > st."periodEnd") THEN
    RAISE EXCEPTION 'Tanggal mutasi (%) di luar periode rekening koran (% s.d. %)', NEW."txDate", st."periodStart", st."periodEnd" USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "bank_lines_guard" BEFORE INSERT OR UPDATE OR DELETE ON "bank_statement_lines" FOR EACH ROW EXECUTE FUNCTION trg_bank_lines_guard();

-- Pencocokan: transaksi sumber harus ada, milik akun yang sama, bernilai SAMA PERSIS (bertanda), sudah berlaku (entri kas APPROVED),
-- bertanggal antara saldo awal akun dan akhir periode. Hanya selagi DRAFT; tidak pernah di-UPDATE.
CREATE FUNCTION trg_bank_matches_guard() RETURNS trigger AS $$
DECLARE st RECORD; ln RECORD; acct RECORD; src_amount numeric; src_date date; p RECORD; e RECORD; t RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Pencocokan tidak dapat diubah (hapus lalu buat ulang)' USING ERRCODE = 'restrict_violation'; END IF;
  SELECT "status", "periodEnd", "cashAccountId" INTO st FROM "bank_statements" WHERE "id" = COALESCE(NEW."statementId", OLD."statementId");
  IF NOT FOUND THEN RETURN COALESCE(NEW, OLD); END IF; -- hapus berantai
  IF st."status" <> 'DRAFT' THEN RAISE EXCEPTION 'Rekening koran sudah difinalisasi: pencocokan tidak dapat ditambah/dihapus' USING ERRCODE = 'restrict_violation'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;

  SELECT "statementId" INTO ln FROM "bank_statement_lines" WHERE "id" = NEW."lineId";
  IF NOT FOUND OR ln."statementId" <> NEW."statementId" THEN RAISE EXCEPTION 'Baris mutasi bukan milik rekening koran ini' USING ERRCODE = 'check_violation'; END IF;
  IF st."cashAccountId" <> NEW."cashAccountId" THEN RAISE EXCEPTION 'Akun pencocokan harus sama dengan akun rekening koran' USING ERRCODE = 'check_violation'; END IF;
  SELECT "openingDate" INTO acct FROM "cash_accounts" WHERE "id" = NEW."cashAccountId";

  IF NEW."sourceType" = 'PAYMENT' THEN
    SELECT "cashAccountId", "amount", "paymentDate" INTO p FROM "payments" WHERE "id" = NEW."sourceId";
    IF NOT FOUND OR p."cashAccountId" IS DISTINCT FROM NEW."cashAccountId" THEN RAISE EXCEPTION 'Pembayaran tidak ditemukan pada akun ini' USING ERRCODE = 'check_violation'; END IF;
    src_amount := p."amount"; src_date := p."paymentDate";
  ELSIF NEW."sourceType" = 'CASH_ENTRY' THEN
    SELECT "cashAccountId", "amount", "direction", "status", "entryDate" INTO e FROM "cash_entries" WHERE "id" = NEW."sourceId";
    IF NOT FOUND OR e."cashAccountId" <> NEW."cashAccountId" THEN RAISE EXCEPTION 'Entri kas tidak ditemukan pada akun ini' USING ERRCODE = 'check_violation'; END IF;
    IF e."status" <> 'APPROVED' THEN RAISE EXCEPTION 'Hanya entri kas yang sudah disetujui yang dapat dicocokkan' USING ERRCODE = 'check_violation'; END IF;
    src_amount := CASE WHEN e."direction" = 'IN' THEN e."amount" ELSE -e."amount" END; src_date := e."entryDate";
  ELSE
    SELECT "fromAccountId", "toAccountId", "amount", "transferDate" INTO t FROM "cash_transfers" WHERE "id" = NEW."sourceId";
    IF NOT FOUND THEN RAISE EXCEPTION 'Transfer tidak ditemukan' USING ERRCODE = 'check_violation'; END IF;
    IF t."toAccountId" = NEW."cashAccountId" THEN src_amount := t."amount";
    ELSIF t."fromAccountId" = NEW."cashAccountId" THEN src_amount := -t."amount";
    ELSE RAISE EXCEPTION 'Transfer tidak melibatkan akun ini' USING ERRCODE = 'check_violation'; END IF;
    src_date := t."transferDate";
  END IF;
  IF NEW."amount" <> src_amount THEN RAISE EXCEPTION 'Nilai pencocokan (%) harus sama persis dengan transaksi buku (%)', NEW."amount", src_amount USING ERRCODE = 'check_violation'; END IF;
  IF src_date < acct."openingDate" THEN RAISE EXCEPTION 'Transaksi mendahului tanggal saldo awal akun dan tidak masuk saldo' USING ERRCODE = 'check_violation'; END IF;
  IF src_date > st."periodEnd" THEN RAISE EXCEPTION 'Transaksi bertanggal setelah akhir periode rekening koran' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "bank_matches_guard" BEFORE INSERT OR UPDATE OR DELETE ON "bank_matches" FOR EACH ROW EXECUTE FUNCTION trg_bank_matches_guard();

-- Akun kas yang sudah punya rekening koran: tanggal saldo awal terkunci; saldo awal tidak boleh diubah bila ada rekening koran yang difinalisasi.
CREATE FUNCTION trg_cash_accounts_bank_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."openingDate" <> OLD."openingDate" AND EXISTS (SELECT 1 FROM "bank_statements" WHERE "cashAccountId" = OLD."id") THEN
    RAISE EXCEPTION 'Akun sudah memiliki rekening koran: tanggal saldo awal tidak dapat diubah' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."openingBalance" <> OLD."openingBalance" AND EXISTS (SELECT 1 FROM "bank_statements" WHERE "cashAccountId" = OLD."id" AND "status" = 'FINALIZED') THEN
    RAISE EXCEPTION 'Akun memiliki rekening koran yang sudah difinalisasi: saldo awal tidak dapat diubah (buka kembali rekonsiliasi lebih dulu)' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "cash_accounts_zz_bank_guard" BEFORE UPDATE ON "cash_accounts" FOR EACH ROW EXECUTE FUNCTION trg_cash_accounts_bank_guard();
