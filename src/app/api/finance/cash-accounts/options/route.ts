import { route } from "@/server/http";
import { listCashAccountOptions } from "@/server/services/cash-accounts";

/** Pilihan akun aktif (tanpa saldo) untuk form pembayaran & pengeluaran. */
export const GET = route(({ actor }) => listCashAccountOptions(actor));
