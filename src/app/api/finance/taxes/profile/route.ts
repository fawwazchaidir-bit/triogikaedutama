import { z } from "zod";
import { readJson, route } from "@/server/http";
import { getTaxProfile, updateTaxProfile } from "@/server/services/finance-tax";

export const GET = route(({ actor }) => getTaxProfile(actor));
export const PUT = route(async ({ req, actor }) => updateTaxProfile(actor, await readJson(req, z.unknown())));
