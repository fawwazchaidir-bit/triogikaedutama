import { route } from "@/server/http";
import { listPeriods } from "@/server/services/periods";

export const GET = route(({ actor }) => listPeriods(actor));
