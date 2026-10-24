import { z } from "zod";
import { readJson, route } from "@/server/http";
import { getSettings, updateCompanySettings } from "@/server/services/settings";

export const GET = route(({ actor }) => getSettings(actor));
export const PATCH = route(async ({ req, actor }) => updateCompanySettings(actor, await readJson(req, z.unknown())));
