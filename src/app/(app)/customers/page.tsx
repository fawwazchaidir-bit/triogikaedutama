import type { Metadata } from "next";
import { z } from "zod";
import { requirePageUser } from "@/server/auth/current";
import { listCustomers } from "@/server/services/customers";
import { CustomersManager } from "@/components/customers-manager";
import { Card, PageHeader } from "@/components/ui/card";
import { FilterBar, FilterField, filterInput } from "@/components/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { can } from "@/lib/permissions";
import { buildQuery } from "@/lib/invoice-can";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Pelanggan" };
export const dynamic = "force-dynamic";

const schema = z.object({ q: z.string().max(100).optional(), status: z.enum(["active", "archived", "all"]).optional(), page: z.coerce.number().int().min(1).optional() });

export default async function CustomersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePageUser();
  const sp = await searchParams;
  const f = schema.safeParse(Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]))).data ?? {};
  const list = await listCustomers(user, { ...f, pageSize: 20 });
  return (
    <div>
      <PageHeader title="Pelanggan" description="Master data pelanggan. Isian otomatis di form invoice; ubah di sini tidak mengubah invoice yang sudah terbit." />
      <FilterBar action="/customers" resetHref="/customers">
        <FilterField label="Cari"><input type="search" name="q" defaultValue={f.q} placeholder="Nama, kontak, kota, email…" className={cn(filterInput, "w-64")} /></FilterField>
        <FilterField label="Status">
          <select name="status" defaultValue={f.status ?? "active"} className={filterInput}><option value="active">Aktif</option><option value="archived">Diarsipkan</option><option value="all">Semua</option></select>
        </FilterField>
      </FilterBar>
      <Card>
        <CustomersManager items={list.items} emptyHint={f.q ? "Tidak ada pelanggan yang cocok dengan pencarian." : undefined}
          can={{ create: can(user.role, "customer:create"), update: can(user.role, "customer:update"), archive: can(user.role, "customer:archive") }} />
        <Pagination page={list.page} pageCount={list.pageCount} total={list.total} hrefFor={(p) => `/customers${buildQuery({ ...f, page: p })}`} />
      </Card>
    </div>
  );
}
