import { afterEach, describe, expect, it, vi } from "vitest";

import { createUploadProxy } from "../../src/web/upload-proxy.js";
import { splitBucketsForUpload } from "../../src/cloudflare/assets/batching.js";
import { planPagesBuckets } from "../../src/cloudflare/pages/batching.js";
import { ASSET_UPLOAD_BATCH_RAW_BYTES, ASSET_UPLOAD_MAX_BODY_BYTES } from "../../src/core/upload-limits.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const sent: Array<{ url: string; init: RequestInit }> = [];
vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
  sent.push({ url, init });
  return new Response("{}");
});
afterEach(() => (sent.length = 0));

describe("createUploadProxy", () => {
  const proxy = createUploadProxy("csrf-token");

  it("relays a Workers asset upload and moves the JWT out of Authorization", async () => {
    const body = new FormData();
    await proxy(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/assets/upload?base64=true`, {
      method: "POST",
      headers: { Authorization: "Bearer upload-jwt-value" },
      body,
    });
    expect(sent[0]!.url).toBe(`/api/upload/assets?target=workers-assets&account=${ACCOUNT}`);
    const headers = new Headers(sent[0]!.init.headers);
    expect(headers.get("x-tapdeploy-upload-jwt")).toBe("upload-jwt-value");
    expect(headers.get("x-tapdeploy-csrf")).toBe("csrf-token");
    expect(headers.has("authorization")).toBe(false);
    expect(sent[0]!.init.body).toBe(body);
  });

  it("maps the three Pages calls and keeps their JSON content type", async () => {
    for (const [path, target] of [["check-missing", "pages-check-missing"], ["upload", "pages-upload"], ["upsert-hashes", "pages-upsert-hashes"]] as const) {
      await proxy(`https://api.cloudflare.com/client/v4/pages/assets/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer j" },
        body: "{}",
      });
      expect(sent.at(-1)!.url).toBe(`/api/upload/assets?target=${target}`);
      expect(new Headers(sent.at(-1)!.init.headers).get("content-type")).toBe("application/json");
    }
  });

  it("refuses a batch the relay would refuse before sending any of it", async () => {
    const headers = { Authorization: "Bearer upload-jwt-value", "Content-Type": "application/json" };
    const url = "https://api.cloudflare.com/client/v4/pages/assets/upload";
    await expect(proxy(url, { method: "POST", headers, body: "x".repeat(ASSET_UPLOAD_MAX_BODY_BYTES + 1) })).rejects.toThrow("relays at most");
    await expect(proxy(url, { method: "POST", headers, body: new Blob([new Uint8Array(ASSET_UPLOAD_MAX_BODY_BYTES + 1)]) })).rejects.toThrow("relays at most");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(ASSET_UPLOAD_MAX_BODY_BYTES + 1)]), "big.bin");
    await expect(proxy(url, { method: "POST", headers, body: form })).rejects.toThrow("relays at most");
    expect(sent).toHaveLength(0);
    await proxy(url, { method: "POST", headers, body: "x".repeat(1024) });
    expect(sent).toHaveLength(1);
  });

  it("passes the caller's AbortSignal through so a cancelled upload stops", async () => {
    const abort = new AbortController();
    await proxy("https://api.cloudflare.com/client/v4/pages/assets/check-missing", { method: "POST", headers: { Authorization: "Bearer upload-jwt-value" }, body: "{}", signal: abort.signal });
    expect(sent[0]!.init.signal).toBe(abort.signal);
  });

  it.each([
    ["another Workers API path", `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/app`],
    ["an extra path segment", `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/assets/upload/extra`],
    ["a non-hex account", "https://api.cloudflare.com/client/v4/accounts/not-an-account/workers/assets/upload"],
    ["another host with a valid path", "https://evil.example/client/v4/pages/assets/upload"],
    ["a look-alike host", "https://api.cloudflare.com.evil.example/client/v4/pages/assets/upload"],
    ["the user endpoint", "https://api.cloudflare.com/client/v4/user"],
    ["a different Pages path", "https://api.cloudflare.com/client/v4/pages/projects"],
  ])("never forwards %s (a typed upload relay, not a generic fetch)", async (_name, url) => {
    await expect(createUploadProxy("csrf-token")(url, { method: "POST", headers: { Authorization: "Bearer upload-jwt-value" }, body: "{}" })).rejects.toThrow("not an asset upload");
    expect(sent).toHaveLength(0);
  });

  it("refuses anything that is not an asset upload", async () => {
    await expect(proxy("https://api.cloudflare.com/client/v4/accounts", { headers: { Authorization: "Bearer j" } })).rejects.toThrow(/cannot be forwarded/);
    await expect(proxy("https://evil.example.com/client/v4/pages/assets/upload", { headers: { Authorization: "Bearer j" } })).rejects.toThrow(/cannot be forwarded/);
    await expect(proxy("https://api.cloudflare.com/client/v4/pages/assets/upload", {})).rejects.toThrow(/upload token/);
    expect(sent).toHaveLength(0);
  });
});

describe("byte-bounded upload batches", () => {
  it("splits a bucket by raw bytes and by part count, and refuses an oversized file", () => {
    const sizes: Record<string, number> = { a: 5, b: 5, c: 5, d: 1 };
    const split = splitBucketsForUpload([["a", "b", "c", "d"]], 64, { sizeOf: (h) => sizes[h]!, maxBytes: 10 });
    expect(split).toEqual([["a", "b"], ["c", "d"]]);
    expect(splitBucketsForUpload([["a", "b", "c"]], 2, { sizeOf: () => 1, maxBytes: 100 })).toEqual([["a", "b"], ["c"]]);
    expect(() => splitBucketsForUpload([["a"]], 64, { sizeOf: () => 11, maxBytes: 10 })).toThrow(/upload limit per file/);
  });

  it("Pages buckets respect the forwarder's per-request budget", () => {
    const mib = 1024 * 1024;
    const buckets = planPagesBuckets([{ hash: "a", size: 6 * mib }, { hash: "b", size: 6 * mib }], ASSET_UPLOAD_BATCH_RAW_BYTES);
    expect(buckets.map((b) => b.map((e) => e.hash))).toEqual([["a"], ["b"]]);
    expect(() => planPagesBuckets([{ hash: "x", size: 10 * mib }], ASSET_UPLOAD_BATCH_RAW_BYTES)).toThrow(/bucket limit/);
  });
});
