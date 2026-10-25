import { z } from "zod";
import { created, readJson, route } from "@/server/http";
import { createCoaAccount, listCoaAccounts } from "@/server/services/finance-coa";

export const GET = route(({ actor }) => listCoaAccounts(actor));
export const POST = route(async ({ req, actor }) => created(await createCoaAccount(actor, await readJson(req, z.unknown()))));
