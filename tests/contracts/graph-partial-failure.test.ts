// A step that fails after an earlier step wrote must leave the run recoverable
// without a duplicate or a deleted resource: the retry of the same approved
// step succeeds once, a replayed receipt writes nothing, and a fresh plan taken
// after the interruption reuses what the first run created.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigV3 } from "../../src/manifest/config-v3.js";
import { graphHonoFixture } from "./graph-hono-fixture.js";

afterEach(() => vi.unstubAllGlobals());

const enc = new TextEncoder();
const config: ConfigV3 = { schemaVersion: 3, app: { id: "example/partial", name: "Partial" }, source: { allowLocalZip: true }, capabilities: ["workers", "r2"] };
const release = {
  "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17", r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }] })),
  "worker/main.mjs": enc.encode("export default { fetch() { return new Response('ok'); } };"),
};

const bucketCreates = (f: { writes: () => Array<{ method: string; path: string }> }) =>
  f.writes().filter((call) => call.method === "POST" && call.path.endsWith("/r2/buckets")).length;

describe("interrupted install: bucket created, Worker upload fails", () => {
  it("surfaces a typed failure, keeps the bucket, and the same approved step then succeeds without a second bucket", async () => {
    const f = await graphHonoFixture(config, release);
    const bucket = await f.step("main", "r2", "create", "media", "create-r2-buckets");
    expect(bucket.status).toBe(200);
    const receipt = (await bucket.json() as { phaseReceipt: unknown }).phaseReceipt;

    f.failUpload();
    const failed = await f.step("main", "worker", "create", "api", "create-worker", { receipts: [receipt] });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    const failedBody = await failed.json() as { ok?: unknown; error?: unknown; phaseReceipt?: unknown };
    expect(failedBody.ok).not.toBe(true);
    expect(failedBody.phaseReceipt).toBeUndefined();
    expect(typeof failedBody.error).toBe("string");
    expect(f.workers.has("api")).toBe(false);
    expect(f.buckets).toHaveLength(1);

    const retried = await f.step("main", "worker", "create", "api", "create-worker", { receipts: [receipt] });
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(f.workers.get("api")?.versions).toHaveLength(1);

    // Replaying the bucket step with its own receipt writes nothing; without it the
    // bucket that now exists is a stale target and is refused, never recreated.
    const writesBefore = f.writes().length;
    const bare = await f.step("main", "r2", "create", "media", "create-r2-buckets");
    expect(bare.status).toBe(409);
    expect(await bare.json()).toEqual({ error: "GRAPH_RESOURCE_CONFLICT" });
    const replay = await f.step("main", "r2", "create", "media", "create-r2-buckets", { phaseReceipt: receipt });
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect((await replay.json() as { status?: string }).status).toBe("IDEMPOTENT_VERIFIED");
    expect(f.writes()).toHaveLength(writesBefore);
    expect(f.buckets).toHaveLength(1);
    expect(bucketCreates(f)).toBe(1);
  });

  it("a fresh plan after the interruption reuses the created bucket instead of creating another", async () => {
    const f = await graphHonoFixture(config, release);
    const bucket = await f.step("main", "r2", "create", "media", "create-r2-buckets");
    expect(bucket.status).toBe(200);
    f.failUpload();
    const failed = await f.step("main", "worker", "create", "api", "create-worker", { receipts: [(await bucket.json() as { phaseReceipt: unknown }).phaseReceipt] });
    expect(failed.status).toBeGreaterThanOrEqual(400);

    const replanned = await f.plan();
    const body = await replanned.json() as typeof f.plannedBody;
    expect(replanned.status, JSON.stringify(body)).toBe(200);
    expect(body.graphPlan.blocked).toBe(false);
    const diffs = body.graphPlan.units[0]!.diffs.map((diff) => `${diff.resource}:${diff.action}`);
    expect(diffs).toContain("r2:preserve");
    expect(diffs).not.toContain("r2:create");
    expect(diffs).toContain("worker:create");

    const step = f.makeStep(body);
    const created = await step("main", "worker", "create", "api", "create-worker");
    expect(created.status, await created.clone().text()).toBe(200);
    expect(f.buckets).toHaveLength(1);
    expect(bucketCreates(f)).toBe(1);
  });
});
