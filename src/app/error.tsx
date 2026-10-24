"use client";
import { useEffect } from "react";

/** Batas error global: tidak pernah menampilkan stack trace / detail internal ke pengguna. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("[ui] error:", error.digest ?? error.message); }, [error]);
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="max-w-sm text-center">
        <h1 className="text-xl font-semibold text-ink">Terjadi kesalahan</h1>
        <p className="mt-2 text-sm text-muted">Permintaan Anda tidak dapat diproses. Coba lagi; bila berulang, hubungi administrator{error.digest ? ` (kode: ${error.digest})` : ""}.</p>
        <button type="button" onClick={reset} className="mt-6 inline-flex h-10 items-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700">Coba lagi</button>
      </div>
    </main>
  );
}
