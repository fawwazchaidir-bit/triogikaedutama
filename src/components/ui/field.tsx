"use client";
import { useId } from "react";
import { cn } from "@/lib/cn";

const CONTROL =
  "w-full rounded-md border border-line bg-white px-3 text-sm text-ink placeholder:text-muted/70 " +
  "focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20 disabled:bg-canvas disabled:text-muted";

export function Field({
  label, error, hint, required, children, className, htmlFor,
}: {
  label: string; error?: string; hint?: string; required?: boolean; htmlFor?: string;
  children: React.ReactNode; className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink-soft">
        {label}{required && <span className="text-brand-600" aria-hidden> *</span>}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
      {error && <p role="alert" className="text-xs font-medium text-brand-700">{error}</p>}
    </div>
  );
}

type InputProps = React.InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string };

export function TextField({ label, error, hint, className, required, id, ...rest }: InputProps) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} error={error} hint={hint} required={required} htmlFor={fid} className={className}>
      <input id={fid} required={required} aria-invalid={!!error} className={cn(CONTROL, "h-10", error && "border-brand-600")} {...rest} />
    </Field>
  );
}

type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & { label: string; error?: string; hint?: string };

export function SelectField({ label, error, hint, className, required, id, children, ...rest }: SelectProps) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} error={error} hint={hint} required={required} htmlFor={fid} className={className}>
      <select id={fid} required={required} aria-invalid={!!error} className={cn(CONTROL, "h-10", error && "border-brand-600")} {...rest}>
        {children}
      </select>
    </Field>
  );
}

type TextAreaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; error?: string; hint?: string };

export function TextAreaField({ label, error, hint, className, required, id, ...rest }: TextAreaProps) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} error={error} hint={hint} required={required} htmlFor={fid} className={className}>
      <textarea id={fid} required={required} aria-invalid={!!error} className={cn(CONTROL, "py-2", error && "border-brand-600")} {...rest} />
    </Field>
  );
}

/** Kontrol polos (tanpa label) untuk sel tabel & filter. */
export const controlClass = cn(CONTROL, "h-9");
export const rawControlClass = CONTROL;
