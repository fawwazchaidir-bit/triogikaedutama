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
- **Izin:** dicek di service; tabel di bawah menyebut izin minimum. `404` dipakai (bukan `403`) untuk invoice milik orang lain bagi Staff.

## Endpoint

| Metode & path | Izin | Fungsi |
|---|---|---|
| `POST /api/auth/login` · `POST /api/auth/logout` · `POST /api/auth/password` · `GET /api/me` | publik · login | Sesi & ganti password sendiri |
| `GET /api/health` | publik | Health check (`{status:"ok"}`) |
| `GET/POST /api/invoices` | `invoice:view(_own)` · `invoice:create` | Daftar (filter: `q from to customerId status paymentStatus sort dir`) · buat **draft** |
| `GET/PUT/DELETE /api/invoices/:id` | lihat · `invoice:create` | Detail · ubah draft (`expectedVersion` → optimistic locking) · hapus draft |
| `POST /api/invoices/:id/issue` | `invoice:issue` | Terbitkan (`{ expectedTotalAmount? }`); `409` bila sudah terbit/total berubah |
| `POST /api/invoices/:id/cancel` | `invoice:cancel` | `{ reason, createReplacement? }` |
| `POST /api/invoices/:id/duplicate` | `invoice:create` | Salin sebagai draft baru |
| `GET /api/invoices/:id/pdf[?download=1]` | `invoice:pdf` / `invoice:preview_draft` | PDF dari snapshot tersimpan; unduhan tercatat di audit |
| `GET /api/invoices/:id/history` | `invoice:history` | Riwayat audit invoice |
| `GET /api/invoices/export?format=csv\|xlsx&…filter` | lihat | Ekspor sesuai filter daftar |
| `GET/POST /api/payments` · `POST /api/payments/:id/reverse` · `POST /api/payments/proof` | `payment:view` · `payment:record` · `payment:reverse` | Ledger; catat; pembalikan (`{reason}`); unggah bukti (multipart) |
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
