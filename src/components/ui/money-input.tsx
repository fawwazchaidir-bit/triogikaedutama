"use client";
import { useId } from "react";
import { cn } from "@/lib/cn";
import { formatNumberId, MAX_AMOUNT } from "@/lib/finance/money";
import { CONTROL } from "./styles";
import { Field } from "./field";

/** Parse digit-only dari ketikan pengguna → bilangan bulat Rupiah (atau null bila kosong). */
function parse(raw: string): number | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  return Math.min(Number(digits.slice(0, 15)), MAX_AMOUNT);
}

/** Input Rupiah dengan pemisah ribuan otomatis (mis. 14.000.000). Menyimpan angka bulat, bukan string. */
export function MoneyInput({
  label, value, onChange, error, hint, required, disabled, className, id,
}: {
  label: string; value: number | null; onChange: (v: number | null) => void; error?: string; hint?: string;
  required?: boolean; disabled?: boolean; className?: string; id?: string;
}) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} error={error} hint={hint} required={required} htmlFor={fid} className={className}>
      <div className="relative">
        <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">Rp</span>
        <input
          id={fid} inputMode="numeric" autoComplete="off" disabled={disabled} aria-invalid={!!error}
          value={value === null ? "" : formatNumberId(value)}
          onChange={(e) => onChange(parse(e.target.value))}
          className={cn(CONTROL, "tabular h-10 pl-9 text-right", error && "border-brand-600")}
        />
      </div>
    </Field>
  );
}

/** Varian tanpa label untuk sel tabel. */
export function MoneyCell({ value, onChange, disabled, ariaLabel, className }: {
  value: number | null; onChange: (v: number | null) => void; disabled?: boolean; ariaLabel: string; className?: string;
}) {
  return (
    <input
      aria-label={ariaLabel} inputMode="numeric" autoComplete="off" disabled={disabled}
      value={value === null ? "" : formatNumberId(value)}
      onChange={(e) => onChange(parse(e.target.value))}
      className={cn(CONTROL, "tabular h-9 text-right", className)}
    />
  );
}
