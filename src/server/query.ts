import "server-only";
import type { ZodType } from "zod";
import { parseInput } from "./validate";

/** Parse query string ke objek terverifikasi (nilai kosong dianggap tidak diisi). */
export function parseQuery<T>(req: Request, schema: ZodType<T>): T {
  const raw: Record<string, string> = {};
  for (const [k, v] of new URL(req.url).searchParams) if (v !== "") raw[k] = v;
  return parseInput(schema, raw);
}
