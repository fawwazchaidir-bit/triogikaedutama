import "server-only";
import { env } from "./env";

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

/**
 * IP klien. X-Forwarded-For hanya dipercaya bila TRUST_PROXY=true (aplikasi di belakang proxy tepercaya);
 * bila tidak, header itu dapat dipalsukan klien sehingga diabaikan (null → rate limit per-IP dilewati,
 * rate limit per-email tetap berlaku).
 */
export function requestMeta(headers: Headers): RequestMeta {
  let ip: string | null = null;
  if (env().TRUST_PROXY) {
    const xff = headers.get("x-forwarded-for");
    ip = (xff ? xff.split(",")[0]?.trim() : headers.get("x-real-ip")?.trim()) || null;
    if (ip && ip.length > 64) ip = null;
  }
  return { ip, userAgent: headers.get("user-agent") };
}
