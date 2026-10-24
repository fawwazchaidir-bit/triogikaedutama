import { can, type Role } from "./permissions";
import type { InvoiceCan } from "@/components/invoice-actions";

/** Hak aksi per invoice untuk UI (penegakan sebenarnya tetap di service layer). */
export function invoiceCan(role: Role, userId: string, inv: { status: "DRAFT" | "ISSUED" | "CANCELLED"; createdById: string }): InvoiceCan {
  const draft = inv.status === "DRAFT";
  const mine = role !== "STAFF" || inv.createdById === userId;
  return {
    edit: draft && can(role, "invoice:create") && mine,
    issue: draft && can(role, "invoice:issue"),
    cancel: inv.status === "ISSUED" && can(role, "invoice:cancel"),
    pay: inv.status === "ISSUED" && can(role, "payment:record"),
    pdf: !draft && can(role, "invoice:pdf"),
    previewDraft: draft && can(role, "invoice:preview_draft"),
    duplicate: can(role, "invoice:create"),
    remove: draft && can(role, "invoice:create") && mine,
  };
}

/** Bangun query string dari objek, mengabaikan nilai kosong. */
export function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}
