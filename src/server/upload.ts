import "server-only";
import { env } from "./env";
import { Errors } from "./errors";

/** Ambil satu file dari multipart/form-data dengan batas ukuran yang diperiksa SEBELUM dibaca ke memori. */
export async function readUpload(req: Request, field = "file"): Promise<{ name: string; bytes: Uint8Array; fields: Record<string, string> }> {
  const maxBytes = env().MAX_UPLOAD_MB * 1024 * 1024;
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes + 64 * 1024) throw Errors.validation(`Ukuran file maksimal ${env().MAX_UPLOAD_MB} MB.`);
  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("multipart/form-data")) {
    throw Errors.badRequest("Gunakan multipart/form-data.");
  }
  let form: FormData;
  try { form = await req.formData(); } catch { throw Errors.badRequest("Form unggahan tidak valid."); }
  const file = form.get(field);
  if (!(file instanceof File)) throw Errors.validation("File wajib dipilih.");
  if (file.size > maxBytes) throw Errors.validation(`Ukuran file maksimal ${env().MAX_UPLOAD_MB} MB.`);
  const fields: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") fields[k] = v;
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), fields };
}
