// Session boundary matrix: every route the app registers is protected unless it
// is listed as public here, so a new route is covered by default. Also pins
// session/token isolation between two logins, forged and cross-deployment
// cookies, the login-CSRF binding of state to the tx cookie, a denied scope and
// the provider revoke on logout.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type TapDeployEnv } from "../../src/api/app.js";
import { runConfigLogin, WORKER_CONFIG_SCOPES, CONFIG_TEXT, type LoginResult } from "./login.js";

const PUBLIC_ORIGIN = "https://installer.example";
const SECRET_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SECRET_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

// Reachable without a session by design.
const PUBLIC_ROUTES = new Set([
  "GET /api/health",
  "POST /api/auth/start",
  "GET /api/auth/callback",
  "GET /api/auth/session",
  "POST /api/auth/logout",
]);

function env(secret = SECRET_A): TapDeployEnv {
  return { RUNTIME: "node", PUBLIC_ORIGIN, OAUTH_CLIENT_ID: "client-123", OAUTH_CLIENT_SECRET: secret };
}

function protectedRoutes(app: ReturnType<typeof createApp>): Array<{ method: string; path: string }> {
  return [...new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`))]
    .filter((route) => !PUBLIC_ROUTES.has(route))
    .sort()
    .map((route) => {
      const [method, path] = route.split(" ") as [string, string];
      return { method, path };
    });
}

// Answers a session-less caller with an explicit "no coverage" body instead of 401.
const PROBE_ROUTE = "POST /api/auth/check-config";
const UNAUTHENTICATED_PROBE = { ok: true, matches: false, reason: "unauthenticated" };

async function expectUnauthenticated(res: Response, route: { method: string; path: string }, label: string): Promise<void> {
  if (`${route.method} ${route.path}` === PROBE_ROUTE) {
    expect(res.status, label).toBe(200);
    expect(await res.json(), label).toEqual(UNAUTHENTICATED_PROBE);
  } else {
    expect(res.status, label).toBe(401);
  }
}

function call(app: ReturnType<typeof createApp>, route: { method: string; path: string }, headers: Record<string, string>) {
  return app.request(route.path, {
    method: route.method,
    headers: { "content-type": "application/json", ...headers },
    ...(route.method === "POST" ? { body: "{}" } : {}),
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("every protected route enforces session, origin and CSRF", () => {
  const app = createApp(env());

  it("registers protected routes to test", () => {
    expect(protectedRoutes(app).length).toBeGreaterThanOrEqual(12);
  });

  it("answers 401 (or the explicit unauthenticated probe answer) without a session cookie", async () => {
    for (const route of protectedRoutes(app)) {
      await expectUnauthenticated(await call(app, route, { origin: PUBLIC_ORIGIN }), route, `${route.method} ${route.path}`);
    }
  });

  it("answers 403 for a valid session with a foreign Origin, a missing CSRF header or another session's CSRF token", async () => {
    const a = await runConfigLogin(app);
    const b = await runConfigLogin(app);
    expect(a.csrf).not.toBe(b.csrf);
    for (const route of protectedRoutes(app)) {
      const label = `${route.method} ${route.path}`;
      const foreignOrigin = await call(app, route, { cookie: a.sessionCookie, origin: "https://evil.example", "x-tapdeploy-csrf": a.csrf });
      expect(foreignOrigin.status, `${label} foreign origin`).toBe(403);
      const noCsrf = await call(app, route, { cookie: a.sessionCookie, origin: PUBLIC_ORIGIN });
      expect(noCsrf.status, `${label} no csrf`).toBe(403);
      const otherCsrf = await call(app, route, { cookie: a.sessionCookie, origin: PUBLIC_ORIGIN, "x-tapdeploy-csrf": b.csrf });
      expect(otherCsrf.status, `${label} other session csrf`).toBe(403);
    }
  });

  it("rejects a tampered cookie and for a cookie sealed by another deployment", async () => {
    const a = await runConfigLogin(app);
    const tampered = a.sessionCookie.slice(0, -4) + (a.sessionCookie.endsWith("AAAA") ? "BBBB" : "AAAA");
    const otherDeployment = await runConfigLogin(createApp(env(SECRET_B)));
    for (const route of protectedRoutes(app)) {
      const label = `${route.method} ${route.path}`;
      const forged = await call(app, route, { cookie: tampered, origin: PUBLIC_ORIGIN, "x-tapdeploy-csrf": a.csrf });
      await expectUnauthenticated(forged, route, `${label} tampered`);
      const foreign = await call(app, route, { cookie: otherDeployment.sessionCookie, origin: PUBLIC_ORIGIN, "x-tapdeploy-csrf": otherDeployment.csrf });
      await expectUnauthenticated(foreign, route, `${label} other deployment`);
    }
  });
});

describe("two logins stay isolated", () => {
  it("sends each session's own provider token and never the other's", async () => {
    const app = createApp(env());
    const a = await runConfigLogin(app);
    const b = await runConfigLogin(app);
    expect(a.accessToken).not.toBe(b.accessToken);

    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return json({ success: true, errors: [], messages: [], result: [] });
    });
    const headers = (login: LoginResult) => ({ cookie: login.sessionCookie, origin: PUBLIC_ORIGIN, "x-tapdeploy-csrf": login.csrf });

    await app.request("/api/cloudflare/accounts", { headers: headers(a) });
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([`Bearer ${a.accessToken}`]));

    seen.length = 0;
    await app.request("/api/cloudflare/accounts", { headers: headers(b) });
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([`Bearer ${b.accessToken}`]));
  });
});

describe("authorization callback", () => {
  async function start(app: ReturnType<typeof createApp>) {
    const res = await app.request("/api/auth/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: CONFIG_TEXT }),
    });
    const body = (await res.json()) as { url: string };
    const tx = res.headers.getSetCookie().find((c) => c.startsWith("__Host-tapdeploy_oauth_tx="))!.split(";")[0]!;
    return { state: new URL(body.url).searchParams.get("state")!, tx };
  }

  it("does not accept another authorization's state with this browser's tx cookie (login CSRF)", async () => {
    const app = createApp(env());
    const victim = await start(app);
    const attacker = await start(app);
    vi.stubGlobal("fetch", async () => json({ access_token: "attacker-token", token_type: "Bearer", scope: WORKER_CONFIG_SCOPES.join(" "), expires_in: 3600 }));
    const res = await app.request(`/api/auth/callback?code=attacker-code&state=${encodeURIComponent(attacker.state)}`, { headers: { cookie: victim.tx } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/?auth=error&error=bad_state`);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-tapdeploy_session="))).toBe(false);
  });

  it("creates no session and requests no extra scope when a necessary scope is denied", async () => {
    const app = createApp(env());
    const { state, tx } = await start(app);
    vi.stubGlobal("fetch", async () => json({ access_token: "tok", token_type: "Bearer", scope: "zone.read", expires_in: 3600 }));
    const res = await app.request(`/api/auth/callback?code=code-1&state=${encodeURIComponent(state)}`, { headers: { cookie: tx } });
    expect(res.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/?auth=error&error=scope_denied`);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-tapdeploy_session="))).toBe(false);
  });

  it("never reflects a provider-supplied error value into the redirect", async () => {
    const app = createApp(env());
    const res = await app.request(`/api/auth/callback?error=${encodeURIComponent("https://evil.example/x")}&state=s`);
    expect(res.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/?auth=error&error=provider_error`);
  });
});

describe("logout", () => {
  it("revokes the session's provider token at the provider", async () => {
    const app = createApp(env());
    const login = await runConfigLogin(app);
    const revoked: Array<{ url: string; body: string; authorization: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      revoked.push({ url: String(input), body: String(init?.body ?? ""), authorization: new Headers(init?.headers).get("authorization") ?? "" });
      return new Response(null, { status: 200 });
    });
    const res = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: login.sessionCookie, origin: PUBLIC_ORIGIN, "x-tapdeploy-csrf": login.csrf },
    });
    expect(res.status).toBe(200);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.url).toContain("/oauth2/revoke");
    expect(revoked[0]!.body).toContain(login.accessToken);
  });
});
