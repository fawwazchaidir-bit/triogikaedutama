import { expect, test } from "@playwright/test";
import { login, logout, USERS } from "./helpers";
import { E2E_PASSWORD } from "./global-setup";

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
});
