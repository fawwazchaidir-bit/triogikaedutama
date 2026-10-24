import { z } from "zod";
import { readJson, route } from "@/server/http";
import { confirmNumbering } from "@/server/services/numbering";

export const POST = route(async ({ req, actor }) => confirmNumbering(actor, await readJson(req, z.unknown())));
