/**
 * Template deskripsi produk → deskripsi baris invoice.
 *
 *   Template : "{name}\nBidang {field}\n(Skema {scheme})"
 *   Hasil    : "Biaya Diklat & Uji Kompetensi\nBidang Food Production\n(Skema Demi Chef)"
 *
 * Aturan: baris yang mengandung placeholder KOSONG dibuang seluruhnya, sehingga produk tanpa skema
 * tidak menghasilkan "(Skema )". Placeholder yang tidak dikenal ditolak saat template disimpan.
 */

export const TEMPLATE_PLACEHOLDERS = ["name", "code", "category", "field", "scheme", "unit"] as const;
export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];
export type TemplateVars = Partial<Record<TemplatePlaceholder, string | null | undefined>>;

export const DEFAULT_DESCRIPTION_TEMPLATE = "{name}\nBidang {field}\n(Skema {scheme})";

const PLACEHOLDER_RE = /\{([a-zA-Z_]+)\}/g;

/** Mengembalikan daftar placeholder tidak dikenal (kosong = valid). */
export function findUnknownPlaceholders(template: string): string[] {
  const unknown = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    const name = m[1] as string;
    if (!(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(name)) unknown.add(name);
  }
  return [...unknown];
}

export function renderDescription(template: string, vars: TemplateVars): string {
  const out: string[] = [];
  for (const rawLine of template.replace(/\r\n?/g, "\n").split("\n")) {
    let dropped = false;
    const rendered = rawLine.replace(PLACEHOLDER_RE, (_, name: string) => {
      const value = (vars as Record<string, string | null | undefined>)[name];
      const text = typeof value === "string" ? value.trim() : "";
      if (!text) dropped = true;
      return text;
    });
    if (dropped) continue;
    const trimmed = rendered.trim();
    if (trimmed) out.push(trimmed);
  }
  return out.join("\n");
}

/** Satu baris untuk kolom "Remark": "A\nB\n(C)" → "A B (C)". */
export function flattenDescription(description: string): string {
  return description.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}
