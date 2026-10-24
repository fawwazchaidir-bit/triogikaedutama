"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiClientError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/card";

export function ChangePasswordForm({ forced }: { forced: boolean }) {
  const router = useRouter();
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    if (form.newPassword !== form.confirm) {
      setErrors({ confirm: "Konfirmasi password tidak sama." });
      return;
    }
    setLoading(true);
    setErrors({});
    try {
      await api("/api/auth/password", { body: { currentPassword: form.currentPassword, newPassword: form.newPassword } });
      router.replace("/");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrors(err.fieldErrors);
        setMessage(Object.keys(err.fieldErrors).length ? null : err.message);
      }
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-xl border border-line bg-surface p-8 shadow-sm" aria-label="Form ganti password">
      <div>
        <h1 className="text-xl font-semibold text-ink">Ganti Password</h1>
        <p className="mt-1 text-sm text-muted">
          {forced ? "Demi keamanan, ganti password sementara Anda sebelum melanjutkan." : "Gunakan minimal 12 karakter. Sesi di perangkat lain akan diakhiri."}
        </p>
      </div>
      {message && <Notice tone="danger">{message}</Notice>}
      <TextField label="Password saat ini" type="password" autoComplete="current-password" required value={form.currentPassword}
        onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} error={errors.currentPassword} />
      <TextField label="Password baru" type="password" autoComplete="new-password" required minLength={12} value={form.newPassword}
        onChange={(e) => setForm({ ...form, newPassword: e.target.value })} error={errors.newPassword} hint="Minimal 12 karakter, bukan password umum." />
      <TextField label="Ulangi password baru" type="password" autoComplete="new-password" required value={form.confirm}
        onChange={(e) => setForm({ ...form, confirm: e.target.value })} error={errors.confirm} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" loading={loading} className="flex-1">Simpan</Button>
        {!forced && <Link href="/" className="inline-flex h-10 items-center rounded-md border border-line px-4 text-sm hover:bg-canvas">Batal</Link>}
      </div>
    </form>
  );
}
