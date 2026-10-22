import { expect, it, vi } from "vitest";
import { verifyDeployedBindings } from "../../src/core/deploy/postcheck-bindings.js";
import type { DeploySpec } from "../../src/core/deploy-spec.js";
import type { TargetSnapshot } from "../../src/core/planning/types.js";
import { publicBindingProof, matchesBindingProof, matchesRuntimeProof } from "../../src/core/deploy/version-proof.js";
import { assetUploadHash, buildAssetUploadManifest } from "../../src/cloudflare/assets/manifest.js";
import { createHash } from "node:crypto";
import { normalizeWranglerV3 } from "../../src/manifest/wrangler-v3.js";
import { executeDeployStep, versionMessage, type DeployStepContext } from "../../src/core/deploy/steps.js";
it("the first serving upload cannot omit a declared D1 binding just because its resource was not created", async () => {
  const code = "export default {}";
  const spec = { project: { id: "proof/app", version: "1" }, targetKind: "workers", worker: { path: "worker.mjs", size: code.length, sha256: createHash("sha256").update(code).digest("hex") }, assets: [], cloudflare: { workerName: "app", r2: [], d1: [{ binding: "DB", databaseName: "required-db", createIfMissing: true }], kv: [], queues: [], hyperdrive: [], vectorize: [], secretsStore: [], runtimeBindings: [], cron: [], secrets: {} }, wrangler: { name: "app", compatibility_date: "2026-10-10", r2_buckets: [], crons: [], d1_databases: [{ binding: "DB", database_name: "required-db" }] } } as unknown as DeploySpec;
  const createWorker = vi.fn(async () => ({ id: "app" }));
  const ctx = { spec, snapshot: { workerExists: false, secretNames: [], activeBindings: [], d1Databases: [], r2Buckets: [], kvNamespaces: [], queues: [], hyperdriveConfigs: [], vectorizeIndexes: [], secretsStores: [], secretsStoreSecrets: [] }, workerName: "app", client: { createWorker, listVersions: async () => [{ id: "uploaded", message: versionMessage(spec) }], listDeployments: async () => [{ id: "deployment", versions: [{ version_id: "uploaded", percentage: 100 }] }] } } as unknown as DeployStepContext;
  const result = await executeDeployStep("create-worker", ctx, { scriptB64: btoa(code) });
  expect(createWorker).not.toHaveBeenCalled();
  expect(result.ok).toBe(false);
});
it("postcheck cannot claim complete configuration when the active version lacks its password, vars or assets", () => {
  const spec = { cloudflare: { r2: [], d1: [], kv: [], queues: [], hyperdrive: [], vectorize: [], secretsStore: [], runtimeBindings: [], secrets: { PASSWORD: "prompt-on-install" } }, assets: [{ path: "index.html" }], wrangler: { vars: { LABEL: "approved" }, assets: { binding: "ASSETS" } } } as unknown as DeploySpec;
  const snapshot = { deployedBindings: {}, activeBindings: [], secretNames: [] } as unknown as TargetSnapshot;
  const result = verifyDeployedBindings(spec, snapshot);
  expect(result.ok).toBe(false);
  expect(result.mismatches).toHaveLength(3);
});
it("asset URL roots are relative to the approved directory and routing flags are type checked", async () => {
  const asset = { path: "public/index.html", size: 1, sha256: "a".repeat(64), workersHash: "b".repeat(32) };
  expect(Object.keys(await buildAssetUploadManifest([asset], "./public"))).toEqual(["/index.html"]);
  await expect(buildAssetUploadManifest([{ ...asset, path: "outside/index.html" }], "public")).rejects.toBeDefined();
  expect(normalizeWranglerV3(JSON.stringify({ name: "app", main: "worker.mjs", compatibility_date: "2026-10-10", assets: { directory: "public", run_worker_first: true } })).issues).toEqual([]);
  expect(normalizeWranglerV3(JSON.stringify({ name: "app", main: "worker.mjs", compatibility_date: "2026-10-10", assets: { directory: "public", run_worker_first: "silently-ignore" } })).issues.length).toBeGreaterThan(0);
});
it("runtime proof requires an explicit matching date and complete flag set", () => {
  const expected = { compatibility_date: "2026-10-10", compatibility_flags: ["nodejs_compat"] };
  expect(matchesRuntimeProof(expected, expected)).toBe(true);
  expect(matchesRuntimeProof(expected, { ...expected, compatibility_date: "2020-01-01" })).toBe(false);
  expect(matchesRuntimeProof(expected, { ...expected, compatibility_flags: [] })).toBe(false);
  expect(matchesRuntimeProof(expected, undefined)).toBe(false);
  expect(matchesRuntimeProof({ compatibility_flags: [] }, {})).toBe(false);
});
it("Worker asset hash matches the official base64-content+extension SHA256 algorithm, not path+integrity hash", async () => {
  const bytes = new TextEncoder().encode("hello assets");
  const expected = createHash("sha256").update(Buffer.from(bytes).toString("base64") + "html").digest("hex").slice(0, 32);
  expect(await assetUploadHash("/a.html", bytes)).toBe(expected);
  expect(await assetUploadHash("/other/a.html", bytes)).toBe(expected);
  expect(await assetUploadHash("/a.txt", bytes)).not.toBe(expected);
  await expect(buildAssetUploadManifest([{ path: "a.html", size: bytes.length, sha256: "a".repeat(64) }])).rejects.toBeDefined();
});
it("prepared proofs preserve exact inherited identities without Secret values", () => {
  const active = [{ name: "PASSWORD", type: "secret_text", text: "must-not-appear-in-proof" }];
  const proof = publicBindingProof([{ name: "PASSWORD", type: "inherit", version_id: "old-active" }, { name: "DB", type: "d1", id: "approved-db" }, { name: "BROWSER", type: "browser" }], active);
  expect(JSON.stringify(proof)).not.toContain("must-not-appear-in-proof");
  expect(matchesBindingProof(proof, [{ name: "PASSWORD", type: "secret_text" }, { name: "DB", type: "d1", database_id: "approved-db" }, { name: "BROWSER", type: "browser" }])).toBe(true);
  expect(matchesBindingProof(proof, proof.slice(1))).toBe(false);
  expect(matchesBindingProof(proof, [...proof.slice(0, 2), { name: "BROWSER", type: "plain_text", text: "wrong" }])).toBe(false);
  expect(matchesBindingProof(proof, [...proof.slice(0, 2), proof[0]!])).toBe(false);
});
