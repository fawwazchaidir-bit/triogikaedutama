/**
 * Matriks hak akses (RBAC). Satu file, dapat ditinjau & diuji.
 *
 * PENTING: UI memakai ini hanya untuk menyembunyikan tombol. Penegakan sebenarnya ada di SERVICE LAYER
 * (`assertCan`) sehingga berlaku untuk setiap endpoint dan halaman server.
 *
 * Prinsip least privilege:
 *   ADMIN   — (pemilik) semua, termasuk pengguna, pengaturan, penomoran, pajak, audit log.
 *   FINANCE — Finance Manager: VERIFIKATOR/penyetuju invoice (setujui → terbit, kembalikan), melihat seluruh data invoice,
 *             pembatalan, pembayaran, laporan, unduh PDF.
 *   STAFF   — Staff Operasional: menginput data invoice secara lengkap (termasuk harga/diskon/pajak) pada invoice
 *             miliknya lalu MENGAJUKAN untuk diverifikasi. Tidak dapat menyetujui/menerbitkan.
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
  ]),
  STAFF: new Set<Permission>([
    "customer:view", "customer:create",
    "product:view",
    "invoice:view_own", "invoice:create", "invoice:override_price", "invoice:discount", "invoice:submit", "invoice:preview_draft",
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
  { href: "/reports", label: "Laporan", anyOf: ["report:view"] },
  { href: "/audit-log", label: "Audit Log", anyOf: ["audit:view"] },
  { href: "/settings", label: "Pengaturan", anyOf: ["settings:view"] },
] as const satisfies readonly { href: string; label: string; anyOf: readonly Permission[] }[];

export function visibleNav(role: Role | null | undefined) {
  return NAV_ITEMS.filter((i) => (i.anyOf as readonly Permission[]).some((p) => can(role, p)));
}
