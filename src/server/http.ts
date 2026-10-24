import "server-only";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { ZodError, type ZodType } from "zod";
import { AppError, Errors } from "./errors";
import { zodFieldErrors } from "./validate";
import { requestMeta, type RequestMeta } from "./request-context";
import { requireApiUser } from "./auth/current";
import type { SessionUser } from "./auth/session";

const MAX_BODY_BYTES = 1_000_000;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Respons sukses dengan status khusus (mis. 201). */
export class ApiResult {
  constructor(readonly data: unknown, readonly status = 200, readonly headers?: HeadersInit) {}
}
export const created = (data: unknown) => new ApiResult(data, 201);

/**
 * Perlindungan CSRF untuk request yang mengubah data. Cookie sesi sudah SameSite=Lax; ini lapis kedua:
 * header Origin harus sama dengan Host yang dituju (browser selalu mengirim Origin pada request lintas-situs
 * dan tidak bisa dipalsukan oleh halaman web lain).
 */
export function assertSameOrigin(req: Request): void {
  if (SAFE_METHODS.has(req.method)) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const origin = req.headers.get("origin");
  if (origin) {
    let originHost: string | null = null;
    try { originHost = new URL(origin).host; } catch { /* fallthrough */ }
    if (originHost && host && originHost === host) return;
    throw Errors.forbidden("Permintaan ditolak (asal tidak sesuai).");
  }
  const site = req.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return;
  throw Errors.forbidden("Permintaan ditolak (asal tidak diketahui).");
}

export async function readJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) throw Errors.badRequest("Content-Type harus application/json.");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw Errors.badRequest("Isi permintaan terlalu besar.");
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw Errors.badRequest("JSON tidak valid."); }
  return schema.parse(body);
}

function errorResponse(err: unknown): NextResponse {
  if (err instanceof AppError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, fieldErrors: err.fieldErrors, ...err.extra } },
      { status: err.status },
    );
  }
  if (err instanceof ZodError) {
    const fieldErrors = zodFieldErrors(err);
    const first = Object.values(fieldErrors)[0] ?? "Data tidak valid.";
    return NextResponse.json({ error: { code: "VALIDATION", message: first, fieldErrors } }, { status: 422 });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return NextResponse.json({ error: { code: "CONFLICT", message: "Data dengan nilai yang sama sudah ada." } }, { status: 409 });
    }
    if (err.code === "P2025") {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Data tidak ditemukan." } }, { status: 404 });
    }
    if (err.code === "P2003") {
      return NextResponse.json({ error: { code: "CONFLICT", message: "Data masih dipakai oleh data lain." } }, { status: 409 });
    }
  }
  // Guard database (trigger/CHECK) — pesan trigger kita memang ditulis untuk pengguna.
  const msg = err instanceof Error ? err.message : "";
  if (/restrict_violation|bersifat append-only|sudah terbit|tidak boleh dihapus|hanya dapat diubah saat invoice/i.test(msg)) {
    const readable = /(Invoice [^\n]*|Rincian invoice[^\n]*|\w+ bersifat append-only[^\n]*)/.exec(msg)?.[1];
    return NextResponse.json(
      { error: { code: "CONFLICT", message: readable ?? "Perubahan ditolak oleh aturan integritas data." } },
      { status: 409 },
    );
  }
  // Jangan bocorkan detail internal ke pengguna.
  console.error("[api] unhandled error:", err);
  return NextResponse.json({ error: { code: "INTERNAL", message: "Terjadi kesalahan pada server. Coba lagi." } }, { status: 500 });
}

interface HandlerArgs<P> {
  req: Request;
  actor: SessionUser;
  params: P;
  meta: RequestMeta;
}

interface PublicHandlerArgs<P> {
  req: Request;
  params: P;
  meta: RequestMeta;
}

type RouteContext<P> = { params: Promise<P> };

/** Route handler terautentikasi: cek Origin → sesi → jalankan → serialisasi hasil/error. */
export function route<P = Record<string, never>>(
  handler: (args: HandlerArgs<P>) => Promise<unknown>,
  opts: { allowMustChange?: boolean } = {},
) {
  return async (req: Request, ctx?: RouteContext<P>): Promise<Response> => {
    try {
      assertSameOrigin(req);
      const actor = await requireApiUser({ allowMustChange: opts.allowMustChange });
      const params = (ctx?.params ? await ctx.params : {}) as P;
      return toResponse(await handler({ req, actor, params, meta: requestMeta(req.headers) }));
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** Route handler publik (hanya login). Tetap memeriksa Origin. */
export function publicRoute<P = Record<string, never>>(handler: (args: PublicHandlerArgs<P>) => Promise<unknown>) {
  return async (req: Request, ctx?: RouteContext<P>): Promise<Response> => {
    try {
      assertSameOrigin(req);
      const params = (ctx?.params ? await ctx.params : {}) as P;
      return toResponse(await handler({ req, params, meta: requestMeta(req.headers) }));
    } catch (err) {
      return errorResponse(err);
    }
  };
}

function toResponse(result: unknown): Response {
  if (result instanceof Response) return result;
  if (result instanceof ApiResult) {
    return NextResponse.json({ data: result.data }, { status: result.status, headers: result.headers });
  }
  return NextResponse.json({ data: result ?? null });
}
