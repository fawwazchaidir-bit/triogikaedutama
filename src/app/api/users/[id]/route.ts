import { z } from "zod";
import { readJson, route } from "@/server/http";
import { updateUser } from "@/server/services/users";
import { uuid } from "@/lib/validation/common";

export const PATCH = route<{ id: string }>(async ({ req, actor, params }) => updateUser(actor, uuid.parse(params.id), await readJson(req, z.unknown())));
