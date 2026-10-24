import { can, type Role } from "./permissions";
import type { InvoiceCan } from "@/components/invoice-actions";

/** Hak aksi per invoice untuk UI (penegakan sebenarnya tetap di service layer). */
export function invoiceCan(
  role: Role,
  userId: string,
  inv: { status: "DRAFT" | "SUBMITTED" | "ISSUED" | "CANCELLED"; createdById: string },
): InvoiceCan {
  const draft = inv.status === "DRAFT";
  const submitted = inv.status === "SUBMITTED";
  const mine = role !== "STAFF" || inv.createdById === userId;
  return {
    edit: draft && can(role, "invoice:create") && mine,
    submit: draft && can(role, "invoice:submit") && mine,
    recall: submitted && can(role, "invoice:submit") && mine,
    approve: (draft || submitted) && can(role, "invoice:approve"),
    reject: submitted && can(role, "invoice:approve"),
    cancel: inv.status === "ISSUED" && can(role, "invoice:cancel"),
    pay: inv.status === "ISSUED" && can(role, "payment:record"),
    pdf: draft || submitted ? can(role, "invoice:preview_draft") : can(role, "invoice:pdf"),
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
