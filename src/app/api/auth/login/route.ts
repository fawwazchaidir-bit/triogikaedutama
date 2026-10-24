import { cookies } from "next/headers";
import { z } from "zod";
import { publicRoute, readJson } from "@/server/http";
import { login } from "@/server/services/auth";
import { cookieOptions, SESSION_COOKIE_NAME } from "@/server/auth/session";

const schema = z.object({
  email: z.string().trim().min(1, "Email wajib diisi").max(200),
  password: z.string().min(1, "Password wajib diisi").max(256),
});

export const POST = publicRoute(async ({ req, meta }) => {
  const input = await readJson(req, schema);
  const { token, expiresAt, user } = await login(input, meta);
  (await cookies()).set(SESSION_COOKIE_NAME(), token, cookieOptions(expiresAt));
  return { user };
});
