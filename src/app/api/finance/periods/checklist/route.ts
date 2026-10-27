import { route } from "@/server/http";
import { parseQuery } from "@/server/query";
import { getPeriodChecklist, monthSchema } from "@/server/services/periods";

export const GET = route(({ req, actor }) => getPeriodChecklist(actor, parseQuery(req, monthSchema)));
