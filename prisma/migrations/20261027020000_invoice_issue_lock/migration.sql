-- Invoice bertanggal di periode yang sudah ditutup tidak boleh diterbitkan (akan mengubah rekap PPN menurut invoice periode itu).
CREATE FUNCTION trg_invoices_issue_lock() RETURNS trigger AS $$
DECLARE lock_date date;
BEGIN
  IF NEW."status" = 'ISSUED' AND OLD."status" IN ('DRAFT', 'SUBMITTED') THEN
    PERFORM pg_advisory_xact_lock_shared(hashtext('books_lock'));
    SELECT "booksLockedThrough" INTO lock_date FROM "company_settings" WHERE "id" = 1;
    IF lock_date IS NOT NULL AND NEW."invoiceDate" <= lock_date THEN
      RAISE EXCEPTION 'Buku sudah ditutup sampai %: invoice bertanggal % tidak dapat diterbitkan', lock_date, NEW."invoiceDate" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "invoices_zz_issue_lock" BEFORE UPDATE ON "invoices" FOR EACH ROW EXECUTE FUNCTION trg_invoices_issue_lock();
