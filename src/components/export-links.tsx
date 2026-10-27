import { Download } from "lucide-react";
import { buildQuery } from "@/lib/invoice-can";

const LABEL = { csv: "CSV", xlsx: "Excel", pdf: "PDF" } as const;

/** Tautan unduhan laporan (server component): `base` = path API, `params` = filter yang sama dengan layar. */
export function ExportLinks({ base, params = {}, formats = ["csv", "xlsx", "pdf"], size = "md" }: {
  base: string; params?: Record<string, string | number | undefined | null>; formats?: readonly (keyof typeof LABEL)[]; size?: "sm" | "md";
}) {
  return (
    <div className="flex gap-2">
      {formats.map((format) => (
        <a key={format} href={`${base}${buildQuery({ ...params, format })}`} download
          className={`inline-flex items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-medium shadow-sm hover:bg-canvas ${size === "sm" ? "h-9" : "h-10"}`}>
          <Download className="size-4" aria-hidden />{LABEL[format]}
        </a>
      ))}
    </div>
  );
}
