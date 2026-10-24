import { z } from "zod";
import { created, readJson, route } from "@/server/http";
import { createUser, listUsers } from "@/server/services/users";

export const GET = route(({ actor }) => listUsers(actor));
export const POST = route(async ({ req, actor }) => created(await createUser(actor, await readJson(req, z.unknown()))));
