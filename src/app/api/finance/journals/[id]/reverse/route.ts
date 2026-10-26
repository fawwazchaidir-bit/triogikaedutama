import { z } from "zod";
import { readJson, route } from "@/server/http";
import { reverseJournal } from "@/server/services/journals";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => reverseJournal(actor, params.id, await readJson(req, z.unknown())));
