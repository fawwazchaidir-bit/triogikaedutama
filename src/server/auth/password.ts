import "server-only";
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Hash password dengan scrypt (bawaan Node, memory-hard, tanpa dependensi native).
 * Format tersimpan: scrypt$N$r$p$salt(base64)$hash(base64) — parameter ikut tersimpan sehingga
 * dapat dinaikkan di masa depan tanpa memutus hash lama (lihat `needsRehash`).
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1, keyLen: 64, saltLen: 16 } as const;

function scryptAsync(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const maxmem = (N: number, r: number) => 128 * N * r * 2;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(PARAMS.saltLen);
  const key = await scryptAsync(password, salt, PARAMS.keyLen, {
    N: PARAMS.N, r: PARAMS.r, p: PARAMS.p, maxmem: maxmem(PARAMS.N, PARAMS.r),
  });
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const N = Number(nStr), r = Number(rStr), p = Number(pStr);
  if (![N, r, p].every(Number.isInteger) || N < 2 || N > 2 ** 20) return false;
  const expected = Buffer.from(hashB64, "base64");
  const key = await scryptAsync(password, Buffer.from(saltB64, "base64"), expected.length, {
    N, r, p, maxmem: maxmem(N, r),
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function needsRehash(stored: string): boolean {
  const [, n, r, p] = stored.split("$");
  return Number(n) !== PARAMS.N || Number(r) !== PARAMS.r || Number(p) !== PARAMS.p;
}

/** Hash dummy untuk menyamakan waktu respons saat email tidak terdaftar (cegah user enumeration via timing). */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(12).toString("hex"));
  return dummy;
}

const COMMON = new Set([
  "password1234", "123456789012", "qwertyuiop12", "administrator", "admin1234567", "trilogika123",
  "trilogikaedutama", "passwordpassword", "welcome12345", "letmein12345", "iloveyou1234",
]);

/** Kebijakan password: ≥12 karakter, tidak umum, tidak memuat email/nama, tidak monoton. Null = valid. */
export function validatePasswordStrength(password: string, ctx: { email?: string; name?: string } = {}): string | null {
  if (password.length < 12) return "Password minimal 12 karakter.";
  if (password.length > 128) return "Password maksimal 128 karakter.";
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return "Password terlalu umum.";
  if (/^(.)\1+$/.test(password)) return "Password tidak boleh berupa satu karakter yang diulang.";
  const local = ctx.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return "Password tidak boleh memuat bagian dari email.";
  const nameParts = (ctx.name ?? "").toLowerCase().split(/\s+/).filter((p) => p.length >= 4);
  if (nameParts.some((p) => lower.includes(p))) return "Password tidak boleh memuat nama Anda.";
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 2) return "Gunakan kombinasi minimal dua jenis karakter (huruf besar/kecil, angka, simbol).";
  return null;
}
