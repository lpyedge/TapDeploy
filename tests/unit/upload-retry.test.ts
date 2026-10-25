import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadAssetBucket } from "../../src/cloudflare/assets/upload.js";
import { uploadPagesAssets } from "../../src/cloudflare/pages/upload.js";

const HASH = "a".repeat(32);
const files = new Map([[HASH, { hash: HASH, bytes: new Uint8Array([1, 2, 3]) }]]);
const pagesFiles = [{ hash: HASH, bytes: new Uint8Array([1, 2, 3]) }];
const ok = () => new Response(JSON.stringify({ success: true, result: { jwt: "done" } }), { status: 200 });

function fetcherOf(...responses: Array<() => Response>) {
  const calls: number[] = [];
  const fetcher = vi.fn(async () => {
    calls.push(Date.now());
    const next = responses[Math.min(calls.length, responses.length) - 1]!;
    return next();
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("asset bucket upload retry", () => {
  it("waits for Retry-After before the second attempt", async () => {
    const { fetcher, calls } = fetcherOf(() => new Response("slow down", { status: 429, headers: { "retry-after": "2" } }), ok);
    const done = uploadAssetBucket("a".repeat(32), [HASH], files, { jwt: "jwt", fetcher });
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(await done).toEqual({ completionJwt: "done" });
    expect(calls).toHaveLength(2);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(2000);
  });

  it("backs off before retrying a 5xx and stops after the bounded attempts", async () => {
    const { fetcher, calls } = fetcherOf(() => new Response(null, { status: 503 }));
    const outcome = uploadAssetBucket("a".repeat(32), [HASH], files, { jwt: "jwt", fetcher }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toMatchObject({ kind: "server" });
    expect(calls).toHaveLength(2);
    expect(calls[1]! - calls[0]!).toBeGreaterThan(0);
  });

  it.each([401, 403])("does not retry a %s", async (status) => {
    const { fetcher, calls } = fetcherOf(() => new Response(null, { status }));
    await expect(uploadAssetBucket("a".repeat(32), [HASH], files, { jwt: "jwt", fetcher })).rejects.toMatchObject({ kind: status === 401 ? "token-expired" : "forbidden" });
    expect(calls).toHaveLength(1);
  });
});

describe("Pages asset upload retry", () => {
  it("retries a 503 once after a back-off and then succeeds", async () => {
    const { fetcher, calls } = fetcherOf(() => new Response(null, { status: 503 }), ok);
    const done = uploadPagesAssets(pagesFiles, { jwt: "jwt", fetcher });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(done).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("waits for Retry-After on a 429", async () => {
    const { fetcher, calls } = fetcherOf(() => new Response(null, { status: 429, headers: { "retry-after": "3" } }), ok);
    const done = uploadPagesAssets(pagesFiles, { jwt: "jwt", fetcher });
    await vi.advanceTimersByTimeAsync(2999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400);
    await expect(done).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("gives up after the bounded attempts with the typed error", async () => {
    const { fetcher, calls } = fetcherOf(() => new Response(null, { status: 503 }));
    const outcome = uploadPagesAssets(pagesFiles, { jwt: "jwt", fetcher }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toMatchObject({ kind: "server" });
    expect(calls).toHaveLength(2);
  });

  it.each([401, 403])("does not retry a %s", async (status) => {
    const { fetcher, calls } = fetcherOf(() => new Response(null, { status }));
    await expect(uploadPagesAssets(pagesFiles, { jwt: "jwt", fetcher })).rejects.toMatchObject({ kind: status === 401 ? "token-expired" : "forbidden" });
    expect(calls).toHaveLength(1);
  });
});
