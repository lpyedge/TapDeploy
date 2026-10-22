import { defineConfig, devices } from "@playwright/test";
const runtime = process.env.PW_RUNTIME ?? "vite";
if (!["vite", "node", "workers"].includes(runtime)) throw new Error("PW_RUNTIME must be vite, node or workers");
const port = Number(process.env.PW_PORT ?? "5173");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PW_PORT must be an integer from 1024 to 65535");
const command = runtime === "node" ? "node dist/node/server.mjs" : runtime === "workers" ? `npx wrangler dev --local --ip 127.0.0.1 --port ${port} --log-level warn` : `npm run dev:web -- --port ${port} --strictPort`;

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "temp/playwright/results",
  fullyParallel: true,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 45_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command,
    env: { NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port) },
    port,
    // Reuse an already-running dev server when explicitly requested
    // (PW_REUSE=1); otherwise Playwright owns the port and fails closed
    // on a collision, which is the safer default for CI.
    reuseExistingServer: process.env.PW_REUSE === "1",
    timeout: 60_000,
  },
});
