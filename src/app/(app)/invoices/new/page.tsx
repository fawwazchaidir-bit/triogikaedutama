import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/server/auth/current";
import { getInvoiceDefaults } from "@/server/services/settings";
import { listTaxConfigs } from "@/server/services/tax";
import { env } from "@/server/env";
import { InvoiceForm } from "@/components/invoice-form";
import { Notice, PageHeader } from "@/components/ui/card";
import { can } from "@/lib/permissions";
import { todayIso } from "@/lib/format";

export const metadata: Metadata = { title: "Buat Invoice" };
export const dynamic = "force-dynamic";

export default async function NewInvoicePage() {
  const user = await requirePagePermission("invoice:create");
  const [defaults, taxes] = await Promise.all([getInvoiceDefaults(user), listTaxConfigs(user, { activeOnly: true })]);
  return (
    <div>
      <PageHeader title="Buat invoice" description="Pilih pelanggan → tambahkan produk → periksa nominal → simpan draft → pratinjau → terbitkan." />
      {!defaults.numberingConfirmed && (
        <div className="mb-5">
          <Notice tone="warn">
            Nomor awal invoice belum dikonfirmasi administrator, sehingga invoice belum dapat <strong>diterbitkan</strong> (draft tetap bisa disimpan).{" "}
            {can(user.role, "numbering:manage") && <Link href="/settings?tab=numbering" className="font-medium underline">Konfirmasi sekarang →</Link>}
          </Notice>
        </div>
      )}
      <InvoiceForm
        mode="create"
        defaults={{ paymentMethod: defaults.defaultPaymentMethod, paymentTermDays: defaults.defaultPaymentTermDays, dueDateBasis: defaults.defaultDueDateBasis, today: todayIso(env().APP_TIMEZONE), banks: defaults.banks }}
        taxes={taxes}
        perms={{ override: can(user.role, "invoice:override_price"), discount: can(user.role, "invoice:discount"), createCustomer: can(user.role, "customer:create"), submit: can(user.role, "invoice:submit") }}
      />
    </div>
  );
}
