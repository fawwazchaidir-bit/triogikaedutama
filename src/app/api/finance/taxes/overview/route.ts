import { route } from "@/server/http";
import { getTaxOverview } from "@/server/services/finance-tax";

export const GET = route(({ actor }) => getTaxOverview(actor));
