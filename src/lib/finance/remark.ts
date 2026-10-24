import { flattenDescription } from "./description-template";

/**
 * Remark yang dicetak di PDF.
 *
 * Remark adalah keterangan PROGRAM yang TETAP (diambil dari template master produk saat baris dibuat), sehingga
 * tidak ikut berubah ketika kolom "Product Description" diisi nama peserta dll.
 *   1. Isian manual pengguna, bila ada.
 *   2. Bila tidak: teks program (unik) dari baris-baris bermaster produk, digabung dengan "; ".
 *   3. Baris bebas (tanpa produk): bila hanya ada SATU baris, pakai deskripsinya dalam satu kalimat; selain itu kosong.
 */
export function resolveRemark(
  remark: string | null | undefined,
  programTexts: (string | null | undefined)[],
  descriptions: string[] = [],
): string | null {
  const manual = remark?.trim();
  if (manual) return manual;
  const programs = [...new Set(programTexts.map((t) => t?.trim()).filter((t): t is string => !!t))];
  if (programs.length > 0) return programs.join("; ");
  if (descriptions.length === 1 && descriptions[0]) return flattenDescription(descriptions[0]);
  return null;
}
