-- Bukti transaksi wajib untuk uang KELUAR (entri kas manual) di atas Rp1.000.000. Berlaku hanya untuk entri baru (ENTRY);
-- pembalikan dikecualikan (mengikuti entri asal). Ambang sama dengan PROOF_REQUIRED_ABOVE di src/lib/accounting/limits.ts.
CREATE OR REPLACE FUNCTION trg_cash_entries_insert_check() RETURNS trigger AS $$
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
    IF NEW."direction" = 'OUT' AND NEW."amount" > 1000000 AND NEW."proofFileId" IS NULL THEN
      RAISE EXCEPTION 'Pengeluaran di atas Rp 1.000.000 wajib melampirkan bukti transaksi' USING ERRCODE = 'check_violation';
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
