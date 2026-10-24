import { route } from "@/server/http";
import { getDashboard } from "@/server/services/dashboard";

export const GET = route(({ req, actor }) => getDashboard(actor, Object.fromEntries(new URL(req.url).searchParams)));
