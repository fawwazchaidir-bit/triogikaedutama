import type { Metadata } from "next";
import Link from "next/link";
import { requirePagePermission } from "@/server/auth/current";
import { getSettings, listBankAccounts } from "@/server/services/settings";
import { getNumberingStatus } from "@/server/services/numbering";
import { listTaxConfigs } from "@/server/services/tax";
import { listUsers } from "@/server/services/users";
import { env } from "@/server/env";
import { PageHeader } from "@/components/ui/card";
import { CompanyForm } from "@/components/settings/company-form";
import { BanksManager } from "@/components/settings/banks-manager";
import { NumberingPanel } from "@/components/settings/numbering-panel";
import { TaxManager } from "@/components/settings/tax-manager";
import { UsersManager } from "@/components/settings/users-manager";
import { can } from "@/lib/permissions";
import { todayIso } from "@/lib/format";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Pengaturan" };
export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requirePagePermission("settings:view");
  const manage = can(user.role, "settings:manage");
  const tabs = [
    { id: "company", label: "Perusahaan & dokumen" },
    { id: "banks", label: "Rekening bank" },
    { id: "numbering", label: "Penomoran invoice" },
    ...(can(user.role, "tax:manage") ? [{ id: "tax", label: "Pajak" }] : []),
    ...(can(user.role, "user:manage") ? [{ id: "users", label: "Pengguna" }] : []),
  ];
  const sp = await searchParams;
  const tab = tabs.some((t) => t.id === sp.tab) ? sp.tab! : "company";

  return (
    <div>
      <PageHeader title="Pengaturan" description="Identitas lembaga, rekening, penomoran, pajak, dan pengguna. Seluruhnya dapat diubah tanpa menyentuh kode." />
      <nav aria-label="Bagian pengaturan" className="mb-5 flex flex-wrap gap-2 border-b border-line pb-3">
        {tabs.map((t) => (
          <Link key={t.id} href={`/settings?tab=${t.id}`} aria-current={t.id === tab ? "page" : undefined}
            className={cn("rounded-md px-3 py-1.5 text-sm font-medium", t.id === tab ? "bg-ink text-white" : "text-ink-soft hover:bg-black/5")}>{t.label}</Link>
        ))}
      </nav>
      {tab === "company" && <CompanyForm initial={await getSettings(user)} readOnly={!manage} />}
      {tab === "banks" && <BanksManager items={await listBankAccounts(user)} canManage={manage} />}
      {tab === "numbering" && <NumberingPanel status={await getNumberingStatus(user)} canManage={can(user.role, "numbering:manage")} today={todayIso(env().APP_TIMEZONE)} />}
      {tab === "tax" && <TaxManager items={await listTaxConfigs(user)} canManage={can(user.role, "tax:manage")} />}
      {tab === "users" && <UsersManager items={await listUsers(user)} selfId={user.userId} />}
    </div>
  );
}
