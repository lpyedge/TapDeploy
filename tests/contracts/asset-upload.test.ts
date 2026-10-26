// The asset-upload forwarder: api.cloudflare.com has no CORS, so the installer
// relays the four JWT-scoped upload calls. The relay must need a session and
// CSRF, reach only fixed Cloudflare URLs, send the upload JWT (never the OAuth
// token, cookie or CSRF value) and keep requests and responses bounded.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import { ASSET_UPLOAD_MAX_BODY_BYTES } from "../../src/core/upload-limits.js";
import { WORKER_CONFIG_SCOPES, runConfigLogin } from "./login.js";
import { assetUploadHash } from "../../src/cloudflare/assets/manifest.js";
import { zipSync } from "fflate";

const ORIGIN = "https://installer.example.com";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const JWT = "aaaaaaaa.bbbbbbbb.cccccccc";
const scopes = WORKER_CONFIG_SCOPES.join(" ");

// Removed the v2 config fixture; a V3 config now authenticates the same
// session (workers + r2 derive the identical Worker Admin + R2 Write scopes).
const V3_CONFIG_TEXT = JSON.stringify({
  schemaVersion: 3,
  app: { id: "test/app", name: "App" },
  source: { allowLocalZip: true },
  capabilities: ["workers", "r2"],
  units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }],
});

async function setup() {
  const app = createApp({ RUNTIME: "node", PUBLIC_ORIGIN: ORIGIN, OAUTH_CLIENT_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", OAUTH_CLIENT_ID: "fake-client" });
  const login = await runConfigLogin(app, { configText: V3_CONFIG_TEXT, scope: scopes });
  return { app, login };
}

function post(app: ReturnType<typeof createApp>, query: string, init: { cookie?: string; csrf?: string; jwt?: string; type?: string; body?: BodyInit }) {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  if (init.csrf) headers["x-tapdeploy-csrf"] = init.csrf;
  if (init.jwt) headers["x-tapdeploy-upload-jwt"] = init.jwt;
  if (init.type) headers["content-type"] = init.type;
  return app.request(`/api/upload/assets?${query}`, { method: "POST", headers, body: init.body ?? "{}" });
}

const upstream: Array<{ url: string; init: RequestInit }> = [];
function stubUpstream(response: () => Response) {
  upstream.length = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    upstream.push({ url: String(url), init });
    return response();
  });
}
afterEach(() => vi.unstubAllGlobals());

describe("asset upload forwarder", () => {
  it("requires a session and the CSRF token", async () => {
    const { app, login } = await setup();
    expect((await post(app, "target=pages-upload", { jwt: JWT, type: "application/json" })).status).toBe(401);
    expect((await post(app, "target=pages-upload", { cookie: login.sessionCookie, jwt: JWT, type: "application/json" })).status).toBe(403);
    expect((await post(app, "target=pages-upload", { cookie: login.sessionCookie, csrf: "wrong", jwt: JWT, type: "application/json" })).status).toBe(403);
  });

  it("relays each target to its fixed URL with only the upload JWT", async () => {
    const { app, login } = await setup();
    const auth = { cookie: login.sessionCookie, csrf: login.csrf, jwt: JWT };
    stubUpstream(() => new Response(JSON.stringify({ success: true, result: { jwt: "completion-token-123456" } }), { status: 200, headers: { "content-type": "application/json" } }));

    const cases: Array<[string, string, string]> = [
      ["target=pages-check-missing", "https://api.cloudflare.com/client/v4/pages/assets/check-missing", "application/json"],
      ["target=pages-upload", "https://api.cloudflare.com/client/v4/pages/assets/upload", "application/json"],
      ["target=pages-upsert-hashes", "https://api.cloudflare.com/client/v4/pages/assets/upsert-hashes", "application/json"],
    ];
    for (const [query, url, type] of cases) {
      const res = await post(app, query, { ...auth, type, body: "payload" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, result: { jwt: "completion-token-123456" } });
      const sent = upstream.at(-1)!;
      expect(sent.url).toBe(url);
      const headers = new Headers(sent.init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${JWT}`);
      expect(headers.get("content-type")).toBe(type);
      expect([...headers.keys()].sort()).toEqual(["authorization", "content-type"]);
      expect(JSON.stringify([...headers.values()])).not.toContain(login.accessToken);
    }
  });

  it("refuses forged Worker bytes under an approved hash before upstream", async () => {
    const { app, login } = await setup();
    const hash = await assetUploadHash("/index.html", new TextEncoder().encode("approved A"));
    const form = new FormData();
    form.append(hash, new Blob([btoa("forged B")]), "index.html");
    stubUpstream(() => Response.json({ success: true }));
    const res = await app.request(`/api/upload/assets?target=workers-assets&account=${ACCOUNT}`, {
      method: "POST", headers: { cookie: login.sessionCookie, "x-tapdeploy-csrf": login.csrf, "x-tapdeploy-upload-jwt": JWT }, body: form,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "WORKER_ASSETS_UNSUPPORTED" });
    expect(upstream).toHaveLength(0);
  });

  it("passes upstream errors and Retry-After through unchanged", async () => {
    const { app, login } = await setup();
    stubUpstream(() => new Response(JSON.stringify({ success: false }), { status: 429, headers: { "content-type": "application/json", "retry-after": "7" } }));
    const res = await post(app, "target=pages-upload", { cookie: login.sessionCookie, csrf: login.csrf, jwt: JWT, type: "application/json" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
  });

  it("rejects unknown targets, bad tokens, wrong content types and bad accounts without calling Cloudflare", async () => {
    const { app, login } = await setup();
    const auth = { cookie: login.sessionCookie, csrf: login.csrf };
    stubUpstream(() => new Response("{}"));
    expect((await post(app, "target=accounts", { ...auth, jwt: JWT, type: "application/json" })).status).toBe(400);
    expect((await post(app, "target=__proto__", { ...auth, jwt: JWT, type: "application/json" })).status).toBe(400);
    expect((await post(app, "target=pages-upload", { ...auth, jwt: "bad token with spaces", type: "application/json" })).status).toBe(400);
    expect((await post(app, "target=pages-upload", { ...auth, type: "application/json" })).status).toBe(400);
    expect((await post(app, "target=pages-upload", { ...auth, jwt: JWT, type: "text/plain" })).status).toBe(415);
    expect((await post(app, `target=workers-assets&account=../../user`, { ...auth, jwt: JWT, type: "multipart/form-data; boundary=x" })).status).toBe(400);
    expect((await post(app, "target=workers-assets", { ...auth, jwt: JWT, type: "multipart/form-data; boundary=x" })).status).toBe(400);
    expect(upstream).toHaveLength(0);
  });

  it("bounds the request and the upstream response, and reports an unreachable upstream", async () => {
    const { app, login } = await setup();
    const auth = { cookie: login.sessionCookie, csrf: login.csrf, jwt: JWT, type: "application/json" };
    stubUpstream(() => new Response("{}"));
    expect((await post(app, "target=pages-upload", { ...auth, body: " ".repeat(ASSET_UPLOAD_MAX_BODY_BYTES + 1) })).status).toBe(413);
    expect(upstream).toHaveLength(0);

    stubUpstream(() => new Response("x".repeat(2 * 1024 * 1024)));
    expect((await post(app, "target=pages-upload", auth)).status).toBe(502);

    vi.stubGlobal("fetch", async () => { throw new TypeError("network down"); });
    expect((await post(app, "target=pages-upload", auth)).status).toBe(502);
  });
});

describe("Worker static assets are unsupported in both runtimes", () => {
  it.each(["node", "workers"] as const)("refuses a valid release before proof or provider calls (%s)", async (runtime) => {
    const app = createApp({ RUNTIME: runtime, PUBLIC_ORIGIN: ORIGIN, OAUTH_CLIENT_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", OAUTH_CLIENT_ID: "fake-client" });
    const login = await runConfigLogin(app, { configText: V3_CONFIG_TEXT, scope: scopes });
    stubUpstream(() => Response.json({ success: true }));
    const enc = new TextEncoder();
    const archive = zipSync({
      "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "main.mjs", compatibility_date: "2026-10-17", assets: { directory: "public" } })),
      "main.mjs": enc.encode("export default { fetch() { return new Response('ok'); } };"),
      "public/index.html": enc.encode("approved A"),
    });
    const res = await app.request("/api/deploy/prepare", { method: "POST", headers: { cookie: login.sessionCookie, "x-tapdeploy-csrf": login.csrf, "content-type": "application/zip" }, body: archive as BodyInit });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "WORKER_ASSETS_UNSUPPORTED" });
    expect(upstream).toHaveLength(0);
  });
});
