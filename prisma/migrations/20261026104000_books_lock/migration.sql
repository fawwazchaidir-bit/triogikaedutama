-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "booksLockedThrough" DATE;

-- ═══════════ Penutupan buku (period lock) ═══════════
-- Pembayaran, entri kas, transfer, dan jurnal manual bertanggal ≤ "booksLockedThrough" ditolak — juga untuk SQL langsung.
-- Koreksi periode tertutup dilakukan lewat pembalikan yang bertanggal hari ini (selalu setelah tanggal penutupan: penutupan harus < hari ini).
-- Penutupan diubah lewat service dengan kunci EKSKLUSIF; setiap sisipan memegang kunci BERSAMA → tidak ada transaksi yang lolos di sela perubahan.

CREATE FUNCTION trg_books_lock_check() RETURNS trigger AS $$
DECLARE lock_date date; d date;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext('books_lock'));
  SELECT "booksLockedThrough" INTO lock_date FROM "company_settings" WHERE "id" = 1;
  IF lock_date IS NULL THEN RETURN NEW; END IF;
  d := (to_jsonb(NEW) ->> TG_ARGV[0])::date;
  IF d <= lock_date THEN
    RAISE EXCEPTION 'Buku sudah ditutup sampai %: transaksi bertanggal % ditolak (koreksi lewat pembalikan bertanggal hari ini)', lock_date, d USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payments_books_lock" BEFORE INSERT ON "payments" FOR EACH ROW EXECUTE FUNCTION trg_books_lock_check('paymentDate');
CREATE TRIGGER "cash_entries_books_lock" BEFORE INSERT ON "cash_entries" FOR EACH ROW EXECUTE FUNCTION trg_books_lock_check('entryDate');
CREATE TRIGGER "cash_transfers_books_lock" BEFORE INSERT ON "cash_transfers" FOR EACH ROW EXECUTE FUNCTION trg_books_lock_check('transferDate');
CREATE TRIGGER "journal_entries_books_lock" BEFORE INSERT ON "journal_entries" FOR EACH ROW EXECUTE FUNCTION trg_books_lock_check('journalDate');

-- Pengeluaran menunggu yang bertanggal di periode yang kemudian ditutup tidak dapat disetujui (tolak lalu catat ulang bertanggal baru).
CREATE FUNCTION trg_cash_entries_approve_lock() RETURNS trigger AS $$
DECLARE lock_date date;
BEGIN
  IF OLD."status" = 'PENDING' AND NEW."status" = 'APPROVED' THEN
    PERFORM pg_advisory_xact_lock_shared(hashtext('books_lock'));
    SELECT "booksLockedThrough" INTO lock_date FROM "company_settings" WHERE "id" = 1;
    IF lock_date IS NOT NULL AND NEW."entryDate" <= lock_date THEN
      RAISE EXCEPTION 'Buku sudah ditutup sampai %: pengeluaran bertanggal % tidak dapat disetujui', lock_date, NEW."entryDate" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "cash_entries_zz_approve_lock" BEFORE UPDATE ON "cash_entries" FOR EACH ROW EXECUTE FUNCTION trg_cash_entries_approve_lock();

-- Akun kas/bank baru atau perubahan saldo awal akun yang tanggal saldo awalnya sudah tertutup mengubah laporan lama.
CREATE FUNCTION trg_cash_accounts_books_lock() RETURNS trigger AS $$
DECLARE lock_date date;
BEGIN
  IF TG_OP = 'INSERT' OR NEW."openingBalance" <> OLD."openingBalance" OR NEW."openingDate" <> OLD."openingDate" THEN
    PERFORM pg_advisory_xact_lock_shared(hashtext('books_lock'));
    SELECT "booksLockedThrough" INTO lock_date FROM "company_settings" WHERE "id" = 1;
    IF lock_date IS NOT NULL AND (NEW."openingDate" <= lock_date OR (TG_OP = 'UPDATE' AND OLD."openingDate" <= lock_date)) THEN
      RAISE EXCEPTION 'Buku sudah ditutup sampai %: saldo awal akun bertanggal % tidak dapat dibuat/diubah', lock_date, NEW."openingDate" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "cash_accounts_books_lock" BEFORE INSERT OR UPDATE ON "cash_accounts" FOR EACH ROW EXECUTE FUNCTION trg_cash_accounts_books_lock();
