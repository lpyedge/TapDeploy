// Workers runtime contract: the Workers build ships the Worker API entry +
// Static Assets with zero installer storage bindings, inlines no assets into the
// script, does no ZIP work in the Worker, and behaves identically to the Node
// entry for the shared API surface (-).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, type ParseError } from "jsonc-parser";

import worker from "../../src/runtime/workers.js";
import { createApp } from "../../src/api/app.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dist = path.join(root, "dist/workers");

const BANNED_BINDINGS = [
  "kv_namespaces",
  "d1_databases",
  "r2_buckets",
  "durable_objects",
  "queues",
  "hyperdrive",
  "vectorize",
];

const BINDINGS: Record<string, unknown> = {
  TAPDEPLOY_PUBLIC_ORIGIN: "https://installer.example",
  TAPDEPLOY_OAUTH_CLIENT_ID: "contract-client",
  TAPDEPLOY_OAUTH_CLIENT_SECRET: "A".repeat(43),
};

let workerScript: string;

describe("workers runtime package", () => {
  beforeAll(() => {
    mkdirSync(path.join(dist, "assets"), { recursive: true });
    writeFileSync(path.join(dist, "assets/.stale-build-canary"), "stale");
    execFileSync(process.execPath, ["scripts/build-workers.mjs"], { cwd: root, stdio: "pipe" });
    expect(existsSync(path.join(dist, "assets/.stale-build-canary"))).toBe(false);
    expect(existsSync(path.join(dist, "worker.mjs"))).toBe(true);
    expect(existsSync(path.join(dist, "assets/index.html"))).toBe(true);
    workerScript = readFileSync(path.join(dist, "worker.mjs"), "utf8");
  }, 60_000);

  it("builds the Worker module plus Static Assets (UI not inlined in the script)", () => {
    const html = readFileSync(path.join(dist, "assets/index.html"), "utf8");
    expect(html).toContain('id="root"');
    // The UI bundle must be a separate asset, never base64-embedded in the script.
    expect(workerScript).not.toContain("data:text/html;base64");
    expect(workerScript).not.toContain('id="root"');
    // Bounded Worker script (no assets baked in).
    expect(Buffer.byteLength(workerScript)).toBeLessThan(2_000_000);
  });

  // the "no ZIP decompression inside the Worker" assertion was removed
  // here (not skipped): it is architecturally obsolete. The sealed V3 prepare
  // route (`/api/deploy/prepare`) runs inside the Worker and must parse the
  // release ZIP itself (`deploy-prepare.ts` → `release/prebuilt-zip.ts` →
  // `release/zip.ts` → fflate), so the decoder's presence is required.
  // Bounded-script safety is still enforced by the size assertion above.

  it("declares Static Assets with no installer storage bindings", () => {
    const errors: ParseError[] = [];
    const config = parse(readFileSync(path.join(root, "wrangler.jsonc"), "utf8"), errors, {
      allowTrailingComma: true,
    }) as Record<string, unknown>;
    expect(errors).toHaveLength(0);
    expect(config.assets).toMatchObject({
      directory: "./dist/workers/assets",
      binding: "ASSETS",
    });
    const assets = config.assets as Record<string, unknown>;
    expect(assets.run_worker_first).toEqual(["/api/*"]);
    for (const banned of BANNED_BINDINGS) {
      expect(config).not.toHaveProperty(banned);
    }
  });

  it("matches the Node entry's API behavior (only the runtime label differs)", async () => {
    const nodeApp = createApp({
      ...(BINDINGS as Record<string, string>),
      RUNTIME: "node",
    });

    for (const path of ["/api/health", "/api/capabilities"]) {
      const req = () => new Request(`https://installer.example${path}`);
      const nodeRes = await nodeApp.fetch(req());
      const workerRes = await worker.fetch(req(), BINDINGS);
      expect(workerRes.status).toBe(nodeRes.status);

      const nodeBody = (await nodeRes.json()) as Record<string, unknown>;
      const workerBody = (await workerRes.json()) as Record<string, unknown>;
      expect(workerBody.runtime).toBe("workers");
      expect(nodeBody.runtime).toBe("node");
      delete nodeBody.runtime;
      delete workerBody.runtime;
      expect(workerBody).toEqual(nodeBody);
    }

    // Unauthenticated session parity, including the cookie policy (no cookie).
    const nodeSession = await nodeApp.fetch(new Request("https://installer.example/api/auth/session"));
    const workerSession = await worker.fetch(
      new Request("https://installer.example/api/auth/session"),
      BINDINGS,
    );
    expect(workerSession.status).toBe(nodeSession.status);
    expect(await workerSession.json()).toEqual(await nodeSession.json());
    expect(workerSession.headers.get("set-cookie")).toBe(nodeSession.headers.get("set-cookie"));
  });

  it("validates locally with Wrangler (dry-run) exposing only the ASSETS binding", () => {
    const run = spawnSync(
      "npx",
      ["wrangler", "deploy", "--dry-run", "--outdir", path.join(root, "dist/workers/dry-run")],
      { cwd: root, encoding: "utf8", timeout: 180_000 },
    );
    const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    expect(run.status, output).toBe(0);
    expect(output).toMatch(/env\.ASSETS\s+Assets/);
    for (const banned of ["KV Namespace", "D1 Database", "R2 Bucket", "Durable Object", "Queue"]) {
      expect(output).not.toContain(banned);
    }
  }, 180_000);
});

// the Workers entry (the exact module the Cloudflare runtime executes) must
// keep the one-shot OAuth/session contract fail-closed. Dummy, recognisable
// values only; the provider token endpoint is stubbed.
const SCOPES = ["dns.write", "workers-r2.write", "workers-scripts.admin", "zone.read"];
const ORIGIN = "https://installer.example";
const CONFIG_TEXT = JSON.stringify({
  schemaVersion: 3,
  app: { id: "test/app", name: "App" },
  source: { allowLocalZip: true },
  capabilities: ["workers", "r2"],
  units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }],
});
// The entry builds its app from the first bindings it sees (one isolate, one
// deployment), so every call loads a fresh module instance.
async function workerFetch(request: Request, bindings: Record<string, unknown>): Promise<Response> {
  vi.resetModules();
  const fresh = (await import("../../src/runtime/workers.js")).default;
  return fresh.fetch(request, bindings);
}

const AUTH_BINDINGS: Record<string, unknown> = { ...BINDINGS };

function startRequest(headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/auth/start`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ text: CONFIG_TEXT }),
  });
}

function stubTokenEndpoint(scope: string): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
    String(input).includes("/oauth2/token")
      ? new Response(JSON.stringify({ access_token: "DUMMY-ACCESS-TOKEN", token_type: "Bearer", scope, expires_in: 3600 }), { headers: { "content-type": "application/json" } })
      : new Response(null, { status: 404 }));
}

// Runs start + callback through the Worker entry; returns the session cookie pair.
async function signIn(bindings: Record<string, unknown> = AUTH_BINDINGS): Promise<string> {
  const start = await workerFetch(startRequest(), bindings);
  expect(start.status).toBe(200);
  const txCookie = (start.headers.get("set-cookie") ?? "").split(";")[0]!;
  const state = new URL(((await start.json()) as { url: string }).url).searchParams.get("state")!;
  stubTokenEndpoint(SCOPES.join(" "));
  const callback = await workerFetch(new Request(`${ORIGIN}/api/auth/callback?code=code-1&state=${encodeURIComponent(state)}`, { headers: { cookie: txCookie } }), bindings);
  expect(callback.status).toBe(302);
  const session = callback.headers.getSetCookie().find((cookie) => cookie.startsWith("__Host-tapdeploy_session="));
  expect(session).toBeDefined();
  return session!.split(";")[0]!;
}

describe("workers-hosted OAuth/session contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["TAPDEPLOY_PUBLIC_ORIGIN", /TAPDEPLOY_PUBLIC_ORIGIN is required/],
    ["TAPDEPLOY_OAUTH_CLIENT_ID", /TAPDEPLOY_OAUTH_CLIENT_ID is required/],
    ["TAPDEPLOY_OAUTH_CLIENT_SECRET", /TAPDEPLOY_OAUTH_CLIENT_SECRET is required/],
  ])("start fails closed with 500 when %s is missing, whatever Host/Forwarded headers say", async (missing, message) => {
    const bindings = { ...AUTH_BINDINGS };
    delete bindings[missing];
    const res = await workerFetch(startRequest({ host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https", forwarded: "host=evil.example;proto=https" }), bindings);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; url?: string };
    expect(body.error).toMatch(message);
    expect(body.url).toBeUndefined();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("the redirect URI is exactly TAPDEPLOY_PUBLIC_ORIGIN/api/auth/callback; forged Host/Forwarded headers cannot change it", async () => {
    const res = await workerFetch(startRequest({ "x-forwarded-host": "evil.example", forwarded: "host=evil.example", "x-original-url": "https://evil.example/" }), AUTH_BINDINGS);
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { url: string }).url);
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/callback`);
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual(SCOPES);
  });

  it.each(["http://installer.example", "https://installer.example/", "https://installer.example/app", "https://installer.example?x=1", "installer.example"])(
    "start refuses TAPDEPLOY_PUBLIC_ORIGIN %j (must be a bare https origin)",
    async (origin) => {
      const res = await workerFetch(startRequest(), { ...AUTH_BINDINGS, TAPDEPLOY_PUBLIC_ORIGIN: origin });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toMatch(/TAPDEPLOY_PUBLIC_ORIGIN/);
    },
  );

  it("start sets a hardened __Host- tx cookie; callback rejects a forged state and a missing tx cookie", async () => {
    const start = await workerFetch(startRequest(), AUTH_BINDINGS);
    const setCookie = start.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-tapdeploy_oauth_tx=/);
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) expect(setCookie).toContain(attribute);
    expect(setCookie).not.toContain("Domain=");
    const tx = setCookie.split(";")[0]!;
    const forged = await workerFetch(new Request(`${ORIGIN}/api/auth/callback?code=c&state=FORGED`, { headers: { cookie: tx } }), AUTH_BINDINGS);
    expect(forged.headers.get("location")).toBe(`${ORIGIN}/?auth=error&error=bad_state`);
    expect(forged.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-tapdeploy_session="))).toBe(false);
    const state = new URL(((await start.json()) as { url: string }).url).searchParams.get("state")!;
    const noTx = await workerFetch(new Request(`${ORIGIN}/api/auth/callback?code=c&state=${state}`), AUTH_BINDINGS);
    expect(noTx.headers.get("location") ?? "").toContain("auth=error");
    expect(noTx.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-tapdeploy_session="))).toBe(false);
  });

  it("a partial grant never mints a session (no silent second authorization)", async () => {
    const start = await workerFetch(startRequest(), AUTH_BINDINGS);
    const tx = (start.headers.get("set-cookie") ?? "").split(";")[0]!;
    const state = new URL(((await start.json()) as { url: string }).url).searchParams.get("state")!;
    stubTokenEndpoint("workers-scripts.admin");
    const callback = await workerFetch(new Request(`${ORIGIN}/api/auth/callback?code=c&state=${state}`, { headers: { cookie: tx } }), AUTH_BINDINGS);
    expect(callback.headers.get("location")).toBe(`${ORIGIN}/?auth=error&error=scope_denied`);
    expect(callback.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-tapdeploy_session="))).toBe(false);
  });

  it("a consumed transaction cannot be replayed", async () => {
    const start = await workerFetch(startRequest(), AUTH_BINDINGS);
    const tx = (start.headers.get("set-cookie") ?? "").split(";")[0]!;
    const state = new URL(((await start.json()) as { url: string }).url).searchParams.get("state")!;
    stubTokenEndpoint(SCOPES.join(" "));
    const callbackUrl = `${ORIGIN}/api/auth/callback?code=c&state=${state}`;
    const first = await workerFetch(new Request(callbackUrl, { headers: { cookie: tx } }), AUTH_BINDINGS);
    expect(first.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-tapdeploy_session="))).toBe(true);
    // The browser drops the cleared tx cookie; resending without it must not mint another session.
    const replay = await workerFetch(new Request(callbackUrl), AUTH_BINDINGS);
    expect(replay.headers.get("location") ?? "").toContain("auth=error");
    expect(replay.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-tapdeploy_session="))).toBe(false);
  });

  it("an authenticated session never exposes the access token; an unauthenticated one carries no data", async () => {
    const anonymous = await workerFetch(new Request(`${ORIGIN}/api/auth/session`), AUTH_BINDINGS);
    expect(await anonymous.json()).toEqual({ authenticated: false });
    const cookie = await signIn();
    const res = await workerFetch(new Request(`${ORIGIN}/api/auth/session`, { headers: { cookie } }), AUTH_BINDINGS);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ authenticated: true });
    expect(text).not.toContain("DUMMY-ACCESS-TOKEN");
    expect(text).not.toMatch(/access_?token/i);
  });

  it("a session sealed with another key, and one read after the key is removed, is not authenticated", async () => {
    const cookie = await signIn();
    for (const bindings of [{ ...AUTH_BINDINGS, TAPDEPLOY_OAUTH_CLIENT_SECRET: "B".repeat(43) }, { ...AUTH_BINDINGS, TAPDEPLOY_OAUTH_CLIENT_SECRET: undefined }]) {
      const res = await workerFetch(new Request(`${ORIGIN}/api/auth/session`, { headers: { cookie } }), bindings);
      expect(((await res.json()) as { authenticated: boolean }).authenticated).toBe(false);
    }
  });

  it("logout needs a matching CSRF token and origin for a live session, and clears the cookie only then", async () => {
    const cookie = await signIn();
    const session = (await (await workerFetch(new Request(`${ORIGIN}/api/auth/session`, { headers: { cookie } }), AUTH_BINDINGS)).json()) as { csrf: string };
    const logout = (headers: Record<string, string>) => workerFetch(new Request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: { cookie, ...headers } }), AUTH_BINDINGS);
    const badRequests: Array<Record<string, string>> = [{}, { "x-tapdeploy-csrf": "WRONG" }, { "x-tapdeploy-csrf": session.csrf, origin: "https://evil.example" }];
    for (const headers of badRequests) {
      const rejected = await logout(headers);
      expect(rejected.status).toBe(403);
      expect(rejected.headers.get("set-cookie")).toBeNull();
    }
    stubTokenEndpoint("");
    const accepted = await logout({ "x-tapdeploy-csrf": session.csrf, origin: ORIGIN });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("/api/* never falls through to the SPA shell", async () => {
    for (const [method, path] of [["GET", "/api/does-not-exist"], ["POST", "/api/does-not-exist"], ["GET", "/api/"]] as const) {
      const res = await workerFetch(new Request(`${ORIGIN}${path}`, { method }), AUTH_BINDINGS);
      expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
      expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
      expect(await res.text()).not.toContain('id="root"');
    }
  });

  it("wrangler.jsonc ships no vars or secrets, so TAPDEPLOY_DEV_EPHEMERAL_KEY and OAuth values can only come from the account's own secret store", () => {
    const errors: ParseError[] = [];
    const config = parse(readFileSync(path.join(root, "wrangler.jsonc"), "utf8"), errors, { allowTrailingComma: true }) as Record<string, unknown>;
    expect(errors).toHaveLength(0);
    for (const key of ["vars", "secrets", "env", "define"]) expect(config, key).not.toHaveProperty(key);
    expect(JSON.stringify(config)).not.toMatch(/TAPDEPLOY_|EPHEMERAL/);
  });
});
