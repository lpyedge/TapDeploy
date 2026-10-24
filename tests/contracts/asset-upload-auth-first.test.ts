// The relay must prove who is asking and what is being asked before it reads a
// single byte of the (up to 16 MiB) body: an unauthenticated or malformed request
// costs the installer nothing. After that, the bytes it does read are counted,
// capped and forwarded exactly, and a browser cancel stops the upstream request.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import { ASSET_UPLOAD_MAX_BODY_BYTES } from "../../src/core/upload-limits.js";
import { WORKER_CONFIG_SCOPES, runConfigLogin } from "./login.js";

const ORIGIN = "https://installer.example.com";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const JWT = "aaaaaaaa.bbbbbbbb.cccccccc";
const CHUNK = 1024 * 1024;
const CONFIG_TEXT = JSON.stringify({ schemaVersion: 3, app: { id: "test/app", name: "App" }, source: { allowLocalZip: true }, capabilities: ["workers", "r2"], units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }] });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

async function setup() {
  const app = createApp({ RUNTIME: "node", PUBLIC_ORIGIN: ORIGIN, OAUTH_CLIENT_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", OAUTH_CLIENT_ID: "fake-client" });
  const login = await runConfigLogin(app, { configText: CONFIG_TEXT, scope: WORKER_CONFIG_SCOPES.join(" ") });
  return { app, login };
}

// A request body that counts how much of it anyone pulled.
function countingBody(totalBytes: number) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const remaining = totalBytes - state.pulled;
      if (remaining <= 0) return controller.close();
      const size = Math.min(CHUNK, remaining);
      state.pulled += size;
      controller.enqueue(new Uint8Array(size).fill(7));
    },
    cancel() { state.cancelled = true; },
  });
  return { body, state };
}

interface Send { cookie?: string; csrf?: string; jwt?: string; type?: string; query?: string; body: BodyInit; headers?: Record<string, string>; signal?: AbortSignal }
function send(app: ReturnType<typeof createApp>, init: Send) {
  const headers: Record<string, string> = { ...init.headers };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.csrf) headers["x-tapdeploy-csrf"] = init.csrf;
  if (init.jwt) headers["x-tapdeploy-upload-jwt"] = init.jwt;
  if (init.type) headers["content-type"] = init.type;
  return app.request(`/api/upload/assets?${init.query ?? "target=pages-upload"}`, { method: "POST", headers, body: init.body, duplex: "half", ...(init.signal ? { signal: init.signal } : {}) } as RequestInit);
}

const upstream: Array<{ url: string; init: RequestInit }> = [];
function stubUpstream(response: () => Response | Promise<Response> = () => new Response("{}")) {
  upstream.length = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => { upstream.push({ url: String(url), init }); return response(); });
}

// Hono's in-memory adapter may pull once while it builds the Request; anything
// beyond a chunk or two means the handler (or a middleware) consumed the body.
const NOT_CONSUMED = 2 * CHUNK;

describe("asset upload relay reads nothing before it has authenticated and validated", () => {
  it("an unauthenticated 16 MiB upload is a 401 and its body is not read", async () => {
    const { app } = await setup();
    stubUpstream();
    const { body, state } = countingBody(ASSET_UPLOAD_MAX_BODY_BYTES);
    const response = await send(app, { jwt: JWT, type: "application/json", body });
    expect(response.status).toBe(401);
    expect(state.pulled).toBeLessThanOrEqual(NOT_CONSUMED);
    expect(upstream).toHaveLength(0);
  });

  it("a wrong CSRF token is a 403, the body is not read and Cloudflare is not called", async () => {
    const { app, login } = await setup();
    stubUpstream();
    const { body, state } = countingBody(ASSET_UPLOAD_MAX_BODY_BYTES);
    const response = await send(app, { cookie: login.sessionCookie, csrf: "wrong", jwt: JWT, type: "application/json", body });
    expect(response.status).toBe(403);
    expect(state.pulled).toBeLessThanOrEqual(NOT_CONSUMED);
    expect(upstream).toHaveLength(0);
  });

  it.each([
    ["an unknown target", { query: "target=accounts", type: "application/json", jwt: JWT }, 400],
    ["a bad upload token", { type: "application/json", jwt: "bad token with spaces" }, 400],
    ["a missing upload token", { type: "application/json" }, 400],
    ["a wrong content type", { type: "text/plain", jwt: JWT }, 415],
    ["a bad account", { query: "target=workers-assets&account=../../user", type: "multipart/form-data; boundary=x", jwt: JWT }, 400],
  ] as const)("%s is refused without reading the body or calling Cloudflare", async (_name, fields, status) => {
    const { app, login } = await setup();
    stubUpstream();
    const { body, state } = countingBody(ASSET_UPLOAD_MAX_BODY_BYTES);
    const response = await send(app, { cookie: login.sessionCookie, csrf: login.csrf, ...fields, body });
    expect(response.status).toBe(status);
    expect(state.pulled).toBeLessThanOrEqual(NOT_CONSUMED);
    expect(upstream).toHaveLength(0);
  });

  it("a declared length over the limit is refused before any byte is read", async () => {
    const { app, login } = await setup();
    stubUpstream();
    const { body, state } = countingBody(ASSET_UPLOAD_MAX_BODY_BYTES + CHUNK);
    const response = await send(app, { cookie: login.sessionCookie, csrf: login.csrf, jwt: JWT, type: "application/json", body, headers: { "content-length": String(ASSET_UPLOAD_MAX_BODY_BYTES + CHUNK) } });
    expect(response.status).toBe(413);
    expect(state.pulled).toBeLessThanOrEqual(NOT_CONSUMED);
    expect(upstream).toHaveLength(0);
  });
});

describe("asset upload relay bounds what it reads once the caller is accepted", () => {
  const auth = async () => { const { app, login } = await setup(); return { app, fields: { cookie: login.sessionCookie, csrf: login.csrf, jwt: JWT, type: "application/json" } }; };

  it("an upload of unknown length over the limit is cut off at the limit and never forwarded", async () => {
    const { app, fields } = await auth();
    stubUpstream();
    const { body, state } = countingBody(ASSET_UPLOAD_MAX_BODY_BYTES + 4 * CHUNK);
    const response = await send(app, { ...fields, body });
    expect(response.status).toBe(413);
    expect(state.pulled).toBeLessThanOrEqual(ASSET_UPLOAD_MAX_BODY_BYTES + 2 * CHUNK);
    expect(state.cancelled).toBe(true);
    expect(upstream).toHaveLength(0);
  });

  it("a Content-Length that understates the body cannot slip past the limit", async () => {
    const { app, fields } = await auth();
    stubUpstream();
    const { body } = countingBody(ASSET_UPLOAD_MAX_BODY_BYTES + CHUNK);
    const response = await send(app, { ...fields, body, headers: { "content-length": "10" } });
    expect(response.status).toBe(413);
    expect(upstream).toHaveLength(0);
  });

  it("forwards the exact bytes and the exact content type (multipart boundary kept)", async () => {
    const { app, login } = await setup();
    stubUpstream(() => new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } }));
    const payload = new Uint8Array(3 * CHUNK + 5).map((_, i) => (i * 31 + 7) & 255);
    const type = "multipart/form-data; boundary=----exact-boundary-123";
    const response = await send(app, { cookie: login.sessionCookie, csrf: login.csrf, jwt: JWT, type, query: `target=workers-assets&account=${ACCOUNT}`, body: payload });
    expect(response.status).toBe(200);
    const sent = upstream.at(-1)!;
    expect(new Headers(sent.init.headers).get("content-type")).toBe(type);
    const forwarded = new Uint8Array(await new Response(sent.init.body as BodyInit).arrayBuffer());
    expect(forwarded.length).toBe(payload.length);
    expect(forwarded.every((byte, i) => byte === payload[i])).toBe(true);
  });

  it("passes upstream 429 and 500 through with Retry-After", async () => {
    const { app, fields } = await auth();
    stubUpstream(() => new Response("{}", { status: 429, headers: { "retry-after": "9" } }));
    const limited = await send(app, { ...fields, body: "{}" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("9");
    stubUpstream(() => new Response("{}", { status: 500 }));
    expect((await send(app, { ...fields, body: "{}" })).status).toBe(500);
  });

  it("a browser cancel aborts the upstream request", async () => {
    const { app, fields } = await auth();
    let seen: AbortSignal | undefined;
    // Like a real fetch: pending until it answers, rejecting when its signal aborts.
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      seen = init.signal ?? undefined;
      seen?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const abort = new AbortController();
    const pending = Promise.resolve(send(app, { ...fields, body: "{}", signal: abort.signal })).catch(() => "aborted");
    while (!seen) await new Promise((r) => setTimeout(r, 0));
    expect(seen.aborted).toBe(false);
    abort.abort();
    await pending;
    expect(seen.aborted).toBe(true);
  });

  it("a stalled upload is dropped after the deadline instead of holding the connection", async () => {
    const { app, fields } = await auth();
    stubUpstream();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stalled = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); } });
    const pending = Promise.resolve(send(app, { ...fields, body: stalled }));
    // Real turns of the event loop (only setTimeout is faked) until the relay has
    // authenticated, validated and started its read deadline.
    while (vi.getTimerCount() === 0) await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(61_000);
    const response = await pending;
    expect(response.status).toBe(408);
    expect(upstream).toHaveLength(0);
  });
});
