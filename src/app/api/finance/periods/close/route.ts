import { z } from "zod";
import { readJson, route } from "@/server/http";
import { closePeriod } from "@/server/services/periods";

export const POST = route(async ({ req, actor }) => closePeriod(actor, await readJson(req, z.unknown())));
