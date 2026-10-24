/**
 * Membuat akun dari command line (mis. Administrator tambahan atau pemulihan akses).
 *   NEW_USER_PASSWORD='…' npm run user:create -- --email a@b.id --name "Nama" --role ADMIN
 * Password dibaca dari environment (bukan argumen, agar tidak tersimpan di riwayat shell/ps).
 */
import "dotenv/config";
import { PrismaClient, type Role } from "@prisma/client";
import { hashPassword, validatePasswordStrength } from "../src/server/auth/password";

const prisma = new PrismaClient();
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  const name = arg("name")?.trim();
  const role = arg("role")?.toUpperCase() as Role | undefined;
  const password = process.env.NEW_USER_PASSWORD ?? "";
  if (!email || !name || !role || !["ADMIN", "FINANCE", "STAFF"].includes(role)) throw new Error("Gunakan: --email <email> --name <nama> --role ADMIN|FINANCE|STAFF (password lewat env NEW_USER_PASSWORD)");
  const weak = validatePasswordStrength(password, { email, name });
  if (weak) throw new Error(`Password ditolak: ${weak}`);
  if (await prisma.user.findUnique({ where: { email } })) throw new Error("Email sudah terdaftar.");
  const u = await prisma.user.create({ data: { email, name, role, passwordHash: await hashPassword(password), mustChangePassword: true } });
  await prisma.auditLog.create({ data: { actorEmail: "cli", action: "user.create", entityType: "User", entityId: u.id, summary: `Pengguna ${email} (${role}) dibuat lewat CLI` } });
  console.log(`✔ Pengguna dibuat: ${email} (${role}). Wajib ganti password saat login pertama.`);
}
main().catch((e) => { console.error(`Gagal: ${e instanceof Error ? e.message : e}`); process.exitCode = 1; }).finally(() => prisma.$disconnect());
