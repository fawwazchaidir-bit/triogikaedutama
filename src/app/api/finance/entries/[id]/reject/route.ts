import { z } from "zod";
import { readJson, route } from "@/server/http";
import { rejectEntry } from "@/server/services/cash-entries";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => rejectEntry(actor, params.id, await readJson(req, z.unknown())));
