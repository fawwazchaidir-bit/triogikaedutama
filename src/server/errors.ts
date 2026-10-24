export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION"
  | "RATE_LIMITED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/** Error yang AMAN ditampilkan ke pengguna (pesan sudah dalam Bahasa Indonesia). */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fieldErrors?: Record<string, string>,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.status = STATUS[code];
  }
}

export const Errors = {
  unauthenticated: (m = "Sesi berakhir. Silakan masuk kembali.") => new AppError("UNAUTHENTICATED", m),
  forbidden: (m = "Anda tidak memiliki izin untuk tindakan ini.") => new AppError("FORBIDDEN", m),
  notFound: (what = "Data") => new AppError("NOT_FOUND", `${what} tidak ditemukan.`),
  conflict: (m: string, extra?: Record<string, unknown>) => new AppError("CONFLICT", m, undefined, extra),
  badRequest: (m: string) => new AppError("BAD_REQUEST", m),
  validation: (m: string, fieldErrors?: Record<string, string>) => new AppError("VALIDATION", m, fieldErrors),
  rateLimited: (m: string, extra?: Record<string, unknown>) => new AppError("RATE_LIMITED", m, undefined, extra),
};
