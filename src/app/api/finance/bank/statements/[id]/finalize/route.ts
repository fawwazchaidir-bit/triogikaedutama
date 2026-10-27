import { route } from "@/server/http";
import { finalizeStatement } from "@/server/services/bank-reconciliation";
import { uuid } from "@/lib/validation/common";

export const POST = route<{ id: string }>(({ actor, params }) => finalizeStatement(actor, uuid.parse(params.id)));
