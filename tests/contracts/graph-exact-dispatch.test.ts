import { expect, it } from "vitest";
import type { DeploySpec } from "../../src/core/deploy-spec.js";
import { exactGraphDispatchSpec } from "../../src/core/deploy/graph-dispatch.js";

const spec = {
  schemaVersion: 1, project: { id: "app", version: "1" }, worker: { path: "main.mjs", size: 1, sha256: "a".repeat(64) }, assets: [], inputs: {}, targetKind: "workers",
  wrangler: { name: "app", compatibility_date: "2026-01-01", r2_buckets: [], crons: [] },
  cloudflare: { workerName: "app", r2: [{ binding: "A", bucketName: "one", createIfMissing: true }, { binding: "B", bucketName: "two", createIfMissing: true }], d1: [], kv: [], queues: [], hyperdrive: [], vectorize: [], secretsStore: [], runtimeBindings: [], cron: [], secrets: {} },
} as DeploySpec;

it("projects an exact resource create and cannot pass an unrelated batch", () => {
  const exact = exactGraphDispatchSpec(spec, { resource: "r2", action: "create", name: "one" });
  expect(exact?.cloudflare.r2).toEqual([{ binding: "A", bucketName: "one", createIfMissing: true }]);
  expect(exactGraphDispatchSpec(spec, { resource: "r2", action: "create", name: "missing" })).toBeNull();
  expect(exactGraphDispatchSpec(spec, { resource: "r2", action: "preserve", name: "one" })).toBeNull();
});
