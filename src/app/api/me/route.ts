import { route } from "@/server/http";

export const GET = route(async ({ actor }) => ({
  id: actor.userId, email: actor.email, name: actor.name, role: actor.role,
}));
