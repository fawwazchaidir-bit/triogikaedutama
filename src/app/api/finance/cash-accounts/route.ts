import { z } from "zod";
import { created, readJson, route } from "@/server/http";
import { createCashAccount, listCashAccounts } from "@/server/services/cash-accounts";

export const GET = route(({ actor }) => listCashAccounts(actor));
export const POST = route(async ({ req, actor }) => created(await createCashAccount(actor, await readJson(req, z.unknown()))));
