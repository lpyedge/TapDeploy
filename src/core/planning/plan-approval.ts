import { openSeal, sealJson, type SealedEnvelope } from "../../auth/keys.js";
import { canonicalJson } from "./digest.js";
import type { ExpectedTarget } from "./types.js";

export interface ApprovalContext {
  nonce: string;
  configHash?: string;
  accountId: string;
  digest: string;
  reference: ExpectedTarget;
  expiresAt: number;
}
export function sealPlanApproval(key: CryptoKey, context: ApprovalContext): Promise<SealedEnvelope> {
  return sealJson(key, { kind: "tapdeploy-plan-approval", ...context });
}
export async function verifyPlanApproval(key: CryptoKey, envelope: unknown, expected: Omit<ApprovalContext, "expiresAt">): Promise<boolean> {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return false;
  const proof = await openSeal<ApprovalContext & { kind: string }>(key, envelope as SealedEnvelope);
  if (!proof || proof.kind !== "tapdeploy-plan-approval" || typeof proof.expiresAt !== "number" || !Number.isFinite(proof.expiresAt) || proof.expiresAt <= Date.now()) return false;
  return proof.nonce === expected.nonce && proof.configHash === expected.configHash &&
    proof.accountId === expected.accountId && proof.digest === expected.digest && canonicalJson(proof.reference) === canonicalJson(expected.reference);
}

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

// a successful graph action receives a sealed receipt.  It is deliberately
// one action wide: a receipt for unit A/action X cannot authorize unit B/action
// X (cross-unit replay), a later action, another account, or a changed plan.
// The state hash is computed from read-back identities by the server; no secret
// value is ever included here.
export interface GraphStepReceiptContext {
  nonce: string;
  configHash?: string;
  accountId: string;
  planDigest: string;
  unitId: string;
  actionId: string;
  stateHash: string;
  expiresAt: number;
}

export function sealGraphStepReceipt(
  key: CryptoKey,
  context: GraphStepReceiptContext,
): Promise<SealedEnvelope> {
  return sealJson(key, { kind: "tapdeploy-graph-step-receipt", ...context });
}

export async function verifyGraphStepReceipt(
  key: CryptoKey,
  envelope: unknown,
  expected: Omit<GraphStepReceiptContext, "expiresAt">,
): Promise<boolean> {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return false;
  const proof = await openSeal<GraphStepReceiptContext & { kind: string }>(
    key,
    envelope as SealedEnvelope,
  );
  if (
    !proof ||
    proof.kind !== "tapdeploy-graph-step-receipt" ||
    typeof proof.expiresAt !== "number" ||
    !Number.isFinite(proof.expiresAt) ||
    proof.expiresAt <= Date.now()
  ) return false;
  return proof.nonce === expected.nonce &&
    proof.configHash === expected.configHash &&
    proof.accountId === expected.accountId &&
    proof.planDigest === expected.planDigest &&
    proof.unitId === expected.unitId &&
    proof.actionId === expected.actionId &&
    proof.stateHash === expected.stateHash;
}
