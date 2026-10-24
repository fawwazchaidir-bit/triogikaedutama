import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../db";
import { env, isSecureDeployment } from "../env";
import type { Actor } from "../actor";

/**
 * Sesi berbasis cookie opaque. Token acak 256-bit; yang disimpan di DB hanya SHA-256-nya,
 * sehingga kebocoran tabel `sessions` tidak memberi akses. Sesi dapat dicabut kapan saja
 * (logout, nonaktifkan pengguna, ganti password).
 */

export const SESSION_COOKIE_NAME = () => (isSecureDeployment() ? "__Host-tes_session" : "tes_session");

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function cookieOptions(expires: Date) {
  return {
    httpOnly: true,
    secure: isSecureDeployment(),
    sameSite: "lax" as const,
    path: "/",
    expires,
  };
}

export async function createSession(userId: string, ip: string | null, userAgent: string | null) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + env().SESSION_ABSOLUTE_DAYS * 86_400_000);
  await prisma.session.create({
    data: { userId, tokenHash: hashToken(token), expiresAt, ip, userAgent: userAgent?.slice(0, 300) ?? null },
  });
  return { token, expiresAt };
}

export interface SessionUser extends Actor {
  sessionId: string;
  mustChangePassword: boolean;
}

/** Validasi token → pengguna. Mengembalikan null bila tidak valid / kedaluwarsa / idle / pengguna nonaktif. */
export async function validateSession(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.revokedAt) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() <= now) return null;
  if (now - session.lastSeenAt.getTime() > env().SESSION_IDLE_HOURS * 3_600_000) return null;
  if (!session.user.isActive) return null;

  // Sliding idle window; tulis paling sering 1×/menit agar tidak membebani DB.
  if (now - session.lastSeenAt.getTime() > 60_000) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
  }
  return {
    sessionId: session.id,
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
    mustChangePassword: session.user.mustChangePassword,
  };
}

export async function revokeSessionByToken(token: string): Promise<void> {
  await prisma.session.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<void> {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
}

/** Housekeeping: hapus sesi kedaluwarsa > 30 hari (dipanggil oportunistik saat login). */
export async function purgeOldSessions(): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  await prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] } });
}
