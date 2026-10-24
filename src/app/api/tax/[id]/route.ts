import { z } from "zod";
import { readJson, route } from "@/server/http";
import { updateTaxConfig } from "@/server/services/tax";
import { uuid } from "@/lib/validation/common";

export const PATCH = route<{ id: string }>(async ({ req, actor, params }) => updateTaxConfig(actor, uuid.parse(params.id), await readJson(req, z.unknown())));
