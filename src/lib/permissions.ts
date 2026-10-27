/**
 * Matriks hak akses (RBAC). Satu file, dapat ditinjau & diuji.
 *
 * PENTING: UI memakai ini hanya untuk menyembunyikan tombol. Penegakan sebenarnya ada di SERVICE LAYER
 * (`assertCan`) sehingga berlaku untuk setiap endpoint dan halaman server.
 *
 * Prinsip least privilege:
 *   ADMIN   — (pemilik) semua, termasuk pengguna, pengaturan, penomoran, pajak, audit log.
 *   FINANCE — Finance Manager: VERIFIKATOR/penyetuju invoice (setujui → terbit, kembalikan), melihat seluruh data invoice,
 *             satu-satunya yang membatalkan invoice terbit & membalikkan pembayaran, plus pembayaran, laporan, unduh PDF.
 *   Keuangan (basis kas): Administrator mengelola bagan akun/akun kas/saldo awal; Finance Manager melihat seluruh kas & laporan
 *             keuangan, mencatat, menyetujui, dan membalikkan; Staff hanya mencatat pengeluaran (menunggu persetujuan) & melihat catatannya sendiri.
 *   STAFF   — Staff Operasional: menginput data invoice secara lengkap (termasuk harga/diskon/pajak) lalu MENGAJUKAN
 *             untuk diverifikasi; juga mencatat pembayaran, melihat laporan, dan seluruh invoice. Beda dengan Finance
 *             Manager: TIDAK dapat menyetujui/menerbitkan/mengembalikan, membatalkan invoice terbit, atau membalikkan
 *             pembayaran (otoritas koreksi) — dan tanpa dashboard.
 */

export type Role = "ADMIN" | "FINANCE" | "STAFF";

export const PERMISSIONS = [
  "dashboard:view",
  "customer:view",
  "customer:create",
  "customer:update",
  "customer:archive",
  "product:view",
  "product:manage",
  "invoice:view",          // semua invoice
  "invoice:view_own",      // hanya invoice buatan sendiri
  "invoice:create",        // buat/edit/hapus DRAFT & duplikasi
  "invoice:override_price",// ubah harga satuan / baris bebas (tanpa produk) / pajak per baris
  "invoice:discount",      // diskon baris & diskon tambahan
  "invoice:submit",        // ajukan draft untuk diverifikasi / tarik kembali pengajuan sendiri
  "invoice:approve",       // setujui & terbitkan (nomor, cap, tanda tangan) atau kembalikan ke staff
  "invoice:cancel",
  "invoice:pdf",           // pratinjau & unduh PDF invoice terbit
  "invoice:preview_draft", // pratinjau PDF draft (watermark DRAFT)
  "invoice:history",       // riwayat perubahan invoice
  "payment:view",
  "payment:record",
  "payment:reverse",
  "report:view",
  "audit:view",
  "settings:view",
  "settings:manage",
  "numbering:manage",
  "tax:manage",
  "user:manage",
  "finance:view",          // kas & bank, buku kas, seluruh pengeluaran, laporan keuangan (arus kas, laba rugi), bagan akun
  "finance:manage",        // bagan akun, akun kas/bank, saldo awal
  "cash:record",           // entri kas non-pengeluaran (penerimaan lain, investasi, pendanaan) & transfer antar akun — langsung berlaku
  "expense:record",        // mencatat pengeluaran (staff: menunggu persetujuan; penyetuju: langsung berlaku)
  "expense:view_own",      // melihat pengeluaran yang dicatat sendiri
  "expense:approve",       // menyetujui/menolak pengeluaran staff
  "expense:void",          // membalikkan entri kas/transfer/jurnal yang sudah berlaku (koreksi)
  "journal:record",        // mencatat jurnal manual (penyesuaian, penyusutan, saldo awal non-kas) — langsung berlaku
  "books:lock",            // menetapkan/membuka penutupan buku (transaksi ≤ tanggal tutup ditolak)
  "bank:reconcile",        // impor rekening koran, mencocokkan, membuat entri dari mutasi, memfinalisasi/membuka rekonsiliasi bank
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL: readonly Permission[] = PERMISSIONS;

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  ADMIN: new Set(ALL),
  FINANCE: new Set<Permission>([
    "dashboard:view",
    "customer:view", "customer:create", "customer:update", "customer:archive",
    "product:view",
    "invoice:view", "invoice:create", "invoice:override_price", "invoice:discount",
    "invoice:approve", "invoice:cancel", "invoice:pdf", "invoice:preview_draft", "invoice:history",
    "payment:view", "payment:record", "payment:reverse",
    "report:view",
    "settings:view",
    "finance:view", "cash:record", "expense:record", "expense:approve", "expense:void", "journal:record", "books:lock", "bank:reconcile",
  ]),
  // Staff Operasional = Finance Manager TANPA otoritas koreksi/persetujuan — approval (setujui/terbitkan/kembalikan),
  // pembatalan invoice terbit, dan pembalikan pembayaran tetap di tangan Finance Manager — serta TANPA dashboard;
  // sebagai gantinya staff dapat mengajukan invoice. Mengedit/menghapus/mengajukan draft hanya untuk draft
  // miliknya sendiri (lihat `canEditDraft`).
  STAFF: new Set<Permission>([
    "customer:view", "customer:create", "customer:update", "customer:archive",
    "product:view",
    "invoice:view", "invoice:create", "invoice:override_price", "invoice:discount", "invoice:submit",
    "invoice:pdf", "invoice:preview_draft", "invoice:history",
    "payment:view", "payment:record",
    "report:view",
    "settings:view",
    "expense:record", "expense:view_own",
  ]),
};

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role].has(permission);
}

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Administrator",
  FINANCE: "Finance Manager",
  STAFF: "Staff Operasional",
};

/** Menu sidebar beserta izin (salah satu cukup) untuk melihatnya. */
export const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", anyOf: ["dashboard:view"] },
  { href: "/invoices", label: "Invoice", anyOf: ["invoice:view", "invoice:view_own"] },
  { href: "/customers", label: "Pelanggan", anyOf: ["customer:view"] },
  { href: "/products", label: "Produk & Layanan", anyOf: ["product:view"] },
  { href: "/payments", label: "Pembayaran", anyOf: ["payment:view"] },
  { href: "/expenses", label: "Pengeluaran", anyOf: ["expense:record", "expense:view_own", "finance:view"] },
  { href: "/cash", label: "Kas & Bank", anyOf: ["finance:view"] },
  { href: "/reconciliation", label: "Rekonsiliasi Bank", anyOf: ["finance:view"] },
  { href: "/journals", label: "Jurnal", anyOf: ["finance:view"] },
  { href: "/reports", label: "Laporan", anyOf: ["report:view"] },
  { href: "/statements", label: "Laporan Keuangan", anyOf: ["finance:view"] },
  { href: "/taxes", label: "Pajak", anyOf: ["finance:view"] },
  { href: "/closing", label: "Tutup Buku", anyOf: ["finance:view"] },
  { href: "/audit-log", label: "Audit Log", anyOf: ["audit:view"] },
  { href: "/settings", label: "Pengaturan", anyOf: ["settings:view"] },
] as const satisfies readonly { href: string; label: string; anyOf: readonly Permission[] }[];

export function visibleNav(role: Role | null | undefined) {
  return NAV_ITEMS.filter((i) => (i.anyOf as readonly Permission[]).some((p) => can(role, p)));
}
