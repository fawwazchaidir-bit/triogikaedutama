import { route } from "@/server/http";
import { unmatchLine } from "@/server/services/bank-reconciliation";
import { uuid } from "@/lib/validation/common";

export const POST = route<{ id: string }>(async ({ actor, params }) => { await unmatchLine(actor, uuid.parse(params.id)); return { ok: true }; });
