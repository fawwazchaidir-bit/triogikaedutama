"use client";
import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

/** Dialog memakai elemen <dialog> native: focus-trap, Esc, dan aksesibilitas ditangani browser. */
export function Dialog({
  open, onClose, title, description, children, footer, size = "md",
}: {
  open: boolean; onClose: () => void; title: string; description?: string;
  children: React.ReactNode; footer?: React.ReactNode; size?: "sm" | "md" | "lg" | "xl";
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  const widths = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl", xl: "max-w-5xl" } as const;

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className={cn("w-[calc(100%-2rem)] rounded-xl border border-line bg-surface p-0 shadow-2xl", widths[size])}
      aria-labelledby="dlg-title"
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
            <div>
              <h2 id="dlg-title" className="text-lg font-semibold text-ink">{title}</h2>
              {description && <p className="mt-1 text-sm text-muted">{description}</p>}
            </div>
            <button type="button" onClick={onClose} aria-label="Tutup" className="rounded-md p-1 text-muted hover:bg-black/5">
              <X className="size-5" />
            </button>
          </header>
          <div className="overflow-y-auto px-6 py-5">{children}</div>
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line bg-canvas/60 px-6 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

/** Konfirmasi tindakan berisiko (terbitkan, batalkan, balikkan pembayaran, dst.). */
export function ConfirmDialog({
  open, onClose, onConfirm, title, description, confirmLabel, tone = "primary", loading, children,
}: {
  open: boolean; onClose: () => void; onConfirm: () => void; title: string; description?: string;
  confirmLabel: string; tone?: "primary" | "danger"; loading?: boolean; children?: React.ReactNode;
}) {
  return (
    <Dialog
      open={open} onClose={loading ? () => undefined : onClose} title={title} description={description} size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={loading}>Batal</Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
