/**
 * Konstanta kelas yang dipakai BERSAMA oleh server & client component.
 * Jangan taruh di file "use client": nilai yang diekspor dari modul client berubah menjadi client reference
 * ketika diimpor server component (bukan string), sehingga className hilang diam-diam.
 */
import { cn } from "@/lib/cn";

export const CONTROL =
  "w-full rounded-md border border-line bg-white px-3 text-sm text-ink placeholder:text-muted/70 " +
  "focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20 disabled:bg-canvas disabled:text-muted";

/** Kontrol polos (tanpa label) untuk sel tabel & filter. */
export const controlClass = cn(CONTROL, "h-9");
