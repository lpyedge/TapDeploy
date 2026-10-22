import { expect, it } from "vitest";
import { deriveSealKey } from "../../src/auth/keys.js";
import { sealPlanApproval, verifyPlanApproval, type ApprovalContext } from "../../src/core/planning/plan-approval.js";
const context: ApprovalContext = { nonce: "fake-session", configHash: "fake-config", accountId: "fake-account", digest: "fake-digest", expiresAt: Date.now() + 60_000, reference: { accountId: "fake-account", workerName: "app", r2BucketIds: { BUCKET: "approved-id" }, secretNames: ["PASSWORD"], domainBaseline: { names: ["app.example.com"], zones: [], dnsRecords: [], workerRoutes: [], workerDomains: [], pagesDomains: [] } } };
it("authenticates every reference field, session, config, account and immutable plan", async () => {
  const key = await deriveSealKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  const approval = await sealPlanApproval(key, context);
  expect(await verifyPlanApproval(key, approval, context)).toBe(true);
  for (const field of ["nonce", "configHash", "accountId", "digest"] as const) expect(await verifyPlanApproval(key, approval, { ...context, [field]: "forged" })).toBe(false);
  for (const reference of [
    { ...context.reference, workerName: "other" },
    { ...context.reference, r2BucketIds: {} },
    { ...context.reference, secretNames: [] },
    { ...context.reference, domainBaseline: undefined },
  ]) expect(await verifyPlanApproval(key, approval, { ...context, reference })).toBe(false);
});
it("rejects missing, tampered, expired and cross-purpose proofs", async () => {
  const key = await deriveSealKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  const approval = await sealPlanApproval(key, context);
  expect(await verifyPlanApproval(key, undefined, context)).toBe(false);
  expect(await verifyPlanApproval(key, { ...approval, ciphertext: "tampered" }, context)).toBe(false);
  const expired = await sealPlanApproval(key, { ...context, expiresAt: 0 });
  expect(await verifyPlanApproval(key, expired, context)).toBe(false);
});
