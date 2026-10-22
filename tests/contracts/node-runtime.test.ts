// Node runtime contract: boot the compiled Node server and exercise the
// real local HTTP surface + static UI, and prove that a spoofed
// X-Forwarded-Host cannot hijack the OAuth callback (only TAPDEPLOY_PUBLIC_ORIGIN is
// trusted).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SESSION_KEY = Buffer.alloc(32).toString("base64url");

let PORT: number;
let PUBLIC_ORIGIN: string;
let base: string;
let child: ChildProcess | undefined;
let foreignCwd: string;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

describe("node runtime bundle", () => {
  beforeAll(async () => {
    mkdirSync(path.join(root, "dist/node/public"), { recursive: true });
    writeFileSync(path.join(root, "dist/node/public/.stale-build-canary"), "stale");
    execFileSync(process.execPath, ["scripts/build-node.mjs"], { cwd: root, stdio: "pipe" });
    expect(existsSync(path.join(root, "dist/node/public/.stale-build-canary"))).toBe(false);
    expect(existsSync(path.join(root, "dist/node/server.mjs"))).toBe(true);
    expect(existsSync(path.join(root, "dist/node/public/index.html"))).toBe(true);

    PORT = await freePort();
    PUBLIC_ORIGIN = `http://127.0.0.1:${PORT}`;
    base = PUBLIC_ORIGIN;

    foreignCwd = mkdtempSync(path.join(tmpdir(), "tapdeploy-node-cwd-"));
    writeFileSync(path.join(foreignCwd, ".env.local"), "TAPDEPLOY_OAUTH_SCOPES=NOT_SCOPE_CANARY\n");
    const productionEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };
    delete productionEnv.TAPDEPLOY_OAUTH_SCOPES;
    child = spawn(process.execPath, [path.join(root, "dist/node/server.mjs")], {
      cwd: foreignCwd,
      stdio: "pipe",
      env: {
        ...productionEnv,
        HOST: "127.0.0.1",
        PORT: String(PORT),
        TAPDEPLOY_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
        TAPDEPLOY_OAUTH_CLIENT_ID: "contract-client",
        TAPDEPLOY_OAUTH_CLIENT_SECRET: SESSION_KEY,
      },
    });

    const healthy = await waitForHealth(20_000);
    if (!healthy) {
      throw new Error("compiled node server did not become healthy");
    }
  }, 60_000);

  afterAll(() => {
    child?.kill("SIGTERM");
    if (foreignCwd) rmSync(foreignCwd, { recursive: true, force: true });
  });

  it("serves the read-only health contract over real HTTP", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, runtime: "node", schemaVersion: 3 });
  });

  it("serves the compiled static UI at /", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/html/);
    const html = await res.text();
    expect(html).toContain('id="root"');
  });

  it("pins the OAuth callback to TAPDEPLOY_PUBLIC_ORIGIN despite X-Forwarded-Host", async () => {
    const res = await fetch(`${base}/api/auth/callback?error=access_denied`, {
      redirect: "manual",
      headers: { "X-Forwarded-Host": "evil.example" },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith(`${PUBLIC_ORIGIN}/`)).toBe(true);
    expect(location).not.toContain("evil.example");
  });

  it("builds the authorize URL redirect_uri from TAPDEPLOY_PUBLIC_ORIGIN, not the forwarded host", async () => {
    // the legacy v2 config shape no longer validates; the
    // redirect_uri invariant is config-format-agnostic, so this uses the
    // equivalent V3 config (workers capability derives worker-admin, which
    // the default scope registry covers).
    const configText = JSON.stringify({
      schemaVersion: 3,
      app: { id: "fixture/node-runtime", name: "Runtime" },
      source: { allowLocalZip: true },
      capabilities: ["workers"],
      units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }],
    });
    const res = await fetch(`${base}/api/auth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Host": "evil.example" },
      body: JSON.stringify({ text: configText }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    const authorize = new URL(body.url);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${PUBLIC_ORIGIN}/api/auth/callback`);
  });

  it("returns 404 (no crash) for an unknown API route", async () => {
    const res = await fetch(`${base}/api/does-not-exist`);
    expect(res.status).toBe(404);
  });
});
