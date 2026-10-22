import { describe, expect, it } from "vitest";
import { deriveSealKey } from "../../src/auth/keys.js";
import { graphExecutionContextDigest, openGraphExecutionContext, openGraphPhaseReceipt, openVerifiedReleaseContext, sealGraphExecutionContext, sealGraphPhaseReceipt, sealVerifiedReleaseContext, type GraphExecutionContext } from "../../src/core/planning/graph-execution-context.js";

async function context(): Promise<GraphExecutionContext> {
  const base = { kind: "tapdeploy-graph-execution/v1" as const, protocolVersion: 1 as const, nonce: "n", configHash: "c", appId: "app", accountId: "a", expiresAt: Date.now()+60_000, sourceKind: "local", sourcePolicyDigest: "p", archiveSha256: "z", manifestDigest: "m", graphPlanDigest: "g", canonicalNonsecretGraphPlan: {}, topoOrder: ["u"], dependencies: [], expectedPerUnitReferences: {}, approvedDiffsWithActionIds: [], perUnitCanonicalSpecs: {}, perUnitWranglerAndBundleProofs: {}, capabilityClosure: {}, costPosture: {}, approvedMode: "install" };
  return { ...base, executionContextDigest: await graphExecutionContextDigest(base) };
}
describe("graph execution context", () => {
  it("round trips only its exact sealed claims", async () => {
    const key = await deriveSealKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"); const value = await context(); const seal = await sealGraphExecutionContext(key, value);
    expect(await openGraphExecutionContext(key, seal, { nonce:"n",configHash:"c",accountId:"a",sourcePolicyDigest:"p" }, Date.now()+120_000)).toEqual(value);
    expect(await openGraphExecutionContext(key, seal, { nonce:"n",configHash:"c",accountId:"other",sourcePolicyDigest:"p" }, Date.now()+120_000)).toBeNull();
    expect(await openGraphExecutionContext(key, { ...seal, ciphertext: "bad" }, { nonce:"n",configHash:"c",accountId:"a",sourcePolicyDigest:"p" }, Date.now()+120_000)).toBeNull();
  });
});

describe("release context and phase receipt", () => {
  it("rejects altered source claims and cross-phase receipts", async () => {
    const key = await deriveSealKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const expiresAt = Date.now() + 60_000;
    const release = await sealVerifiedReleaseContext(key, { kind: "tapdeploy-verified-prebuilt-release/v1", nonce: "n", configHash: "c", appId: "app", sourceKind: "local", sourcePolicyDigest: "policy", archiveSha256: "archive", manifestDigest: "manifest", expiresAt, units: [], combinedUnitRootDigest: "root" });
    expect(await openVerifiedReleaseContext(key, release, { nonce: "n", configHash: "c", sourcePolicyDigest: "policy" }, expiresAt + 1)).not.toBeNull();
    expect(await openVerifiedReleaseContext(key, release, { nonce: "n", configHash: "c", sourcePolicyDigest: "other" }, expiresAt + 1)).toBeNull();
    const expected = { nonce: "n", configHash: "c", accountId: "a", sourcePolicyDigest: "policy", graphPlanDigest: "plan", executionContextDigest: "context", unitId: "u", actionId: "action", phase: "worker.prepare", stateHash: "state" };
    const receipt = await sealGraphPhaseReceipt(key, { kind: "tapdeploy-graph-phase-receipt/v1", ...expected, expiresAt });
    expect(await openGraphPhaseReceipt(key, receipt, expected, expiresAt + 1)).not.toBeNull();
    expect(await openGraphPhaseReceipt(key, receipt, { ...expected, phase: "worker.activate" }, expiresAt + 1)).toBeNull();
  });
});
