-- ═══════════ Pengerasan buku besar (temuan pengujian putaran B) ═══════════
-- 1. Akun cadangan (4-1100 pendapatan invoice, 1-1450 penampung, 3-2200 laba tahun berjalan yang DIHITUNG) tidak boleh dijurnal manual — kini juga dijaga database.
-- 2. Identitas "saldo buku besar akun kas = saldo modul kas" hanya benar bila akun bagan akun kas/bank TIDAK dipakai jalur lain:
--    a. akun kas/bank tidak boleh dipetakan ke akun yang boleh dipilih pada entri kas manual, akun sistem selain 1-1100/1-1200,
--       akun yang sudah punya jurnal manual, atau akun yang sudah menjadi akun lawan entri kas;
--    b. akun lawan entri kas tidak boleh akun kas/bank;
--    c. penanda "boleh dipilih pada entri manual" tidak boleh dinyalakan pada akun kas/bank; kode/jenis/seksi akun tidak boleh berubah
--       bila sudah punya jurnal manual (mengubah laporan secara retroaktif).
-- 3. Balapan: sisipan jurnal/entri kas memegang kunci BERSAMA, perubahan pemetaan/penanda memegang kunci EKSKLUSIF — keduanya tidak dapat lolos bersamaan.

CREATE OR REPLACE FUNCTION trg_journal_lines_check() RETURNS trigger AS $$
DECLARE acct RECORD; hdr RECORD;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext('coa_cash_mapping'));
  SELECT "code", "type", "isActive" INTO acct FROM "coa_accounts" WHERE "id" = NEW."accountId";
  SELECT "kind", "entryType" INTO hdr FROM "journal_entries" WHERE "id" = NEW."journalId";
  IF NOT FOUND THEN RAISE EXCEPTION 'Jurnal tidak ditemukan' USING ERRCODE = 'foreign_key_violation'; END IF;
  IF EXISTS (SELECT 1 FROM "cash_accounts" WHERE "coaAccountId" = NEW."accountId") THEN
    RAISE EXCEPTION 'Akun kas/bank tidak boleh dijurnal manual: gunakan modul kas (saldo kas diturunkan dari modul kas)' USING ERRCODE = 'check_violation';
  END IF;
  IF hdr."entryType" = 'ENTRY' THEN
    IF NOT acct."isActive" THEN RAISE EXCEPTION 'Akun jurnal tidak aktif' USING ERRCODE = 'check_violation'; END IF;
    IF acct."code" IN ('4-1100', '1-1450', '3-2200') THEN
      RAISE EXCEPTION 'Akun % dicadangkan (dicatat/dihitung otomatis) dan tidak boleh dijurnal manual', acct."code" USING ERRCODE = 'check_violation';
    END IF;
    IF hdr."kind" = 'OPENING' AND acct."type" IN ('PENDAPATAN', 'BEBAN') THEN
      RAISE EXCEPTION 'Jurnal saldo awal hanya boleh memuat akun neraca (aset, liabilitas, ekuitas)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_cash_accounts_guard() RETURNS trigger AS $$
DECLARE coa RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Akun kas/bank tidak boleh dihapus (nonaktifkan saja)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."coaAccountId" <> OLD."coaAccountId" THEN
    PERFORM pg_advisory_xact_lock(hashtext('coa_cash_mapping'));
    SELECT "code", "type", "isSystem", "manualEntry" INTO coa FROM "coa_accounts" WHERE "id" = NEW."coaAccountId";
    IF coa."type" IS DISTINCT FROM 'ASET' THEN
      RAISE EXCEPTION 'Akun kas/bank harus dipetakan ke akun bagan akun berjenis ASET' USING ERRCODE = 'check_violation';
    END IF;
    IF coa."manualEntry" THEN
      RAISE EXCEPTION 'Akun % dapat dipilih pada entri kas manual dan tidak boleh dipetakan ke akun kas/bank', coa."code" USING ERRCODE = 'check_violation';
    END IF;
    IF coa."isSystem" AND coa."code" NOT IN ('1-1100', '1-1200') THEN
      RAISE EXCEPTION 'Akun sistem % tidak dapat dipetakan ke akun kas/bank', coa."code" USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "journal_lines" WHERE "accountId" = NEW."coaAccountId") THEN
      RAISE EXCEPTION 'Akun bagan akun ini sudah memiliki jurnal manual dan tidak dapat dipetakan ke akun kas/bank' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "cash_entries" WHERE "counterAccountId" = NEW."coaAccountId") THEN
      RAISE EXCEPTION 'Akun bagan akun ini sudah dipakai sebagai akun lawan entri kas dan tidak dapat dipetakan ke akun kas/bank' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
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

CREATE OR REPLACE FUNCTION trg_coa_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Akun % tidak boleh dihapus (nonaktifkan saja)', OLD."code" USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."code" <> OLD."code" OR NEW."type" <> OLD."type" OR NEW."section" <> OLD."section" OR (NEW."manualEntry" AND NOT OLD."manualEntry") THEN
    PERFORM pg_advisory_xact_lock(hashtext('coa_cash_mapping'));
  END IF;
  IF (NEW."code" <> OLD."code" OR NEW."type" <> OLD."type" OR NEW."section" <> OLD."section") THEN
    IF OLD."isSystem" THEN
      RAISE EXCEPTION 'Akun sistem % tidak boleh diubah kode/jenisnya', OLD."code" USING ERRCODE = 'restrict_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM "cash_entries" WHERE "counterAccountId" = OLD."id")
       OR EXISTS (SELECT 1 FROM "cash_accounts" WHERE "coaAccountId" = OLD."id")
       OR EXISTS (SELECT 1 FROM "journal_lines" WHERE "accountId" = OLD."id") THEN
      RAISE EXCEPTION 'Akun % sudah dipakai transaksi/jurnal: kode/jenis tidak boleh diubah', OLD."code" USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW."manualEntry" AND NOT OLD."manualEntry" AND EXISTS (SELECT 1 FROM "cash_accounts" WHERE "coaAccountId" = OLD."id") THEN
    RAISE EXCEPTION 'Akun % dipetakan ke akun kas/bank dan tidak boleh dipilih pada entri kas manual', OLD."code" USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."isSystem" <> OLD."isSystem" THEN
    RAISE EXCEPTION 'Penanda akun sistem tidak boleh diubah' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Akun lawan entri kas tidak boleh akun kas/bank. (Aturan "wajib akun yang boleh dipilih pada entri manual" sudah dijaga cash_entries_guard.)
-- Nama pemicu berawalan "zz" agar berjalan SETELAH pemicu lama (pesan kesalahan lama tetap berlaku untuk akun terlarang).
CREATE FUNCTION trg_cash_entries_counter_cashmap() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext('coa_cash_mapping'));
  IF EXISTS (SELECT 1 FROM "cash_accounts" WHERE "coaAccountId" = NEW."counterAccountId") THEN
    RAISE EXCEPTION 'Akun lawan entri kas tidak boleh akun kas/bank (gunakan transfer antar akun)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "cash_entries_zz_counter_cashmap" BEFORE INSERT ON "cash_entries"
  FOR EACH ROW EXECUTE FUNCTION trg_cash_entries_counter_cashmap();
