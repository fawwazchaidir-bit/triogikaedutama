import type { Metadata } from "next";
import { z } from "zod";
import { requirePagePermission } from "@/server/auth/current";
import { listProducts } from "@/server/services/products";
import { listTaxConfigs } from "@/server/services/tax";
import { ProductsManager } from "@/components/products-manager";
import { Card, PageHeader } from "@/components/ui/card";
import { FilterBar, FilterField, filterInput } from "@/components/filter-bar";
import { Pagination } from "@/components/ui/pagination";
import { can } from "@/lib/permissions";
import { buildQuery } from "@/lib/invoice-can";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Produk & Layanan" };
export const dynamic = "force-dynamic";

const schema = z.object({ q: z.string().max(100).optional(), status: z.enum(["active", "archived", "all"]).optional(), page: z.coerce.number().int().min(1).optional() });

export default async function ProductsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePagePermission("product:view");
  const sp = await searchParams;
  const f = schema.safeParse(Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]))).data ?? {};
  const [list, taxes] = await Promise.all([listProducts(user, { ...f, pageSize: 20 }), listTaxConfigs(user, { activeOnly: true })]);
  return (
    <div>
      <PageHeader title="Produk & Layanan" description="Katalog layanan pelatihan. Harga di invoice adalah snapshot — perubahan harga di sini tidak mengubah invoice lama." />
      <FilterBar action="/products" resetHref="/products">
        <FilterField label="Cari"><input type="search" name="q" defaultValue={f.q} placeholder="Kode, nama, bidang, skema…" className={cn(filterInput, "w-64")} /></FilterField>
        <FilterField label="Status"><select name="status" defaultValue={f.status ?? "active"} className={filterInput}><option value="active">Aktif</option><option value="archived">Diarsipkan</option><option value="all">Semua</option></select></FilterField>
      </FilterBar>
      <Card>
        <ProductsManager items={list.items} taxes={taxes} canManage={can(user.role, "product:manage")} />
        <Pagination page={list.page} pageCount={list.pageCount} total={list.total} hrefFor={(p) => `/products${buildQuery({ ...f, page: p })}`} />
      </Card>
    </div>
  );
}
