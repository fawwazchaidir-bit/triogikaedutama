import { route } from "@/server/http";
import { readBooksLock } from "@/server/services/books-lock";

/** Tanggal kunci buku dipelihara dari periode yang ditutup (lihat /api/finance/periods); hanya dapat dibaca di sini. */
export const GET = route(({ actor }) => readBooksLock(actor));
