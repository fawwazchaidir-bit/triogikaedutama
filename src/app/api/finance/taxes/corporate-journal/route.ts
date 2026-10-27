import { z } from "zod";
import { created, readJson, route } from "@/server/http";
import { postCorporateTaxJournal } from "@/server/services/finance-tax";

export const POST = route(async ({ req, actor }) => created(await postCorporateTaxJournal(actor, await readJson(req, z.unknown()))));
