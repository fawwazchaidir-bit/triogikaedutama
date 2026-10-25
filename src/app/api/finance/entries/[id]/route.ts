import { route } from "@/server/http";
import { cancelPendingEntry } from "@/server/services/cash-entries";

/** Pencatat membatalkan pengajuannya sendiri (hanya yang masih menunggu). */
export const DELETE = route<{ id: string }>(async ({ actor, params }) => { await cancelPendingEntry(actor, params.id); return { ok: true }; });
