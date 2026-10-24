import { z } from "zod";
import { readJson, route } from "@/server/http";
import { setNextNumber } from "@/server/services/numbering";

export const POST = route(async ({ req, actor }) => setNextNumber(actor, await readJson(req, z.unknown())));
