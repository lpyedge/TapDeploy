import { describe, expect, it } from "vitest";
import { isOwnProgressRetry, verifyProgressReceipt } from "../../src/api/routes/deploy-step.js";
import { TAPDEPLOY_MANAGED_MARKER } from "../../src/core/planning/digest.js";
import { deriveSealKey, sealJson } from "../../src/auth/keys.js";

const drift = { guards: [{ level: "block", code: "remote-drift" }] };
const snapshot = { activeDeploymentVersionIds: ["foreign"], versions: [{ id: "foreign", message: `app/other v1 ${TAPDEPLOY_MANAGED_MARKER}` }] };
describe("post-activate exact progress", () => {
  it.each(["reconcile-schedules", "reconcile-rate-limits", "register-queue-consumers", "reconcile-domains"] as const)(
    "%s refuses foreign cutover", step => {
      expect(isOwnProgressRetry(step, drift, snapshot, { versionId: "approved" }, "app/ours")).toBe(false);
    },
  );
  it("activation retry rejects split traffic, not merely includes(id)", () => {
    expect(isOwnProgressRetry("activate", drift, { ...snapshot, activeDeploymentVersionIds: ["approved", "foreign"] }, { versionId: "approved" }, "app/ours")).toBe(false);
  });
  it.each(["reconcile-schedules", "reconcile-rate-limits", "register-queue-consumers", "reconcile-domains", "activate"] as const)("%s permits attested exclusively active own cutover", step => {
    const own = { activeDeploymentVersionIds: ["approved"], versions: [{ id: "approved", message: `app/ours v1 ${TAPDEPLOY_MANAGED_MARKER}` }] };
    expect(isOwnProgressRetry(step, drift, own, { versionId: "approved" }, "app/ours", "approved")).toBe(true);
  });
  it("receipt is bound to session, account, plan, version and expiration", async () => {
    const key = await deriveSealKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const expected = { nonce: "session", accountId: "account", planDigest: "digest", versionId: "approved" };
    const proof = await sealJson(key, { kind: "tapdeploy-version-progress", ...expected, expiresAt: Date.now() + 60_000 });
    expect(await verifyProgressReceipt(key, proof, expected)).toBe("approved");
    for (const field of Object.keys(expected)) expect(await verifyProgressReceipt(key, proof, { ...expected, [field]: "foreign" })).toBeUndefined();
    expect(await verifyProgressReceipt(key, { ...proof, ciphertext: "tampered" }, expected)).toBeUndefined();
    const expired = await sealJson(key, { kind: "tapdeploy-version-progress", ...expected, expiresAt: 0 });
    expect(await verifyProgressReceipt(key, expired, expected)).toBeUndefined();
  });
});
