// Pre-auth config validation + one-shot authorization contract.
//
// The pre-auth phase validates the user-supplied config WITHOUT any Cloudflare
// session/token, derives the code-registry scope bundle from the config's
// declared symbolic capabilities and binds ONE OAuth transaction to the
// canonical v3 config hash. This suite drives the real auth routes on a bare
// Hono app (createApp()'s v2-only route set is import-blocked in this workspace;
// DIRTY_WORKTREE_CONTINUE — the v3 auth path must not depend on v2 modules).
//
// Oracle assertions: one authorization per config (no accretion / no restart),
// registered-scope subset enforced before consent, a changed config invalidates
// the session, and no raw scope can be authored in a config.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { attachAuthRoutes } from "../../src/api/routes/auth.js";
import { bindConfigToSession } from "../../src/core/config-envelope.js";
import { computeConfigV3Id, type ConfigV3 } from "../../src/manifest/config-v3.js";
import type { AppEnv, TapDeployEnv } from "../../src/api/app.js";

const BASE_ENV: TapDeployEnv = {
  RUNTIME: "node",
  PUBLIC_ORIGIN: "http://localhost:8787",
  OAUTH_CLIENT_ID: "tapdeploy-test-client",
  OAUTH_CLIENT_SECRET: "tapdeploy-test-secret",
};

function makeApp(env: TapDeployEnv = BASE_ENV): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  attachAuthRoutes(app, env);
  return app;
}

function v3Config(overrides: Partial<ConfigV3> = {}): ConfigV3 {
  return {
    schemaVersion: 3,
    app: { id: "example/notes", name: "Example Notes" },
    source: { defaultUrl: "https://example.com/notes.zip" },
    capabilities: ["workers", "r2"],
    ...overrides,
  };
}

async function start(app: Hono<AppEnv>, text: unknown): Promise<Response> {
  return app.request("/api/auth/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: typeof text === "string" ? text : JSON.stringify(text),
    }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pre-auth v3 start", () => {
  it("validates a v3 config without a session and returns one config-bounded authorize URL", async () => {
    const app = makeApp();
    const res = await start(app, v3Config());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configHash).toBe(await computeConfigV3Id(v3Config()));
    expect(body.scopes).toEqual(["dns.write", "workers-r2.write", "workers-scripts.admin", "zone.read"]);

    const url = new URL(body.url);
    expect(url.origin).toBe("https://dash.cloudflare.com");
    expect(url.searchParams.get("scope")).toBe(
      "dns.write workers-r2.write workers-scripts.admin zone.read",
    );
    expect(url.searchParams.get("client_id")).toBe("tapdeploy-test-client");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();

    const cookie = res.headers.getSetCookie()[0];
    expect(cookie).toContain("tapdeploy_oauth_tx=");
    expect(cookie).toContain("HttpOnly");
  });

  it("re-plans the same single scope bundle on a repeated start (no accretion)", async () => {
    const app = makeApp();
    const a = await (await start(app, v3Config())).json();
    const b = await (await start(app, v3Config())).json();
    expect(b.configHash).toBe(a.configHash);
    expect(b.scopes).toEqual(a.scopes);
    expect(new URL(b.url).searchParams.get("scope")).toBe(a.scopes.join(" "));
  });

  it("rejects a config that smuggles raw scopes or unknown capabilities", async () => {
    const app = makeApp();
    const smuggled = { ...v3Config(), requestedScopes: ["workers-scripts.admin"] };
    const rawCapability = { ...v3Config(), capabilities: ["workers-scripts.admin"] };
    for (const text of [smuggled, rawCapability]) {
      const res = await start(app, text);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("invalid_config");
      expect(body.url).toBeUndefined();
    }
  });

  it("refuses a config-less start", async () => {
    const app = makeApp();
    const res = await app.request("/api/auth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("config_required");
  });
});

describe("one-shot callback -> session -> envelope", () => {
  it("completes one callback, issues the session, and a changed config invalidates it", async () => {
    const app = makeApp();
    const started = await start(app, v3Config());
    const startBody = await started.json();
    const state = new URL(startBody.url).searchParams.get("state")!;
    const txCookie = started.headers.getSetCookie()[0]!.split(";")[0]!;

    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          access_token: "tok-123",
          token_type: "Bearer",
          scope: "dns.write workers-r2.write workers-scripts.admin zone.read",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const callback = await app.request(
      `/api/auth/callback?state=${encodeURIComponent(state)}&code=code-1`,
      { headers: { Cookie: txCookie } },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe(
      "http://localhost:8787/?auth=success",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/oauth2/token");

    const setCookies = callback.headers.getSetCookie();
    const sessionCookie = setCookies.find((c) => c.startsWith("tapdeploy_session="));
    expect(sessionCookie).toBeDefined();

    const sessionRes = await app.request("/api/auth/session", {
      headers: { Cookie: sessionCookie!.split(";")[0]! },
    });
    const session = await sessionRes.json();
    expect(session.authenticated).toBe(true);
    expect(session.configHash).toBe(startBody.configHash);
    expect(session.scope).toEqual(startBody.scopes);

    const same = await bindConfigToSession({
      sessionConfigHash: session.configHash,
      configText: JSON.stringify(v3Config()),
    });
    expect(same.ok).toBe(true);

    const changed = await bindConfigToSession({
      sessionConfigHash: session.configHash,
      configText: JSON.stringify(
        v3Config({ capabilities: ["workers", "r2", "queues"] }),
      ),
    });
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error).toBe("config_mismatch");
  });

  it("a declined grant blocks with a visible error and never restarts authorization", async () => {
    const app = makeApp();
    const started = await start(app, v3Config());
    const startBody = await started.json();
    const state = new URL(startBody.url).searchParams.get("state")!;
    const txCookie = started.headers.getSetCookie()[0]!.split(";")[0]!;

    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          access_token: "tok-123",
          token_type: "Bearer",
          scope: "workers-scripts.admin",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const callback = await app.request(
      `/api/auth/callback?state=${encodeURIComponent(state)}&code=code-2`,
      { headers: { Cookie: txCookie } },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe(
      "http://localhost:8787/?auth=error&error=scope_denied",
    );
    expect(calls).toHaveLength(1);
    expect(
      callback.headers.getSetCookie().some((c) => c.startsWith("tapdeploy_session=")),
    ).toBe(false);
  });
});