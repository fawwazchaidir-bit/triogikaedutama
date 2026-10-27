-- Akun sistem tidak boleh dipilih pada entri kas manual — kecuali akun utang pajak (2-1210 PPN, 2-1230 PPh badan), agar SETORAN pajak dapat dicatat sebagai kas keluar.
ALTER TABLE "coa_accounts" ADD CONSTRAINT "coa_system_not_manual" CHECK (NOT ("isSystem" AND "manualEntry") OR "code" IN ('2-1210', '2-1230'));
