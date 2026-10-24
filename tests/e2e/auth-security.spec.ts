import { expect, test } from "@playwright/test";
import { login, logout, USERS } from "./helpers";
import { E2E_PASSWORD } from "./global-setup";

const ORIGIN = { Origin: "http://127.0.0.1:3100" };

test.describe("autentikasi & keamanan HTTP", () => {
  test("anonim diarahkan ke login; kredensial salah ditolak dengan pesan generik; login & logout berfungsi", async ({ page }) => {
    for (const path of ["/dashboard", "/invoices", "/settings", "/invoices/new"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    }
    await page.getByLabel("Email").fill(USERS.finance);
    await page.getByLabel("Password").fill("password-salah-sekali");
    await page.getByRole("button", { name: "Masuk" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Email atau password salah" })).toBeVisible();
    await page.getByLabel("Email").fill("tidak.ada@trilogika.test");
    await page.getByLabel("Password").fill("password-salah-sekali");
    await page.getByRole("button", { name: "Masuk" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Email atau password salah" })).toBeVisible(); // sama persis → tidak membocorkan keberadaan akun

    await login(page, "finance");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await logout(page);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/); // sesi benar-benar dicabut
  });

  test("cookie sesi HttpOnly + SameSite=Lax; header keamanan terpasang; tidak ada X-Powered-By", async ({ page, context }) => {
    const res = await page.goto("/login");
    const h = res!.headers();
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("SAMEORIGIN");
    expect(h["referrer-policy"]).toBe("same-origin");
    expect(h["content-security-policy"]).toContain("frame-ancestors 'self'");
    expect(h["content-security-policy"]).toContain("object-src 'self'");
    expect(h["content-security-policy"]).not.toContain("unsafe-eval");
    expect(h["permissions-policy"]).toContain("camera=()");
    expect(h["x-powered-by"]).toBeUndefined();
    await login(page, "admin");
    const cookie = (await context.cookies()).find((c) => c.name.endsWith("tes_session"))!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Lax");
    expect(cookie.value.length).toBeGreaterThanOrEqual(40);
    // halaman terautentikasi tidak boleh tersimpan di cache bersama/peramban
    const dash = await page.goto("/dashboard");
    expect(dash!.headers()["cache-control"]).toMatch(/no-store|no-cache|private/);
    // token tidak dapat dibaca skrip halaman
    expect(await page.evaluate(() => document.cookie)).not.toContain("tes_session");
  });

  test("API tanpa login → 401; asal (Origin) lintas-situs → 403 (CSRF); tanpa Origin ditolak", async ({ request }) => {
    for (const url of ["/api/invoices", "/api/me", "/api/customers", "/api/settings", "/api/payments", "/api/reports/invoices", "/api/dashboard", "/api/audit-logs", "/api/users"]) {
      const r = await request.get(url);
      expect(r.status(), url).toBe(401);
      expect((await r.json()).error.code).toBe("UNAUTHENTICATED");
    }
    expect((await request.get("/api/files/00000000-0000-0000-0000-000000000000")).status()).toBe(401);
    const evil = await request.post("/api/auth/login", { data: { email: USERS.admin, password: E2E_PASSWORD }, headers: { Origin: "https://evil.example" } });
    expect(evil.status()).toBe(403);
    const noOrigin = await request.post("/api/auth/login", { data: { email: USERS.admin, password: E2E_PASSWORD } });
    expect(noOrigin.status()).toBe(403);
    const bad = await request.post("/api/auth/login", { data: "bukan json", headers: { Origin: "http://127.0.0.1:3100", "Content-Type": "text/plain" } });
    expect(bad.status()).toBe(400);
  });

  test("pembatasan percobaan login: setelah 5 gagal akun diblokir (429) walau password benar", async ({ request }) => {
    const origin = { Origin: "http://127.0.0.1:3100" };
    const target = "korban.brute@trilogika.test";
    for (let i = 0; i < 5; i++) {
      const r = await request.post("/api/auth/login", { data: { email: target, password: `tebakan-${i}-xxxxxxxx` }, headers: origin });
      expect(r.status()).toBe(401);
    }
    const blocked = await request.post("/api/auth/login", { data: { email: target, password: E2E_PASSWORD }, headers: origin });
    expect(blocked.status()).toBe(429);
    expect((await blocked.json()).error.message).toMatch(/Terlalu banyak percobaan/);
  });

  test("halaman yang dilarang tampil 404 bagi peran tanpa izin, bukan error 500", async ({ page }) => {
    await login(page, "staff");
    for (const p of ["/dashboard", "/payments", "/reports", "/audit-log", "/settings"]) {
      const res = await page.goto(p);
      expect(res!.status(), p).toBe(404);
      await expect(page.getByText("Halaman tidak ditemukan")).toBeVisible();
    }
  });

  test("pengguna baru wajib mengganti password sebelum memakai aplikasi (UI & API)", async ({ page, browser }) => {
    await login(page, "admin");
    const email = `baru.${Date.now()}@trilogika.test`;
    const temp = "Sementara-Aman-2026!";
    const created = await page.request.post("/api/users", { data: { email, name: "Pegawai Baru", role: "STAFF", password: temp }, headers: ORIGIN });
    expect(created.status()).toBe(201);
    expect((await page.request.post("/api/users", { data: { email: `lemah.${Date.now()}@trilogika.test`, name: "Lemah", role: "STAFF", password: "pendek" }, headers: ORIGIN })).status()).toBe(422);

    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto("/login");
    await p.getByLabel("Email").fill(email);
    await p.getByLabel("Password").fill(temp);
    await p.getByRole("button", { name: "Masuk" }).click();
    await expect(p).toHaveURL(/\/change-password/);
    expect((await p.request.get("/api/invoices")).status()).toBe(403); // API diblokir sampai password diganti
    await p.goto("/invoices");
    await expect(p).toHaveURL(/\/change-password/); // halaman lain mengarahkan kembali

    await p.getByLabel("Password saat ini").fill(temp);
    await p.getByLabel(/^Password baru/).fill("kopi");
    await p.getByLabel("Ulangi password baru").fill("kopi");
    await p.getByRole("button", { name: "Simpan" }).click();
    await expect(p.getByText(/minimal 12 karakter/i).first()).toBeVisible(); // kebijakan password ditegakkan server
    await p.getByLabel(/^Password baru/).fill("Kopi-Hangat-9-Pagi");
    await p.getByLabel("Ulangi password baru").fill("Kopi-Hangat-9-Pagi");
    await p.getByRole("button", { name: "Simpan" }).click();
    await expect(p).not.toHaveURL(/\/change-password/);
    await expect(p.getByRole("navigation", { name: "Menu utama" })).toBeVisible();
    expect((await p.request.get("/api/invoices")).status()).toBe(200);
    await ctx.close();
  });
});
