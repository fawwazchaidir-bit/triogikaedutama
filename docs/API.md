# API

REST JSON di bawah `/api`. Dipakai oleh UI aplikasi; dapat dipakai pihak lain **dari browser pada origin yang sama**
(autentikasi = cookie sesi). Belum ada token API untuk server-ke-server (lihat [BUSINESS-DECISIONS.md](BUSINESS-DECISIONS.md) #6).

## Konvensi

- **Autentikasi:** `POST /api/auth/login` mengatur cookie `HttpOnly; SameSite=Lax` (`__Host-tes_session` di HTTPS). Semua endpoint lain menolak tanpa sesi (`401`).
- **CSRF:** request yang mengubah data (`POST/PUT/PATCH/DELETE`) wajib membawa header `Origin` yang **sama dengan host** aplikasi
  (browser mengirimnya otomatis), atau `Sec-Fetch-Site: same-origin`. Selain itu `403`.
- **Format sukses:** `{ "data": … }`. **Format error:** `{ "error": { "code", "message", "fieldErrors"? , …detail } }`.
  `code`: `BAD_REQUEST 400 · UNAUTHENTICATED 401 · FORBIDDEN 403 · NOT_FOUND 404 · CONFLICT 409 · VALIDATION 422 · RATE_LIMITED 429 · INTERNAL 500`.
  Pesan selalu Bahasa Indonesia dan aman ditampilkan; detail internal tidak pernah dikirim.
- **Uang:** bilangan bulat Rupiah (`number`). **Tanggal:** `YYYY-MM-DD` (zona Asia/Jakarta). **Waktu:** ISO-8601 UTC.
- **Paginasi:** `?page=1&pageSize=20` → `{ items, total, page, pageSize, pageCount }`.
- **Izin:** dicek di service; tabel di bawah menyebut izin minimum. `404` dipakai (bukan `403`) bila Staff menyunting/menghapus/mengajukan draft milik orang lain.

## Endpoint

| Metode & path | Izin | Fungsi |
|---|---|---|
| `POST /api/auth/login` · `POST /api/auth/logout` · `POST /api/auth/password` · `GET /api/me` | publik · login | Sesi & ganti password sendiri |
| `GET /api/health` | publik | Health check (`{status:"ok"}`) |
| `GET/POST /api/invoices` | `invoice:view(_own)` · `invoice:create` | Daftar (filter: `q from to customerId status[DRAFT|SUBMITTED|ISSUED|CANCELLED] paymentStatus sort dir`) · buat **draft** |
| `GET/PUT/DELETE /api/invoices/:id` | lihat · `invoice:create` | Detail · ubah draft (`expectedVersion` → optimistic locking) · hapus draft |
| `POST /api/invoices/:id/submit` | `invoice:submit` | Ajukan draft sendiri untuk verifikasi → `SUBMITTED` (isi terkunci); `409` bila pajak nonaktif/pelanggan diarsipkan |
| `POST /api/invoices/:id/recall` | `invoice:submit` | Tarik kembali pengajuan sendiri → `DRAFT` |
| `POST /api/invoices/:id/reject` | `invoice:approve` | Kembalikan ke staff `{ reason }` (5–300 karakter) → `DRAFT` |
| `POST /api/invoices/:id/issue` | `invoice:approve` | **Setujui & terbitkan** (`{ expectedTotalAmount? }`) dari `SUBMITTED` atau `DRAFT`; `409` bila sudah terbit, total berubah, atau hasil hitung berbeda dari yang diajukan |
| `POST /api/invoices/:id/cancel` | `invoice:cancel` | `{ reason, createReplacement? }` |
| `POST /api/invoices/:id/duplicate` | `invoice:create` | Salin sebagai draft baru |
| `GET /api/invoices/:id/pdf[?download=1]` | `invoice:pdf` / `invoice:preview_draft` | PDF **A4 landscape** dari data tersimpan. Draft/menunggu verifikasi → watermark DRAFT tanpa nomor/cap/tanda tangan; unduhan tercatat di audit |
| `GET /api/invoices/:id/history` | `invoice:history` | Riwayat audit invoice |
| `GET /api/invoices/export?format=csv\|xlsx&…filter` | lihat | Ekspor sesuai filter daftar |
| `GET/POST /api/payments` · `POST /api/payments/:id/reverse` · `POST /api/payments/proof` | `payment:view` · `payment:record` · `payment:reverse` | Ledger; catat (`cashAccountId` opsional — default menurut metode); pembalikan (`{reason}`); unggah bukti (multipart) |
| `GET/POST /api/customers` · `GET/PUT/PATCH /api/customers/:id` · `GET /api/customers/search?q=` | `customer:*` | Master pelanggan (`PATCH {isActive}` = arsip/aktifkan); `409 needsConfirmation` untuk kemiripan |
| `GET/POST /api/products` · `PUT /api/products/:id` · `GET /api/products/search?q=` | `product:*` | Master produk |
| `GET/POST /api/tax` · `PATCH /api/tax/:id` | `tax:manage` (`?activeOnly=true` untuk pembuat invoice) | Konfigurasi pajak |
| `GET/PATCH /api/settings` · `POST /api/settings/files` | `settings:view` · `settings:manage` | Pengaturan perusahaan; unggah logo/cap/tanda tangan |
| `GET/PATCH /api/settings/numbering` · `POST …/numbering/confirm` · `POST …/numbering/next` | `numbering:manage` | Format, aktivasi, naikkan nomor |
| `GET/POST /api/settings/banks` · `PATCH /api/settings/banks/:id` | `settings:*` | Rekening bank |
| `GET/POST /api/users` · `PATCH /api/users/:id` · `POST /api/users/:id/password` | `user:manage` | Pengguna |
| `GET /api/dashboard?from&to&customerId&status&paymentStatus&q` | `dashboard:view` | Metrik & tren |
| `GET /api/reports/:type?format=json\|csv\|xlsx&from&to&customerId` | `report:view` | `invoices by-customer by-product payments receivables overdue paid cancelled monthly` |
| `GET /api/audit-logs?q&action&entityType&entityId&from&to&page` | `audit:view` | Audit log |
| `GET/POST /api/finance/entries` · `DELETE …/:id` · `POST …/:id/approve\|reject\|reverse` | `expense:record` · `expense:view_own`/`finance:view` · `expense:approve` · `expense:void` | Entri kas manual (pengeluaran: staff → `PENDING`); `DELETE` hanya pengajuan sendiri yang menunggu; `reject`/`reverse` butuh `{ reason }` |
| `GET/POST /api/finance/transfers` · `POST …/:id/reverse` | `finance:view` · `cash:record` · `expense:void` | Transfer antar akun kas/bank |
| `GET/POST /api/finance/cash-accounts` · `PATCH …/:id` · `GET …/options` | `finance:view` · `finance:manage` · (opsi: pencatat) | Akun kas/bank + saldo awal; `options` = pilihan aktif tanpa saldo |
| `GET/POST /api/finance/coa` · `PATCH …/:id` | `finance:view`/`expense:record` · `finance:manage` | Bagan akun (staff hanya melihat kategori beban yang boleh dipilih) |
| `GET /api/finance/ledger?accountId&from&to` | `finance:view` | Buku kas satu akun dengan saldo berjalan |
| `GET /api/finance/statements/:type?format=json\|csv\|xlsx\|pdf&from&to&accountId&compare=none\|previous\|year` | `finance:view` | `cash-flow`, `income-statement` (dari buku besar), `balance-sheet`, `trial-balance` (per `to`), `general-ledger` (wajib `accountId`); tanpa `from` = 1 Jan tahun `to`; `compare` (hanya laba rugi, neraca, arus kas) menambah kolom pembanding/selisih/%; ekspor dicatat di audit |
| `GET/POST /api/finance/journals` · `POST …/:id/reverse` | `finance:view` · `journal:record` · `expense:void` + `journal:record` | Jurnal manual (`kind` GENERAL/OPENING, `lines[{accountId,debit,credit,memo}]` seimbang); pembalikan butuh `{ reason }` |
| `GET /api/finance/journal-book?from&to&source&page` | `finance:view` | Buku jurnal gabungan (saldo awal kas, pembayaran, entri kas, transfer, manual) |
| `GET /api/finance/books-lock` | `finance:view` | Tanggal kunci buku `{ lockedThrough }` (hanya baca — dipelihara dari periode yang ditutup) |
| `GET /api/finance/periods` | `finance:view` | Daftar periode bulanan (status, foto ringkas, `verified`, `canClose/canReopen`) + `lockedThrough`, `lockConsistent` |
| `GET /api/finance/periods/checklist?year&month` | `finance:view` | Daftar periksa penutupan: butir `HARD`/`SOFT`, `ok`, `detail`, `closable` |
| `POST /api/finance/periods/close` · `POST …/reopen` | `books:lock` | Tutup `{ year, month, acknowledge: [id peringatan], note }` (berurutan; 409 bila syarat WAJIB gagal, 422 bila peringatan belum diakui); buka kembali `{ year, month, reason }` (hanya periode terakhir yang ditutup) |
| `GET /api/finance/taxes/overview` | `finance:view` | Ringkasan pajak: utang PPN, kredit PPh, utang PPh badan, profil |
| `GET /api/finance/taxes/:type?format=json\|csv\|xlsx\|pdf&from&to&year&month` | `finance:view` | `vat` (rekap PPN), `pph23` (register PPh dipotong), `corporate` (estimasi PPh badan); ekspor dicatat di audit |
| `GET/PUT /api/finance/taxes/profile` | `finance:view` · `finance:manage` | Profil pajak `{ isPkp, regime: NONE\|GENERAL\|FINAL, rateBps }` (tarif diisi pengguna) |
| `PUT /api/finance/taxes/year-input` | `journal:record` | Masukan tahunan PPh badan (koreksi fiskal, kompensasi rugi, pengurang pajak) |
| `POST /api/finance/taxes/corporate-journal` | `journal:record` | Bukukan jurnal estimasi PPh badan `{ year, month? }` (dihitung ulang di server, atomik) |
| `GET/POST /api/finance/taxes/payments` | `finance:view` · `cash:record` | Setoran PPN/PPh badan (kas keluar ke 2-1210/2-1230) |
| `PUT /api/payments/:id/withholding-ref` | `payment:record` | Isi/ubah nomor bukti potong pada pembayaran bertanda PPh dipotong |
| `GET /api/finance/bank/overview` · `GET/POST /api/finance/bank/statements` · `POST …/statements/preview` | `finance:view` · `bank:reconcile` | Ringkasan per akun bank; daftar/impor rekening koran (`csv` teks atau `lines[]`); pratinjau pemetaan CSV |
| `GET /api/finance/bank/statements/:id?format=json\|csv\|xlsx\|pdf` · `DELETE` | `finance:view` · `bank:reconcile` | Ruang kerja rekonsiliasi atau laporan rekonsiliasi; hapus rekening koran draft |
| `POST …/statements/:id/auto-match\|finalize\|reopen` | `bank:reconcile` | Cocokkan otomatis (tak ambigu), finalisasi (selisih harus 0), buka kembali (`{reason}`, hanya yang terakhir) |
| `POST /api/finance/bank/lines/:id/match\|unmatch\|entry` | `bank:reconcile` | Cocokkan satu baris dengan transaksi buku, batalkan, atau catat entri kas dari mutasi (`{ counterAccountId }`) |
| `POST /api/finance/proof` | `expense:record` | Unggah bukti pengeluaran (PNG/JPEG/PDF) |
| `GET /api/files/:id` | tergantung jenis | Logo/cap/tanda tangan/bukti bayar (diunduh, bukan dirender inline) |

## Contoh (dari browser pada origin yang sama)

```js
// Membuat draft invoice 7 Pax Demi Chef lalu menerbitkannya
const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());

const { data: draft } = await post("/api/invoices", {
  customerId, invoiceDate: "2026-01-13", paymentMethod: "Transfer", paymentTermDays: 4, dueDateBasis: "CALENDAR_DAYS",
  lines: [{ productId, description: "Biaya Diklat & Uji Kompetensi\nBidang Food Production\n(Skema Demi Chef)",
            quantity: 7, unit: "Pax", unitPrice: 2000000, discount: 0, taxConfigId: null }],
  extraDiscount: 0, transport: 0, admin: 0, downPayment: 0,
});
// draft.amounts.total === 14000000  (dihitung server)
const { data: issued } = await post(`/api/invoices/${draft.id}/issue`, { expectedTotalAmount: draft.amounts.total });
// issued.number === "00435", issued.dueDate === "2026-01-17"
window.open(`/api/invoices/${issued.id}/pdf`);   // pratinjau; ?download=1 untuk mengunduh
```
