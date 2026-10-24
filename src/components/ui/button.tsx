"use client";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-200 shadow-sm",
  secondary: "bg-white text-ink border border-line hover:bg-canvas disabled:text-muted shadow-sm",
  ghost: "text-ink-soft hover:bg-black/5 disabled:text-muted",
  danger: "bg-white text-brand-700 border border-brand-200 hover:bg-brand-50 disabled:text-muted",
};
const SIZES: Record<Size, string> = { sm: "h-8 px-3 text-sm gap-1.5", md: "h-10 px-4 text-sm gap-2" };

export function Button({
  variant = "secondary", size = "md", loading = false, className, children, disabled, type = "button", ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean }) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center rounded-md font-medium transition-colors disabled:cursor-not-allowed",
        VARIANTS[variant], SIZES[size], className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}
