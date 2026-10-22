import { expect, it } from "vitest";
import { deriveSealKey } from "../../src/auth/keys.js";
import { sealGraphPlanApproval, verifyGraphPlanApproval } from "../../src/core/planning/plan-approval.js";
import { graphExecutionContextDigest, openGraphExecutionContext, sealGraphExecutionContext } from "../../src/core/planning/graph-execution-context.js";

const keyText = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const hash = "a".repeat(64);

function contextBase() {
  return {
    kind: "tapdeploy-graph-execution/v1" as const, protocolVersion: 1 as const, nonce: "session", configHash: hash,
    appId: "example/app", accountId: "account", expiresAt: Date.now() + 60_000,
    sourceKind: "local", sourcePolicyDigest: hash, archiveSha256: hash, manifestDigest: hash,
    graphPlanDigest: hash, canonicalNonsecretGraphPlan: { digest: hash }, topoOrder: ["api"], dependencies: [],
    expectedPerUnitReferences: { api: { accountId: "account", workerName: "api" } },
    approvedDiffsWithActionIds: [{ unitId: "api", actionId: "action", resource: "worker", action: "create" }],
    perUnitCanonicalSpecs: { api: { cloudflare: { workerName: "api" } } },
    perUnitWranglerAndBundleProofs: { api: { bundleDigest: hash, modules: [{ path: "main.mjs", sha256: hash }] } },
    capabilityClosure: { declared: ["workers"], resolved: ["workers"] }, costPosture: { confirmed: true }, approvedMode: "install",
  };
}

it("seals a complete server-derived execution context and binds approval to it", async () => {
  const key = await deriveSealKey(keyText); const base = contextBase();
  const executionContextDigest = await graphExecutionContextDigest(base);
  const executionContext = await sealGraphExecutionContext(key, { ...base, executionContextDigest });
  expect(await openGraphExecutionContext(key, executionContext, { nonce: "session", configHash: hash, accountId: "account", sourcePolicyDigest: hash }, base.expiresAt)).not.toBeNull();
  const approval = await sealGraphPlanApproval(key, { nonce: "session", configHash: hash, accountId: "account", digest: hash, references: base.expectedPerUnitReferences, executionContextDigest, expiresAt: base.expiresAt });
  expect(await verifyGraphPlanApproval(key, approval, { nonce: "session", configHash: hash, accountId: "account", digest: hash, references: base.expectedPerUnitReferences, executionContextDigest, })).toBe(true);
  expect(await verifyGraphPlanApproval(key, approval, { nonce: "session", configHash: hash, accountId: "account", digest: hash, references: base.expectedPerUnitReferences, executionContextDigest: "b".repeat(64) })).toBe(false);
});
