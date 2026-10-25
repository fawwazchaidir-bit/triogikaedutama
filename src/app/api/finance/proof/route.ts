import { created, route } from "@/server/http";
import { readUpload } from "@/server/upload";
import { storeFile } from "@/server/services/files";

/** Unggah bukti pengeluaran (PNG/JPEG/PDF). Mengembalikan `id` untuk dilampirkan saat mencatat pengeluaran. */
export const POST = route(async ({ req, actor }) => {
  const { name, bytes } = await readUpload(req);
  return created(await storeFile(actor, "EXPENSE_PROOF", { name, bytes }));
});
