-- ═══════════ Integritas modul keuangan (basis kas) ═══════════
-- Berlaku juga untuk SQL langsung: entri disetujui/transfer/pembayaran tidak dapat diubah, koreksi hanya lewat pembalikan.

-- ─────────────────────────── Bagan akun ───────────────────────────
ALTER TABLE "coa_accounts"
  ADD CONSTRAINT "coa_code_format" CHECK ("code" ~ '^[0-9]-[0-9]{4}$'),
  ADD CONSTRAINT "coa_name_nonblank" CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "coa_system_not_manual" CHECK (NOT ("isSystem" AND "manualEntry"));

CREATE FUNCTION trg_coa_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Akun % tidak boleh dihapus (nonaktifkan saja)', OLD."code" USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."code" <> OLD."code" OR NEW."type" <> OLD."type" OR NEW."section" <> OLD."section") THEN
    IF OLD."isSystem" THEN
      RAISE EXCEPTION 'Akun sistem % tidak boleh diubah kode/jenisnya', OLD."code" USING ERRCODE = 'restrict_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "cash_entries" WHERE "counterAccountId" = OLD."id")
       OR EXISTS (SELECT 1 FROM "cash_accounts" WHERE "coaAccountId" = OLD."id") THEN
      RAISE EXCEPTION 'Akun % sudah dipakai transaksi: kode/jenis tidak boleh diubah', OLD."code" USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW."isSystem" <> OLD."isSystem" THEN
    RAISE EXCEPTION 'Penanda akun sistem tidak boleh diubah' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "coa_guard" BEFORE UPDATE OR DELETE ON "coa_accounts"
  FOR EACH ROW EXECUTE FUNCTION trg_coa_guard();

-- ─────────────────────────── Akun kas / bank ───────────────────────────
ALTER TABLE "cash_accounts"
  ADD CONSTRAINT "cash_accounts_opening_nonneg" CHECK ("openingBalance" >= 0),
  ADD CONSTRAINT "cash_accounts_default_active" CHECK (NOT "isDefault" OR "isActive");
CREATE UNIQUE INDEX "cash_accounts_one_default_per_kind" ON "cash_accounts" ("kind") WHERE "isDefault";

CREATE FUNCTION trg_cash_accounts_guard() RETURNS trigger AS $$
DECLARE coa_type "CoaType";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Akun kas/bank tidak boleh dihapus (nonaktifkan saja)' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT "type" INTO coa_type FROM "coa_accounts" WHERE "id" = NEW."coaAccountId";
  IF coa_type IS DISTINCT FROM 'ASET' THEN
    RAISE EXCEPTION 'Akun kas/bank harus dipetakan ke akun bagan akun berjenis ASET' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."openingDate" <> OLD."openingDate" OR NEW."kind" <> OLD."kind" OR NEW."coaAccountId" <> OLD."coaAccountId" THEN
      IF EXISTS (SELECT 1 FROM "payments" WHERE "cashAccountId" = OLD."id")
         OR EXISTS (SELECT 1 FROM "cash_entries" WHERE "cashAccountId" = OLD."id")
         OR EXISTS (SELECT 1 FROM "cash_transfers" WHERE "fromAccountId" = OLD."id" OR "toAccountId" = OLD."id") THEN
        RAISE EXCEPTION 'Akun sudah memiliki mutasi: tanggal saldo awal, jenis, dan akun bagan tidak boleh diubah' USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "cash_accounts_guard" BEFORE INSERT OR UPDATE OR DELETE ON "cash_accounts"
  FOR EACH ROW EXECUTE FUNCTION trg_cash_accounts_guard();

-- ─────────────────────────── Entri kas ───────────────────────────
ALTER TABLE "cash_entries"
  ADD CONSTRAINT "cash_entries_amount_pos" CHECK ("amount" > 0),
  ADD CONSTRAINT "cash_entries_desc_nonblank" CHECK (length(btrim("description")) > 0),
  ADD CONSTRAINT "cash_entries_shape" CHECK (
    ("entryType" = 'ENTRY' AND "reversesEntryId" IS NULL AND "reason" IS NULL)
    OR ("entryType" = 'REVERSAL' AND "reversesEntryId" IS NOT NULL AND "reason" IS NOT NULL AND "status" = 'APPROVED')
  ),
  ADD CONSTRAINT "cash_entries_status_shape" CHECK (
    ("status" = 'PENDING' AND "approvedById" IS NULL AND "approvedAt" IS NULL AND "rejectedById" IS NULL AND "rejectedAt" IS NULL AND "rejectionReason" IS NULL)
    OR ("status" = 'APPROVED' AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "rejectedById" IS NULL AND "rejectedAt" IS NULL AND "rejectionReason" IS NULL)
    OR ("status" = 'REJECTED' AND "rejectedById" IS NOT NULL AND "rejectedAt" IS NOT NULL AND "rejectionReason" IS NOT NULL AND "approvedById" IS NULL AND "approvedAt" IS NULL)
  );

-- Saat INSERT: akun kas aktif & tanggal ≥ tanggal saldo awal; akun lawan sesuai arah; pembalikan konsisten dengan entri asal.
CREATE FUNCTION trg_cash_entries_insert_check() RETURNS trigger AS $$
DECLARE acct RECORD; ctr RECORD; orig RECORD;
BEGIN
  SELECT "isActive", "openingDate" INTO acct FROM "cash_accounts" WHERE "id" = NEW."cashAccountId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Akun kas/bank tidak ditemukan'; END IF;
  IF NEW."entryDate" < acct."openingDate" THEN
    RAISE EXCEPTION 'Tanggal entri (%) mendahului tanggal saldo awal akun (%)', NEW."entryDate", acct."openingDate" USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."entryType" = 'ENTRY' THEN
    IF NOT acct."isActive" THEN RAISE EXCEPTION 'Akun kas/bank tidak aktif' USING ERRCODE = 'check_violation'; END IF;
    SELECT "type", "isActive", "manualEntry" INTO ctr FROM "coa_accounts" WHERE "id" = NEW."counterAccountId";
    IF NOT FOUND OR NOT ctr."isActive" OR NOT ctr."manualEntry" THEN
      RAISE EXCEPTION 'Akun lawan tidak aktif atau tidak boleh dipakai pada entri kas manual' USING ERRCODE = 'check_violation';
    END IF;
    IF ctr."type" = 'BEBAN' AND NEW."direction" <> 'OUT' THEN
      RAISE EXCEPTION 'Beban hanya dapat berupa pengeluaran (OUT); koreksi lewat pembalikan' USING ERRCODE = 'check_violation';
    END IF;
    IF ctr."type" = 'PENDAPATAN' AND NEW."direction" <> 'IN' THEN
      RAISE EXCEPTION 'Pendapatan hanya dapat berupa penerimaan (IN); koreksi lewat pembalikan' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT * INTO orig FROM "cash_entries" WHERE "id" = NEW."reversesEntryId";
    IF NOT FOUND OR orig."entryType" <> 'ENTRY' OR orig."status" <> 'APPROVED' THEN
      RAISE EXCEPTION 'Pembalikan harus merujuk entri ENTRY yang sudah disetujui' USING ERRCODE = 'check_violation';
    END IF;
    IF orig."cashAccountId" <> NEW."cashAccountId" OR orig."counterAccountId" <> NEW."counterAccountId" OR orig."amount" <> NEW."amount" THEN
      RAISE EXCEPTION 'Pembalikan harus memakai akun & nominal yang sama persis dengan entri asal' USING ERRCODE = 'check_violation';
    END IF;
    IF orig."direction" = NEW."direction" THEN
      RAISE EXCEPTION 'Arah pembalikan harus berlawanan dengan entri asal' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "cash_entries_insert_check" BEFORE INSERT ON "cash_entries"
  FOR EACH ROW EXECUTE FUNCTION trg_cash_entries_insert_check();

-- Setelah itu: hanya PENDING yang boleh berubah (→ APPROVED/REJECTED) atau dihapus; kolom isi tidak boleh berubah sama sekali.
CREATE FUNCTION trg_cash_entries_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'PENDING' OR OLD."entryType" <> 'ENTRY' THEN
      RAISE EXCEPTION 'Entri kas yang sudah diproses bersifat append-only: DELETE dilarang (gunakan pembalikan)' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'Entri kas yang sudah diproses bersifat append-only: UPDATE dilarang (gunakan pembalikan)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = 'PENDING' THEN
    RAISE EXCEPTION 'Entri kas menunggu persetujuan tidak dapat diubah isinya; hapus lalu catat ulang' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."entryType" <> OLD."entryType" OR NEW."reversesEntryId" IS DISTINCT FROM OLD."reversesEntryId"
     OR NEW."entryDate" <> OLD."entryDate" OR NEW."direction" <> OLD."direction" OR NEW."amount" <> OLD."amount"
     OR NEW."cashAccountId" <> OLD."cashAccountId" OR NEW."counterAccountId" <> OLD."counterAccountId"
     OR NEW."description" <> OLD."description" OR NEW."payee" IS DISTINCT FROM OLD."payee" OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."proofFileId" IS DISTINCT FROM OLD."proofFileId" OR NEW."createdById" <> OLD."createdById" OR NEW."createdAt" <> OLD."createdAt"
     OR NEW."reason" IS DISTINCT FROM OLD."reason" THEN
    RAISE EXCEPTION 'Isi entri kas tidak boleh diubah; hanya keputusan persetujuan yang dicatat' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "cash_entries_guard" BEFORE UPDATE OR DELETE ON "cash_entries"
  FOR EACH ROW EXECUTE FUNCTION trg_cash_entries_guard();

-- ─────────────────────────── Transfer antar akun ───────────────────────────
ALTER TABLE "cash_transfers"
  ADD CONSTRAINT "cash_transfers_amount_pos" CHECK ("amount" > 0),
  ADD CONSTRAINT "cash_transfers_distinct" CHECK ("fromAccountId" <> "toAccountId"),
  ADD CONSTRAINT "cash_transfers_shape" CHECK (
    ("entryType" = 'ENTRY' AND "reversesTransferId" IS NULL AND "reason" IS NULL)
    OR ("entryType" = 'REVERSAL' AND "reversesTransferId" IS NOT NULL AND "reason" IS NOT NULL)
  );

CREATE FUNCTION trg_cash_transfers_insert_check() RETURNS trigger AS $$
DECLARE f RECORD; t RECORD; orig RECORD;
BEGIN
  SELECT "isActive", "openingDate" INTO f FROM "cash_accounts" WHERE "id" = NEW."fromAccountId";
  SELECT "isActive", "openingDate" INTO t FROM "cash_accounts" WHERE "id" = NEW."toAccountId";
  IF f IS NULL OR t IS NULL THEN RAISE EXCEPTION 'Akun kas/bank tidak ditemukan'; END IF;
  IF NEW."transferDate" < f."openingDate" OR NEW."transferDate" < t."openingDate" THEN
    RAISE EXCEPTION 'Tanggal transfer mendahului tanggal saldo awal salah satu akun' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."entryType" = 'ENTRY' THEN
    IF NOT f."isActive" OR NOT t."isActive" THEN RAISE EXCEPTION 'Akun kas/bank tidak aktif' USING ERRCODE = 'check_violation'; END IF;
  ELSE
    SELECT * INTO orig FROM "cash_transfers" WHERE "id" = NEW."reversesTransferId";
    IF NOT FOUND OR orig."entryType" <> 'ENTRY' THEN
      RAISE EXCEPTION 'Pembalikan harus merujuk transfer ENTRY yang ada' USING ERRCODE = 'check_violation';
    END IF;
    IF orig."fromAccountId" <> NEW."toAccountId" OR orig."toAccountId" <> NEW."fromAccountId" OR orig."amount" <> NEW."amount" THEN
      RAISE EXCEPTION 'Transfer pembalik harus menukar akun asal-tujuan dengan nominal yang sama persis' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "cash_transfers_insert_check" BEFORE INSERT ON "cash_transfers"
  FOR EACH ROW EXECUTE FUNCTION trg_cash_transfers_insert_check();
CREATE TRIGGER "cash_transfers_append_only" BEFORE UPDATE OR DELETE ON "cash_transfers"
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_update_delete();

-- ─────────────────────────── Pembayaran invoice → akun kas ───────────────────────────
-- Pembalikan harus kembali ke akun kas yang sama dengan pembayaran asal; pembayaran baru hanya ke akun aktif.
CREATE OR REPLACE FUNCTION trg_payments_reversal_check() RETURNS trigger AS $$
DECLARE orig RECORD; acct_active boolean;
BEGIN
  IF NEW."entryType" = 'REVERSAL' THEN
    SELECT "invoiceId", "amount", "entryType", "cashAccountId" INTO orig FROM "payments" WHERE "id" = NEW."reversesPaymentId";
    IF NOT FOUND OR orig."entryType" <> 'PAYMENT' THEN
      RAISE EXCEPTION 'Pembalikan harus merujuk pembayaran (PAYMENT) yang ada';
    END IF;
    IF orig."invoiceId" <> NEW."invoiceId" THEN
      RAISE EXCEPTION 'Pembalikan harus berada pada invoice yang sama dengan pembayaran asal';
    END IF;
    IF NEW."amount" <> -orig."amount" THEN
      RAISE EXCEPTION 'Nominal pembalikan harus sama persis dengan pembayaran asal (berlawanan tanda)';
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
