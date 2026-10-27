import { route } from "@/server/http";
import { deleteStatement, getStatementWorkspace } from "@/server/services/bank-reconciliation";
import { uuid } from "@/lib/validation/common";

export const GET = route<{ id: string }>(({ actor, params }) => getStatementWorkspace(actor, uuid.parse(params.id)));
export const DELETE = route<{ id: string }>(async ({ actor, params }) => { await deleteStatement(actor, uuid.parse(params.id)); return { ok: true }; });
