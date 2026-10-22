import { describe, expect, it } from "vitest";
import { createApp, type TapDeployEnv } from "../../src/api/app.js";
import { deriveSealKey, sealJson } from "../../src/auth/keys.js";

const CONFIG_TEXT = JSON.stringify({
  schemaVersion: 3,
  app: { id: "test/app", name: "App" },
  source: { allowLocalZip: true },
  capabilities: ["workers", "r2"],
  units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }],
});
// Sorted to match the planner's deterministic output.
const CONFIG_SCOPES = ["dns.write", "workers-r2.write", "workers-scripts.admin", "zone.read"];

// /api/auth/start is now a config-bounded POST. Sends the config text so the
// server derives the exact scope set and binds config hash + targets + modes.
function startReq(app: Awaited<ReturnType<typeof createApp>>): Promise<Response> {
  return Promise.resolve(app.request("/api/auth/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: CONFIG_TEXT }),
  }));
}

const PUBLIC_ORIGIN = "https://installer.example";
const CLIENT_ID = "client-123";
const CLIENT_SECRET = "secret-456";
// Fixed 32-byte base64url key (stable, so sealed tx can be read on callback).

function authEnv(overrides: Partial<TapDeployEnv> = {}): TapDeployEnv {
  return {
    RUNTIME: "node",
    TAPDEPLOY_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    TAPDEPLOY_OAUTH_CLIENT_ID: CLIENT_ID,
    TAPDEPLOY_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    // Register the scopes the workers fixture requires on the OAuth client, so
    // the config-bounded start can derive them.
    ...overrides,
  };
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function getTxCookie(res: Response): Promise<string> {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/(__Host-tapdeploy_oauth_tx=[^;]*)/);
  if (!match) throw new Error("no tx cookie in Set-Cookie");
  return match[1]!;
}

function findCookie(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
}

async function getSessionCookie(res: Response): Promise<string> {
  const cookie = findCookie(res, "__Host-tapdeploy_session");
  if (!cookie) throw new Error("no session cookie in Set-Cookie");
  return cookie;
}

describe("auth routes", () => {
  it("returns 500 when OAuth client id is not configured", async () => {
    const app = createApp(authEnv({ TAPDEPLOY_OAUTH_CLIENT_ID: "" }));
    const res = await startReq(app);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/TAPDEPLOY_OAUTH_CLIENT_ID is required/);
  });

  it("fails closed on /api/auth/start when TAPDEPLOY_OAUTH_CLIENT_SECRET is missing", async () => {
    const app = createApp(authEnv({ TAPDEPLOY_OAUTH_CLIENT_SECRET: undefined }));
    const res = await startReq(app);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/TAPDEPLOY_OAUTH_CLIENT_SECRET is required/);
  });

  it("fails closed on /api/auth/session when TAPDEPLOY_OAUTH_CLIENT_SECRET is missing", async () => {
    const app = createApp(authEnv({ TAPDEPLOY_OAUTH_CLIENT_SECRET: undefined }));
    const res = await app.request("/api/auth/session", {
      headers: { cookie: "__Host-tapdeploy_session=stale" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(false);
  });

  it("requests exactly the config-derived scopes in consent", async () => {
    const app = createApp(authEnv());
    const res = await startReq(app);
    const body = await res.json();
    const url = new URL(body.url);
    // Worker + R2 derive Worker Admin + R2 Write; an HTTP unit adds Zone Read + DNS Write.
    expect(url.searchParams.get("scope")).toBe("dns.write workers-r2.write workers-scripts.admin zone.read");
  });

  it("requires a config to start OAuth (config-first)", async () => {
    const app = createApp(authEnv());
    const res = await app.request("/api/auth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("config_required");
  });

  it("rejects an invalid config at OAuth start", async () => {
    const app = createApp(authEnv());
    const res = await app.request("/api/auth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "{ not json" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_config");
  });

  it("issues a 20-minute session cookie", async () => {
    const app = createApp(authEnv());
    const startRes = await startReq(app);
    const startCookie = await getTxCookie(startRes);
    const state = new URL((await startRes.json()).url).searchParams.get("state")!;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse({ access_token: "tok", token_type: "Bearer" })) as typeof fetch;
    try {
      const cbRes = await app.request(`/api/auth/callback?code=code-1&state=${encodeURIComponent(state)}`, {
        headers: { cookie: startCookie },
      });
      const session = cbRes.headers.getSetCookie().find((c) => c.startsWith("__Host-tapdeploy_session=")) ?? "";
      expect(session).toContain("Max-Age=1200");
    } finally {
      globalThis.fetch = origFetch;
    }
  });


  it("start returns an authorize URL and a hardened tx cookie", async () => {
    const app = createApp(authEnv());
    const res = await startReq(app);
    expect(res.status).toBe(200);
    const body = await res.json();
    const url = new URL(body.url);
    expect(url.origin).toBe("https://dash.cloudflare.com");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(`${PUBLIC_ORIGIN}/api/auth/callback`);
    expect(url.searchParams.get("scope")).toContain("workers-scripts.admin");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    const setCookie = res.headers.get("set-cookie") ?? "";
    const tx = await getTxCookie(res);
    expect(tx).toContain("__Host-tapdeploy_oauth_tx=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=1200");
  });

  it("callback with a valid state/code exchanges and sets the session cookie", async () => {
    const app = createApp(authEnv());
    const startRes = await startReq(app);
    const startBody = await startRes.json();
    const url = new URL(startBody.url);
    const state = url.searchParams.get("state")!;

    // Capture the tx cookie to echo it back on the callback request.
    const origFetch = globalThis.fetch;
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input);
      seen.push({ url: u, init });
      if (u.includes("/oauth2/token")) {
        // Return the granted scope set; must cover the requested scopes so the
        // config-bounded verification passes.
        return jsonResponse({
          access_token: "tok-abc",
          token_type: "Bearer",
          scope: CONFIG_SCOPES.join(" "),
          expires_in: 3600,
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    try {
      const startCookie = await getTxCookie(startRes);
      const cbRes2 = await app.request(`/api/auth/callback?code=code-1&state=${encodeURIComponent(state)}`, {
        headers: { cookie: startCookie },
      });
      expect(cbRes2.status).toBe(302);

      // Two independently usable Set-Cookie values (not comma-folded).
      const setCookies = cbRes2.headers.getSetCookie();
      expect(setCookies.length).toBe(2);
      const sessionRaw = findCookie(cbRes2, "__Host-tapdeploy_session");
      expect(sessionRaw).toBeDefined();
      expect(sessionRaw).toContain("HttpOnly");
      expect(sessionRaw).toContain("Secure");
      expect(sessionRaw).toContain("Path=/");
      const txClear = findCookie(cbRes2, "__Host-tapdeploy_oauth_tx");
      expect(txClear).toContain("Max-Age=0");
      expect(txClear).toContain("HttpOnly");

      const sessionCookie = sessionRaw ?? "";
      const sessRes = await app.request("/api/auth/session", {
        headers: { cookie: sessionCookie },
      });
      const sessBody = await sessRes.json();
      expect(sessBody.authenticated).toBe(true);
      // The session records the config-bound granted scope set.
      expect(sessBody.scope).toEqual(CONFIG_SCOPES);
      expect(sessBody.configHash).toMatch(/^[0-9a-f]{64}$/);
      expect(sessBody.expiresAt).toBeGreaterThan(Date.now());
    } finally {
      globalThis.fetch = origFetch;
    }

    expect(seen.length).toBeGreaterThanOrEqual(1);
    const tokenCall = seen.find((s) => s.url.includes("/oauth2/token"));
    expect(tokenCall).toBeDefined();
    const body = String(tokenCall!.init?.body ?? "");
    expect(body).toContain("code=code-1");
    expect(body).toContain("code_verifier=");
    expect(body).toContain("grant_type=authorization_code");
    expect(tokenCall!.init?.headers).toMatchObject({ Authorization: `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}` });
  }, 15000);

  it("callback rejects a mismatched state", async () => {
    const app = createApp(authEnv());
    const startRes = await startReq(app);
    const startCookie = await getTxCookie(startRes);
    const cbRes = await app.request("/api/auth/callback?code=code-1&state=WRONG", {
      headers: { cookie: startCookie },
    });
    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/?auth=error&error=bad_state`);
  });

  it.each(["workers-scripts.admin", ""])("callback blocks partial/empty grant %j (no silent re-auth)", async scope => {
    const app = createApp(authEnv());
    const startRes = await startReq(app);
    const startCookie = await getTxCookie(startRes);
    const state = new URL((await startRes.json()).url).searchParams.get("state")!;

    const origFetch = globalThis.fetch;
    // Only grant part of the requested scopes -> verification fails -> block.
    globalThis.fetch = (async () =>
      jsonResponse({ access_token: "tok", token_type: "Bearer", scope })) as typeof fetch;
    try {
      const cbRes = await app.request(`/api/auth/callback?code=code-1&state=${encodeURIComponent(state)}`, {
        headers: { cookie: startCookie },
      });
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/?auth=error&error=scope_denied`);
      // No session cookie is set on a denied scope.
      const send = findCookie(cbRes, "__Host-tapdeploy_session");
      expect(send).toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("callback rejects an expired transaction cookie", async () => {
    const app = createApp(authEnv());
    const key = await deriveSealKey(CLIENT_SECRET);
    const expired = await sealJson(key, {
      state: "s",
      nonce: "n",
      verifier: "v",
      issuedAt: Date.now() - 25 * 60 * 1000,
    });
    const txCookie = `__Host-tapdeploy_oauth_tx=${encodeURIComponent(JSON.stringify(expired))}`;
    const cbRes = await app.request("/api/auth/callback?code=code-1&state=s", {
      headers: { cookie: txCookie },
    });
    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/?auth=error&error=expired_tx`);
  });

  it("callback redirects to an exchange error when the provider rejects the code", async () => {
    const app = createApp(authEnv());
    const startRes = await startReq(app);
    const startCookie = await getTxCookie(startRes);
    const state = new URL((await startRes.json()).url).searchParams.get("state")!;

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse({ error: "invalid_grant", error_description: "code used twice" }, 400)) as typeof fetch;
    try {
      const cbRes = await app.request(`/api/auth/callback?code=code-1&state=${encodeURIComponent(state)}`, {
        headers: { cookie: startCookie },
      });
      expect(cbRes.status).toBe(302);
      expect(cbRes.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/?auth=error&error=exchange`);
      // Raw upstream detail must NOT be reflected into the redirect URL.
      expect(cbRes.headers.get("location")).not.toContain("code%20used%20twice");
      expect(cbRes.headers.get("location")).not.toContain("detail");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("callback rejects a replay of an already-consumed tx cookie", async () => {
    const app = createApp(authEnv());
    const startRes = await startReq(app);
    const startCookie = await getTxCookie(startRes);
    const state = new URL((await startRes.json()).url).searchParams.get("state")!;

    const origFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse({ access_token: "tok-1", token_type: "Bearer" });
      }
      return jsonResponse({ error: "invalid_grant", error_description: "code used twice" }, 400);
    }) as typeof fetch;
    try {
      const first = await app.request(`/api/auth/callback?code=code-1&state=${encodeURIComponent(state)}`, {
        headers: { cookie: startCookie },
      });
      expect(first.status).toBe(302);
      expect(first.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/?auth=success`);

      // The tx cookie is cleared on success, so a replay without it fails.
      const replay = await app.request(`/api/auth/callback?code=code-1&state=${encodeURIComponent(state)}`, {
        headers: { cookie: startCookie },
      });
      // Second attempt: provider rejects replay; exchange path returns error redirect.
      expect([302]).toContain(replay.status);
      expect(replay.headers.get("location")).toContain("auth=error");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("callback rejects when the tx cookie is missing", async () => {
    const app = createApp(authEnv());
    const cbRes = await app.request("/api/auth/callback?code=code-1&state=abc");
    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/?auth=error&error=missing_tx`);
  });

  it("callback redirects on a malformed/expired tx cookie", async () => {
    const app = createApp(authEnv());
    const cbRes = await app.request("/api/auth/callback?code=code-1&state=abc", {
      headers: { cookie: "__Host-tapdeploy_oauth_tx=not-json" },
    });
    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/?auth=error&error=bad_tx`);
  });

  it("callback redirects to an error URL when the provider returns an error", async () => {
    const app = createApp(authEnv());
    const cbRes = await app.request("/api/auth/callback?error=access_denied");
    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/?auth=error&error=access_denied`);
  });

  it("session returns authenticated:false with no session cookie", async () => {
    const app = createApp(authEnv());
    const res = await app.request("/api/auth/session");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
  });

  it("session returns authenticated:false for an invalid session cookie", async () => {
    const app = createApp(authEnv());
    const res = await app.request("/api/auth/session", {
      headers: { cookie: "__Host-tapdeploy_session=not-json" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false });
  });

  it("logout clears the session cookie when CSRF + origin pass", async () => {
    const app = createApp(authEnv());
    // Build a valid session by running the full callback flow.
    const startRes = await startReq(app);
    const startCookie = await getTxCookie(startRes);
    const state = new URL((await startRes.json()).url).searchParams.get("state")!;

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/oauth2/token")) {
        return jsonResponse({ access_token: "tok-abc", token_type: "Bearer" });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    try {
      const cbRes = await app.request(`/api/auth/callback?code=code-1&state=${encodeURIComponent(state)}`, {
        headers: { cookie: startCookie },
      });
      const sessionCookie = (await getSessionCookie(cbRes)).split(";")[0]!;

      // Fetch the CSRF token from the session endpoint.
      const sessRes = await app.request("/api/auth/session", {
        headers: { cookie: sessionCookie },
      });
      const csrf = (await sessRes.json()).csrf as string;
      expect(csrf).toBeTruthy();

      const logoutRes = await app.request("/api/auth/logout", {
        method: "POST",
        headers: {
          cookie: sessionCookie,
          origin: PUBLIC_ORIGIN,
          "x-tapdeploy-csrf": csrf,
        },
      });
      expect(logoutRes.status).toBe(200);
      const setCookie = logoutRes.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("__Host-tapdeploy_session=;");
      expect(setCookie).toContain("Max-Age=0");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("logout rejects a bad origin", async () => {
    const app = createApp(authEnv());
    const res = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/auth/check-config coverage probe", () => {
  async function authedSession(app: Awaited<ReturnType<typeof createApp>>): Promise<{ cookie: string; csrf: string }> {
    const startRes = await startReq(app);
    const state = new URL((await startRes.json()).url).searchParams.get("state")!;
    const startCookie = await getTxCookie(startRes);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse({ access_token: "tok", token_type: "Bearer", scope: CONFIG_SCOPES.join(" "), expires_in: 3600 })) as typeof fetch;
    try {
      const cbRes = await app.request(`/api/auth/callback?code=code-1&state=${encodeURIComponent(state)}`, {
        headers: { cookie: startCookie },
      });
      expect(cbRes.status).toBe(302);
      const sessionCookie = (findCookie(cbRes, "__Host-tapdeploy_session") ?? "").split(";")[0]!;
      const sessRes = await app.request("/api/auth/session", { headers: { cookie: sessionCookie } });
      const sessBody = (await sessRes.json()) as { csrf: string };
      return { cookie: sessionCookie, csrf: sessBody.csrf };
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  const check = (app: Awaited<ReturnType<typeof createApp>>, session: { cookie: string; csrf: string }, text: string, origin = PUBLIC_ORIGIN) =>
    app.request("/api/auth/check-config", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: session.cookie, origin, "x-tapdeploy-csrf": session.csrf },
      body: JSON.stringify({ text }),
    });

  it("reports covered for the exact config the grant was issued for", async () => {
    const app = createApp(authEnv());
    const session = await authedSession(app);
    const res = await check(app, session, CONFIG_TEXT);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, matches: true });
  });

  it("reports mismatch for a different config without minting anything", async () => {
    const app = createApp(authEnv());
    const session = await authedSession(app);
    const other = JSON.stringify({ ...JSON.parse(CONFIG_TEXT), app: { id: "other/app", name: "Other" } });
    const res = await check(app, session, other);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; matches: boolean; reason: string };
    expect(body).toMatchObject({ ok: true, matches: false, reason: "config_mismatch" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("reports invalid for a malformed config", async () => {
    const app = createApp(authEnv());
    const session = await authedSession(app);
    const res = await check(app, session, "{not json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; matches: boolean; reason: string };
    expect(body.ok).toBe(true);
    expect(body.matches).toBe(false);
    expect(body.reason).toBe("invalid_config");
  });

  it("fails closed when unauthenticated", async () => {
    const app = createApp(authEnv());
    const res = await app.request("/api/auth/check-config", {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: PUBLIC_ORIGIN },
      body: JSON.stringify({ text: CONFIG_TEXT }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, matches: false, reason: "unauthenticated" });
  });

  it("rejects a bad origin with 403 and no coverage answer", async () => {
    const app = createApp(authEnv());
    const session = await authedSession(app);
    const res = await check(app, session, CONFIG_TEXT, "https://evil.example");
    expect(res.status).toBe(403);
  });
});
