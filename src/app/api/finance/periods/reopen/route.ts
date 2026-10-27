import { z } from "zod";
import { readJson, route } from "@/server/http";
import { reopenPeriod } from "@/server/services/periods";

export const POST = route(async ({ req, actor }) => reopenPeriod(actor, await readJson(req, z.unknown())));
