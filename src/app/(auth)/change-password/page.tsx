import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/current";
import { ChangePasswordForm } from "./change-password-form";

export const metadata: Metadata = { title: "Ganti Password" };

export default async function ChangePasswordPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <ChangePasswordForm forced={user.mustChangePassword} />
    </div>
  );
}
