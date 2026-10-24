import { route } from "@/server/http";
import { listAuditLogs } from "@/server/services/audit";

export const GET = route(({ req, actor }) => listAuditLogs(actor, Object.fromEntries(new URL(req.url).searchParams)));
