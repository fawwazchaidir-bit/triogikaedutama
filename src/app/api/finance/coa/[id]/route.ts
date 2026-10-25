import { z } from "zod";
import { readJson, route } from "@/server/http";
import { updateCoaAccount } from "@/server/services/finance-coa";

export const PATCH = route<{ id: string }>(async ({ req, actor, params }) => updateCoaAccount(actor, params.id, await readJson(req, z.unknown())));
