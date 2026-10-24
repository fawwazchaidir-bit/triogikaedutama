-- ════════════════════════════════════════════════════════════════════════════
-- Integrity guards — defense in depth di level database.
--
-- Aplikasi sudah menegakkan aturan yang sama di service layer. Migrasi ini memastikan bahwa
-- bahkan bug aplikasi, skrip ad-hoc, atau akses SQL langsung TIDAK dapat:
--   * mengubah invoice yang sudah terbit (nilai, nomor, snapshot),
--   * mengubah / menghapus baris ledger pembayaran,
--   * mengubah / menghapus audit log,
--   * menyimpan nilai keuangan yang tidak konsisten.
-- Koreksi yang sah dilakukan lewat pembatalan invoice dan pembalikan (reversal) pembayaran.
-- ════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────── CHECK constraints ───────────────────────────

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_amounts_nonneg" CHECK (
    "grossAmount" >= 0 AND "discountAmount" >= 0 AND "extraDiscountAmount" >= 0 AND "subtotalAmount" >= 0
    AND "taxBaseAmount" >= 0 AND "taxAmount" >= 0 AND "transportAmount" >= 0 AND "adminAmount" >= 0
    AND "surchargeAmount" >= 0 AND "totalAmount" >= 0 AND "downPaymentAmount" >= 0 AND "paidAmount" >= 0
  ),
  ADD CONSTRAINT "invoices_balance_consistent" CHECK (
    "paidAmount" <= "totalAmount" AND "balanceAmount" = "totalAmount" - "paidAmount"
  ),
  ADD CONSTRAINT "invoices_dp_within_total" CHECK ("downPaymentAmount" <= "totalAmount"),
  -- Identitas keuangan: nilai yang tidak konsisten tidak bisa tersimpan, apa pun jalur penulisnya.
  --   Total = Subtotal − Diskon tambahan + Pajak (yang ditambahkan) + Transport + Administrasi
  --   DP/pembayaran TIDAK ikut mengurangi Total (hanya mengurangi saldo).
  ADD CONSTRAINT "invoices_total_identity" CHECK (
    "surchargeAmount" = "transportAmount" + "adminAmount"
    AND "totalAmount" = "subtotalAmount" - "extraDiscountAmount" + "taxAmount" + "surchargeAmount"
    AND "grossAmount" - "discountAmount" = "subtotalAmount" - "extraDiscountAmount"
  ),
  ADD CONSTRAINT "invoices_number_by_status" CHECK (
    ("status" = 'DRAFT' AND "number" IS NULL) OR ("status" <> 'DRAFT' AND "number" IS NOT NULL)
  ),
  ADD CONSTRAINT "invoices_cancel_info" CHECK (
    "status" <> 'CANCELLED' OR ("cancelledAt" IS NOT NULL AND "cancelReason" IS NOT NULL AND length(btrim("cancelReason")) > 0)
  ),
  ADD CONSTRAINT "invoices_issue_info" CHECK (
    "status" = 'DRAFT' OR ("issuedAt" IS NOT NULL AND "issuedById" IS NOT NULL)
  ),
  ADD CONSTRAINT "invoices_term_nonneg" CHECK ("paymentTermDays" >= 0 AND "dueDate" >= "invoiceDate"),
  ADD CONSTRAINT "invoices_version_pos" CHECK ("version" >= 1);

ALTER TABLE "invoice_items"
  ADD CONSTRAINT "invoice_items_values" CHECK (
    "lineNo" >= 1 AND "quantity" > 0 AND "unitPrice" >= 0 AND "grossAmount" >= 0
    AND "discountAmount" >= 0 AND "discountAmount" <= "grossAmount"
    AND "netAmount" = "grossAmount" - "discountAmount"
  );

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_entry_shape" CHECK (
    ("entryType" = 'PAYMENT'  AND "amount" > 0 AND "reversesPaymentId" IS NULL)
    OR
    ("entryType" = 'REVERSAL' AND "amount" < 0 AND "reversesPaymentId" IS NOT NULL
       AND "reason" IS NOT NULL AND length(btrim("reason")) > 0)
  );

ALTER TABLE "company_settings"
  ADD CONSTRAINT "company_settings_singleton" CHECK ("id" = 1),
  ADD CONSTRAINT "company_settings_values" CHECK ("defaultPaymentTermDays" >= 0 AND "invoiceNumberStart" >= 1);

ALTER TABLE "tax_configurations"
  ADD CONSTRAINT "tax_configurations_values" CHECK (
    "rateBps" >= 0 AND "rateBps" <= 10000 AND "dppNumerator" > 0 AND "dppDenominator" > 0
  );

ALTER TABLE "products" ADD CONSTRAINT "products_price_nonneg" CHECK ("defaultPrice" >= 0);
ALTER TABLE "invoice_number_sequences" ADD CONSTRAINT "invoice_number_sequences_pos" CHECK ("nextValue" >= 1);

-- Hanya satu rekening bank default.
CREATE UNIQUE INDEX "bank_accounts_single_default" ON "bank_accounts" ("isDefault") WHERE "isDefault" = true;

-- ─────────────────────────── Append-only: audit_logs, payments, stored_files ───────────────────────────

CREATE FUNCTION trg_forbid_update_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% bersifat append-only: % dilarang (gunakan pembalikan/koreksi baru)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_logs_append_only" BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_update_delete();
CREATE TRIGGER "payments_append_only" BEFORE UPDATE OR DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_update_delete();
CREATE TRIGGER "stored_files_append_only" BEFORE UPDATE OR DELETE ON "stored_files"
  FOR EACH ROW EXECUTE FUNCTION trg_forbid_update_delete();

-- Pembalikan harus konsisten dengan pembayaran asalnya: invoice sama, nominal berlawanan tanda persis.
CREATE FUNCTION trg_payments_reversal_check() RETURNS trigger AS $$
DECLARE orig RECORD;
BEGIN
  IF NEW."entryType" = 'REVERSAL' THEN
    SELECT "invoiceId", "amount", "entryType" INTO orig FROM "payments" WHERE "id" = NEW."reversesPaymentId";
    IF NOT FOUND OR orig."entryType" <> 'PAYMENT' THEN
      RAISE EXCEPTION 'Pembalikan harus merujuk pembayaran (PAYMENT) yang ada';
    END IF;
    IF orig."invoiceId" <> NEW."invoiceId" THEN
      RAISE EXCEPTION 'Pembalikan harus berada pada invoice yang sama dengan pembayaran asal';
    END IF;
    IF NEW."amount" <> -orig."amount" THEN
      RAISE EXCEPTION 'Nominal pembalikan harus sama persis dengan pembayaran asal (berlawanan tanda)';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "payments_reversal_check" BEFORE INSERT ON "payments"
  FOR EACH ROW EXECUTE FUNCTION trg_payments_reversal_check();

-- ─────────────────────────── Imutabilitas invoice ───────────────────────────

CREATE FUNCTION trg_invoices_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Invoice % berstatus % dan tidak boleh dihapus (batalkan, jangan hapus)', OLD."number", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD."status" = 'DRAFT' THEN
    IF NEW."status" = 'CANCELLED' THEN
      RAISE EXCEPTION 'Draft tidak dapat dibatalkan; hapus draft atau terbitkan terlebih dahulu'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW; -- draft bebas diedit; DRAFT→ISSUED diperiksa oleh CHECK constraint
  END IF;

  -- Mulai di sini invoice sudah ISSUED atau CANCELLED.
  IF NEW."status" = 'DRAFT' THEN
    RAISE EXCEPTION 'Invoice terbit tidak dapat dikembalikan menjadi draft' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'CANCELLED' AND NEW."status" <> 'CANCELLED' THEN
    RAISE EXCEPTION 'Invoice batal tidak dapat diaktifkan kembali (buat invoice baru)' USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW."number"               IS DISTINCT FROM OLD."number"
  OR NEW."numberScope"          IS DISTINCT FROM OLD."numberScope"
  OR NEW."numberSeq"            IS DISTINCT FROM OLD."numberSeq"
  OR NEW."invoiceDate"          IS DISTINCT FROM OLD."invoiceDate"
  OR NEW."paymentMethod"        IS DISTINCT FROM OLD."paymentMethod"
  OR NEW."paymentTermDays"      IS DISTINCT FROM OLD."paymentTermDays"
  OR NEW."dueDateBasis"         IS DISTINCT FROM OLD."dueDateBasis"
  OR NEW."dueDate"              IS DISTINCT FROM OLD."dueDate"
  OR NEW."reference"            IS DISTINCT FROM OLD."reference"
  OR NEW."remark"               IS DISTINCT FROM OLD."remark"
  OR NEW."customerId"           IS DISTINCT FROM OLD."customerId"
  OR NEW."customerNameSnapshot" IS DISTINCT FROM OLD."customerNameSnapshot"
  OR NEW."customerSnapshot"     IS DISTINCT FROM OLD."customerSnapshot"
  OR NEW."bankAccountId"        IS DISTINCT FROM OLD."bankAccountId"
  OR NEW."bankLabel"            IS DISTINCT FROM OLD."bankLabel"
  OR NEW."bankAccountNumber"    IS DISTINCT FROM OLD."bankAccountNumber"
  OR NEW."bankAccountName"      IS DISTINCT FROM OLD."bankAccountName"
  OR NEW."grossAmount"          IS DISTINCT FROM OLD."grossAmount"
  OR NEW."discountAmount"       IS DISTINCT FROM OLD."discountAmount"
  OR NEW."extraDiscountAmount"  IS DISTINCT FROM OLD."extraDiscountAmount"
  OR NEW."subtotalAmount"       IS DISTINCT FROM OLD."subtotalAmount"
  OR NEW."taxBaseAmount"        IS DISTINCT FROM OLD."taxBaseAmount"
  OR NEW."taxAmount"            IS DISTINCT FROM OLD."taxAmount"
  OR NEW."transportAmount"      IS DISTINCT FROM OLD."transportAmount"
  OR NEW."adminAmount"          IS DISTINCT FROM OLD."adminAmount"
  OR NEW."surchargeAmount"      IS DISTINCT FROM OLD."surchargeAmount"
  OR NEW."totalAmount"          IS DISTINCT FROM OLD."totalAmount"
  OR NEW."downPaymentAmount"    IS DISTINCT FROM OLD."downPaymentAmount"
  OR NEW."taxSnapshot"          IS DISTINCT FROM OLD."taxSnapshot"
  OR NEW."companySnapshot"      IS DISTINCT FROM OLD."companySnapshot"
  OR NEW."displaySnapshot"      IS DISTINCT FROM OLD."displaySnapshot"
  OR NEW."issuedAt"             IS DISTINCT FROM OLD."issuedAt"
  OR NEW."issuedById"           IS DISTINCT FROM OLD."issuedById"
  OR NEW."replacesInvoiceId"    IS DISTINCT FROM OLD."replacesInvoiceId"
  OR NEW."duplicatedFromId"     IS DISTINCT FROM OLD."duplicatedFromId"
  OR NEW."createdById"          IS DISTINCT FROM OLD."createdById"
  OR NEW."createdAt"            IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Invoice % sudah terbit: isi/nilai/snapshot tidak boleh diubah (gunakan pembatalan dan terbitkan ulang)', OLD."number"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD."status" = 'CANCELLED' AND (
       NEW."paidAmount" IS DISTINCT FROM OLD."paidAmount"
    OR NEW."balanceAmount" IS DISTINCT FROM OLD."balanceAmount"
    OR NEW."paymentStatus" IS DISTINCT FROM OLD."paymentStatus"
    OR NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt"
    OR NEW."cancelledById" IS DISTINCT FROM OLD."cancelledById"
    OR NEW."cancelReason" IS DISTINCT FROM OLD."cancelReason"
  ) THEN
    RAISE EXCEPTION 'Invoice % sudah dibatalkan dan tidak boleh diubah lagi', OLD."number"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "invoices_guard" BEFORE UPDATE OR DELETE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION trg_invoices_guard();

-- Item hanya boleh dimutasi selama invoice induknya DRAFT.
CREATE FUNCTION trg_invoice_items_guard() RETURNS trigger AS $$
DECLARE
  parent_status "InvoiceStatus";
  old_status "InvoiceStatus";
BEGIN
  IF TG_OP <> 'DELETE' THEN
    SELECT "status" INTO parent_status FROM "invoices" WHERE "id" = NEW."invoiceId";
    IF parent_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'Rincian invoice hanya dapat diubah saat invoice berstatus DRAFT'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    SELECT "status" INTO old_status FROM "invoices" WHERE "id" = OLD."invoiceId";
    IF old_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'Rincian invoice hanya dapat diubah saat invoice berstatus DRAFT'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "invoice_items_guard" BEFORE INSERT OR UPDATE OR DELETE ON "invoice_items"
  FOR EACH ROW EXECUTE FUNCTION trg_invoice_items_guard();
