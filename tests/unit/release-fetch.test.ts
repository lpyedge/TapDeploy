import { afterEach, describe, expect, it, vi } from "vitest";
import { RELEASE_MAX_BYTES } from "../../src/core/upload-limits.js";
import { fetchReleaseBytes } from "../../src/web/release.js";

afterEach(() => vi.unstubAllGlobals());

const URL_OK = "https://example.org/release.zip";
const GITHUB = "https://github.com/example/app/releases/download/v1.0.0/app.zip";
const calls: Array<{ url: string; method: string; signal: AbortSignal | undefined }> = [];

function stub(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  calls.length = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", signal: init?.signal ?? undefined });
    return handler(String(url), init);
  });
}
const stream = (chunks: number, size = 1024 * 1024) => {
  let sent = 0;
  return new ReadableStream<Uint8Array>({ pull(c) { if (sent++ >= chunks) return c.close(); c.enqueue(new Uint8Array(size)); } });
};

describe("fetchReleaseBytes keeps one deployable limit", () => {
  it("refuses a declared size over the limit from the HEAD, before any body byte is requested", async () => {
    stub((_url, init) => new Response(null, { status: 200, headers: { "content-length": String(RELEASE_MAX_BYTES + 1) }, ...(init?.method === "HEAD" ? {} : {}) }));
    await expect(fetchReleaseBytes(URL_OK, "csrf")).rejects.toThrow("the limit is 8.0 MiB");
    expect(calls.map((c) => c.method)).toEqual(["HEAD"]);
  });

  it("cuts off a body that is larger than it claimed (chunked or lying length)", async () => {
    stub((_url, init) => init?.method === "HEAD" ? new Response(null, { status: 405 }) : new Response(stream(9), { status: 200, headers: { "content-length": "100" } }));
    await expect(fetchReleaseBytes(URL_OK, "csrf")).rejects.toThrow();
  });

  it("returns exactly the bytes of a ZIP at the limit", async () => {
    const bytes = new Uint8Array(RELEASE_MAX_BYTES).fill(3);
    stub((_url, init) => init?.method === "HEAD" ? new Response(null, { status: 405 }) : new Response(bytes, { status: 200 }));
    const got = await fetchReleaseBytes(URL_OK, "csrf");
    expect(got.length).toBe(RELEASE_MAX_BYTES);
    expect(got[0]).toBe(3);
  });

  it("refuses a final URL a redirect moved to a disallowed host", async () => {
    stub((_url, init) => {
      const res = init?.method === "HEAD" ? new Response(null, { status: 405 }) : new Response(new Uint8Array(4), { status: 200 });
      if (init?.method !== "HEAD") Object.defineProperty(res, "url", { value: "https://127.0.0.1/evil.zip" });
      return res;
    });
    await expect(fetchReleaseBytes(URL_OK, "csrf")).rejects.toThrow("redirected to a disallowed URL");
  });

  it("refuses non-HTTPS and private hosts without any request", async () => {
    stub(() => new Response("x"));
    await expect(fetchReleaseBytes("http://example.org/release.zip", "csrf")).rejects.toThrow("HTTPS");
    await expect(fetchReleaseBytes("https://192.168.1.5/release.zip", "csrf")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("a host that blocks cross-origin downloads gets an actionable message", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("Failed to fetch"); });
    await expect(fetchReleaseBytes(URL_OK, "csrf")).rejects.toThrow(/does not allow cross-origin downloads.*Local ZIP/);
  });

  it("a download that never finishes ends with a timeout message", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
      const pending = fetchReleaseBytes(URL_OK, "csrf");
      const settled = expect(pending).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(121_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("an abort stops a direct download", async () => {
    const abort = new AbortController();
    stub((_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const pending = fetchReleaseBytes(URL_OK, "csrf", abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow();
    expect(calls[0]!.signal?.aborted).toBe(true);
  });
});

describe("GitHub downloads go through the installer relay", () => {
  it("posts the URL with the CSRF token and reads at most the limit", async () => {
    stub(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    expect([...await fetchReleaseBytes(GITHUB, "csrf-1")]).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/release/download");
    expect(calls[0]!.method).toBe("POST");
  });

  it("reports the relay's size refusal with the 8 MiB limit", async () => {
    stub(() => Response.json({ error: "too_large", size: 20 * 1024 * 1024, limit: RELEASE_MAX_BYTES }, { status: 413 }));
    await expect(fetchReleaseBytes(GITHUB, "csrf")).rejects.toThrow("release ZIP is 20.0 MiB; the limit is 8.0 MiB");
  });

  it("stops reading a relayed stream that exceeds the limit", async () => {
    stub(() => new Response(stream(10), { status: 200 }));
    await expect(fetchReleaseBytes(GITHUB, "csrf")).rejects.toThrow();
  });

  it("explains a missing release, and an abort cancels the relay call", async () => {
    stub(() => Response.json({ error: "upstream_status", status: 404 }, { status: 404 }));
    await expect(fetchReleaseBytes(GITHUB, "csrf")).rejects.toThrow("not found (HTTP 404)");
    const abort = new AbortController();
    stub((_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const pending = fetchReleaseBytes(GITHUB, "csrf", abort.signal);
    abort.abort();
    await expect(pending).rejects.toThrow();
    expect(calls[0]!.signal?.aborted).toBe(true);
  });
});
