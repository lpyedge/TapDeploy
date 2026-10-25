import { expect, it, vi } from "vitest";
import { executeDeployStep, type DeployStepContext } from "../../src/core/deploy/steps.js";
import { vectorizeActionFor, ensureVectorizeIndex } from "../../src/cloudflare/resources/vectorize.js";
function context(): DeployStepContext {
  return { workerName: "app", accountId: "a".repeat(32), accessToken: "fake", spec: { targetKind: "pages", project: { id: "app", version: "1" }, assets: [], wrangler: { name: "app", compatibility_date: "2026-10-10" }, cloudflare: { workerName: "app", r2: [{ binding: "BUCKET", bucketName: "new-bucket", createIfMissing: true }], d1: [], kv: [], queues: [], hyperdrive: [], vectorize: [], secretsStore: [], runtimeBindings: [], cron: [], secrets: {} } }, snapshot: { workerExists: false, r2Buckets: [], hyperdriveConfigs: [], secretNames: [], activeDeploymentVersionIds: [] }, client: { createR2Bucket: vi.fn(async () => ({ name: "new-bucket", id: "bucket" })) } } as unknown as DeployStepContext;
}
it("Pages cannot invoke a Worker-only resource step outside its cost/configuration plan", async () => {
  const ctx = context();
  expect((await executeDeployStep("create-r2-buckets", ctx, {})).ok).toBe(false);
  expect(ctx.client.createR2Bucket).not.toHaveBeenCalled();
});
it("an existing Vectorize schema mismatch or ambiguous name is not a preserve success", () => {
  const desired = { binding: "INDEX", indexName: "vectors", createIfMissing: true, config: { dimensions: 128, metric: "cosine" as const } };
  const existing = { name: "vectors", id: "index", config: { dimensions: 768, metric: "cosine" as const } };
  expect(vectorizeActionFor(desired, [existing]).action).toBe("conflict");
  expect(vectorizeActionFor(desired, [existing, { ...existing, id: "other" }]).action).toBe("conflict");
});
it("invalid/mixed Vectorize configuration refuses before provider mutation", async () => {
  const ctx = context();
  ctx.client.createVectorizeIndex = vi.fn();
  await expect(ensureVectorizeIndex(ctx.client, { indexName: "vectors", createIfMissing: true, knownIndexes: [], createRequest: { name: "vectors", config: { preset: "not-an-official-preset" } } })).rejects.toThrow(/configuration/);
  expect(ctx.client.createVectorizeIndex).not.toHaveBeenCalled();
  expect(vectorizeActionFor({ binding: "INDEX", indexName: "vectors", createIfMissing: true, config: { preset: "@cf/baai/bge-base-en-v1.5", dimensions: 768 } }, []).action).toBe("conflict");
});
