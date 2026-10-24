import { cookies } from "next/headers";
import { route } from "@/server/http";
import { logout } from "@/server/services/auth";
import { SESSION_COOKIE_NAME } from "@/server/auth/session";

export const POST = route(
  async ({ actor }) => {
    const store = await cookies();
    await logout(store.get(SESSION_COOKIE_NAME())?.value, actor);
    store.delete(SESSION_COOKIE_NAME());
    return { ok: true };
  },
  { allowMustChange: true },
);
