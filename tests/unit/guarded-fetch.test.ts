import { afterEach, describe, expect, it, vi } from "vitest";

import { DownloadRefusedError, fetchBounded, formatBytes } from "../../src/web/lib/guarded-fetch.js";

const opts = {
  maxBytes: 10,
  accept: "application/json",
  timeoutMs: 1000,
  label: "config",
  checkFinalUrl: (url: string) => (url.startsWith("https://good.") ? null : "redirected to a disallowed URL"),
};

function stubFetch(handler: (init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    calls.push(init?.method ?? "GET");
    return handler(init);
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchBounded", () => {
  it("refuses on a HEAD that declares too much and never issues the GET", async () => {
    const calls = stubFetch(() => new Response(null, { status: 200, headers: { "content-length": "11" } }));
    await expect(fetchBounded("https://good.example/c.json", opts)).rejects.toThrow(/config is 11 B; the limit is 10 B/);
    expect(calls).toEqual(["HEAD"]);
  });

  it("falls back to a bounded GET when HEAD is blocked", async () => {
    const calls = stubFetch((init) => {
      if (init?.method === "HEAD") throw new TypeError("blocked by CORS");
      return new Response("12345");
    });
    expect(new TextDecoder().decode(await fetchBounded("https://good.example/c.json", opts))).toBe("12345");
    expect(calls).toEqual(["HEAD", "GET"]);
  });

  it("caps a GET that sends more than it declared", async () => {
    stubFetch((init) => {
      if (init?.method === "HEAD") return new Response(null, { status: 405 });
      return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(6)); c.enqueue(new Uint8Array(6)); c.close(); } }));
    });
    await expect(fetchBounded("https://good.example/c.json", opts)).rejects.toThrow(/size bound/);
  });

  it("rejects HTTP errors and a disallowed redirect target", async () => {
    stubFetch(() => new Response("nope", { status: 404 }));
    await expect(fetchBounded("https://good.example/c.json", opts)).rejects.toThrow(/HTTP 404/);

    stubFetch(() => {
      const res = new Response("ok");
      Object.defineProperty(res, "url", { value: "http://127.0.0.1/x" });
      return res;
    });
    await expect(fetchBounded("https://good.example/c.json", opts)).rejects.toBeInstanceOf(DownloadRefusedError);
  });

  it("times out a response that never arrives", async () => {
    stubFetch((init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    await expect(fetchBounded("https://good.example/c.json", { ...opts, timeoutMs: 20 })).rejects.toThrow(/timed out/);
  });
});

describe("formatBytes", () => {
  it("uses readable units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(64 * 1024 * 1024)).toBe("64.0 MiB");
  });
});
