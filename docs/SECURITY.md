# Keamanan

Ringkasan kontrol, bukti pengujian, dan keterbatasan yang diketahui. Prinsip: **frontend tidak pernah menentukan nominal final, status pembayaran,
nomor invoice, atau hak akses** — semuanya ditegakkan di server (dan, untuk imutabilitas, di database).

## Kontrol

| Area | Kontrol | Bukti |
|---|---|---|
| Autentikasi | Sesi cookie `HttpOnly; SameSite=Lax` (`__Host-` + `Secure` di HTTPS); token acak 256-bit, **hanya hash SHA-256 di DB**; idle 8 jam, maksimum 7 hari; dicabut saat logout / nonaktif / ganti peran / reset password | `tests/integration/auth.test.ts`, E2E |
| Password | **scrypt** (N=2¹⁵, r=8) bawaan Node; kebijakan ≥12 karakter, bukan password umum, tidak memuat email/nama; waktu respons seragam untuk akun tak dikenal; tidak ada password default (seed gagal bila kosong/lemah) | auth.test.ts, seed |
| Brute force | 5 kegagalan/15 menit per email (+ per IP bila `TRUST_PROXY`) → blokir 15 menit; penghitung atomik di PostgreSQL (lintas instance) | auth.test.ts (paralel), E2E (429) |
| Otorisasi | RBAC least-privilege di **service layer** (`assertCan`) untuk setiap operasi; **pemisahan tugas**: Staff Operasional menginput, mengajukan, mencatat pembayaran, dan melihat laporan, tetapi hanya Finance Manager/Administrator yang menyetujui & menerbitkan (approval), membatalkan invoice terbit, dan membalikkan pembayaran; staff hanya dapat menyunting/menghapus/mengajukan draft **sendiri** (milik orang lain → 404); izin halaman → 404 | invoice-flow/master-data tests, E2E RBAC (API langsung → 403) |
| CSRF | SameSite=Lax + pemeriksaan `Origin` (atau `Sec-Fetch-Site`) pada setiap request mutasi | E2E (Origin asing → 403) |
| Integritas data | Transaksi + row lock; CHECK & trigger (invoice terbit/ledger/audit imutabel; **invoice yang diajukan terkunci** hingga diverifikasi) — berlaku juga untuk SQL langsung | integration (SQL mentah ditolak) |
| Anti-pemalsuan dokumen | Dokumen yang belum disetujui berwatermark **DRAFT**, tanpa nomor/cap/tanda tangan (dijaga di sumber data PDF); persetujuan menghitung ulang & mensyaratkan isi identik dengan yang diajukan; setiap pengajuan/pengembalian/persetujuan/unduhan PDF tercatat di audit log | pdf.test.ts, invoice-flow.test.ts, E2E |
| Injeksi | Query Prisma / `$queryRaw` ter-parameter; tidak ada SQL hasil penyambungan string di kode aplikasi; React meng-escape output; Zod membuang field tak dikenal (anti mass-assignment) | tinjauan kode, tes validasi |
| XSS / clickjacking | CSP (`frame-ancestors 'self'`, `object-src 'self'`, tanpa `unsafe-eval` di produksi), `X-Frame-Options`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS (produksi) | E2E header |
| Unggahan | Validasi **magic bytes** (PNG/JPEG/PDF; SVG ditolak), batas ukuran sebelum dibaca, nama file disanitasi, disajikan `attachment` + `nosniff` + CSP `sandbox`, tersimpan imutabel | master-data.test.ts, E2E |
| CSV/Excel | Sel teks diawali `= + - @` dinetralkan (CSV injection); nominal tetap angka | reports.test.ts |
| Error | Pesan aman ke pengguna; detail internal hanya di log server; halaman 404/error tanpa stack trace | E2E |
| Audit | Append-only (trigger), satu transaksi dengan perubahan; pelaku, IP, sebelum/sesudah, alasan; termasuk unduhan PDF & ekspor | integration |
| Rahasia | Hanya environment; `.env` di-`gitignore`; tidak ada kredensial di source; password/token tidak pernah di-log | tinjauan kode |

Pagar struktural: `tests/unit/api-routes.test.ts` menggagalkan test bila ada endpoint API yang melewati `route()` / `publicRoute()`.

## Keterbatasan & rekomendasi lanjutan

1. **CSP masih memakai `script-src 'unsafe-inline'`** (kebutuhan hydration Next.js tanpa nonce). Pertahanan utama XSS adalah escaping React; migrasi ke CSP berbasis nonce disarankan.
2. **Belum ada MFA** — disarankan TOTP untuk Administrator/Finance Manager (penyetuju invoice).
3. **Belum ada token API/SSO** untuk integrasi server-ke-server ([BUSINESS-DECISIONS.md](BUSINESS-DECISIONS.md) #6).
4. **Rate limit hanya pada login.** Endpoint lain dilindungi autentikasi; batas ukuran body (1 MB JSON, 3 MB unggahan) dan batas halaman/ekspor mencegah beban berlebih. Tambahkan rate limit di reverse proxy bila perlu.
5. **Enkripsi saat disimpan** (disk, backup) dan **rotasi backup** adalah tanggung jawab infrastruktur.
6. **Audit dependensi** (`npm audit --omit=dev`): `uuid` (via `exceljs`) dinaikkan lewat `overrides`. Tersisa 3 temuan *high* yang berasal dari `deepmerge-ts` di dalam **Prisma CLI**
   (alat build/migrasi, bukan jalur runtime yang memproses input pengguna); perbaikannya memerlukan Prisma ≥ 7.10 (perubahan besar) — jadwalkan upgrade terkontrol.
7. Font PDF bawaan (Times) mencakup Latin/WinAnsi; nama pelanggan beraksara non-Latin tidak akan tampil benar tanpa mendaftarkan font Unicode.

## Pelaporan

Temuan keamanan: laporkan ke Administrator sistem; jangan membuka isu publik berisi data nyata.
