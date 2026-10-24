import { z } from "zod";
import { route } from "@/server/http";
import { readFileForActor } from "@/server/services/files";
import { Errors } from "@/server/errors";

export const GET = route<{ id: string }>(async ({ actor, params }) => {
  const id = z.string().uuid().safeParse(params.id);
  if (!id.success) throw Errors.notFound("File");
  const file = await readFileForActor(actor, id.data);
  const isPdf = file.mimeType === "application/pdf";
  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(file.size),
      // File bukti bayar diunduh (bukan dirender inline di origin kita) — mencegah eksekusi konten tak terduga.
      "Content-Disposition": `${isPdf || file.kind === "PAYMENT_PROOF" ? "attachment" : "inline"}; filename="${file.originalName}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, max-age=3600, immutable",
    },
  });
});
