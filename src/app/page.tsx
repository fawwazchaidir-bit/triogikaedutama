import { redirect } from "next/navigation";
import { requirePageUser } from "@/server/auth/current";
import { can } from "@/lib/permissions";

export default async function Home() {
  const user = await requirePageUser();
  redirect(can(user.role, "dashboard:view") ? "/dashboard" : "/invoices");
}
