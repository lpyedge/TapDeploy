import { afterEach, describe, expect, it, vi } from "vitest";

import { createUploadProxy } from "../../src/web/upload-proxy.js";
import { splitBucketsForUpload } from "../../src/cloudflare/assets/batching.js";
import { planPagesBuckets } from "../../src/cloudflare/pages/batching.js";
import { ASSET_UPLOAD_BATCH_RAW_BYTES } from "../../src/core/upload-limits.js";

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
