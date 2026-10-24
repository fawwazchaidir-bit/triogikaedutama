import "server-only";
import { z } from "zod";
import { prisma, transaction } from "../db";
import { Errors } from "../errors";
import { parseInput } from "../validate";
import { assertCan, type Actor } from "../actor";
import { writeAudit } from "../audit";
import { hashPassword, validatePasswordStrength } from "../auth/password";
import { revokeAllSessions } from "../auth/session";
import { normalizeEmail } from "./auth";

export const userCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email("Email tidak valid").max(200),
  name: z.string().trim().min(2, "Nama minimal 2 karakter").max(120),
  role: z.enum(["ADMIN", "FINANCE", "STAFF"]),
  password: z.string().min(1, "Password wajib diisi").max(128),
});

export const userUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  role: z.enum(["ADMIN", "FINANCE", "STAFF"]).optional(),
  isActive: z.boolean().optional(),
});

export const resetPasswordSchema = z.object({ password: z.string().min(1).max(128) });

export interface UserDto {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "FINANCE" | "STAFF";
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

const toDto = (u: {
  id: string; email: string; name: string; role: UserDto["role"]; isActive: boolean;
  mustChangePassword: boolean; lastLoginAt: Date | null; createdAt: Date;
}): UserDto => ({
  id: u.id, email: u.email, name: u.name, role: u.role, isActive: u.isActive,
  mustChangePassword: u.mustChangePassword,
  lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  createdAt: u.createdAt.toISOString(),
});

export async function listUsers(actor: Actor): Promise<UserDto[]> {
  assertCan(actor, "user:manage");
  const users = await prisma.user.findMany({ orderBy: [{ isActive: "desc" }, { name: "asc" }] });
  return users.map(toDto);
}

export async function createUser(actor: Actor, raw: unknown): Promise<UserDto> {
  assertCan(actor, "user:manage");
  const input = parseInput(userCreateSchema, raw);
  const weak = validatePasswordStrength(input.password, { email: input.email, name: input.name });
  if (weak) throw Errors.validation(weak, { password: weak });
  if (await prisma.user.findUnique({ where: { email: input.email } })) {
    throw Errors.conflict("Email sudah terdaftar.");
  }
  const passwordHash = await hashPassword(input.password);
  return transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        email: normalizeEmail(input.email), name: input.name, role: input.role, passwordHash,
        // Pengguna baru wajib mengganti password yang diberikan admin pada login pertama.
        mustChangePassword: true,
      },
    });
    await writeAudit(tx, actor, {
      action: "user.create", entityType: "User", entityId: u.id,
      summary: `Pengguna ${u.email} dibuat (${u.role})`, after: { email: u.email, name: u.name, role: u.role },
    });
    return toDto(u);
  });
}

async function activeAdminCount(): Promise<number> {
  return prisma.user.count({ where: { role: "ADMIN", isActive: true } });
}

export async function updateUser(actor: Actor, id: string, raw: unknown): Promise<UserDto> {
  assertCan(actor, "user:manage");
  const input = parseInput(userUpdateSchema, raw);
  const before = await prisma.user.findUnique({ where: { id } });
  if (!before) throw Errors.notFound("Pengguna");

  const demoting = before.role === "ADMIN" && input.role && input.role !== "ADMIN";
  const deactivating = before.isActive && input.isActive === false;
  if ((demoting || (deactivating && before.role === "ADMIN")) && (await activeAdminCount()) <= 1) {
    throw Errors.conflict("Tidak dapat menonaktifkan atau menurunkan Administrator terakhir.");
  }
  if (id === actor.userId && (deactivating || demoting)) {
    throw Errors.conflict("Anda tidak dapat menonaktifkan atau menurunkan akun Anda sendiri.");
  }

  return transaction(async (tx) => {
    const u = await tx.user.update({ where: { id }, data: input });
    await writeAudit(tx, actor, {
      action: "user.update", entityType: "User", entityId: id, summary: `Pengguna ${u.email} diperbarui`,
      before: { name: before.name, role: before.role, isActive: before.isActive },
      after: { name: u.name, role: u.role, isActive: u.isActive },
    });
    return toDto(u);
  }).then(async (dto) => {
    if (deactivating || demoting || input.role) await revokeAllSessions(id); // paksa login ulang dengan hak baru
    return dto;
  });
}

export async function resetUserPassword(actor: Actor, id: string, raw: unknown): Promise<void> {
  assertCan(actor, "user:manage");
  const { password } = parseInput(resetPasswordSchema, raw);
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw Errors.notFound("Pengguna");
  const weak = validatePasswordStrength(password, { email: user.email, name: user.name });
  if (weak) throw Errors.validation(weak, { password: weak });
  const passwordHash = await hashPassword(password);
  await transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: { passwordHash, mustChangePassword: true } });
    await writeAudit(tx, actor, {
      action: "user.reset_password", entityType: "User", entityId: id, summary: `Password ${user.email} direset oleh admin`,
    });
  });
  await revokeAllSessions(id);
}
