// contract test for the read-only `/api/cloudflare/targets` route. It
// requires an authenticated config-bounded session and a CSRF token, and
// returns the live Workers scripts + Pages projects for the selected account so
// the operator can pick an explicit upgrade target. It is strictly
// read-only — no mutation. It follows the official provider list shapes
// (workers list result[], pages /pages/projects result[]).

import { describe, expect, it, vi } from "vitest";
import { createApp, type TapDeployEnv } from "../../src/api/app.js";
import { WORKER_CONFIG_SCOPES, runConfigLogin } from "./login.js";

const PUBLIC_ORIGIN = "https://installer.example";
const ACCOUNT = "a".repeat(32);
const CLIENT_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// The legacy v2 fixture (targets/resources shapes) was removed with ; the
// equivalent live V3 configs derive the same scope-bound sessions the route
// guards depend on (Workers -> workers-scripts.admin, Pages -> page.write).
const workerConfigText = JSON.stringify({
  schemaVersion: 3,
  app: { id: "test/app", name: "App" },
  source: { allowLocalZip: true },
  capabilities: ["workers", "r2"],
  units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }],
});
const dualConfigText = JSON.stringify({
  schemaVersion: 3,
  app: { id: "test/app", name: "App" },
  source: { allowLocalZip: true },
  capabilities: ["workers", "pages"],
  units: [
    { id: "main", kind: "worker", wrangler: "wrangler.jsonc" },
    { id: "site", kind: "pages", wrangler: "site/wrangler.jsonc" },
  ],
});
const pagesConfigText = JSON.stringify({
  schemaVersion: 3,
  app: { id: "test/app", name: "App" },
  source: { allowLocalZip: true },
  capabilities: ["pages"],
  units: [{ id: "site", kind: "pages", wrangler: "site/wrangler.jsonc" }],
});

function env(): TapDeployEnv {
  return {
    RUNTIME: "node",
    PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    OAUTH_CLIENT_ID: "client-123",
    OAUTH_CLIENT_SECRET: CLIENT_SECRET,
  };
}

function envelope(result: unknown) {
  return { success: true, errors: [], messages: [], result };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function headers(sessionCookie: string, csrf: string, origin = PUBLIC_ORIGIN) {
  return {
    cookie: sessionCookie,
    origin,
    "x-tapdeploy-csrf": csrf,
    "content-type": "application/json",
  };
}

// A mock fetcher that serves both the workers list and the Pages projects list
// following their official shapes.
function providersMock() {
  const calls: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const u = String(input);
    calls.push(u);
    if (u.includes("/workers/scripts")) {
      return jsonResponse(
        envelope([{ id: "existing-worker", created_on: "2026-01-01", modified_on: "2026-01-01" }]),
      );
    }
    if (u.includes("/pages/projects")) {
      return jsonResponse(
        envelope([
          {
            id: "project-id-1",
            name: "my-pages-app",
            subdomain: "my-pages-app.pages.dev",
            created_on: "2026-01-01T00:00:00Z",
            modified_on: "2026-02-01T00:00:00Z",
            domains: ["my-pages-app.pages.dev"],
            canonical_deployment: {
              id: "deployment-id-1",
              url: "https://my-pages-app.pages.dev",
              environment: "production",
            },
          },
        ]),
      );
    }
    return jsonResponse(envelope({}));
  });
  return { fn, calls };
}

describe("targets route (read-only target discovery)", () => {
  it("a Pages-only flow never queries Workers", async () => {
    const app = createApp(env());
    const session = await runConfigLogin(app, { configText: pagesConfigText, scope: "dns.write page.write zone.read" });
    const mock = providersMock();
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock.fn as typeof fetch;
    try {
      const response = await app.request("/api/cloudflare/targets", { method: "POST", headers: headers(session.sessionCookie, session.csrf), body: JSON.stringify({ accountId: ACCOUNT }) });
      expect(response.status).toBe(200);
      expect((await response.json()).workers).toEqual([]);
      expect(mock.calls.some((url) => url.includes("/workers/scripts"))).toBe(false);
      expect(mock.calls.some((url) => url.includes("/pages/projects"))).toBe(true);
    } finally { globalThis.fetch = origFetch; }
  });
  it("does not report a denied declared Pages capability as an empty verified list", async () => {
    const app = createApp(env());
    const session = await runConfigLogin(app, { configText: pagesConfigText, scope: "dns.write page.write zone.read" });
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => jsonResponse({ success: false, errors: [{ code: 9109, message: "Access denied" }] }, 403));
    try {
      const response = await app.request("/api/cloudflare/targets", { method: "POST", headers: headers(session.sessionCookie, session.csrf), body: JSON.stringify({ accountId: ACCOUNT }) });
      expect(response.status).toBe(502);
      expect((await response.json()).upstream).toBe("forbidden");
    } finally { globalThis.fetch = origFetch; }
  });
  it("requires an authenticated session", async () => {
    const app = createApp(env());
    const res = await app.request("/api/cloudflare/targets", {
      method: "POST",
      headers: { origin: PUBLIC_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ accountId: ACCOUNT }),
    });
    expect(res.status).toBe(401);
  });

  it("requires an accountId in the body", async () => {
    const app = createApp(env());
    const session = await runConfigLogin(app, { configText: workerConfigText });
    const res = await app.request("/api/cloudflare/targets", {
      method: "POST",
      headers: headers(session.sessionCookie, session.csrf),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("accountId is required");
  });

  it("returns Workers + Pages targets from the official list shapes", async () => {
    const app = createApp(env());
    const session = await runConfigLogin(app, { configText: dualConfigText, scope: [...WORKER_CONFIG_SCOPES, "page.write"].join(" ") });
    const mock = providersMock();
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock.fn as typeof fetch;
    try {
      const res = await app.request("/api/cloudflare/targets", {
        method: "POST",
        headers: headers(session.sessionCookie, session.csrf),
        body: JSON.stringify({ accountId: ACCOUNT }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        accountId: string;
        workers: { name: string }[];
        pages: { name: string; id: string }[];
      };
      expect(body.accountId).toBe(ACCOUNT);
      expect(body.workers).toEqual([{ name: "existing-worker" }]);
      expect(body.pages).toEqual([{ name: "my-pages-app", id: "project-id-1" }]);
      // Both follow the official account-scoped read routes.
      expect(mock.calls.some((u) => u.includes(`/accounts/${ACCOUNT}/workers/scripts`))).toBe(true);
      expect(mock.calls.some((u) => u.includes(`/accounts/${ACCOUNT}/pages/projects`))).toBe(true);
      // No OAuth token may be leaked into the response.
      expect(JSON.stringify(body)).not.toContain(session.accessToken);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("skips Pages discovery when its capability was not granted", async () => {
    const app = createApp(env());
    const session = await runConfigLogin(app, { configText: workerConfigText });
    const mock = providersMock();
    const origFetch = globalThis.fetch;
    // Pages list returns 403 (scope not granted) while workers succeeds.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/pages/projects")) {
        return jsonResponse({ success: false, errors: [{ code: 9109, message: "Access denied" }] }, 403);
      }
      if (String(input).includes("/workers/scripts")) {
        return jsonResponse(
          envelope([{ id: "existing-worker", created_on: "2026-01-01", modified_on: "2026-01-01" }]),
        );
      }
      return jsonResponse(envelope({}));
    }) as typeof fetch;
    try {
      const res = await app.request("/api/cloudflare/targets", {
        method: "POST",
        headers: headers(session.sessionCookie, session.csrf),
        body: JSON.stringify({ accountId: ACCOUNT }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        workers: { name: string }[];
        pages: { name: string; id: string }[];
      };
      expect(body.workers).toEqual([{ name: "existing-worker" }]);
      expect(body.pages).toEqual([]);
    } finally {
      globalThis.fetch = origFetch;
      void mock;
    }
  });
});

describe("domains route (read-only custom-domain discovery)", () => {
  it("lists zones, one zone's address records and bound domains with read calls only", async () => {
    const app = createApp(env());
    const session = await runConfigLogin(app, {});
    const zone = "7".repeat(32);
    const calls: Array<{ method: string; url: string }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url });
      if (url.includes("/zones/") && url.includes("/dns_records")) return jsonResponse(envelope([{ id: "r1", name: "www.example.com", type: "A", content: "192.0.2.1" }, { id: "r2", name: "example.com", type: "MX", content: "mx.example.com" }]));
      if (url.includes("/zones")) return jsonResponse(envelope([{ id: zone, name: "Example.com" }]));
      if (url.includes("/workers/domains")) return jsonResponse(envelope([{ id: "d1", hostname: "api.example.com", service: "api", zone_id: zone, zone_name: "example.com" }]));
      if (url.includes("/pages/projects/site/domains")) return jsonResponse(envelope([{ id: "p1", name: "docs.example.com", status: "pending" }]));
      if (url.includes("/pages/projects/new-site/domains")) return jsonResponse({ success: false, errors: [{ code: 8000007, message: "not found" }] }, 404);
      return jsonResponse(envelope([]));
    }) as typeof fetch;
    try {
      const response = await app.request("/api/cloudflare/domains", { method: "POST", headers: headers(session.sessionCookie, session.csrf), body: JSON.stringify({ accountId: ACCOUNT, zone: "example.com", pagesProjects: ["site", "new-site", "Bad Name"] }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        accountId: ACCOUNT,
        zones: ["example.com"],
        zone: "example.com",
        records: [{ name: "www.example.com", type: "A", content: "192.0.2.1" }],
        workerDomains: [{ hostname: "api.example.com", service: "api", zone: "example.com" }],
        pagesDomains: { site: ["docs.example.com"], "new-site": [] },
      });
      expect(calls.every((call) => call.method === "GET")).toBe(true);
    } finally { globalThis.fetch = origFetch; }
  });
});

describe("pages-domain-status route (one read for the result page's watch)", () => {
  it("answers the status Cloudflare reports for one domain with a single read, and 'missing' when it is not bound", async () => {
    const app = createApp(env());
    const session = await runConfigLogin(app, {});
    const calls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(envelope([{ id: "p1", name: "docs.example.com", status: "pending" }, { id: "p2", name: "site.pages.dev", status: "active" }]));
    }) as typeof fetch;
    try {
      const ask = (hostname: string, project = "site") => app.request("/api/cloudflare/pages-domain-status", { method: "POST", headers: headers(session.sessionCookie, session.csrf), body: JSON.stringify({ accountId: ACCOUNT, project, hostname }) });
      expect(await (await ask("Docs.Example.com")).json()).toEqual({ status: "pending" });
      expect(await (await ask("other.example.com")).json()).toEqual({ status: "missing" });
      expect(calls).toHaveLength(2);
      expect((await ask("docs.example.com", "Bad Name")).status).toBe(400);
      expect((await ask("not a host")).status).toBe(400);
    } finally { globalThis.fetch = origFetch; }
  });
});
