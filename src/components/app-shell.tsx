"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  BarChart3, FileText, KeyRound, LayoutDashboard, LogOut, Menu, Package, ScrollText, Settings, Users, Wallet, X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { api } from "@/lib/api-client";
import { ROLE_LABELS, type Role } from "@/lib/permissions";
import { ToastProvider } from "@/components/ui/toast";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  "/dashboard": LayoutDashboard,
  "/invoices": FileText,
  "/customers": Users,
  "/products": Package,
  "/payments": Wallet,
  "/reports": BarChart3,
  "/audit-log": ScrollText,
  "/settings": Settings,
};

export interface ShellProps {
  user: { name: string; email: string; role: Role };
  nav: { href: string; label: string }[];
  company: { name: string; logoUrl: string };
  children: React.ReactNode;
}

export function AppShell({ user, nav, company, children }: ShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    try { await api("/api/auth/logout", { method: "POST", body: {} }); } finally { router.push("/login"); router.refresh(); }
  }

  const sidebar = (
    <div className="flex h-full flex-col bg-ink text-stone-200">
      <div className="flex items-center gap-3 px-5 py-5">
        <Image src={company.logoUrl} alt="" width={40} height={40} unoptimized className="size-10 rounded-full bg-white/5" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight text-white">{company.name}</p>
          <p className="text-xs text-stone-400">Invoice Management</p>
        </div>
      </div>
      <nav aria-label="Menu utama" className="flex-1 space-y-0.5 px-3 py-2">
        {nav.map((item) => {
          const Icon = ICONS[item.href] ?? FileText;
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href} href={item.href} onClick={() => setOpen(false)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active ? "bg-brand-600 text-white" : "text-stone-300 hover:bg-white/10 hover:text-white",
              )}
            >
              <Icon className="size-[18px] shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-white/10 p-4">
        <p className="truncate text-sm font-medium text-white">{user.name}</p>
        <p className="truncate text-xs text-stone-400">{user.email}</p>
        <p className="mt-1 inline-block rounded bg-white/10 px-1.5 py-0.5 text-[11px] font-medium text-stone-300">{ROLE_LABELS[user.role]}</p>
        <div className="mt-3 flex gap-2">
          <Link href="/change-password" className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-white/10 px-2 py-1.5 text-xs text-stone-200 hover:bg-white/20">
            <KeyRound className="size-3.5" /> Password
          </Link>
          <button type="button" onClick={logout} disabled={busy} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-white/10 px-2 py-1.5 text-xs text-stone-200 hover:bg-white/20 disabled:opacity-50">
            <LogOut className="size-3.5" /> Keluar
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <ToastProvider>
      <div className="min-h-screen lg:grid lg:grid-cols-[16rem_1fr]">
        <aside className="no-print sticky top-0 hidden h-screen lg:block">{sidebar}</aside>

        <div className="no-print sticky top-0 z-30 flex items-center justify-between border-b border-white/10 bg-ink px-4 py-3 text-white lg:hidden">
          <button type="button" aria-label="Buka menu" onClick={() => setOpen(true)} className="rounded-md p-1.5 hover:bg-white/10"><Menu className="size-5" /></button>
          <span className="text-sm font-semibold">{company.name}</span>
          <span className="size-8" />
        </div>
        {open && (
          <div className="no-print fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
            <button type="button" aria-label="Tutup menu" className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
            <div className="relative h-full w-72 max-w-[85%] shadow-2xl">
              <button type="button" aria-label="Tutup" onClick={() => setOpen(false)} className="absolute right-2 top-2 z-10 rounded-md p-1.5 text-white hover:bg-white/10"><X className="size-5" /></button>
              {sidebar}
            </div>
          </div>
        )}

        <main className="min-w-0 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </ToastProvider>
  );
}
