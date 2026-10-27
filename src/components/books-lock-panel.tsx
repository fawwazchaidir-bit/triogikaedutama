import Link from "next/link";
import { Lock, LockOpen } from "lucide-react";
import { formatDateLong } from "@/lib/format";

/** Status kunci buku (hanya baca): dikelola lewat penutupan bulanan di halaman Tutup Buku. */
export function BooksLockPanel({ lockedThrough }: { lockedThrough: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
      {lockedThrough ? <Lock className="size-4 shrink-0 text-brand-700" aria-hidden /> : <LockOpen className="size-4 shrink-0 text-muted" aria-hidden />}
      <div className="min-w-0 flex-1">
        {lockedThrough
          ? <span><strong>Buku ditutup sampai {formatDateLong(lockedThrough)}.</strong> Transaksi bertanggal sampai tanggal itu ditolak; koreksi dilakukan lewat pembalikan bertanggal hari ini.</span>
          : <span><strong>Belum ada bulan yang ditutup.</strong> Transaksi bertanggal mundur masih dapat mengubah laporan periode lalu. Tutup bulan setelah laporan final.</span>}
      </div>
      <Link href="/closing" className="font-medium text-brand-700 hover:underline">Tutup Buku →</Link>
    </div>
  );
}
