import { openSeal, sealJson, type SealedEnvelope } from "../../auth/keys.js";
import { canonicalJson } from "./digest.js";
import type { ExpectedTarget } from "./types.js";

// sealed approval for a multi-unit
// graph plan. It binds the SAME session/config/account/digest material as the
// single-target proof, but the reference is the per-unit drift reference map
// (unit id -> ExpectedTarget) rather than one target. A partial graph that needs
// a fresh plan produces a new digest, so an old approval never verifies against
// it; every actual mutation still traces to an approved intent.
export interface GraphApprovalContext {
  nonce: string;
  configHash?: string;
  accountId: string;
  digest: string;
  references: Record<string, ExpectedTarget>;
  /** Digest of the sealed full execution context, not browser display JSON. */
  executionContextDigest?: string;
  expiresAt: number;
}
export function sealGraphPlanApproval(
  key: CryptoKey,
  context: GraphApprovalContext,
): Promise<SealedEnvelope> {
  return sealJson(key, { kind: "tapdeploy-graph-plan-approval", ...context });
}
export async function verifyGraphPlanApproval(
  key: CryptoKey,
  envelope: unknown,
  expected: Omit<GraphApprovalContext, "expiresAt">,
): Promise<boolean> {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return false;
  const proof = await openSeal<GraphApprovalContext & { kind: string }>(
    key,
    envelope as SealedEnvelope,
  );
  if (
    !proof ||
    proof.kind !== "tapdeploy-graph-plan-approval" ||
    typeof proof.expiresAt !== "number" ||
    !Number.isFinite(proof.expiresAt) ||
    proof.expiresAt <= Date.now()
  ) {
    return false;
  }
  return (
    proof.nonce === expected.nonce &&
    proof.configHash === expected.configHash &&
    proof.accountId === expected.accountId &&
    proof.digest === expected.digest &&
    proof.executionContextDigest === expected.executionContextDigest &&
    canonicalJson(proof.references) === canonicalJson(expected.references)
  );
}
