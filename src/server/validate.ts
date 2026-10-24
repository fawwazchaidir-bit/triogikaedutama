import "server-only";
import { ZodError, type ZodType } from "zod";
import { Errors } from "./errors";

/**
 * Validasi input service → `AppError(VALIDATION)` dengan pesan per-field (Bahasa Indonesia).
 * Dipakai di SEMUA service agar perilaku sama baik dipanggil lewat API, halaman server, seed, maupun test.
 */
export function parseInput<T>(schema: ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  throw zodToAppError(r.error);
}

export function zodToAppError(err: ZodError) {
  const fieldErrors = zodFieldErrors(err);
  return Errors.validation(Object.values(fieldErrors)[0] ?? "Data tidak valid.", fieldErrors);
}

export function zodFieldErrors(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join(".") || "_";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
