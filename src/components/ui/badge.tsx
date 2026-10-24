import { cn } from "@/lib/cn";

type Tone = "gray" | "green" | "amber" | "red" | "blue" | "dark";

const TONES: Record<Tone, string> = {
  gray: "bg-stone-100 text-stone-700 ring-stone-200",
  green: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-brand-50 text-brand-700 ring-brand-200",
  blue: "bg-sky-50 text-sky-800 ring-sky-200",
  dark: "bg-ink text-white ring-ink",
};

export function Badge({ tone = "gray", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap", TONES[tone], className)}>
      {children}
    </span>
  );
}

export type InvoiceStatus = "DRAFT" | "ISSUED" | "CANCELLED";
export type PaymentStatusValue = "UNPAID" | "PARTIALLY_PAID" | "PAID";

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const map: Record<InvoiceStatus, [Tone, string]> = {
    DRAFT: ["gray", "Draft"],
    ISSUED: ["blue", "Diterbitkan"],
    CANCELLED: ["dark", "Dibatalkan"],
  };
  const [tone, label] = map[status];
  return <Badge tone={tone}>{label}</Badge>;
}

/** `overdue` diturunkan dari jatuh tempo + saldo (tidak disimpan). */
export function PaymentStatusBadge({ status, overdue, invoiceStatus }: { status: PaymentStatusValue; overdue?: boolean; invoiceStatus?: InvoiceStatus }) {
  if (invoiceStatus && invoiceStatus !== "ISSUED") return <span className="text-muted">—</span>;
  if (overdue && status !== "PAID") {
    return <Badge tone="red">{status === "PARTIALLY_PAID" ? "Jatuh Tempo · Sebagian" : "Jatuh Tempo"}</Badge>;
  }
  const map: Record<PaymentStatusValue, [Tone, string]> = {
    UNPAID: ["amber", "Belum Dibayar"],
    PARTIALLY_PAID: ["blue", "Dibayar Sebagian"],
    PAID: ["green", "Lunas"],
  };
  const [tone, label] = map[status];
  return <Badge tone={tone}>{label}</Badge>;
}
