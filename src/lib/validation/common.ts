import { z } from "zod";

/** Teks opsional: string kosong/spasi → null; dipangkas; dibatasi panjangnya. */
export const optionalText = (max: number, label = "Teks") =>
  z.preprocess(
    (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v ?? null),
    z.string().max(max, `${label} maksimal ${max} karakter`).nullable(),
  );

export const requiredText = (min: number, max: number, label: string) =>
  z.string({ error: `${label} wajib diisi` }).trim().min(min, `${label} wajib diisi`).max(max, `${label} maksimal ${max} karakter`);

export const optionalEmail = z.preprocess(
  (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim().toLowerCase()) : v ?? null),
  z.string().email("Format email tidak valid").max(200).nullable(),
);

/** NPWP: angka, titik, strip; maksimal 30 karakter. */
export const optionalNpwp = z.preprocess(
  (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v ?? null),
  z.string().regex(/^[0-9.\-\s]{5,30}$/, "NPWP hanya boleh berisi angka, titik, dan strip").nullable(),
);

export const optionalPhone = z.preprocess(
  (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v ?? null),
  z.string().regex(/^[0-9+()\-\s./]{5,30}$/, "Nomor telepon tidak valid").nullable(),
);

export const uuid = z.string().uuid("ID tidak valid");

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Tanggal harus berformat YYYY-MM-DD");

export const rupiah = (label: string) =>
  z
    .number({ error: `${label} harus berupa angka` })
    .int(`${label} harus berupa bilangan bulat Rupiah`)
    .min(0, `${label} tidak boleh negatif`)
    .max(999_999_999_999_999, `${label} terlalu besar`);

/** Normalisasi nama untuk deteksi duplikasi: huruf kecil, tanpa badan usaha & tanda baca. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(pt|cv|ud|pd|yayasan|koperasi|tbk|persero|firma|fa|the)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeCity(city: string | null | undefined): string {
  return (city ?? "").toLowerCase().replace(/\b(kota|kabupaten|kab)\b\.?/g, " ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
