"use client";
import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";

/** Menu aksi sederhana (klik di luar / Esc menutup). Item `danger` bernada merah. */
export function Menu({ items, label = "Aksi" }: {
  label?: string;
  items: ({ label: string; onSelect?: () => void; href?: string; danger?: boolean; download?: boolean; hidden?: boolean } | "sep")[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const visible = items.filter((i) => i === "sep" || !i.hidden);
  const cls = "block w-full px-3 py-2 text-left text-sm hover:bg-canvas";
  return (
    <div ref={ref} className="relative inline-block">
      <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)}
        className="inline-flex size-8 items-center justify-center rounded-md border border-line bg-white text-ink-soft hover:bg-canvas">
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1 w-52 overflow-hidden rounded-md border border-line bg-white py-1 shadow-lg">
          {visible.map((it, i) =>
            it === "sep" ? <hr key={i} className="my-1 border-line" /> : it.href ? (
              <a key={i} role="menuitem" href={it.href} {...(it.download ? { download: true } : {})} className={cn(cls, it.danger && "text-brand-700")} onClick={() => setOpen(false)}>{it.label}</a>
            ) : (
              <button key={i} type="button" role="menuitem" className={cn(cls, it.danger && "text-brand-700")} onClick={() => { setOpen(false); it.onSelect?.(); }}>{it.label}</button>
            ))}
        </div>
      )}
    </div>
  );
}
