# Deployment, Backup & Pemulihan

Dua jalur resmi: **A. Server Linux (Node + systemd + Nginx)** atau **B. Docker Compose**. Keduanya membutuhkan **PostgreSQL ≥ 14**,
**HTTPS** (wajib; cookie sesi menjadi `Secure` + HSTS aktif otomatis saat `APP_URL` berawalan `https://`), dan disk untuk backup.

> Catatan kejujuran: `npm run build` + `next start`, mode *standalone* (dipakai Dockerfile), pembuatan PDF, engine Prisma, serta skrip backup/restore/rekonsiliasi
> **telah dijalankan dan diverifikasi** di lingkungan pengembangan. Berkas `Dockerfile`, `docker-compose.yml`, dan workflow CI **belum dieksekusi** di sana
> (tidak ada daemon Docker / runner GitHub) — jalankan sekali di staging sebelum dipakai produksi.

## 1. Variabel environment

| Variabel | Wajib | Keterangan |
|---|:--:|---|
| `DATABASE_URL` | ✔ | `postgresql://user:pass@host:5432/db?schema=public` |
| `APP_URL` | ✔ | URL publik, mis. `https://invoice.trilogikaedutama.id`. Menentukan cookie `Secure`/`__Host-` dan HSTS. |
| `APP_TIMEZONE` | | Default `Asia/Jakarta` |
| `TRUST_PROXY` | | `true` **hanya** bila di belakang reverse proxy tepercaya yang menimpa `X-Forwarded-For/Host`. Default `false`. |
| `LOGIN_MAX_ATTEMPTS` `LOGIN_WINDOW_MINUTES` `LOGIN_LOCKOUT_MINUTES` | | Default 5 / 15 / 15 |
| `SESSION_IDLE_HOURS` `SESSION_ABSOLUTE_DAYS` | | Default 8 / 7 |
| `MAX_UPLOAD_MB` | | Default 3 |
| `ADMIN_EMAIL` `ADMIN_NAME` `ADMIN_PASSWORD` | seed | Administrator pertama (`npm run db:seed`). Password ≥ 12 karakter; **tidak ada default**. Hapus dari environment setelah seed. |
| `TEST_DATABASE_URL` | test | Database **terpisah** untuk test/E2E (isinya dikosongkan test). Jangan arahkan ke produksi. |

Simpan secret di environment/secret manager (mis. `/etc/trilogika/invoice.env` dengan mode `640`), **jangan** di repository.

## 2. Jalur A — Server Linux

```bash
# 1) Prasyarat (Ubuntu 22.04/24.04). Node.js 22: https://nodejs.org (atau NodeSource/nvm)
sudo apt install -y postgresql nginx

# 2) Database
sudo -u postgres psql
#   CREATE ROLE trilogika LOGIN PASSWORD 'GANTI_DENGAN_PASSWORD_KUAT';
#   CREATE DATABASE trilogika_invoice OWNER trilogika;

# 3) Aplikasi
sudo useradd -r -m -d /opt/trilogika-invoice trilogika
sudo -u trilogika git clone <URL-repo> /opt/trilogika-invoice
cd /opt/trilogika-invoice
sudo install -d -m 750 -o root -g trilogika /etc/trilogika
sudoedit /etc/trilogika/invoice.env      # isi variabel pada bagian 1
sudo -u trilogika npm ci
set -a; . /etc/trilogika/invoice.env; set +a
sudo -E -u trilogika npm run build
sudo -E -u trilogika npm run db:migrate  # prisma migrate deploy
sudo -E -u trilogika npm run db:seed     # satu kali (butuh ADMIN_EMAIL & ADMIN_PASSWORD di environment)
```

**systemd** (`/etc/systemd/system/trilogika-invoice.service`):

```ini
[Unit]
Description=Trilogika Invoice
After=network.target postgresql.service

[Service]
User=trilogika
WorkingDirectory=/opt/trilogika-invoice
EnvironmentFile=/etc/trilogika/invoice.env
ExecStart=/opt/trilogika-invoice/node_modules/.bin/next start -H 127.0.0.1 -p 3000
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

**Nginx + TLS** (certbot): proxy harus **menimpa** header klien (bukan menambahkan), lalu set `TRUST_PROXY=true`.

```nginx
server {
  listen 443 ssl http2;
  server_name invoice.trilogikaedutama.id;
  # ssl_certificate ... (diisi certbot)
  client_max_body_size 4m;                       # unggahan maks 3 MB + overhead multipart
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;   # menimpa; jangan pakai $proxy_add_x_forwarded_for
    proxy_read_timeout 60s;
  }
}
server { listen 80; server_name invoice.trilogikaedutama.id; return 301 https://$host$request_uri; }
```

## 3. Jalur B — Docker Compose

Buat file `.env` di samping `docker-compose.yml` (jangan di-commit) berisi:

```dotenv
POSTGRES_PASSWORD=ganti-dengan-password-kuat
APP_URL=https://invoice.trilogikaedutama.id
ADMIN_EMAIL=admin@trilogikaedutama.id
ADMIN_PASSWORD=ganti-dengan-password-kuat-min-12
```

Lalu jalankan:

```bash
docker compose up -d --build       # db -> migrate+seed (sekali) -> app di 127.0.0.1:3000
```

Pasang reverse proxy HTTPS (konfigurasi Nginx di atas) di depan `127.0.0.1:3000`. Rekonsiliasi dari image alat:
`docker compose run --rm migrate npm run db:reconcile`. Hapus `ADMIN_PASSWORD` dari `.env` setelah akun dibuat.

## 4. Checklist hari pertama (setelah login Administrator)

1. Ganti password sementara (dipaksa saat login pertama).
2. **Pengaturan → Perusahaan & dokumen**: periksa identitas, NPWP, penandatangan; unggah logo/cap/tanda tangan; pilih format Rupiah.
3. **Pengaturan → Rekening bank**: verifikasi rekening.
4. **Pengaturan → Pajak**: tambahkan konfigurasi pajak **sesuai ketentuan lembaga** (kosong = semua bebas pajak).
5. **Pengaturan → Penomoran invoice**: konfirmasi nomor berikutnya (**periksa dulu apakah 00434/00435 sudah terpakai**).
6. **Produk & Layanan**: lengkapi katalog. **Pelanggan**: tambahkan pelanggan aktif.
7. **Pengaturan → Pengguna**: buat akun Finance & Staff (password sementara, wajib diganti).
8. Terbitkan satu invoice uji → unduh PDF → bandingkan dengan dokumen Word → batalkan (alasan: uji) bila tidak dipakai.
9. Jadwalkan backup & rekonsiliasi (bagian 5) dan **lakukan satu kali latihan pemulihan**.

## 5. Backup & pemulihan

Backup memakai `pg_dump` format custom (terkompresi), diverifikasi dapat dibaca, diberi checksum, dengan retensi default 30 hari (`BACKUP_KEEP_DAYS`).

```bash
# Sekali jalan
BACKUP_DIR=/var/backups/trilogika npm run db:backup

# Jadwal (crontab -e): backup harian 01:30, rekonsiliasi integritas harian 02:00
30 1 * * *  cd /opt/trilogika-invoice && set -a && . /etc/trilogika/invoice.env && set +a && BACKUP_DIR=/var/backups/trilogika npm run -s db:backup    >> /var/log/trilogika-backup.log 2>&1
0  2 * * *  cd /opt/trilogika-invoice && set -a && . /etc/trilogika/invoice.env && set +a && npm run -s db:reconcile                                       >> /var/log/trilogika-reconcile.log 2>&1
```

- **Salin arsip ke luar server** (object storage terenkripsi / disk terpisah). Backup memuat data pelanggan, rekening, dan bukti bayar → perlakukan sebagai data
  sensitif (skrip memakai `umask 077`; enkripsi saat disimpan/dikirim adalah tanggung jawab infrastruktur).
- `db:reconcile` keluar dengan kode ≠ 0 bila ada ketidakcocokan (cache pembayaran vs ledger, identitas total, nomor, pembalikan) — pasang notifikasi pada kegagalan.
- **Latihan pemulihan (disarankan tiap kuartal)** — ke database baru, tanpa menyentuh produksi:

```bash
createdb trilogika_restore_check
TARGET_URL=postgresql://USER:PASS@HOST:5432/trilogika_restore_check \
  npm run db:restore -- /var/backups/trilogika/trilogika_YYYYmmdd_HHMMSS.dump
DATABASE_URL=postgresql://USER:PASS@HOST:5432/trilogika_restore_check npm run db:reconcile
```

- **Pemulihan sebenarnya** (bencana): hentikan aplikasi → pastikan ada backup terbaru dari kondisi saat ini → jalankan
  `CONFIRM_RESTORE=yes TARGET_URL=... npm run db:restore -- <arsip>` → `db:reconcile` → nyalakan aplikasi. Skrip menolak menimpa database berisi data tanpa
  `CONFIRM_RESTORE=yes`, memeriksa checksum, dan memulihkan dalam satu transaksi. Trigger & constraint integritas ikut terpulihkan.
- **Latihan yang sudah dijalankan** di lingkungan pengembangan: backup → restore ke database baru → jumlah baris identik (invoice, item, pembayaran, audit, pengguna, pelanggan),
  rekonsiliasi bersih, 4 trigger inti utuh; manipulasi data yang disengaja terdeteksi `db:reconcile` (exit 1).

## 6. Upgrade & rollback

1. Backup (`db:backup`). 2. `git pull` → `npm ci` → `npm run build`. 3. `npm run db:migrate` (hanya menjalankan migrasi baru). 4. Restart service. 5. Cek `GET /api/health` dan `db:reconcile`.

**Aturan migrasi:** jangan mengedit migrasi yang sudah diterapkan; setiap perubahan skema = migrasi baru (`npm run db:migrate:dev`). Rollback = pulihkan backup sebelum upgrade (migrasi bersifat maju).

## 7. Monitoring

`GET /api/health` (database terjangkau) untuk load balancer/uptime monitor; log aplikasi ke stdout/journald (tidak memuat password/token); jejak tindakan di menu **Audit Log**;
alarm bila `db:reconcile` gagal atau backup terakhir lebih dari 26 jam.

## 8. Checklist keamanan sebelum go-live

- [ ] HTTPS aktif, `APP_URL` berawalan `https://`, `TRUST_PROXY=true` hanya bila proxy menimpa `X-Forwarded-*`.
- [ ] Password Administrator kuat; `ADMIN_PASSWORD` dihapus dari environment; tidak ada akun demo (`@trilogika.test`) di produksi (**jangan** menjalankan `db:seed:dev`).
- [ ] PostgreSQL tidak terbuka ke internet; user DB khusus aplikasi dengan password kuat.
- [ ] Backup berjalan, tersalin keluar server, dan latihan restore sukses.
- [ ] Nomor invoice dikonfirmasi; konfigurasi pajak ditinjau konsultan pajak.
- [ ] `npm audit --omit=dev` ditinjau (lihat [SECURITY.md](SECURITY.md)).
