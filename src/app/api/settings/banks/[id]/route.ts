import { z } from "zod";
import { readJson, route } from "@/server/http";
import { updateBankAccount } from "@/server/services/settings";
import { uuid } from "@/lib/validation/common";

export const PATCH = route<{ id: string }>(async ({ req, actor, params }) => updateBankAccount(actor, uuid.parse(params.id), await readJson(req, z.unknown())));
