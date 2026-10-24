-- ════════════════════════════════════════════════════════════════════════════
-- Guard untuk alur verifikasi (status SUBMITTED). Dipisah dari migrasi enum karena PostgreSQL tidak
-- mengizinkan nilai enum baru dipakai pada transaksi yang sama dengan ADD VALUE.
--
-- DRAFT ──ajukan──► SUBMITTED ──setujui──► ISSUED
--   ▲                   │
--   └──kembalikan/tarik─┘          (DRAFT ──setujui langsung (oleh penyetuju)──► ISSUED tetap diizinkan)
--
-- Selama SUBMITTED: isi/nilai TERKUNCI (staff tidak dapat mengubah setelah mengajukan — pencegah kecurangan).
-- Saat SUBMITTED → ISSUED: nilai yang disetujui HARUS sama dengan yang diajukan.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "invoices" DROP CONSTRAINT "invoices_number_by_status";
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_number_by_status" CHECK (
  ("status" IN ('DRAFT', 'SUBMITTED') AND "number" IS NULL) OR ("status" NOT IN ('DRAFT', 'SUBMITTED') AND "number" IS NOT NULL)
);

ALTER TABLE "invoices" DROP CONSTRAINT "invoices_issue_info";
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issue_info" CHECK (
  "status" IN ('DRAFT', 'SUBMITTED') OR ("issuedAt" IS NOT NULL AND "issuedById" IS NOT NULL)
);

ALTER TABLE "invoices" ADD CONSTRAINT "invoices_submit_info" CHECK (
  "status" <> 'SUBMITTED' OR ("submittedAt" IS NOT NULL AND "submittedById" IS NOT NULL)
);

CREATE OR REPLACE FUNCTION trg_invoices_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Invoice % berstatus % dan tidak boleh dihapus (batalkan/tarik kembali, jangan hapus)', COALESCE(OLD."number", '(draft)'), OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- ── DRAFT: bebas diedit ──
  IF OLD."status" = 'DRAFT' THEN
    IF NEW."status" = 'CANCELLED' THEN
      RAISE EXCEPTION 'Draft tidak dapat dibatalkan; hapus draft atau terbitkan terlebih dahulu'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- ── SUBMITTED: menunggu verifikasi ──
  IF OLD."status" = 'SUBMITTED' THEN
    IF NEW."status" = 'CANCELLED' THEN
      RAISE EXCEPTION 'Invoice yang sedang menunggu verifikasi tidak dapat dibatalkan; setujui atau kembalikan'
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" = 'DRAFT' THEN
      RETURN NEW; -- dikembalikan penyetuju / ditarik pengaju
    END IF;
    IF NEW."invoiceDate"          IS DISTINCT FROM OLD."invoiceDate"
    OR NEW."paymentMethod"        IS DISTINCT FROM OLD."paymentMethod"
    OR NEW."paymentTermDays"      IS DISTINCT FROM OLD."paymentTermDays"
    OR NEW."dueDateBasis"         IS DISTINCT FROM OLD."dueDateBasis"
    OR NEW."dueDate"              IS DISTINCT FROM OLD."dueDate"
    OR NEW."customerId"           IS DISTINCT FROM OLD."customerId"
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
    OR NEW."createdById"          IS DISTINCT FROM OLD."createdById"
    OR NEW."submittedById"        IS DISTINCT FROM OLD."submittedById"
    OR NEW."submittedAt"          IS DISTINCT FROM OLD."submittedAt"
    THEN
      IF NEW."status" = 'ISSUED' THEN
        RAISE EXCEPTION 'Isi yang disetujui harus sama dengan yang diajukan; kembalikan ke staff bila ada perubahan'
          USING ERRCODE = 'restrict_violation';
      END IF;
      RAISE EXCEPTION 'Invoice sedang menunggu verifikasi: isi/nilai terkunci (tarik kembali ke draft terlebih dahulu)'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW; -- SUBMITTED→SUBMITTED (hanya catatan internal dsb.) atau SUBMITTED→ISSUED dengan nilai yang sama
  END IF;

  -- ── Mulai di sini invoice sudah ISSUED atau CANCELLED ──
  IF NEW."status" IN ('DRAFT', 'SUBMITTED') THEN
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
  OR NEW."submittedAt"          IS DISTINCT FROM OLD."submittedAt"
  OR NEW."submittedById"        IS DISTINCT FROM OLD."submittedById"
  OR NEW."rejectedAt"           IS DISTINCT FROM OLD."rejectedAt"
  OR NEW."rejectedById"         IS DISTINCT FROM OLD."rejectedById"
  OR NEW."rejectionReason"      IS DISTINCT FROM OLD."rejectionReason"
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
