import "server-only";
import { can, type Permission, type Role } from "@/lib/permissions";
import { Errors } from "./errors";

/** Identitas pelaku sebuah operasi — diteruskan ke SETIAP service agar izin & audit konsisten. */
export interface Actor {
  userId: string;
  email: string;
  name: string;
  role: Role;
  ip?: string | null;
  userAgent?: string | null;
}

export function assertCan(actor: Actor, permission: Permission): void {
  if (!can(actor.role, permission)) throw Errors.forbidden();
}

export function actorCan(actor: Actor, permission: Permission): boolean {
  return can(actor.role, permission);
}
