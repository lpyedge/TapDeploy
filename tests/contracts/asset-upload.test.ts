// The asset-upload forwarder: api.cloudflare.com has no CORS, so the installer
// relays the four JWT-scoped upload calls. The relay must need a session and
// CSRF, reach only fixed Cloudflare URLs, send the upload JWT (never the OAuth
// token, cookie or CSRF value) and keep requests and responses bounded.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import { ASSET_UPLOAD_MAX_BODY_BYTES } from "../../src/core/upload-limits.js";
import { WORKER_CONFIG_SCOPES, runConfigLogin } from "./login.js";
import { deriveSealKey } from "../../src/auth/keys.js";
import { createSession, sessionCookieName } from "../../src/auth/session.js";
import { computeConfigV3Id } from "../../src/manifest/config-v3.js";
import { graphActionId } from "../../src/core/planning/digest.js";
import { assetUploadHash } from "../../src/cloudflare/assets/manifest.js";
import { uploadAssetBucket } from "../../src/cloudflare/assets/upload.js";
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
      [`target=workers-assets&account=${ACCOUNT}`, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/assets/upload?base64=true`, "multipart/form-data; boundary=xyz"],
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

// the Worker static-asset pair over the real graph API (both runtimes).
// register → direct upload of approved buckets through the same-origin
// forwarder (OAuth never leaves the server) → provider-attested complete →
// version bound to the completion JWT → activate → postcheck. The provider is
// the only mock; session/context cryptography, planning, receipts and the
// upload bytes are production code.
describe("worker static-asset pair (graph API)", () => {
  const ACCOUNT = "a".repeat(32);
  const ORIGIN = "https://installer.example.com";
  const CODE = "export default { fetch() { return new Response('ok'); } };";
  const INDEX = "<h1>hi</h1>";
  const APPJS = "console.log(1)";
  const WRANGLER = JSON.stringify({
    name: "api",
    main: "worker/main.mjs",
    compatibility_date: "2026-10-17",
    assets: { directory: "public" },
  });
  const V3_CONFIG = {
    schemaVersion: 3,
    app: { id: "example/assets", name: "Assets" },
    source: { allowLocalZip: true },
    capabilities: ["workers"],
  };
  const SESSION_JWT = (n: number) => `session-jwt-${String(n).padStart(8, "0")}`;
  const COMPLETION_JWT = "completion-jwt-00000001";
  const enc = new TextEncoder();

  interface MockVersion { id: string; message: string; bindings: Record<string, unknown>[]; runtime: Record<string, unknown> }

  async function setupGraph(runtime: "node" | "workers") {
    const env = { RUNTIME: runtime, PUBLIC_ORIGIN: ORIGIN, OAUTH_CLIENT_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } as const;
    const app = createApp(env);
    const key = await deriveSealKey(env.OAUTH_CLIENT_SECRET);
    const session = await createSession(key, { ttlMs: 120_000, publicOrigin: ORIGIN }, {
      accessToken: "offline-test-token", tokenType: "Bearer", scope: [], source: "v3", accountId: ACCOUNT,
      configHash: await computeConfigV3Id(V3_CONFIG as never),
      sourcePolicy: { allowLocalZip: true, appId: "example/assets", units: [] },
    });
    const headers = {
      origin: ORIGIN,
      "x-tapdeploy-csrf": session.payload.csrf,
      cookie: `${sessionCookieName(ORIGIN)}=${session.cookieValue}`,
    };
    const uploaded = new Set<string>();
    const issuedSessions = new Set<string>();
    const workers = new Map<string, { versions: MockVersion[]; active: string }>();
    let sessionCounter = 0;
    let versionCounter = 0;
    const ok = (result: unknown) => Response.json({ success: true, result });
    const calls: Array<{ method: string; path: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.cloudflare.com");
      const method = init?.method ?? "GET";
      const path = url.pathname;
      calls.push({ method, path });
      if (path.endsWith("/assets-upload-session") && method === "POST") {
        const { manifest } = JSON.parse(String(init?.body)) as { manifest: Record<string, { hash: string }> };
        const missing = Object.values(manifest).map((m) => m.hash).filter((h) => !uploaded.has(h));
        if (missing.length > 0) {
          const jwt = SESSION_JWT(++sessionCounter);
          issuedSessions.add(jwt);
          return ok({ jwt, buckets: [missing] });
        }
        return ok({ jwt: COMPLETION_JWT, buckets: [] });
      }
      if (path.endsWith("/workers/assets/upload") && method === "POST") {
        const jwt = /^Bearer (.+)$/.exec(new Headers(init?.headers).get("authorization") ?? "")?.[1] ?? "";
        if (!issuedSessions.has(jwt)) {
          return Response.json({ success: false, errors: [{ code: 10001, message: "unauthorized" }] }, { status: jwt === COMPLETION_JWT ? 403 : 401 });
        }
        return ok({ jwt: COMPLETION_JWT });
      }
      if (path.endsWith("/workers/scripts") && method === "GET") return ok([...workers.keys()].map((id) => ({ id })));
      const match = /\/workers\/scripts\/([^/]+)(.*)$/.exec(path);
      if (match) {
        const name = decodeURIComponent(match[1]!);
        const tail = match[2]!;
        const worker = workers.get(name);
        if ((tail === "" && method === "PUT") || (tail === "/versions" && method === "POST")) {
          const form = init?.body as FormData;
          const meta = JSON.parse(await (form.get("metadata") as Blob).text()) as Record<string, unknown>;
          if ((meta.assets as { jwt?: unknown } | undefined)?.jwt !== COMPLETION_JWT) {
            return Response.json({ success: false, errors: [{ code: 10001, message: "unauthorized" }] }, { status: 401 });
          }
          const id = `00000000-0000-4000-8000-${String(++versionCounter).padStart(12, "0")}`;
          const version: MockVersion = { id, message: (meta.annotations as Record<string, string>)["workers/message"]!, bindings: (meta.bindings as Record<string, unknown>[]) ?? [], runtime: { compatibility_date: meta.compatibility_date, compatibility_flags: meta.compatibility_flags ?? [] } };
          if (worker) worker.versions.unshift(version);
          else workers.set(name, { versions: [version], active: id });
          return ok({ id: tail === "" ? name : id });
        }
        if (!worker) {
          return Response.json({ success: false, errors: [{ code: 10007, message: "not found" }] }, { status: 404 });
        }
        if (tail === "/versions" && method === "GET") return ok({ items: worker.versions.map(({ id, message }) => ({ id, message })) });
        if (tail.startsWith("/versions/") && method === "GET") {
          const version = worker.versions.find((v) => v.id === tail.slice("/versions/".length));
          return version ? ok({ id: version.id, message: version.message, resources: { bindings: version.bindings, script_runtime: version.runtime } }) : Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
        }
        if (tail === "/deployments") {
          if (method === "POST") worker.active = (JSON.parse(String(init?.body)) as { versions: Array<{ version_id: string }> }).versions[0]!.version_id;
          const deployment = { id: `deployment-${worker.active}`, versions: [{ version_id: worker.active, percentage: 100 }] };
          return ok(method === "GET" ? { deployments: [deployment] } : deployment);
        }
        if (tail === "/schedules") return ok({ schedules: [] });
        if (tail === "/settings") return ok({ bindings: worker.versions[0]?.bindings ?? [] });
        if (tail === "/secrets") return ok([]);
      }
      throw new Error(`unexpected provider operation ${method} ${path}`);
    }));
    return { app, headers, calls, workers, uploaded };
  }

  function files() {
    return {
      "wrangler.jsonc": enc.encode(WRANGLER),
      "worker/main.mjs": enc.encode(CODE),
      "public/index.html": enc.encode(INDEX),
      "public/app.js": enc.encode(APPJS),
    };
  }

  async function prepareAndPlan(t: Awaited<ReturnType<typeof setupGraph>>) {
    const archive = zipSync(files(), { level: 0 });
    const prepared = await t.app.request("/api/deploy/prepare", {
      method: "POST",
      headers: { ...t.headers, "content-type": "application/zip" },
      body: archive as unknown as BodyInit,
    });
    const preparedBody = await prepared.json() as { releaseProof: unknown };
    expect(prepared.status, JSON.stringify(preparedBody)).toBe(200);
    const planned = await t.app.request("/api/deploy/plan", {
      method: "POST",
      headers: { ...t.headers, "content-type": "application/json" },
      body: JSON.stringify({ accountId: ACCOUNT, releaseProof: preparedBody.releaseProof, config: { text: JSON.stringify(V3_CONFIG) }, paidRiskConfirmed: true, mode: "install" }),
    });
    const body = await planned.json() as {
      graphPlan: { blocked: boolean; digest: string; units: Array<{ unitId: string; kind: string; diffs: Array<{ resource: string; action: string; name?: string }> }> };
      executionContext: unknown; approval: unknown; bundleDigests: Record<string, string>;
    };
    return { body };
  }

  function step(t: Awaited<ReturnType<typeof setupGraph>>, plan: { executionContext: unknown; approval: unknown; bundleDigests: Record<string, string> }, unitId: string, resource: string, action: string, name: string | undefined, phase: string, args: Record<string, unknown> = {}) {
    const actionId = graphActionId({ unitId, resource, action, ...(name !== undefined ? { name } : {}) });
    return t.app.request("/api/deploy/step", {
      method: "POST",
      headers: { ...t.headers, "content-type": "application/json" },
      body: JSON.stringify({
        accountId: ACCOUNT, executionContext: plan.executionContext, approval: plan.approval,
        unitId, actionId, phase, step: phase, bundleDigest: plan.bundleDigests[unitId], args,
      }),
    });
  }

  it.each(["node", "workers"] as const)("registers, uploads approved buckets, completes, and binds the version (%s)", async (runtime) => {
    const t = await setupGraph(runtime);
    const { body } = await prepareAndPlan(t);
    expect(body.graphPlan.blocked, JSON.stringify(body.graphPlan)).toBe(false);
    const diffs = body.graphPlan.units.find((u) => u.unitId === "main")!.diffs;
    expect(diffs.map((d) => `${d.resource}:${d.action}`).sort()).toContain("static-assets:create");
    const expectedHashes = new Set([
      await assetUploadHash("/index.html", enc.encode(INDEX)),
      await assetUploadHash("/app.js", enc.encode(APPJS)),
    ]);
    const register = await step(t, body, "main", "static-assets", "create", "api", "register-assets");
    expect(register.status, await register.clone().text()).toBe(200);
    const registerBody = await register.json() as { result: { jwt: string; buckets: string[][] }; phaseReceipt: unknown };
    expect(new Set(registerBody.result.buckets.flat())).toEqual(expectedHashes);
    // The browser uploads only approved buckets through the same-origin
    // forwarder with the session JWT (the OAuth token never leaves the server).
    const byHash = new Map<string, { hash: string; bytes: Uint8Array; contentType: string }>();
    for (const [name, bytes] of [["/index.html", enc.encode(INDEX)], ["/app.js", enc.encode(APPJS)]] as const) {
      const hash = await assetUploadHash(name, bytes);
      byHash.set(hash, { hash, bytes, contentType: name.endsWith(".html") ? "text/html" : "application/javascript" });
    }
    const uploadFetch = async (input: string | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      for (const name of form.keys()) t.uploaded.add(String(name));
      const jwt = /^Bearer (.+)$/.exec(new Headers(init?.headers).get("authorization") ?? "")?.[1] ?? "";
      const request = new Request(`https://installer.example/api/upload/assets?target=workers-assets&account=${ACCOUNT}`, {
        method: "POST",
        headers: { "x-tapdeploy-csrf": t.headers["x-tapdeploy-csrf"], cookie: t.headers.cookie, "x-tapdeploy-upload-jwt": jwt },
        body: form,
      });
      return t.app.request(request);
    };
    for (const bucket of registerBody.result.buckets) {
      const res = await uploadAssetBucket(ACCOUNT, bucket, new Map(bucket.map((h) => [h, byHash.get(h)!])), { jwt: registerBody.result.jwt, fetcher: uploadFetch as typeof fetch });
      expect(res.completionJwt ?? registerBody.result.jwt).toBeTruthy();
    }
    const complete = await step(t, body, "main", "static-assets", "create", "api", "complete-assets", { receipts: [registerBody.phaseReceipt] });
    expect(complete.status, await complete.clone().text()).toBe(200);
    const completeBody = await complete.json() as { result: { jwt: string }; phaseReceipt: unknown };
    expect(completeBody.result.jwt).toBe(COMPLETION_JWT);
    const created = await step(t, body, "main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(CODE).toString("base64"), assetJwt: completeBody.result.jwt, receipts: [registerBody.phaseReceipt, completeBody.phaseReceipt] });
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = await created.json() as { result: { versionId: string }; phaseReceipt: unknown };
    const version = t.workers.get("api")?.versions[0];
    expect(version?.bindings).toContainEqual({ name: "ASSETS", type: "assets" });
    const activated = await step(t, body, "main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt, registerBody.phaseReceipt, completeBody.phaseReceipt] });
    expect(activated.status, await activated.clone().text()).toBe(200);
    const wrote = (suffix: string, method: string) => t.calls.some((c) => c.path.endsWith(suffix) && c.method === method);
    expect(wrote("/assets-upload-session", "POST")).toBe(true);
    expect(wrote("/workers/assets/upload", "POST")).toBe(true);
    expect(wrote("/workers/scripts/api", "PUT")).toBe(true);
  });

  it.each(["node", "workers"] as const)("refuses completion while approved buckets are still missing (%s)", async (runtime) => {
    const t = await setupGraph(runtime);
    const { body } = await prepareAndPlan(t);
    const register = await step(t, body, "main", "static-assets", "create", "api", "register-assets");
    expect(register.status).toBe(200);
    const registerBody = await register.json() as { phaseReceipt: unknown };
    // No upload happened: the provider still reports missing hashes.
    const complete = await step(t, body, "main", "static-assets", "create", "api", "complete-assets", { receipts: [registerBody.phaseReceipt] });
    expect(complete.status).toBe(409);
    expect((await complete.json() as { error: string }).error).toBe("assets-not-ready");
    // And a version upload without the completion JWT refuses before any write.
    const writesBefore = t.calls.length;
    const created = await step(t, body, "main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(CODE).toString("base64") });
    expect(created.status).toBe(409);
    expect(t.calls).toHaveLength(writesBefore);
  });

  it.each(["node", "workers"] as const)("rejects forged and wrong-unit upload tokens with zero version writes (%s)", async (runtime) => {
    const t = await setupGraph(runtime);
    const { body } = await prepareAndPlan(t);
    const register = await step(t, body, "main", "static-assets", "create", "api", "register-assets");
    expect(register.status).toBe(200);
    const registerBody = await register.json() as { result: { jwt: string; buckets: string[][] }; phaseReceipt: unknown };
    const byHash = new Map<string, { hash: string; bytes: Uint8Array; contentType: string }>();
    for (const [name, bytes] of [["/index.html", enc.encode(INDEX)], ["/app.js", enc.encode(APPJS)]] as const) {
      const hash = await assetUploadHash(name, bytes);
      byHash.set(hash, { hash, bytes, contentType: "application/octet-stream" });
    }
    const attempt = (jwt: string) =>
      uploadAssetBucket(ACCOUNT, registerBody.result.buckets[0]!, new Map(registerBody.result.buckets[0]!.map((h) => [h, byHash.get(h)!])), {
        jwt,
        fetcher: (async () => Response.json({ success: false, errors: [{ code: 10001 }] }, { status: 401 })) as typeof fetch,
      });
    await expect(attempt("forged-jwt-0000000000")).rejects.toMatchObject({ kind: "token-expired" });
    await expect(attempt(SESSION_JWT(999))).rejects.toMatchObject({ kind: "token-expired" });
    // The completion and version legs never ran: no version exists.
    expect(t.workers.size).toBe(0);
    expect(t.calls.some((c) => c.method === "PUT" && c.path.endsWith("/workers/scripts/api"))).toBe(false);
  });

  it("re-registers idempotently on a lost response and orders complete after register", async () => {
    const t = await setupGraph("node");
    const { body } = await prepareAndPlan(t);
    const register = await step(t, body, "main", "static-assets", "create", "api", "register-assets");
    expect(register.status).toBe(200);
    const registerBody = await register.json() as { phaseReceipt: unknown };
    // Lost response: the same register call with its receipt is idempotent.
    const retry = await step(t, body, "main", "static-assets", "create", "api", "register-assets", { phaseReceipt: registerBody.phaseReceipt });
    expect(retry.status, await retry.clone().text()).toBe(200);
    expect((await retry.json() as { status?: string }).status).toBe("IDEMPOTENT_VERIFIED");
    // Complete without the register receipt refuses before any provider write.
    const writesBefore = t.calls.length;
    const complete = await step(t, body, "main", "static-assets", "create", "api", "complete-assets");
    expect(complete.status).toBe(409);
    expect(t.calls).toHaveLength(writesBefore);
    // Create-version without the completion receipt refuses as well.
    const created = await step(t, body, "main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(CODE).toString("base64"), assetJwt: COMPLETION_JWT, receipts: [registerBody.phaseReceipt] });
    expect(created.status).toBe(409);
  });

  it("refuses worker assets without a built main module at prepare time", async () => {
    const t = await setupGraph("node");
    const archive = zipSync(
      { "wrangler.jsonc": enc.encode(WRANGLER), "public/index.html": enc.encode(INDEX) },
      { level: 0 },
    );
    const prepared = await t.app.request("/api/deploy/prepare", {
      method: "POST",
      headers: { ...t.headers, "content-type": "application/zip" },
      body: archive as unknown as BodyInit,
    });
    // Explicit prepare refusal: no built main module, no asset graph.
    expect(prepared.status).toBe(400);
    expect(await prepared.json()).toMatchObject({ error: "INVALID_PER_UNIT_RELEASE" });
  });
});
