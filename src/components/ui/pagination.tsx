import Link from "next/link";
import { cn } from "@/lib/cn";

/** Pagination berbasis URL (server component friendly): `hrefFor(page)` membangun query string. */
export function Pagination({ page, pageCount, total, hrefFor }: { page: number; pageCount: number; total: number; hrefFor: (p: number) => string }) {
  if (pageCount <= 1) return <p className="px-5 py-3 text-xs text-muted">{total} data</p>;
  const link = "rounded-md border border-line bg-white px-3 py-1.5 text-sm hover:bg-canvas";
  return (
    <nav aria-label="Halaman" className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
      <p className="text-xs text-muted">{total} data · halaman {page} dari {pageCount}</p>
      <div className="flex gap-2">
        {page > 1 ? <Link href={hrefFor(page - 1)} className={link}>← Sebelumnya</Link> : <span className={cn(link, "pointer-events-none opacity-40")}>← Sebelumnya</span>}
        {page < pageCount ? <Link href={hrefFor(page + 1)} className={link}>Berikutnya →</Link> : <span className={cn(link, "pointer-events-none opacity-40")}>Berikutnya →</span>}
      </div>
    </nav>
  );
}
