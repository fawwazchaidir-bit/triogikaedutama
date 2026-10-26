-- ═══════════ Integritas jurnal manual (buku besar) ═══════════
-- Jurnal dari kas (pembayaran, entri kas, transfer, saldo awal kas) diturunkan dari tabel sumbernya dan TIDAK disimpan di sini.

-- Akun sistem baru: penerimaan invoice yang belum dialokasikan ke akun kas (agar pembukuan tetap seimbang). Idempoten.
INSERT INTO "coa_accounts" ("id", "code", "name", "type", "section", "manualEntry", "isSystem", "isActive", "updatedAt")
VALUES (gen_random_uuid(), '1-1450', 'Penerimaan Invoice Belum Dialokasikan ke Kas/Bank', 'ASET', 'OPERASI', false, true, true, now())
ON CONFLICT ("code") DO NOTHING;

-- ─────────────────────────── Baris jurnal ───────────────────────────
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_nonneg" CHECK ("debit" >= 0 AND "credit" >= 0),
  ADD CONSTRAINT "journal_lines_one_side" CHECK (("debit" > 0) <> ("credit" > 0)),
  ADD CONSTRAINT "journal_lines_lineno_pos" CHECK ("lineNo" >= 1);

ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_desc_nonblank" CHECK (length(btrim("description")) > 0),
  ADD CONSTRAINT "journal_entries_shape" CHECK (
    ("entryType" = 'ENTRY' AND "reversesJournalId" IS NULL AND "reason" IS NULL)
    OR ("entryType" = 'REVERSAL' AND "reversesJournalId" IS NOT NULL AND "reason" IS NOT NULL)
  );

-- Header: tanggal tidak mendahului tanggal mulai pembukuan (saldo awal akun kas tertua); OPENING tepat pada tanggal itu;
-- pembalikan harus merujuk jurnal ENTRY yang ada dan sekali saja (unik).
CREATE FUNCTION trg_journal_entries_check() RETURNS trigger AS $$
DECLARE start_date date; orig RECORD;
BEGIN
  SELECT MIN("openingDate") INTO start_date FROM "cash_accounts";
  IF start_date IS NULL THEN
    RAISE EXCEPTION 'Belum ada akun kas/bank: tanggal mulai pembukuan belum ditetapkan' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."journalDate" < start_date THEN
    RAISE EXCEPTION 'Tanggal jurnal (%) mendahului tanggal mulai pembukuan (%)', NEW."journalDate", start_date USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."entryType" = 'ENTRY' THEN
    IF NEW."kind" = 'OPENING' AND NEW."journalDate" <> start_date THEN
      RAISE EXCEPTION 'Jurnal saldo awal harus bertanggal tepat pada tanggal mulai pembukuan (%)', start_date USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT "entryType" INTO orig FROM "journal_entries" WHERE "id" = NEW."reversesJournalId";
    IF NOT FOUND OR orig."entryType" <> 'ENTRY' THEN
      RAISE EXCEPTION 'Pembalikan harus merujuk jurnal ENTRY yang ada' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "journal_entries_check" BEFORE INSERT ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION trg_journal_entries_check();
CREATE TRIGGER "journal_entries_append_only" BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_update_delete();
CREATE TRIGGER "journal_lines_append_only" BEFORE UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_update_delete();

-- Baris: akun aktif, BUKAN akun yang dipetakan ke akun kas/bank (saldo kas hanya boleh bergerak lewat modul kas),
-- jurnal OPENING hanya akun neraca (aset/liabilitas/ekuitas); pembalikan hanya boleh menukar baris jurnal asal (dicek saat commit).
CREATE FUNCTION trg_journal_lines_check() RETURNS trigger AS $$
DECLARE acct RECORD; hdr RECORD;
BEGIN
  SELECT "type", "isActive" INTO acct FROM "coa_accounts" WHERE "id" = NEW."accountId";
  SELECT "kind", "entryType" INTO hdr FROM "journal_entries" WHERE "id" = NEW."journalId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Jurnal tidak ditemukan' USING ERRCODE = 'foreign_key_violation'; END IF;
  IF EXISTS (SELECT 1 FROM "cash_accounts" WHERE "coaAccountId" = NEW."accountId") THEN
    RAISE EXCEPTION 'Akun kas/bank tidak boleh dijurnal manual: gunakan modul kas (saldo kas diturunkan dari modul kas)' USING ERRCODE = 'check_violation';
  END IF;
  IF hdr."entryType" = 'ENTRY' THEN
    IF NOT acct."isActive" THEN RAISE EXCEPTION 'Akun jurnal tidak aktif' USING ERRCODE = 'check_violation'; END IF;
    IF hdr."kind" = 'OPENING' AND acct."type" IN ('PENDAPATAN', 'BEBAN') THEN
      RAISE EXCEPTION 'Jurnal saldo awal hanya boleh memuat akun neraca (aset, liabilitas, ekuitas)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "journal_lines_check" BEFORE INSERT ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION trg_journal_lines_check();

-- Keseimbangan: pada COMMIT setiap jurnal harus memiliki ≥ 2 baris dan Σ debit = Σ kredit (trigger konstrain tertunda).
-- Pembalikan harus PERSIS kebalikan jurnal asal (per akun: debit pembalik = kredit asal, kredit pembalik = debit asal).
CREATE FUNCTION trg_journal_balanced() RETURNS trigger AS $$
DECLARE d numeric; c numeric; n int; hdr RECORD;
BEGIN
  SELECT COALESCE(SUM("debit"), 0), COALESCE(SUM("credit"), 0), COUNT(*) INTO d, c, n FROM "journal_lines" WHERE "journalId" = NEW."journalId";
  IF n < 2 THEN
    RAISE EXCEPTION 'Jurnal harus memiliki minimal dua baris' USING ERRCODE = 'check_violation';
  END IF;
  IF d <> c THEN
    RAISE EXCEPTION 'Jurnal tidak seimbang: debit % ≠ kredit %', d, c USING ERRCODE = 'check_violation';
  END IF;
  SELECT "entryType", "reversesJournalId" INTO hdr FROM "journal_entries" WHERE "id" = NEW."journalId";
  IF hdr."entryType" = 'REVERSAL' THEN
    IF EXISTS (
      SELECT 1
        FROM (SELECT "accountId", SUM("debit") AS d, SUM("credit") AS c FROM "journal_lines" WHERE "journalId" = NEW."journalId" GROUP BY "accountId") r
        FULL JOIN (SELECT "accountId", SUM("debit") AS d, SUM("credit") AS c FROM "journal_lines" WHERE "journalId" = hdr."reversesJournalId" GROUP BY "accountId") o
          ON r."accountId" = o."accountId"
       WHERE COALESCE(r.d, 0) <> COALESCE(o.c, 0) OR COALESCE(r.c, 0) <> COALESCE(o.d, 0)
    ) THEN
      RAISE EXCEPTION 'Jurnal pembalik harus persis kebalikan jurnal asal (debit ↔ kredit per akun)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "journal_lines_balanced" AFTER INSERT ON "journal_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_journal_balanced();

-- Jurnal tanpa baris sama sekali juga ditolak (header disisipkan tanpa baris).
CREATE FUNCTION trg_journal_has_lines() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "journal_lines" WHERE "journalId" = NEW."id") THEN
    RAISE EXCEPTION 'Jurnal harus memiliki baris' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "journal_entries_has_lines" AFTER INSERT ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_journal_has_lines();

-- Akun yang dipetakan ke kas/bank tidak boleh sudah memiliki baris jurnal manual (menjaga identitas: saldo buku besar kas = Σ saldo akun kas),
-- dan tanggal saldo awal tidak boleh digeser melewati jurnal yang sudah ada.
CREATE OR REPLACE FUNCTION trg_cash_accounts_guard() RETURNS trigger AS $$
DECLARE coa_type "CoaType";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Akun kas/bank tidak boleh dihapus (nonaktifkan saja)' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT "type" INTO coa_type FROM "coa_accounts" WHERE "id" = NEW."coaAccountId";
  IF coa_type IS DISTINCT FROM 'ASET' THEN
    RAISE EXCEPTION 'Akun kas/bank harus dipetakan ke akun bagan akun berjenis ASET' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM "journal_lines" WHERE "accountId" = NEW."coaAccountId") THEN
      RAISE EXCEPTION 'Akun bagan akun ini sudah memiliki jurnal manual dan tidak dapat dipetakan ke akun kas/bank' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."coaAccountId" <> OLD."coaAccountId" THEN
      IF EXISTS (SELECT 1 FROM "journal_lines" WHERE "accountId" = NEW."coaAccountId") THEN
        RAISE EXCEPTION 'Akun bagan akun ini sudah memiliki jurnal manual dan tidak dapat dipetakan ke akun kas/bank' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW."openingDate" <> OLD."openingDate" OR NEW."kind" <> OLD."kind" OR NEW."coaAccountId" <> OLD."coaAccountId" THEN
      IF EXISTS (SELECT 1 FROM "payments" WHERE "cashAccountId" = OLD."id")
         OR EXISTS (SELECT 1 FROM "cash_entries" WHERE "cashAccountId" = OLD."id")
         OR EXISTS (SELECT 1 FROM "cash_transfers" WHERE "fromAccountId" = OLD."id" OR "toAccountId" = OLD."id") THEN
        RAISE EXCEPTION 'Akun sudah memiliki mutasi: tanggal saldo awal, jenis, dan akun bagan tidak boleh diubah' USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;
    IF NEW."openingDate" <> OLD."openingDate" AND EXISTS (SELECT 1 FROM "journal_entries") THEN
      RAISE EXCEPTION 'Sudah ada jurnal manual: tanggal mulai pembukuan tidak boleh digeser' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
