import { z } from "zod";
import { readJson, route } from "@/server/http";
import { readBooksLock, setBooksLock } from "@/server/services/books-lock";

export const GET = route(({ actor }) => readBooksLock(actor));
export const PUT = route(async ({ req, actor }) => setBooksLock(actor, await readJson(req, z.unknown())));
