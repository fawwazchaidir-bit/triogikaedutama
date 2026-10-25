import { route } from "@/server/http";
import { parseQuery } from "@/server/query";
import { getAccountLedger, ledgerQuerySchema } from "@/server/services/finance-statements";

export const GET = route(({ req, actor }) => getAccountLedger(actor, parseQuery(req, ledgerQuerySchema)));
