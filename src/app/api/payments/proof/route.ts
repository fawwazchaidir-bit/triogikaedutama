import { created, route } from "@/server/http";
import { readUpload } from "@/server/upload";
import { storeFile } from "@/server/services/files";

/** Unggah bukti pembayaran (PNG/JPEG/PDF). Mengembalikan `id` untuk dilampirkan saat mencatat pembayaran. */
export const POST = route(async ({ req, actor }) => {
  const { name, bytes } = await readUpload(req);
  return created(await storeFile(actor, "PAYMENT_PROOF", { name, bytes }));
});
