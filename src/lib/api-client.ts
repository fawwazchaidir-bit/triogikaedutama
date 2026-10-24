/** Klien fetch untuk komponen browser. Semua error API dinormalisasi menjadi `ApiClientError`. */

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly fieldErrors: Record<string, string> = {},
    /** Seluruh objek `error` dari server (mis. `duplicates`, `needsConfirmation`, `retryAfterSeconds`). */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export async function api<T = unknown>(
  url: string,
  opts: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers: opts.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiClientError("Tidak dapat terhubung ke server. Periksa koneksi Anda.", 0, "NETWORK");
  }
  const text = await res.text();
  let json: { data?: T; error?: { code?: string; message?: string; fieldErrors?: Record<string, string> } & Record<string, unknown> } = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined" && !location.pathname.startsWith("/login")) {
      // Navigasi keras sengaja dipakai: membuang seluruh state klien milik sesi yang sudah berakhir.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      location.href = "/login";
    }
    throw new ApiClientError(
      json.error?.message ?? "Terjadi kesalahan. Coba lagi.",
      res.status,
      json.error?.code ?? "UNKNOWN",
      json.error?.fieldErrors ?? {},
      json.error ?? {},
    );
  }
  return json.data as T;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Terjadi kesalahan.";
}
