import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { resetDb, seedFixtures, TEST_PASSWORD, type Fixtures } from "../helpers/db";
import { changeOwnPassword, login, logout } from "@/server/services/auth";
import { createUser, resetUserPassword, updateUser } from "@/server/services/users";
import { hashToken, validateSession } from "@/server/auth/session";
import { hashPassword, validatePasswordStrength, verifyPassword } from "@/server/auth/password";
import { AppError } from "@/server/errors";

let fx: Fixtures;
const meta = { ip: "10.0.0.1", userAgent: "vitest" };
beforeEach(async () => {
  await resetDb();
  fx = await seedFixtures();
});

const rejects = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as AppError;

describe("login & sesi", () => {
  it("login benar → sesi valid; token mentah tidak disimpan (hanya hash)", async () => {
    const res = await login({ email: "FINANCE@test.local ", password: TEST_PASSWORD }, meta);
    expect(res.user.email).toBe("finance@test.local");
    const stored = await prisma.session.findFirstOrThrow({ where: { userId: fx.finance.userId } });
    expect(stored.tokenHash).toBe(hashToken(res.token));
    expect(stored.tokenHash).not.toBe(res.token);
    const u = await validateSession(res.token);
    expect(u).toMatchObject({ userId: fx.finance.userId, role: "FINANCE" });
    expect(await validateSession(res.token + "x")).toBeNull();
    expect(await validateSession(undefined)).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "auth.login", actorId: fx.finance.userId } })).toBe(1);
  });

  it("password salah & email tidak dikenal memberi pesan yang sama (anti user-enumeration)", async () => {
    const a = await rejects(login({ email: "finance@test.local", password: "salah-salah-salah" }, meta));
    const b = await rejects(login({ email: "tidak-ada@test.local", password: "salah-salah-salah" }, meta));
    expect(a.code).toBe("UNAUTHENTICATED");
    expect(b.code).toBe("UNAUTHENTICATED");
    expect(a.message).toBe(b.message);
  });

  it("5 kegagalan memblokir akun — bahkan dengan password benar — tetapi tidak memblokir akun lain", async () => {
    for (let i = 0; i < 5; i++) await rejects(login({ email: "staff@test.local", password: "salah-salah-salah" }, { ip: null, userAgent: null }));
    const blocked = await rejects(login({ email: "staff@test.local", password: TEST_PASSWORD }, { ip: null, userAgent: null }));
    expect(blocked.code).toBe("RATE_LIMITED");
    expect(blocked.message).toMatch(/Terlalu banyak percobaan/);
    const other = await login({ email: "admin@test.local", password: TEST_PASSWORD }, { ip: null, userAgent: null });
    expect(other.user.role).toBe("ADMIN");
    // pemblokiran berakhir: majukan waktu
    await prisma.rateLimitBucket.updateMany({ data: { blockedUntil: new Date(Date.now() - 1000), windowStart: new Date(Date.now() - 3600_000) } });
    expect((await login({ email: "staff@test.local", password: TEST_PASSWORD }, { ip: null, userAgent: null })).user.role).toBe("STAFF");
  });

  it("percobaan paralel dihitung atomik (tidak ada yang lolos dari batas)", async () => {
    await Promise.allSettled(Array.from({ length: 12 }, () => login({ email: "staff2@test.local", password: "salah-salah-salah" }, { ip: null, userAgent: null })));
    const b = await prisma.rateLimitBucket.findFirstOrThrow({ where: { key: { startsWith: "login:email:" } } });
    expect(b.count).toBeGreaterThanOrEqual(5);
    expect(b.blockedUntil).not.toBeNull();
  });

  it("akun nonaktif tidak bisa login dan sesi lamanya dicabut", async () => {
    const s = await login({ email: "staff@test.local", password: TEST_PASSWORD }, meta);
    await updateUser(fx.admin, fx.staff.userId, { isActive: false });
    expect(await validateSession(s.token)).toBeNull();
    expect((await rejects(login({ email: "staff@test.local", password: TEST_PASSWORD }, meta))).code).toBe("UNAUTHENTICATED");
  });

  it("sesi idle & kedaluwarsa & logout ditolak", async () => {
    const s = await login({ email: "admin@test.local", password: TEST_PASSWORD }, meta);
    await prisma.session.updateMany({ data: { lastSeenAt: new Date(Date.now() - 9 * 3600_000) } });
    expect(await validateSession(s.token)).toBeNull(); // idle 8 jam
    const s2 = await login({ email: "admin@test.local", password: TEST_PASSWORD }, meta);
    expect(await validateSession(s2.token)).not.toBeNull();
    await logout(s2.token, fx.admin);
    expect(await validateSession(s2.token)).toBeNull();
    const s3 = await login({ email: "admin@test.local", password: TEST_PASSWORD }, meta);
    await prisma.session.updateMany({ where: { tokenHash: hashToken(s3.token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await validateSession(s3.token)).toBeNull();
  });
});

describe("password", () => {
  it("scrypt: hash unik per panggilan, verifikasi benar/salah, format tidak valid ditolak", async () => {
    const h1 = await hashPassword("Kata-Sandi-Kuat-1");
    const h2 = await hashPassword("Kata-Sandi-Kuat-1");
    expect(h1).not.toBe(h2);
    expect(h1.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("Kata-Sandi-Kuat-1", h1)).toBe(true);
    expect(await verifyPassword("kata-sandi-kuat-1", h1)).toBe(false);
    expect(await verifyPassword("x", "bukan-hash")).toBe(false);
    expect(await verifyPassword("x", "scrypt$1$1$1$a$b")).toBe(false);
  });

  it("kebijakan kekuatan password", () => {
    expect(validatePasswordStrength("pendek1!")).toMatch(/12 karakter/);
    expect(validatePasswordStrength("passwordpassword")).toMatch(/umum/);
    expect(validatePasswordStrength("aaaaaaaaaaaaaaaa")).toMatch(/diulang/);
    expect(validatePasswordStrength("budisantoso2024!", { email: "budisantoso@x.id" })).toMatch(/email/);
    expect(validatePasswordStrength("abcdefghijklmnop")).toMatch(/dua jenis/);
    expect(validatePasswordStrength("Kopi-Hangat-9-Pagi")).toBeNull();
  });

  it("ganti password: wajib password lama, aturan kekuatan, sesi lain dicabut", async () => {
    const s1 = await login({ email: "finance@test.local", password: TEST_PASSWORD }, meta);
    const s2 = await login({ email: "finance@test.local", password: TEST_PASSWORD }, meta);
    const cur = await validateSession(s1.token);
    expect((await rejects(changeOwnPassword(cur!, { currentPassword: "salah", newPassword: "Kopi-Hangat-9-Pagi" }))).code).toBe("VALIDATION");
    expect((await rejects(changeOwnPassword(cur!, { currentPassword: TEST_PASSWORD, newPassword: "pendek" }))).code).toBe("VALIDATION");
    await changeOwnPassword(cur!, { currentPassword: TEST_PASSWORD, newPassword: "Kopi-Hangat-9-Pagi" });
    expect(await validateSession(s1.token)).not.toBeNull(); // sesi saat ini tetap
    expect(await validateSession(s2.token)).toBeNull(); // sesi lain dicabut
    expect((await login({ email: "finance@test.local", password: "Kopi-Hangat-9-Pagi" }, meta)).user.email).toBe("finance@test.local");
    expect(await prisma.auditLog.count({ where: { action: "auth.password_changed" } })).toBe(1);
  });
});

describe("manajemen pengguna (Administrator saja)", () => {
  it("admin membuat pengguna dengan password kuat; wajib ganti saat login pertama; email unik", async () => {
    const u = await createUser(fx.admin, { email: "Baru@Test.Local", name: "Pegawai Baru", role: "STAFF", password: "Kopi-Hangat-9-Pagi" });
    expect(u).toMatchObject({ email: "baru@test.local", role: "STAFF", mustChangePassword: true });
    const res = await login({ email: "baru@test.local", password: "Kopi-Hangat-9-Pagi" }, meta);
    expect(res.user.mustChangePassword).toBe(true);
    expect((await rejects(createUser(fx.admin, { email: "baru@test.local", name: "Dobel", role: "STAFF", password: "Kopi-Hangat-9-Pagi" }))).code).toBe("CONFLICT");
    expect((await rejects(createUser(fx.admin, { email: "lemah@test.local", name: "Lemah", role: "STAFF", password: "12345678" }))).code).toBe("VALIDATION");
    expect((await rejects(createUser(fx.finance, { email: "x@test.local", name: "X", role: "ADMIN", password: "Kopi-Hangat-9-Pagi" }))).code).toBe("FORBIDDEN");
    expect((await rejects(createUser(fx.staff, { email: "y@test.local", name: "Y", role: "ADMIN", password: "Kopi-Hangat-9-Pagi" }))).code).toBe("FORBIDDEN");
  });

  it("tidak dapat menonaktifkan/menurunkan Administrator terakhir atau diri sendiri", async () => {
    expect((await rejects(updateUser(fx.admin, fx.admin.userId, { isActive: false }))).code).toBe("CONFLICT");
    expect((await rejects(updateUser(fx.admin, fx.admin.userId, { role: "STAFF" }))).code).toBe("CONFLICT");
    await updateUser(fx.admin, fx.finance.userId, { role: "ADMIN" });
    expect((await updateUser(fx.admin, fx.finance.userId, { isActive: false })).isActive).toBe(false);
  });

  it("reset password oleh admin memaksa ganti password & mencabut sesi", async () => {
    const s = await login({ email: "staff@test.local", password: TEST_PASSWORD }, meta);
    await resetUserPassword(fx.admin, fx.staff.userId, { password: "Reset-Sementara-77" });
    expect(await validateSession(s.token)).toBeNull();
    expect((await login({ email: "staff@test.local", password: "Reset-Sementara-77" }, meta)).user.mustChangePassword).toBe(true);
  });
});
