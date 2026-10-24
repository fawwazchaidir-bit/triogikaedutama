import { z } from "zod";
import { readJson, route } from "@/server/http";
import { getNumberingStatus, updateNumberingConfig } from "@/server/services/numbering";

export const GET = route(({ actor }) => getNumberingStatus(actor));
export const PATCH = route(async ({ req, actor }) => updateNumberingConfig(actor, await readJson(req, z.unknown())));
