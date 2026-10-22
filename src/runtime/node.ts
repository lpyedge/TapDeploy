import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

import { createApp } from "../api/app.js";
import { nodeEnvFromProcess } from "../api/env.js";

loadDevEnv();

const moduleDir = dirname(fileURLToPath(import.meta.url));
// Module-relative static root so the compiled server works from any cwd.
const publicRoot = resolve(moduleDir, "public");

const app = createApp(nodeEnvFromProcess());

// Only mount static serving when the built asset directory exists (the built
// server). In dev the UI is served by Vite, so we skip a missing-dir warning.
if (existsSync(publicRoot)) {
  app.use("/*", serveStatic({ root: publicRoot }));
}

const port = Number(process.env.PORT ?? 8787);

const server = serve(
  {
    fetch: app.fetch,
    port,
    hostname: "0.0.0.0",
  },
  (info) => {
    console.log(`[tapdeploy] node runtime listening on port ${info.port}`);
    // TAPDEPLOY_PUBLIC_ORIGIN is the single trusted origin for cookies, CSRF and the
    // OAuth redirect_uri. Request Host / X-Forwarded-Host are never consulted,
    // so a reverse proxy only needs to forward to this port.
    if (!process.env.TAPDEPLOY_PUBLIC_ORIGIN) {
      console.warn("[tapdeploy] TAPDEPLOY_PUBLIC_ORIGIN is not set; OAuth endpoints will fail closed");
    }
  },
);

// Container-friendly graceful shutdown (Docker sends SIGTERM). No in-flight
// state to persist: sessions are stateless cookies.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

// Developer-only .env.local loader (no dotenv dependency). Values are only
// applied for keys not already present in process.env so a real deployment's
// environment always wins. Production should inject env directly, not via
// .env.local. The root is cwd-relative on purpose (dev runs from the repo root).
function loadDevEnv(): void {
  if (process.env.NODE_ENV === "production") return;
  const envFile = resolve(process.cwd(), ".env.local");
  if (!existsSync(envFile)) {
    return;
  }
  const text = readFileSync(envFile, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}
