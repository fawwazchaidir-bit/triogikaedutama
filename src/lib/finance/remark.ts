import { flattenDescription } from "./description-template";

/**
 * Remark yang dicetak di PDF: isian pengguna bila ada; bila kosong dan hanya ada SATU baris,
 * otomatis memakai deskripsi baris itu dalam satu kalimat (seperti invoice referensi).
 */
export function resolveRemark(remark: string | null | undefined, descriptions: string[]): string | null {
  const manual = remark?.trim();
  if (manual) return manual;
  if (descriptions.length === 1 && descriptions[0]) return flattenDescription(descriptions[0]);
  return null;
}
