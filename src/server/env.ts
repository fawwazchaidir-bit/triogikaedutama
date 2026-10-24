import "server-only";
import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const int = (def: number, min = 1, max = 1_000_000) =>
  z.coerce.number().int().min(min).max(max).default(def);

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL wajib diisi"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  APP_TIMEZONE: z.string().default("Asia/Jakarta"),
  TRUST_PROXY: bool.default(false),
  LOGIN_MAX_ATTEMPTS: int(5, 1, 100),
  LOGIN_WINDOW_MINUTES: int(15, 1, 1440),
  LOGIN_LOCKOUT_MINUTES: int(15, 1, 1440),
  SESSION_IDLE_HOURS: int(8, 1, 720),
  SESSION_ABSOLUTE_DAYS: int(7, 1, 90),
  MAX_UPLOAD_MB: int(3, 1, 20),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** Env divalidasi sekali; kesalahan konfigurasi gagal CEPAT dengan pesan yang jelas. */
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Konfigurasi environment tidak valid — ${msg}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export function isSecureDeployment(): boolean {
  return env().APP_URL.startsWith("https://");
}
