"use client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiClientError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { Notice } from "@/components/ui/card";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ user: { mustChangePassword: boolean } }>("/api/auth/login", { body: { email, password } });
      router.replace(res.user.mustChangePassword ? "/change-password" : "/");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Gagal masuk. Coba lagi.");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-xl border border-line bg-surface p-8 shadow-sm" aria-label="Form masuk">
      <div className="flex flex-col items-center gap-3 text-center">
        <Image src="/brand/logo.png" alt="Trilogika Edutama" width={72} height={72} priority unoptimized />
        <div>
          <h1 className="text-xl font-semibold text-ink">Trilogika Edutama</h1>
          <p className="text-sm text-muted">Invoice Management System</p>
        </div>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      <TextField label="Email" type="email" name="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      <TextField label="Password" type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      <Button type="submit" variant="primary" loading={loading} className="w-full">Masuk</Button>
    </form>
  );
}
