import "dotenv/config";
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) throw new Error("TEST_DATABASE_URL wajib diisi untuk E2E (database terpisah — isinya akan DIKOSONGKAN).");

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "tests/e2e/.artifacts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: BASE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "id-ID",
    timezoneId: "Asia/Jakarta",
    // Di CI: `npx playwright install chromium`. Di sandbox ini: PW_CHROMIUM_PATH=/opt/pw-browsers/chromium
    launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH || undefined },
  },
  // Build produksi sungguhan (sekaligus memverifikasi `next build`) dengan database TEST.
  webServer: {
    command: `npm run build && npx next start -H 127.0.0.1 -p ${PORT}`,
    url: `${BASE}/login`,
    timeout: 300_000,
    reuseExistingServer: !process.env.CI,
    env: { DATABASE_URL: TEST_DB, APP_URL: BASE, NODE_ENV: "production", APP_TIMEZONE: "Asia/Jakarta", TRUST_PROXY: "false" },
  },
});
