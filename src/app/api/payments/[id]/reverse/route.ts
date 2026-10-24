import { z } from "zod";
import { readJson, route } from "@/server/http";
import { reversePayment } from "@/server/services/payments";
import { uuid } from "@/lib/validation/common";

export const POST = route<{ id: string }>(async ({ req, actor, params }) =>
  reversePayment(actor, uuid.parse(params.id), await readJson(req, z.unknown())));
