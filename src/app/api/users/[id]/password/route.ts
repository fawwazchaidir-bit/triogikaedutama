import { z } from "zod";
import { readJson, route } from "@/server/http";
import { resetUserPassword } from "@/server/services/users";
import { uuid } from "@/lib/validation/common";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => {
  await resetUserPassword(actor, uuid.parse(params.id), await readJson(req, z.unknown()));
  return { ok: true };
});
