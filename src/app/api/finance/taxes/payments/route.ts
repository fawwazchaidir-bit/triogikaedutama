import { z } from "zod";
import { created, readJson, route } from "@/server/http";
import { listTaxPayments, recordTaxPayment } from "@/server/services/finance-tax";

export const GET = route(({ actor }) => listTaxPayments(actor));
export const POST = route(async ({ req, actor }) => created(await recordTaxPayment(actor, await readJson(req, z.unknown()))));
