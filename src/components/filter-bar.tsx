import Link from "next/link";
import { Button } from "@/components/ui/button";
import { controlClass } from "@/components/ui/styles";

/**
 * Bilah filter berbasis URL (form GET): hasil dapat di-bookmark/dibagikan, dan halaman tetap server-rendered.
 * Satu baris di atas konten yang dicakupnya.
 */
export function FilterBar({ action, children, resetHref }: { action: string; children: React.ReactNode; resetHref: string }) {
  return (
    <form method="get" action={action} className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-4 shadow-sm">
      {children}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" className="h-9">Terapkan</Button>
        <Link href={resetHref} className="inline-flex h-9 items-center rounded-md border border-line bg-white px-3 text-sm hover:bg-canvas">Reset</Link>
      </div>
    </form>
  );
}

export function FilterField({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1 text-xs font-medium text-muted ${className ?? ""}`}>
      {label}
      {children}
    </label>
  );
}

export const filterInput = controlClass;
