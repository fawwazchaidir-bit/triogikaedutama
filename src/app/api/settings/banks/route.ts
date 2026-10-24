import { z } from "zod";
import { created, readJson, route } from "@/server/http";
import { createBankAccount, listBankAccounts } from "@/server/services/settings";

export const GET = route(({ actor }) => listBankAccounts(actor));
export const POST = route(async ({ req, actor }) => created(await createBankAccount(actor, await readJson(req, z.unknown()))));
