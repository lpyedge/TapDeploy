import { describe, expect, it, vi } from "vitest";
import { createCloudflareClient } from "../../src/cloudflare/client/client.js";
import { snapshotTarget } from "../../src/core/planning/snapshot.js";
import { TAPDEPLOY_MANAGED_MARKER, resolveActiveOwnership } from "../../src/core/planning/digest.js";
import { executeDeployStep, type DeployStepContext } from "../../src/core/deploy/steps.js";
import type { CloudflareApiClient } from "../../src/cloudflare/client/client.js";
import { createHash } from "node:crypto";

const accountId = "a".repeat(32);
const oldId = "00000000-0000-4000-8000-000000000001";
describe("exact active history", () => {
  it("resolves an old active ID beyond the newest 50-version page and inventories exact version bindings", async () => {
    const reads: string[] = [];
    const client = createCloudflareClient({ accountId, accessToken: "fake", fetcher: async url => {
      const path = new URL(url).pathname;
      reads.push(path);
      const json = (result: unknown) => Response.json({ success: true, result });
      if (path.endsWith("/workers/scripts")) return json([{ id: "old-worker" }]);
      if (path.endsWith("/versions")) return json({ items: Array.from({ length: 50 }, (_, i) => ({ id: `new-${i}`, message: `foreign/app v1 ${TAPDEPLOY_MANAGED_MARKER}` })) });
      if (path.endsWith("/deployments")) return json({ deployments: [{ id: "d", versions: [{ version_id: oldId, percentage: 100 }] }] });
      if (path.endsWith(`/versions/${oldId}`)) return json({ id: oldId, annotations: { "workers/message": `owned/app v1 ${TAPDEPLOY_MANAGED_MARKER}` }, resources: { bindings: [{ type: "service", name: "EXTRA", service: "legacy" }, { type: "secret_text", name: "PASSWORD" }] } });
      if (path.endsWith("/settings")) return json({ bindings: [] });
      if (path.endsWith("/secrets")) return json([{ name: "LATEST_ONLY_SECRET" }]);
      throw new Error(`unexpected ${path}`);
    } });
    const snapshot = await snapshotTarget(client, { accountId, workerName: "old-worker", needs: { schedules: false, rateLimits: false, domains: false, r2: false, d1: false, kv: false, queues: false, hyperdrive: false, vectorize: false, secretsStore: false } });
    expect(resolveActiveOwnership(snapshot.versions, snapshot.activeDeploymentVersionIds, "owned/app").owned).toBe(true);
    expect(snapshot.secretNames).toEqual(["PASSWORD"]);
    expect(reads.filter(p => p.endsWith(`/versions/${oldId}`))).toHaveLength(1);
  });
  it("does not accept an exact-version response for another ID", async () => {
    const client = createCloudflareClient({ accountId, accessToken: "fake", fetcher: vi.fn(async () => Response.json({ success: true, result: { id: "foreign", resources: { bindings: [] } } })) });
    // The new exact getter must reject mismatched identity, not treat as empty.
    const getter = (client as unknown as { getVersion?: (name: string, id: string) => Promise<unknown> }).getVersion;
    expect(getter).toBeDefined();
    await expect(getter!("old-worker", oldId)).rejects.toBeDefined();
  });
});

describe("undeclared active binding preservation", () => {
  function context(): DeployStepContext {
    const code = "export default {}";
    return {
      client: { createVersion: vi.fn(async () => ({ id: "prepared" })) } as unknown as CloudflareApiClient,
      accountId, workerName: "app", accessToken: "fake",
      spec: { schemaVersion: 1, targetKind: "workers", project: { id: "owned/app", version: "1" }, worker: { path: "worker.mjs", size: code.length, sha256: createHash("sha256").update(code).digest("hex") }, assets: [], inputs: {}, wrangler: { name: "app", compatibility_date: "2026-10-10", r2_buckets: [], crons: [], vars: { NEW: "approved" } }, cloudflare: { workerName: "app", r2: [], d1: [], kv: [], queues: [], hyperdrive: [], vectorize: [], secretsStore: [], runtimeBindings: [], cron: [], secrets: {} } },
      snapshot: { accountId, workerName: "app", workerExists: true, activeDeploymentVersionIds: [oldId], versions: [{ id: oldId }], activeBindings: [{ name: "EXTRA", type: "service", service: "legacy", environment: "production" }, { name: "OLD_VAR", type: "plain_text", text: "unchanged" }], r2Buckets: [], d1Databases: [], kvNamespaces: [], queues: [], hyperdriveConfigs: [], vectorizeIndexes: [], secretsStores: [], secretsStoreSecrets: [], secretNames: [], scheduleCrons: [], rateLimitCount: 0 },
    };
  }
  it("copies undeclared functional bindings from exact active inventory without latest inheritance", async () => {
    const ctx = context();
    const original = structuredClone(ctx.snapshot.activeBindings);
    const result = await executeDeployStep("create-version", ctx, { scriptB64: btoa("export default {}") });
    expect(result.ok).toBe(true);
    const metadata = vi.mocked(ctx.client.createVersion).mock.calls[0]?.[1].metadata;
    expect(metadata?.bindings).toEqual([{ name: "NEW", type: "plain_text", text: "approved" }, ...original!]);
    expect(ctx.snapshot.activeBindings).toEqual(original);
  });
  it.each(["unproven", "unknown", "secret", "split", "old-assets"])("%s preservation stops before any preparatory write", async kind => {
    const ctx = context();
    if (kind === "unproven") ctx.snapshot.activeBindings = undefined;
    if (kind === "unknown") ctx.snapshot.activeBindings = [{ name: "OPAQUE", type: "unsupported_future_binding" }];
    if (kind === "secret") ctx.snapshot.secretNames = ["OLD_SECRET"];
    if (kind === "split") ctx.snapshot.activeDeploymentVersionIds.push("another");
    if (kind === "old-assets") ctx.snapshot.activeBindings = [{ name: "ASSETS", type: "assets" }];
    expect(await executeDeployStep("create-r2-buckets", ctx, {})).toMatchObject({ ok: false, error: { kind: "inherit-source-unavailable" } });
    expect(ctx.client.createVersion).not.toHaveBeenCalled();
  });
  it("a plaintext declaration cannot overwrite an undeclared active secret, even during resource preparation", async () => {
    const ctx = context();
    ctx.spec.wrangler.vars = { PASSWORD: "not-a-secret" };
    ctx.snapshot.activeBindings = [{ type: "secret_text", name: "PASSWORD" }];
    ctx.snapshot.secretNames = ["PASSWORD"];
    ctx.spec.cloudflare.r2 = [{ binding: "BUCKET", bucketName: "new-bucket", createIfMissing: true }];
    const createR2Bucket = vi.fn(async () => ({ name: "new-bucket", creation_date: "2026-10-14" }));
    ctx.client = { ...ctx.client, createR2Bucket } as unknown as CloudflareApiClient;
    const result = await executeDeployStep("create-r2-buckets", ctx, {});
    expect(createR2Bucket).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, error: { kind: "inherit-source-unavailable" } });
  });
  it("preserves declared and undeclared exact-active secrets alongside untouched service bindings", async () => {
    const ctx = context();
    ctx.snapshot.latestVersionId = "00000000-0000-4000-8000-000000000099";
    ctx.snapshot.activeBindings!.push({ name: "PASSWORD", type: "secret_text" }, { name: "LEGACY_KEY", type: "secret_key" });
    ctx.snapshot.secretNames = ["PASSWORD", "LEGACY_KEY"];
    ctx.spec.cloudflare.secrets = { PASSWORD: "prompt-on-install" };
    expect((await executeDeployStep("create-version", ctx, { scriptB64: btoa("export default {}"), secrets: { PASSWORD: "do-not-overwrite" } })).ok).toBe(true);
    const metadata = vi.mocked(ctx.client.createVersion).mock.calls[0]![1].metadata;
    expect(metadata.bindings).toContainEqual({ type: "inherit", name: "PASSWORD", version_id: oldId });
    expect(metadata.bindings).toContainEqual({ type: "inherit", name: "LEGACY_KEY", version_id: oldId });
    expect(metadata.bindings).toContainEqual({ name: "EXTRA", type: "service", service: "legacy", environment: "production" });
    expect(JSON.stringify(metadata)).not.toContain("do-not-overwrite");
    expect(JSON.stringify(metadata)).not.toContain(ctx.snapshot.latestVersionId);
  });
});
