# Keputusan Bisnis — perlu konfirmasi pimpinan

Brief meminta agar aturan yang memengaruhi keuangan **tidak dikarang**. Berikut asumsi yang dipakai saat ini, dampaknya, dan cara mengubahnya.
Semua dapat diubah lewat **Pengaturan** (tanpa mengedit kode) kecuali yang bertanda 🔧 (perlu perubahan kode kecil).

## A. Wajib dikonfirmasi sebelum go-live

| # | Topik | Asumsi saat ini | Mengapa penting | Cara mengubah / langkah |
|---|---|---|---|---|
| 1 | **Nomor invoice berikutnya** | Format `{SEQ:5}`, nomor awal contoh **00434**, **belum aktif**. Penerbitan ditolak sampai Administrator mengonfirmasi. | Invoice contoh sudah bernomor **00434**; bila sudah terbit, nomor berikutnya mestinya **00435**. Nomor ganda = masalah audit/pajak. | Pengaturan → Penomoran invoice → isi nomor berikutnya → centang pernyataan "belum pernah dipakai" → Aktifkan. |
| 2 | **Pajak (PPN/PPh)** | **Tidak ada tarif yang diasumsikan.** Semua baris bebas pajak (sesuai invoice contoh: `Tax 0`). | Apakah lembaga PKP / jasa pelatihan tertentu dikenai PPN, dan berapa tarif/DPP, ditentukan regulasi & konsultan pajak. | Pengaturan → Pajak: tambah konfigurasi (tarif, faktor DPP mis. 11/12, eksklusif/inklusif). Pajak dipilih per baris invoice; produk dapat membawa pajak default. |
| 3 | **PPh yang dipotong pelanggan** (mis. PPh 23) | **Belum ditangani** (pajak yang ditambahkan pada total saja). | Pelanggan instansi sering memotong PPh; ini memengaruhi jumlah yang benar-benar dibayar. | 🔧 Perlu desain: baris "potongan pajak" yang mengurangi pembayaran diharapkan, bukan total invoice. |
| 4 | **Cap & tanda tangan pada invoice** | Cap perusahaan (dari dokumen contoh) tercetak otomatis pada invoice **terbit** (dapat dimatikan). **Tanda tangan basah tidak disertakan** di repository. | Keabsahan cap/tanda tangan elektronik di mata pelanggan/auditor adalah keputusan hukum/kebijakan internal. | Pengaturan → Perusahaan & dokumen → unggah/tampilkan cap & tanda tangan. |
| 5 | **Penandatangan (Finance Manager)** | Jabatan **Finance Manager** (revisi; sebelumnya "Finance"), nama `Elva Aditya Fawwaz, S.E.` (sesuai brief). Dokumen contoh bertuliskan `Elva Aditya S, S.E.`. Invoice yang **sudah terbit sebelum revisi** tetap memuat snapshot lama ("Finance") — snapshot tidak diubah. | Nama pada dokumen resmi harus benar. | Pengaturan → Perusahaan & dokumen → Penandatangan. |
| 6 | **Integrasi dengan dashboard admin Trilogika** | Autentikasi berbasis **cookie sesi** (cocok bila dashboard berada di domain/subdomain yang sama dan dibuka lewat browser). **Belum ada token API/SSO** untuk panggilan server-ke-server. | Brief menyebut aplikasi "akan terhubung" ke dashboard admin; mekanismenya (SSO/OIDC, API key, embed) belum diketahui. | 🔧 Setelah diputuskan: tambah API key bertoken terbatas-izin atau SSO. Layanan (`src/server/services`) sudah terpisah dari HTTP sehingga mudah dipakai ulang. |

## B. Kebijakan yang diambil (dapat dibalik bila tidak sesuai)

| # | Topik | Keputusan | Alternatif |
|---|---|---|---|
| 7 | Nomor untuk draft | Draft **tidak bernomor**; nomor dialokasikan saat terbit → tidak ada lubang karena draft dibuang. | Nomor sejak draft (🔧; menimbulkan lubang bila draft dibuang). |
| 8 | Payment term default | **4 hari kalender** (dari contoh 13→17 Jan 2026). Hari kerja = Senin–Jumat; **hari libur nasional belum dikecualikan**. | Tambah kalender libur (🔧; fungsi sudah menerima daftar libur). |
| 9 | "Payment Term" di PDF | Menampilkan **metode** (`Transfer`) seperti dokumen referensi; jatuh tempo ada di baris sendiri. | Tampilkan "Transfer (4 hari)" (🔧 kecil di template). |
| 10 | Down Payment | DP pada draft dicatat otomatis sebagai **pembayaran** (tanggal = tanggal invoice) saat terbit; mengurangi sisa tagihan, **bukan** total invoice. PDF menambah baris "Sisa Tagihan" bila DP > 0. | — |
| 11 | Kelebihan bayar | **Ditolak.** Belum ada mekanisme deposit/kredit. | Fitur kredit pelanggan (🔧). |
| 12 | Pembatalan | Hanya invoice **terbit** tanpa pembayaran aktif; bila ada pembayaran, balikkan dulu. Invoice batal tidak dapat diaktifkan kembali. | — |
| 13 | Siapa boleh apa | **Staff Operasional = Finance Manager − approval − pembatalan invoice − pembalikan pembayaran − dashboard** (+ hak mengajukan). Staff menginput invoice lengkap (harga, diskon, pajak), mengajukan, **mencatat** pembayaran, melihat laporan, mengunduh PDF invoice terbit, mengelola pelanggan (buat/ubah/arsip), dan melihat pengaturan (hanya baca). **Hanya Finance Manager/Admin yang menyetujui/menerbitkan/mengembalikan pengajuan, membatalkan invoice terbit, dan membalikkan pembayaran** (otoritas koreksi; alasan wajib, tercatat). Hanya Administrator: pengguna, penomoran, pajak, produk, audit log, dan mengubah pengaturan. Admin (pemilik) tidak berubah. | Atur ulang di `src/lib/permissions.ts` (satu baris per izin + tes). |
| 14 | Visibilitas invoice | Staff melihat **seluruh** invoice (Pembayaran & Laporan memang lintas invoice). Menyunting/menghapus/mengajukan **draft** tetap hanya untuk pembuatnya. | Kembalikan ke "hanya miliknya" dengan mencabut `invoice:view` dan memberi `invoice:view_own` (konsekuensinya Pembayaran/Laporan perlu dibatasi juga). |
| 15 | Remark vs Product Description | *Remark* mengikuti **program (tetap)** — teks template produk yang dibekukan per baris; *Product Description* **dinamis** (boleh memuat nama peserta, periode, dll) dan tidak memengaruhi Remark. Remark manual tetap dapat menimpa. Baris bebas tunggal tanpa produk memakai deskripsinya. | — |
| 23 | Alur persetujuan | Staff → **Ajukan** → Finance Manager **setujui & terbitkan** / **kembalikan (alasan wajib)**. Selama menunggu verifikasi isi terkunci; staff dapat menarik kembali. **Finance Manager/Admin boleh menerbitkan draft miliknya sendiri langsung** (tanpa pengajuan) — tercatat di audit log. Persetujuan hanya sah bila hasil hitung identik dengan yang diajukan. | Wajibkan pengaju ≠ penyetuju untuk semua invoice (🔧 satu aturan di `issueInvoice`; konsekuensinya Finance tidak dapat menerbitkan invoice sendiri). |
| 24 | Dokumen belum diverifikasi | Watermark **DRAFT**, nomor "DRAFT", tanpa tanda tangan & cap, kalimat peringatan di kaki halaman; tombol unduh hanya untuk invoice terbit (pratinjau tetap tersedia untuk peninjauan). | Blokir total pratinjau/unduh sebelum disetujui (🔧). |
| 25 | Sumber tanda tangan & cap | Gambar tanda tangan/cap dan nama penandatangan berasal dari **Pengaturan** (satu penandatangan resmi: Finance Manager) dan dibekukan saat disetujui. Siapa yang menyetujui (akun) tercatat di audit log & detail invoice. | Tanda tangan per-akun penyetuju (🔧 butuh unggah tanda tangan per pengguna). |
| 16 | Nilai nol di PDF | Ditampilkan `0` (seperti contoh), bukan `Rp. 0,-`. | — |
| 17 | Zona waktu | Seluruh "hari ini", jatuh tempo, overdue, dan laporan bulanan memakai **Asia/Jakarta (WIB)**. | Ubah `APP_TIMEZONE`. |
| 18 | Mata uang | Hanya **IDR**, tanpa sen. Format tampilan dapat diganti (`Rp. 14.000.000,-`, `Rp 14.000.000`, `Rp 14.000.000,00`). | — |
| 19 | Bukti pembayaran | PNG/JPEG/PDF ≤ **3 MB**, disimpan di database (ikut backup). | Penyimpanan objek (S3) bila volume besar (🔧). |
| 20 | Retensi | Backup harian disimpan 30 hari (`BACKUP_KEEP_DAYS`). Data transaksi **tidak dihapus** (arsip/batal saja). | Sesuaikan dengan kebijakan retensi dokumen perusahaan/pajak. |
| 21 | Laporan | Operasional penagihan — **bukan laporan akuntansi** (tanpa jurnal, pengakuan pendapatan, penyesuaian). Setiap laporan memuat penafian itu. | Integrasi ke software akuntansi (di luar lingkup). |
| 22 | Keamanan akun | Password ≥ 12 karakter; terkunci 15 menit setelah 5 kegagalan; sesi idle 8 jam / maksimum 7 hari. **Belum ada MFA.** | MFA TOTP (🔧) disarankan untuk Administrator/Finance. |
