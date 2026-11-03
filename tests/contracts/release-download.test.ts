// POST /api/release/download: GitHub release downloads send no CORS headers, so
// the installer relays exactly the allowlisted GitHub hosts for a signed-in
// session, as a bounded stream, with no credentials and no open redirects.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import { RELEASE_MAX_BYTES } from "../../src/core/upload-limits.js";
import { isRelayedDownloadHost, relayedDownloadProblem } from "../../src/release/url.js";
import { CONFIG_TEXT, WORKER_CONFIG_SCOPES, runConfigLogin } from "./login.js";

const ORIGIN = "https://installer.example.com";
const scopes = WORKER_CONFIG_SCOPES.join(" ");
const ASSET = "https://github.com/example/app/releases/download/v1.0.0/app.zip";
const CDN = "https://release-assets.githubusercontent.com/github-production-release-asset/1/abc?sig=x";
// The URL publishers document; GitHub redirects it to the tagged asset, then to the CDN.
const LATEST = "https://github.com/example/app/releases/latest/download/app.zip";

async function setup() {
  const app = createApp({ RUNTIME: "node", PUBLIC_ORIGIN: ORIGIN, OAUTH_CLIENT_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", OAUTH_CLIENT_ID: "fake-client" });
  return { app, login: await runConfigLogin(app, { configText: CONFIG_TEXT, scope: scopes }) };
}

const seen: Array<{ url: string; init?: RequestInit }> = [];
function stub(handler: (url: string) => Response) {
  seen.length = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return handler(String(url));
  });
}
afterEach(() => vi.unstubAllGlobals());

function download(app: ReturnType<typeof createApp>, login: { sessionCookie: string; csrf: string }, url: unknown, headers: Record<string, string> = {}) {
  return app.request("/api/release/download", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: login.sessionCookie, "x-tapdeploy-csrf": login.csrf, ...headers },
    body: JSON.stringify({ url }),
  });
}

describe("relay URL policy", () => {
  it("allows GitHub release downloads and the GitHub asset CDNs only", () => {
    for (const ok of [ASSET, LATEST, "https://github.com/o/r/archive/refs/tags/v1.zip", "https://codeload.github.com/o/r/zip/refs/heads/main", CDN, "https://objects.githubusercontent.com/x"]) {
      expect(relayedDownloadProblem(ok), ok).toBeNull();
    }
    for (const bad of [
      "http://github.com/o/r/releases/download/v1/a.zip",
      "https://github.com/o/r",
      "https://github.com/o/r/issues/1",
      "https://github.com/o/r/releases/latest",
      "https://github.com/o/r/releases/tag/v1",
      "https://github.com/o/r/blob/main/a.zip",
      "https://github.com.evil.example/o/r/releases/download/v1/a.zip",
      "https://user:pw@github.com/o/r/releases/download/v1/a.zip",
      "https://github.com:8443/o/r/releases/download/v1/a.zip",
      "https://example.com/a.zip",
      "https://127.0.0.1/a.zip",
      "https://169.254.169.254/latest/meta-data",
      "not a url",
    ]) {
      expect(relayedDownloadProblem(bad), bad).not.toBeNull();
    }
    expect(isRelayedDownloadHost(ASSET)).toBe(true);
    expect(isRelayedDownloadHost("https://example.com/a.zip")).toBe(false);
  });
});

describe("release download relay", () => {
  it("streams the asset after following allowlisted redirects, sending no credentials", async () => {
    const { app, login } = await setup();
    stub((url) => (url === ASSET ? new Response(null, { status: 302, headers: { location: CDN } }) : new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-length": "4" } })));
    const res = await download(app, login, ASSET);
    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect(seen.map((s) => s.url)).toEqual([ASSET, CDN]);
    for (const { init } of seen) {
      expect(init?.redirect).toBe("manual");
      expect(Object.keys((init?.headers ?? {}) as Record<string, string>)).toEqual(["Accept"]);
    }
  });

  it("follows a latest-release URL through the tagged asset to the CDN", async () => {
    const { app, login } = await setup();
    stub((url) => {
      if (url === LATEST) return new Response(null, { status: 302, headers: { location: ASSET } });
      if (url === ASSET) return new Response(null, { status: 302, headers: { location: CDN } });
      return new Response(new Uint8Array([5, 6]), { headers: { "content-length": "2" } });
    });
    const res = await download(app, login, LATEST);
    expect(res.status).toBe(200);
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([5, 6]);
    expect(seen.map((s) => s.url)).toEqual([LATEST, ASSET, CDN]);
  });

  it("needs a session and CSRF, and refuses URLs outside the allowlist without fetching", async () => {
    const { app, login } = await setup();
    stub(() => new Response("x"));
    expect((await app.request("/api/release/download", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await download(app, login, ASSET, { "x-tapdeploy-csrf": "wrong" })).status).toBe(403);
    expect((await download(app, login, undefined)).status).toBe(400);
    expect((await download(app, login, "https://example.com/a.zip")).status).toBe(400);
    expect((await download(app, login, "https://github.com/o/r/issues/1")).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("refuses a redirect to a host outside the allowlist", async () => {
    const { app, login } = await setup();
    stub(() => new Response(null, { status: 302, headers: { location: "https://evil.example.com/steal.zip" } }));
    const res = await download(app, login, ASSET);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("redirect_refused");
    expect(seen).toHaveLength(1);
  });

  it.each([
    ["a downgrade to http", "http://github.com/example/app/releases/download/v1.0.0/app.zip"],
    ["a private IPv4 host", "https://169.254.169.254/latest/meta-data"],
    ["a loopback host", "https://127.0.0.1/app.zip"],
    ["an IPv4-mapped IPv6 private host", "https://[::ffff:10.0.0.1]/app.zip"],
    ["credentials in the URL", "https://user:pw@github.com/example/app/releases/download/v1.0.0/app.zip"],
    ["a non-default port", "https://github.com:8443/example/app/releases/download/v1.0.0/app.zip"],
    ["a non-release github.com path", "https://github.com/example/app/issues/1"],
  ])("refuses a redirect hop to %s and never fetches it", async (_label, hop) => {
    const { app, login } = await setup();
    stub(() => new Response(null, { status: 302, headers: { location: hop } }));
    const res = await download(app, login, ASSET);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("redirect_refused");
    expect(seen.map((s) => s.url)).toEqual([ASSET]);
  });

  it("resolves a relative redirect against the current hop and still applies the allowlist", async () => {
    const { app, login } = await setup();
    stub((url) => (url === ASSET ? new Response(null, { status: 302, headers: { location: "/example/app/releases/download/v1.0.1/app.zip" } }) : new Response(new Uint8Array([9]), { headers: { "content-length": "1" } })));
    const res = await download(app, login, ASSET);
    expect(res.status).toBe(200);
    expect(seen.map((s) => s.url)).toEqual([ASSET, "https://github.com/example/app/releases/download/v1.0.1/app.zip"]);
  });

  it("gives up after the redirect budget and on a redirect without a location", async () => {
    const { app, login } = await setup();
    stub(() => new Response(null, { status: 302, headers: { location: ASSET } }));
    expect((await download(app, login, ASSET)).status).toBe(502);
    expect(seen).toHaveLength(5);
    stub(() => new Response(null, { status: 302 }));
    const noLocation = await download(app, login, ASSET);
    expect(noLocation.status).toBe(502);
    expect(((await noLocation.json()) as { error: string }).error).toBe("redirect_refused");
    expect(seen).toHaveLength(1);
  });

  it("forwards none of the caller's credentials (session cookie, CSRF, Authorization) upstream", async () => {
    const { app, login } = await setup();
    stub(() => new Response(new Uint8Array([1]), { headers: { "content-length": "1" } }));
    const res = await download(app, login, ASSET, { authorization: "Bearer CALLER-SECRET", origin: ORIGIN });
    expect(res.status).toBe(200);
    expect(JSON.stringify(seen)).not.toMatch(/CALLER-SECRET|tapdeploy_session|x-tapdeploy-csrf/i);
    expect(Object.keys((seen[0]!.init?.headers ?? {}) as Record<string, string>)).toEqual(["Accept"]);
  });

  it("refuses an oversized download before streaming it, and cuts a longer stream off", async () => {
    const { app, login } = await setup();
    stub(() => new Response("x", { headers: { "content-length": String(RELEASE_MAX_BYTES + 1) } }));
    const res = await download(app, login, ASSET);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "too_large", size: RELEASE_MAX_BYTES + 1, limit: RELEASE_MAX_BYTES });

    const chunk = new Uint8Array(8 * 1024 * 1024);
    stub(() => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 9; i++) c.enqueue(chunk); c.close(); } })));
    const streamed = await download(app, login, ASSET);
    await expect(streamed.arrayBuffer()).rejects.toThrow();
  });

  it("reports a missing asset as 404 and an unreachable upstream as 502", async () => {
    const { app, login } = await setup();
    stub(() => new Response("nope", { status: 404 }));
    expect((await download(app, login, ASSET)).status).toBe(404);
    vi.stubGlobal("fetch", async () => { throw new TypeError("down"); });
    expect((await download(app, login, ASSET)).status).toBe(502);
  });
});
