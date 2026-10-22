import { expect, it } from "vitest";
import { deriveSealKey } from "../../src/auth/keys.js";
import { openGraphPhaseReceipt, sealGraphPhaseReceipt } from "../../src/core/planning/graph-execution-context.js";

it("rejects a graph phase receipt replayed into another phase or unit", async () => {
  const key = await deriveSealKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  const receipt = await sealGraphPhaseReceipt(key, { kind: "tapdeploy-graph-phase-receipt/v1", nonce: "n", configHash: "c", accountId: "a", sourcePolicyDigest: "s", graphPlanDigest: "p", executionContextDigest: "e", unitId: "one", actionId: "action", phase: "create-r2-buckets", stateHash: "h", expiresAt: Date.now() + 60_000 });
  const expected = { nonce: "n", configHash: "c", accountId: "a", sourcePolicyDigest: "s", graphPlanDigest: "p", executionContextDigest: "e", unitId: "one", actionId: "action", phase: "create-r2-buckets", stateHash: "h" };
  expect(await openGraphPhaseReceipt(key, receipt, expected, Date.now() + 60_000)).not.toBeNull();
  expect(await openGraphPhaseReceipt(key, receipt, { ...expected, phase: "activate" }, Date.now() + 60_000)).toBeNull();
  expect(await openGraphPhaseReceipt(key, receipt, { ...expected, unitId: "two" }, Date.now() + 60_000)).toBeNull();
});
