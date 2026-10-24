"use client";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { CONTROL } from "./styles";

/**
 * Autocomplete aksesibel (WAI-ARIA combobox/listbox): ketik untuk mencari, ↑↓ memilih, Enter memilih, Esc menutup.
 * Hasil diambil lewat `search` (debounce 200 ms); respons usang diabaikan agar urutan hasil tidak tertukar.
 */
export function Combobox<T>({
  value, onValueChange, search, onSelect, renderItem, itemKey, placeholder, disabled, ariaLabel, emptyText = "Tidak ditemukan", footer, className, invalid,
}: {
  value: string; onValueChange: (v: string) => void; search: (q: string) => Promise<T[]>; onSelect: (item: T) => void;
  renderItem: (item: T) => React.ReactNode; itemKey: (item: T) => string; placeholder?: string; disabled?: boolean;
  ariaLabel: string; emptyText?: string; footer?: React.ReactNode; className?: string; invalid?: boolean;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const run = (q: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const mine = ++seq.current;
      setLoading(true);
      try {
        const r = await search(q);
        if (mine === seq.current) { setItems(r); setActive(0); }
      } catch { if (mine === seq.current) setItems([]); }
      finally { if (mine === seq.current) setLoading(false); }
    }, 200);
  };

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const choose = (it: T) => { onSelect(it); setOpen(false); };

  return (
    <div ref={box} className={cn("relative", className)}>
      <input
        role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-label={ariaLabel} aria-invalid={invalid}
        aria-activedescendant={open && items[active] ? `${listId}-${active}` : undefined}
        autoComplete="off" disabled={disabled} placeholder={placeholder} value={value}
        className={cn(CONTROL, "h-10", invalid && "border-brand-600")}
        onChange={(e) => { onValueChange(e.target.value); setOpen(true); run(e.target.value); }}
        onFocus={() => { setOpen(true); run(value); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, Math.max(items.length - 1, 0))); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Enter" && open && items[active]) { e.preventDefault(); choose(items[active]); }
          else if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && (
        <div className="absolute z-30 mt-1 w-full min-w-64 overflow-hidden rounded-md border border-line bg-white shadow-lg">
          <ul id={listId} role="listbox" className="max-h-64 overflow-y-auto py-1">
            {items.map((it, i) => (
              <li key={itemKey(it)} id={`${listId}-${i}`} role="option" aria-selected={i === active}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); choose(it); }}
                className={cn("cursor-pointer px-3 py-2 text-sm", i === active ? "bg-brand-50" : "hover:bg-canvas")}>
                {renderItem(it)}
              </li>
            ))}
            {!loading && items.length === 0 && <li className="px-3 py-2 text-sm text-muted">{emptyText}</li>}
            {loading && items.length === 0 && <li className="px-3 py-2 text-sm text-muted">Mencari…</li>}
          </ul>
          {footer && <div className="border-t border-line bg-canvas/60 px-3 py-2 text-sm">{footer}</div>}
        </div>
      )}
    </div>
  );
}
