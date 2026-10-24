# Trilogika Invoice — Invoice Management System

Aplikasi invoice internal **Trilogika Edutama** yang menggantikan pembuatan invoice manual di Microsoft Word:
data dimasukkan **sekali**, disimpan terstruktur di PostgreSQL, lalu dipakai ulang untuk nomor otomatis, perhitungan,
terbilang, PDF, pembayaran, dashboard, dan laporan.

> Aplikasi **berfungsi penuh** (bukan mockup): login berperan, master data, mesin invoice dengan alur persetujuan, PDF A4 landscape, pembayaran,
> dashboard, laporan, audit log — semuanya tersimpan permanen di database dan diuji (lihat [Pengujian](#pengujian)).

## Fitur

| Area | Ringkasan |
|---|---|
| **Invoice** | **Staff Operasional** menginput data lengkap → **ajukan** → **Finance Manager** memeriksa (melihat seluruh data) lalu **menyetujui & menerbitkan** atau **mengembalikan** dengan alasan → unduh PDF resmi. Nomor otomatis & unik (aman untuk pengguna bersamaan), jatuh tempo otomatis (hari kalender/kerja), banyak item, diskon, pajak, transport, administrasi, DP, terbilang bahasa Indonesia. Duplikasi, pembatalan (nomor & riwayat dipertahankan), ekspor CSV/Excel. |
| **Keuangan** | Mesin kalkulasi terpusat berbasis bilangan bulat Rupiah (BigInt), urutan perhitungan eksplisit, satu aturan pembulatan, pajak dapat dikonfigurasi (tarif, DPP pecahan, inklusif/eksklusif). |
| **Snapshot** | Invoice terbit membekukan pelanggan, lembaga, rekening, harga, dan pajak. Mengubah master tidak mengubah invoice lama — dijaga aplikasi **dan** trigger database. |
| **Pembayaran** | Buku besar *append-only*; pembayaran sebagian/lunas; koreksi lewat pembalikan (tidak ada penghapusan); bukti bayar; kelebihan bayar ditolak. |
| **PDF** | **A4 landscape** meniru invoice referensi Trilogika (judul INVOICE di tengah, blok Number/Inv. Date/Payment Term/Due Date mepet kanan); *Product Description* dinamis (nama peserta, dll) sedangkan *Remark* tetap mengikuti program; deskripsi panjang & banyak item membungkus otomatis; header tabel berulang; **watermark DRAFT** pada dokumen yang belum diverifikasi (tanpa nomor, tanda tangan, dan cap — baru muncul setelah disetujui Finance Manager), watermark DIBATALKAN; logo, cap, tanda tangan dari Pengaturan; nama file otomatis `Invoice_00434_CV_Bima_Satria_Jaya.pdf`. |
| **Master data** | Pelanggan (autocomplete, pencegahan duplikasi, arsip, riwayat & piutang), produk/layanan (template deskripsi otomatis), pajak, rekening bank. |
| **Dashboard & laporan** | 10 metrik dengan definisi eksplisit (nilai invoice ≠ kas ≠ piutang), grafik tren, 9 laporan + ekspor CSV/XLSX. |
| **Keamanan** | Login berperan (Administrator / Finance Manager / Staff Operasional; Staff = Finance Manager tanpa approval & dashboard, sehingga input ↔ verifikasi terpisah) ditegakkan di backend, sesi ber-hash, scrypt, rate limit login, CSRF, header keamanan, validasi unggahan berdasarkan isi file, audit log append-only. |

## Teknologi

Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS 4 · PostgreSQL 16 · Prisma 6 ·
`@react-pdf/renderer` · Zod · Vitest · Playwright. Alasan pemilihan: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Mulai cepat (lokal)

Prasyarat: **Node.js ≥ 22**, **PostgreSQL ≥ 14**, dan `poppler-utils` (hanya untuk menjalankan test PDF).

```bash
npm ci
cp .env.example .env                 # lalu isi DATABASE_URL, TEST_DATABASE_URL, dsb.

# database (contoh)
createdb trilogika_dev && createdb trilogika_test

npm run db:migrate                   # terapkan migrasi (prisma migrate deploy)
npm run db:seed:dev                  # data demo + akun (password dicetak sekali / dari DEV_SEED_PASSWORD)
npm run dev                          # http://localhost:3000
```

Akun demo dari `db:seed:dev`: `admin@trilogika.test`, `finance@trilogika.test`, `staff@trilogika.test`.
**Seed development menolak berjalan** bila `NODE_ENV=production` atau database bukan lokal.

Untuk **produksi**, gunakan `npm run db:seed` (bukan `:dev`) — membuat identitas lembaga, rekening, produk awal, dan
**satu** akun Administrator dari `ADMIN_EMAIL` / `ADMIN_PASSWORD` (tanpa password default; seed gagal bila lemah).
Panduan lengkap: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

> ⚠️ **Sebelum invoice pertama diterbitkan**, Administrator wajib membuka *Pengaturan → Penomoran invoice* dan
> mengonfirmasi nomor berikutnya. Konfigurasi awal memakai contoh `00434` — **periksa dulu apakah nomor itu sudah
> pernah dipakai** (invoice contoh sudah bernomor 00434, sehingga nomor berikutnya kemungkinan `00435`).

## Perintah

| Perintah | Fungsi |
|---|---|
| `npm run dev` / `build` / `start` | Server development / build produksi / jalankan build |
| `npm run lint` · `typecheck` | ESLint · TypeScript |
| `npm test` | Unit + integration (butuh `TEST_DATABASE_URL`) |
| `npm run test:e2e` | E2E Playwright pada **build produksi** + database test |
| `npm run db:migrate` | `prisma migrate deploy` (aman untuk produksi) |
| `npm run db:migrate:dev` | Buat migrasi baru saat mengembangkan skema |
| `npm run db:seed` · `db:seed:dev` | Seed produksi · seed demo (lokal saja) |
| `npm run db:backup` · `db:restore` | Backup/restore PostgreSQL (lihat DEPLOYMENT) |
| `npm run db:reconcile` | Rekonsiliasi integritas (cache pembayaran = ledger, identitas total, nomor, dst.) |
| `npm run user:create` | Buat akun dari CLI (password lewat env `NEW_USER_PASSWORD`) |

## Struktur proyek

```
prisma/                skema, migrasi (termasuk trigger integritas), seed produksi & development
src/lib/finance/       modul MURNI: calculate, terbilang, due-date, invoice-number, description-template, money
src/lib/               permissions (RBAC), validation (zod bersama), types, format
src/server/services/   SELURUH logika bisnis: invoices, payments, customers, products, settings, tax, numbering, …
src/server/pdf/        template PDF (react-pdf) + penyusun data dari snapshot
src/server/            auth (sesi, password, rate limit), http wrapper (CSRF), audit, env, db
src/app/(app)/         halaman (server components) · src/app/api/ route handler REST
src/components/        komponen UI & form (form invoice, dialog aksi, pengaturan)
tests/                 unit · integration (PostgreSQL asli) · e2e (Playwright)
scripts/               backup, restore, reconcile, create-user
docs/                  arsitektur, keputusan bisnis, deployment, API, keamanan
```

Prinsip lapisan: **UI** → **API route (route wrapper: sesi, CSRF, error aman)** → **service (izin, validasi, transaksi, audit)** →
**Prisma** → **PostgreSQL (CHECK + trigger)**. Modul keuangan di `src/lib/finance` dipakai identik oleh server dan browser.

## Pengujian

- **Unit** (`tests/unit`): kalkulasi (termasuk pajak DPP 11/12, diskon pro-rata, DP), terbilang, jatuh tempo, penomoran, template, RBAC, pagar struktural API.
- **Integration** (`tests/integration`, PostgreSQL asli): skenario CV Bima Satria Jaya (Rp14.000.000), nomor unik pada **10 penerbitan paralel**,
  klik ganda, rollback transaksi, snapshot vs perubahan master, ledger & pembalikan, pembayaran paralel, imutabilitas lewat SQL langsung,
  RBAC di service, alur persetujuan (ajukan → setujui/kembalikan, penguncian isi di aplikasi **dan** database, persetujuan paralel), Remark vs Product Description, laporan/dashboard/ekspor (+ proteksi formula-injection), PDF (landscape, teks, snapshot, multi-halaman, watermark DRAFT/DIBATALKAN, nomor/cap/tanda tangan hanya setelah disetujui), persistensi.
- **E2E** (`tests/e2e`, build produksi): alur UI penuh sampai PDF & pembayaran, alur Staff → Finance Manager (ajukan, kembalikan, setujui), dua tab menerbitkan bersamaan, RBAC lewat UI & API,
  CSRF, rate limit login, header keamanan.

## Dokumentasi

[Arsitektur & keputusan desain](docs/ARCHITECTURE.md) · [Keputusan bisnis yang perlu konfirmasi](docs/BUSINESS-DECISIONS.md) ·
[Deployment, backup, pemulihan](docs/DEPLOYMENT.md) · [API](docs/API.md) · [Keamanan](docs/SECURITY.md)
