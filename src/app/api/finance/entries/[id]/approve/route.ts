import { route } from "@/server/http";
import { approveEntry } from "@/server/services/cash-entries";

export const POST = route<{ id: string }>(({ actor, params }) => approveEntry(actor, params.id));
