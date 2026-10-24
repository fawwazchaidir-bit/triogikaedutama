import { created, route } from "@/server/http";
import { readUpload } from "@/server/upload";
import { storeFile } from "@/server/services/files";
import { writeAudit } from "@/server/audit";
import { prisma } from "@/server/db";
import { Errors } from "@/server/errors";

/** Unggah logo/cap/tanda tangan. Setelah berhasil, klien menautkan `id` lewat PATCH /api/settings. */
export const POST = route(async ({ req, actor }) => {
  const { name, bytes, fields } = await readUpload(req);
  const kind = fields.kind;
  if (kind !== "LOGO" && kind !== "STAMP" && kind !== "SIGNATURE") throw Errors.validation("Jenis file tidak valid.");
  const file = await storeFile(actor, kind, { name, bytes });
  await writeAudit(prisma, actor, { action: "settings.file_upload", entityType: "StoredFile", entityId: file.id, summary: `Unggah ${kind.toLowerCase()} (${name})` });
  return created(file);
});
