/**
 * Bagan akun USULAN untuk lembaga pelatihan & sertifikasi (disusun mengikuti struktur SAK EMKM:
 * aset, liabilitas, ekuitas, penghasilan, beban). Ini USULAN AWAL — wajib ditinjau akuntan/konsultan pajak
 * dan dapat disesuaikan Administrator di Pengaturan → Keuangan.
 *
 * Kode `d-dddd`: digit pertama = kelompok (1 aset, 2 liabilitas, 3 ekuitas, 4 penghasilan, 5/6/7 beban).
 *  • `manualEntry` = boleh dipilih sebagai akun lawan pada entri kas manual.
 *  • `isSystem`    = dicadangkan (invoice, piutang, pajak, penyusutan, penutup); dipakai tahap akuntansi berikutnya.
 */
export type CoaTypeValue = "ASET" | "KEWAJIBAN" | "EKUITAS" | "PENDAPATAN" | "BEBAN";
export type CashFlowSectionValue = "OPERASI" | "INVESTASI" | "PENDANAAN";

export interface CoaSeed {
  code: string;
  name: string;
  type: CoaTypeValue;
  section: CashFlowSectionValue;
  manualEntry: boolean;
  isSystem: boolean;
}

const sys = (code: string, name: string, type: CoaTypeValue, section: CashFlowSectionValue = "OPERASI"): CoaSeed => ({ code, name, type, section, manualEntry: false, isSystem: true });
const exp = (code: string, name: string): CoaSeed => ({ code, name, type: "BEBAN", section: "OPERASI", manualEntry: true, isSystem: false });
const inc = (code: string, name: string): CoaSeed => ({ code, name, type: "PENDAPATAN", section: "OPERASI", manualEntry: true, isSystem: false });

export const COA_SEED: readonly CoaSeed[] = [
  // ── Aset ──
  sys("1-1100", "Kas", "ASET"),
  sys("1-1200", "Bank", "ASET"),
  sys("1-1300", "Piutang Usaha", "ASET"),
  sys("1-1400", "Uang Muka Pajak (PPh dipotong pelanggan)", "ASET"),
  sys("1-1450", "Penerimaan Invoice Belum Dialokasikan ke Kas/Bank", "ASET"),
  { code: "1-2100", name: "Peralatan Kantor", type: "ASET", section: "INVESTASI", manualEntry: true, isSystem: false },
  { code: "1-2200", name: "Peralatan Pelatihan & Praktik", type: "ASET", section: "INVESTASI", manualEntry: true, isSystem: false },
  { code: "1-2300", name: "Kendaraan", type: "ASET", section: "INVESTASI", manualEntry: true, isSystem: false },
  sys("1-2900", "Akumulasi Penyusutan", "ASET", "INVESTASI"),
  // ── Liabilitas ──
  sys("2-1100", "Utang Usaha", "KEWAJIBAN"),
  sys("2-1200", "Utang Pajak (PPN, PPh)", "KEWAJIBAN"),
  { code: "2-2100", name: "Utang Bank & Pinjaman", type: "KEWAJIBAN", section: "PENDANAAN", manualEntry: true, isSystem: false },
  // ── Ekuitas ──
  { code: "3-1100", name: "Modal Disetor", type: "EKUITAS", section: "PENDANAAN", manualEntry: true, isSystem: false },
  { code: "3-1200", name: "Prive / Penarikan Pemilik", type: "EKUITAS", section: "PENDANAAN", manualEntry: true, isSystem: false },
  sys("3-2100", "Saldo Laba", "EKUITAS", "PENDANAAN"),
  sys("3-2200", "Laba (Rugi) Tahun Berjalan", "EKUITAS", "PENDANAAN"),
  // ── Penghasilan ──
  sys("4-1100", "Pendapatan Jasa Pelatihan & Sertifikasi", "PENDAPATAN"),
  inc("4-2100", "Pendapatan Lain-lain"),
  inc("4-2200", "Pendapatan Bunga & Jasa Giro"),
  // ── Beban langsung program (5) ──
  exp("5-1100", "Honor Instruktur, Asesor & Narasumber"),
  exp("5-1200", "Bahan Praktik & Perlengkapan Pelatihan"),
  exp("5-1300", "Sewa Tempat & Fasilitas Kegiatan"),
  exp("5-1400", "Konsumsi & Akomodasi Kegiatan"),
  exp("5-1500", "Biaya Sertifikasi, Lisensi & Uji Kompetensi"),
  // ── Beban operasional (6) ──
  exp("6-1100", "Gaji & Tunjangan Karyawan"),
  exp("6-1200", "Sewa Kantor"),
  exp("6-1300", "Listrik, Air, Internet & Telepon"),
  exp("6-1400", "Pemasaran & Iklan"),
  exp("6-1500", "Transportasi & Perjalanan Dinas"),
  exp("6-1600", "ATK & Perlengkapan Kantor"),
  exp("6-1700", "Pemeliharaan & Perbaikan"),
  exp("6-1800", "Administrasi & Biaya Bank"),
  exp("6-1900", "Perizinan, Legalitas & Profesional"),
  sys("6-2000", "Beban Penyusutan", "BEBAN"),
  exp("6-9000", "Beban Lain-lain"),
  // ── Pajak penghasilan (7) ──
  sys("7-1100", "Beban Pajak Penghasilan (PPh Badan)", "BEBAN"),
];
