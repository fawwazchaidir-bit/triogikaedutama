import { z } from "zod";
import { readJson, route } from "@/server/http";
import { reverseTransfer } from "@/server/services/cash-entries";

export const POST = route<{ id: string }>(async ({ req, actor, params }) => reverseTransfer(actor, params.id, await readJson(req, z.unknown())));
