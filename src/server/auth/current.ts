import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { can, type Permission } from "@/lib/permissions";
import { Errors } from "../errors";
import { requestMeta } from "../request-context";
import { SESSION_COOKIE_NAME, validateSession, type SessionUser } from "./session";

/** Pengguna login saat ini (di-cache per request). Null bila tidak login. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const store = await cookies();
  const user = await validateSession(store.get(SESSION_COOKIE_NAME())?.value);
  if (!user) return null;
  const meta = requestMeta(await headers());
  return { ...user, ...meta };
});

/** Untuk halaman server: arahkan ke /login bila belum masuk. */
export async function requirePageUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/change-password");
  return user;
}

/** Untuk route handler: lempar 401 bila belum masuk. */
export async function requireApiUser(opts: { allowMustChange?: boolean } = {}): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw Errors.unauthenticated();
  if (user.mustChangePassword && !opts.allowMustChange) {
    throw Errors.forbidden("Anda harus mengganti password terlebih dahulu.");
  }
  return user;
}

/**
 * Untuk halaman server: pengguna harus memiliki izin tertentu, jika tidak → 404 (bukan 403/500).
 * Halaman yang dilarang tidak membocorkan keberadaannya. Service tetap memeriksa izin sendiri (lapis kedua).
 */
export async function requirePagePermission(permission: Permission | Permission[]): Promise<SessionUser> {
  const user = await requirePageUser();
  const needed = Array.isArray(permission) ? permission : [permission];
  if (!needed.some((p) => can(user.role, p))) notFound();
  return user;
}
