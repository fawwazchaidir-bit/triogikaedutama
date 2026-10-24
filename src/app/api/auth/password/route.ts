import { z } from "zod";
import { readJson, route } from "@/server/http";
import { changeOwnPassword } from "@/server/services/auth";

const schema = z.object({
  currentPassword: z.string().min(1, "Password saat ini wajib diisi").max(256),
  newPassword: z.string().min(1, "Password baru wajib diisi").max(128),
});

export const POST = route(
  async ({ req, actor }) => {
    await changeOwnPassword(actor, await readJson(req, schema));
    return { ok: true };
  },
  { allowMustChange: true },
);
