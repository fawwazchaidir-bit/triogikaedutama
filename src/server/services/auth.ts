import "server-only";
import { prisma, transaction } from "../db";
import { env } from "../env";
import { Errors } from "../errors";
import { writeAudit } from "../audit";
import type { Actor } from "../actor";
import type { RequestMeta } from "../request-context";
import { dummyHash, hashPassword, needsRehash, validatePasswordStrength, verifyPassword } from "../auth/password";
import { blockedSeconds, hashKey, recordFailure, resetBucket } from "../auth/rate-limit";
import { createSession, purgeOldSessions, revokeAllSessions, revokeSessionByToken } from "../auth/session";

const GENERIC_FAIL = "Email atau password salah.";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function limits() {
  const e = env();
  return {
    email: { max: e.LOGIN_MAX_ATTEMPTS, windowMs: e.LOGIN_WINDOW_MINUTES * 60_000, blockMs: e.LOGIN_LOCKOUT_MINUTES * 60_000 },
    // Batas per-IP lebih longgar (banyak pengguna bisa berbagi satu IP kantor).
    ip: { max: e.LOGIN_MAX_ATTEMPTS * 6, windowMs: e.LOGIN_WINDOW_MINUTES * 60_000, blockMs: e.LOGIN_LOCKOUT_MINUTES * 60_000 },
  };
}

export async function login(input: { email: string; password: string }, meta: RequestMeta) {
  const email = normalizeEmail(input.email);
  const cfg = limits();
  const emailKey = `login:email:${hashKey(email)}`;
  const ipKey = meta.ip ? `login:ip:${hashKey(meta.ip)}` : null;

  const waits = await Promise.all([blockedSeconds(emailKey), ipKey ? blockedSeconds(ipKey) : Promise.resolve(0)]);
  const wait = Math.max(...waits);
  if (wait > 0) {
    throw Errors.rateLimited(`Terlalu banyak percobaan masuk. Coba lagi dalam ${Math.ceil(wait / 60)} menit.`, {
      retryAfterSeconds: wait,
    });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  // Selalu jalankan verifikasi (hash dummy bila user tidak ada) agar waktu respons seragam.
  const ok = await verifyPassword(input.password, user?.passwordHash ?? (await dummyHash()));

  if (!user || !ok || !user.isActive) {
    const [e] = await Promise.all([recordFailure(emailKey, cfg.email), ipKey ? recordFailure(ipKey, cfg.ip) : null]);
    if (user) {
      await writeAudit(prisma, null, {
        action: "auth.login_failed",
        entityType: "User",
        entityId: user.id,
        summary: user.isActive ? "Percobaan masuk gagal (password salah)" : "Percobaan masuk ke akun nonaktif",
        after: { email, ip: meta.ip, lockedOut: e.blocked },
      });
    }
    throw Errors.unauthenticated(GENERIC_FAIL);
  }

  await resetBucket(emailKey);
  const { token, expiresAt } = await createSession(user.id, meta.ip, meta.userAgent);
  await transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        // Naikkan parameter hash secara transparan bila kebijakan berubah.
        ...(needsRehash(user.passwordHash) ? { passwordHash: await hashPassword(input.password) } : {}),
      },
    });
    await writeAudit(tx, { userId: user.id, email: user.email, name: user.name, role: user.role, ...meta }, {
      action: "auth.login", entityType: "User", entityId: user.id, summary: "Masuk",
    });
  });
  void purgeOldSessions().catch(() => undefined);

  return {
    token,
    expiresAt,
    user: { id: user.id, email: user.email, name: user.name, role: user.role, mustChangePassword: user.mustChangePassword },
  };
}

export async function logout(token: string | undefined, actor: Actor | null): Promise<void> {
  if (token) await revokeSessionByToken(token);
  if (actor) {
    await writeAudit(prisma, actor, { action: "auth.logout", entityType: "User", entityId: actor.userId, summary: "Keluar" });
  }
}

export async function changeOwnPassword(
  actor: Actor & { sessionId?: string },
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: actor.userId } });
  if (!user) throw Errors.notFound("Pengguna");
  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw Errors.validation("Password saat ini salah.", { currentPassword: "Password saat ini salah." });
  }
  const weak = validatePasswordStrength(input.newPassword, { email: user.email, name: user.name });
  if (weak) throw Errors.validation(weak, { newPassword: weak });
  if (input.newPassword === input.currentPassword) {
    throw Errors.validation("Password baru harus berbeda.", { newPassword: "Password baru harus berbeda." });
  }
  const passwordHash = await hashPassword(input.newPassword);
  await transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false } });
    await writeAudit(tx, actor, { action: "auth.password_changed", entityType: "User", entityId: user.id, summary: "Password diganti" });
  });
  // Cabut sesi lain; sesi saat ini tetap aktif.
  await revokeAllSessions(user.id, actor.sessionId);
}
