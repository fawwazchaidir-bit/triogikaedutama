import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requirePagePermission } from "@/server/auth/current";
import { getInvoice } from "@/server/services/invoices";
import { getInvoiceDefaults } from "@/server/services/settings";
import { listTaxConfigs } from "@/server/services/tax";
import { env } from "@/server/env";
import { InvoiceForm } from "@/components/invoice-form";
import { PageHeader } from "@/components/ui/card";
import { can } from "@/lib/permissions";
import { invoiceCan } from "@/lib/invoice-can";
import { todayIso } from "@/lib/format";
import { uuid } from "@/lib/validation/common";
import { AppError } from "@/server/errors";

export const metadata: Metadata = { title: "Edit Draft Invoice" };
export const dynamic = "force-dynamic";

export default async function EditInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePagePermission("invoice:create");
  const id = uuid.safeParse((await params).id);
  if (!id.success) notFound();
  const invoice = await getInvoice(user, id.data).catch((e: unknown) => { if (e instanceof AppError && e.code === "NOT_FOUND") notFound(); throw e; });
  // Invoice terbit tidak bisa diedit: arahkan ke detail (perubahan lewat pembatalan & penerbitan ulang).
  if (!invoiceCan(user.role, user.userId, invoice).edit) redirect(`/invoices/${invoice.id}`);
  const [defaults, taxes] = await Promise.all([getInvoiceDefaults(user), listTaxConfigs(user, { activeOnly: true })]);
  return (
    <div>
      <PageHeader title="Edit draft invoice" description={`Draft untuk ${invoice.customerName}. Nomor dialokasikan saat disetujui Finance Manager.`} />
      <InvoiceForm
        mode="edit" invoice={invoice}
        defaults={{ paymentMethod: defaults.defaultPaymentMethod, paymentTermDays: defaults.defaultPaymentTermDays, dueDateBasis: defaults.defaultDueDateBasis, today: todayIso(env().APP_TIMEZONE), banks: defaults.banks }}
        taxes={taxes}
        perms={{ override: can(user.role, "invoice:override_price"), discount: can(user.role, "invoice:discount"), createCustomer: can(user.role, "customer:create"), submit: can(user.role, "invoice:submit") }}
      />
    </div>
  );
}
