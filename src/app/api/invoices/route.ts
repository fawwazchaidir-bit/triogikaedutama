import { z } from "zod";
import { created, readJson, route } from "@/server/http";
import { parseQuery } from "@/server/query";
import { invoiceListQuerySchema } from "@/server/invoice-query";
import { createDraft, listInvoices } from "@/server/services/invoices";

export const GET = route(({ req, actor }) => listInvoices(actor, parseQuery(req, invoiceListQuerySchema)));
export const POST = route(async ({ req, actor }) => created(await createDraft(actor, await readJson(req, z.unknown()))));
