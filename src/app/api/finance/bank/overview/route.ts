import { route } from "@/server/http";
import { getReconOverview } from "@/server/services/bank-reconciliation";

export const GET = route(({ actor }) => getReconOverview(actor));
