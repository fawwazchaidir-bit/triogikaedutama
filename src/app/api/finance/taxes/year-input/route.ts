import { z } from "zod";
import { readJson, route } from "@/server/http";
import { saveTaxYearInput } from "@/server/services/finance-tax";

export const PUT = route(async ({ req, actor }) => saveTaxYearInput(actor, await readJson(req, z.unknown())));
