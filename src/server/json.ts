import "server-only";
import { Prisma } from "@prisma/client";

/**
 * Ubah nilai apa pun (BigInt, Decimal, Date, nested) menjadi JSON aman untuk disimpan
 * (audit log, snapshot). BigInt → number (nominal Rupiah selalu < 2^53 oleh validasi MAX_AMOUNT).
 */
export function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (typeof v === "bigint") return Number(v);
      if (v instanceof Prisma.Decimal) return v.toString();
      return v;
    }),
  ) as Prisma.InputJsonValue;
}

/** Tanggal DATE dari Prisma (UTC midnight) → "YYYY-MM-DD". */
export function dateToIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" → Date UTC midnight untuk kolom @db.Date. */
export function isoToDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}
