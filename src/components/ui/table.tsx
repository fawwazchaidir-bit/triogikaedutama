import { cn } from "@/lib/cn";

/** Pembungkus tabel responsif: scroll horizontal di layar sempit tanpa memecah layout halaman. */
export function TableWrap({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("overflow-x-auto", className)}>{children}</div>;
}

export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return <table className={cn("w-full min-w-max border-collapse text-sm", className)}>{children}</table>;
}

export function Th({ children, className, align = "left" }: { children?: React.ReactNode; className?: string; align?: "left" | "right" | "center" }) {
  return (
    <th scope="col" className={cn(
      "whitespace-nowrap border-b border-line bg-canvas/70 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted",
      align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left", className,
    )}>
      {children}
    </th>
  );
}

export function Td({ children, className, align = "left", mono }: { children?: React.ReactNode; className?: string; align?: "left" | "right" | "center"; mono?: boolean }) {
  return (
    <td className={cn(
      "border-b border-line/70 px-4 py-3 align-top",
      align === "right" ? "text-right tabular" : align === "center" ? "text-center" : "text-left",
      mono && "font-mono text-[13px]", className,
    )}>
      {children}
    </td>
  );
}
