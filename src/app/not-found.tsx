import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="max-w-sm text-center">
        <p className="text-5xl font-semibold text-brand-600">404</p>
        <h1 className="mt-3 text-xl font-semibold text-ink">Halaman tidak ditemukan</h1>
        <p className="mt-2 text-sm text-muted">Halaman yang Anda cari tidak ada, atau Anda tidak memiliki akses ke halaman ini.</p>
        <Link href="/" className="mt-6 inline-flex h-10 items-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700">Kembali ke beranda</Link>
      </div>
    </main>
  );
}
