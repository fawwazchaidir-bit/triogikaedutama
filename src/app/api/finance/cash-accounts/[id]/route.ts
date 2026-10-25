import { z } from "zod";
import { readJson, route } from "@/server/http";
import { updateCashAccount } from "@/server/services/cash-accounts";

export const PATCH = route<{ id: string }>(async ({ req, actor, params }) => updateCashAccount(actor, params.id, await readJson(req, z.unknown())));
