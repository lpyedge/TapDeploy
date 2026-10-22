// HTTP boundary guards for the live /api/deploy/plan route. The legacy
// v2 manifest->plan mechanics were removed with the V1/V2 pipeline and
// are covered by the V3 graph suites; this file keeps the cross-cutting route
// guards (auth, origin, CSRF, body validation) bound to a V3 config session.
import { describe, expect, it } from "vitest";

import { createApp, type TapDeployEnv } from "../../src/api/app.js";
import { runConfigLogin } from "./login.js";

const PUBLIC_ORIGIN = "https://installer.example";
// Fixed 32-byte base64url key (stable, so the session seal round-trips).
const CLIENT_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// equivalent V3 config (workers + r2 capabilities derive the same scopes
// the removed v2 fixture did).
const V3_CONFIG_TEXT = JSON.stringify({
  schemaVersion: 3,
  app: { id: "test/app", name: "App" },
  source: { allowLocalZip: true },
  capabilities: ["workers", "r2"],
  units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }],
});

function env(): TapDeployEnv {
  return {
    RUNTIME: "node",
    TAPDEPLOY_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    TAPDEPLOY_OAUTH_CLIENT_ID: "client-123",
    TAPDEPLOY_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
  };
}

function headers(sessionCookie: string, csrf: string, origin = PUBLIC_ORIGIN) {
  return {
    cookie: sessionCookie,
    origin,
    "x-tapdeploy-csrf": csrf,
    "content-type": "application/json",
  };
}

const runLogin = (app: ReturnType<typeof createApp>) =>
  runConfigLogin(app, { configText: V3_CONFIG_TEXT });

describe("deploy plan route boundary guards", () => {
  // the legacy v2 manifest->plan mechanics moved to the V3 graph and are
  // covered end-to-end by tests/contracts/graph-e2e-hono.test.ts (fresh
  // install, upgrade, adopt refusal, drift, upstream 502, Pages). The
  // cross-cutting HTTP boundary guards below are route-independent and are
  // preserved here against the live route, now bound to a V3 config session.
  it("requires an authenticated session", async () => {
    const app = createApp(env());
    const res = await app.request("/api/deploy/plan", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("rejects an origin outside the allowlist", async () => {
    const app = createApp(env());
    const session = await runLogin(app);
    const res = await app.request("/api/deploy/plan", {
      method: "POST",
      headers: headers(session.sessionCookie, session.csrf, "https://evil.example"),
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("rejects a missing CSRF header", async () => {
    const app = createApp(env());
    const session = await runLogin(app);
    const res = await app.request("/api/deploy/plan", {
      method: "POST",
      headers: {
        cookie: session.sessionCookie,
        origin: PUBLIC_ORIGIN,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("requires an accountId in the body", async () => {
    const app = createApp(env());
    const session = await runLogin(app);
    const res = await app.request("/api/deploy/plan", {
      method: "POST",
      headers: headers(session.sessionCookie, session.csrf),
      body: JSON.stringify({ config: { text: V3_CONFIG_TEXT } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("accountId is required");
  });
});

// Only a Config V3 plan with a server-issued release proof, and only a step
// carrying the sealed execution context, can ever reach the provider.
describe("deploy API refuses requests outside the sealed V3 flow", () => {
  it("plan with a non-V3 config is refused as an invalid config", async () => {
    const app = createApp(env());
    const session = await runLogin(app);
    const res = await app.request("/api/deploy/plan", {
      method: "POST",
      headers: headers(session.sessionCookie, session.csrf),
      body: JSON.stringify({ accountId: "acct-1", manifest: { project: { id: "x" } }, inputs: {}, config: { text: JSON.stringify({ schemaVersion: 2, app: { id: "x", name: "X" } }) } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_config");
  });

  it("step without a sealed execution context is refused", async () => {
    const app = createApp(env());
    const session = await runLogin(app);
    const res = await app.request("/api/deploy/step", {
      method: "POST",
      headers: headers(session.sessionCookie, session.csrf),
      body: JSON.stringify({ accountId: "acct-1", step: "create-worker", args: {} }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("executionContext is required");
  });
});
