// R2 privacy guard.
//
// The owner bootstrap (SETUP_ARMED) may only proceed against an R2 bucket
// whose privacy is PROVEN by official read-back — never from the wrangler
// binding alone and never from "new buckets are private by default":
//
//   - the managed r2.dev endpoint must read back `enabled: false`
//   - the custom domain list must read back empty (zero attachments)
//   - the bucket identity must match: name readback == requested name, and a
//     jurisdiction claim must match exactly (a same-name bucket in another
//     jurisdiction is refused as an unverified identity)
//   - any scope shortfall (unauthorized/forbidden), API error, missing or
//     invalid response, or messy namespace/jurisdiction is UNKNOWN — never
//     treated as private
//
// An EXISTING bucket that reads back public (r2.dev enabled or any custom
// domain attached) refuses owner bootstrap; nothing in this module ever
// disables a public domain (there is no write surface at all). A private
// decision carries an immutable proof receipt for the owner bootstrap; because any read is
// only a snapshot (TOCTOU), the write-side gate (`gateR2Bootstrap`) requires
// the proof to be fresh and otherwise demands a re-read.
//
// Object lists/exists are deliberately NOT part of this module: object
// metadata belongs to a separate typed API with minimal metadata only. This
// guard never reads object contents — least of all any owner/password object.

import type { CloudflareErrorKind } from "../../cloudflare/client/errors.js";

// ---------------------------------------------------------------------------
// Read facts (produced by the read-only adapter; pure classification below)
// ---------------------------------------------------------------------------

export interface R2BucketPrivacyView {
  name: string;
  jurisdiction?: string;
}

interface R2ManagedDomainView {
  domain: string;
  enabled: boolean;
}

interface R2CustomDomainView {
  domain: string;
  enabled: boolean;
}

/** One read surface: either a normalized value or the normalized error kind. */
export type R2PrivacyRead<T> =
  | { ok: true; value: T }
  | { ok: false; kind: CloudflareErrorKind };

export interface R2PrivacyFacts {
  accountId: string;
  bucketName: string;
  /** Jurisdiction claim the plan targets; the read-back must match exactly. */
  jurisdiction?: string;
  /** When the three reads were taken (ms epoch) — the TOCTOU anchor. */
  readAtMs: number;
  bucket: R2PrivacyRead<R2BucketPrivacyView>;
  managedDomain: R2PrivacyRead<R2ManagedDomainView>;
  customDomains: R2PrivacyRead<R2CustomDomainView[]>;
}

// ---------------------------------------------------------------------------
// Decision + proof
// ---------------------------------------------------------------------------

type R2PrivacyState = "PRIVATE_VERIFIED" | "PUBLIC_EXPOSED" | "UNKNOWN";

type R2PrivacyReasonCode =
  | "bucket-not-found"
  | "read-failed"
  | "identity-mismatch"
  | "jurisdiction-mismatch"
  | "managed-domain-enabled"
  | "custom-domains-present";

interface R2PrivacyReason {
  code: R2PrivacyReasonCode;
  detail: string;
}

// The immutable safety proof the owner bootstrap binds into the one-time bootstrap. It can
// only ever exist in the verified-private state (all conditions held at
// `readAtMs`); every field is a primitive and the object is frozen.
export interface R2PrivacyProof {
  readonly proofKind: "r2-private-readback";
  readonly state: "PRIVATE_VERIFIED";
  readonly accountId: string;
  readonly bucketName: string;
  readonly jurisdiction: string | null;
  readonly managedDomainEnabled: false;
  readonly customDomainCount: 0;
  readonly readAtMs: number;
}

interface R2PrivacyPrivateDecision {
  state: "PRIVATE_VERIFIED";
  reasons: readonly R2PrivacyReason[];
  proof: R2PrivacyProof;
}

interface R2PrivacyRefusedDecision {
  state: "PUBLIC_EXPOSED" | "UNKNOWN";
  reasons: readonly R2PrivacyReason[];
}

export type R2PrivacyDecision = R2PrivacyPrivateDecision | R2PrivacyRefusedDecision;

function unknown(reasons: R2PrivacyReason[]): R2PrivacyRefusedDecision {
  return { state: "UNKNOWN", reasons };
}

/**
 * Pure classification of the three official read-backs. Returns
 * PRIVATE_VERIFIED (with the frozen proof) only when every condition holds;
 * PUBLIC_EXPOSED refuses bootstrap (existing public bucket — never
 * auto-disabled); everything unproven is UNKNOWN, never treated as private.
 */
export function evaluateR2Privacy(facts: R2PrivacyFacts): R2PrivacyDecision {
  // 1. Bucket identity must be verified first: a wrong or unverifiable
  //    identity makes every later fact meaningless.
  if (!facts.bucket.ok) {
    return unknown([
      facts.bucket.kind === "not-found"
        ? {
            code: "bucket-not-found",
            detail: `R2 bucket "${facts.bucketName}" does not exist in this account; a default-private policy cannot be proven for an absent bucket`,
          }
        : {
            code: "read-failed",
            detail: `R2 bucket read failed (${facts.bucket.kind}); privacy is unverified`,
          },
    ]);
  }
  const bucket = facts.bucket.value;
  if (bucket.name !== facts.bucketName) {
    return unknown([
      {
        code: "identity-mismatch",
        detail: `R2 bucket readback name "${bucket.name}" does not match requested "${facts.bucketName}"; refusing to attribute a privacy policy to a different bucket`,
      },
    ]);
  }
  if (facts.jurisdiction !== undefined && bucket.jurisdiction !== facts.jurisdiction) {
    return unknown([
      {
        code: "jurisdiction-mismatch",
        detail: `R2 bucket "${facts.bucketName}" reads back jurisdiction "${bucket.jurisdiction ?? ""}" but the plan claims "${facts.jurisdiction}"; a same-name bucket in another jurisdiction is refused`,
      },
    ]);
  }

  // 2. Managed r2.dev endpoint: must be proven disabled.
  if (!facts.managedDomain.ok) {
    return unknown([
      {
        code: "read-failed",
        detail: `R2 managed domain read failed (${facts.managedDomain.kind}); public exposure is unverified`,
      },
    ]);
  }
  if (facts.managedDomain.value.enabled) {
    return {
      state: "PUBLIC_EXPOSED",
      reasons: [
        {
          code: "managed-domain-enabled",
          detail: `R2 managed r2.dev domain "${facts.managedDomain.value.domain}" is enabled for bucket "${facts.bucketName}"; owner bootstrap is refused and the public domain is never auto-disabled`,
        },
      ],
    };
  }

  // 3. Custom domains: must be proven empty.
  if (!facts.customDomains.ok) {
    return unknown([
      {
        code: "read-failed",
        detail: `R2 custom domain list read failed (${facts.customDomains.kind}); public exposure is unverified`,
      },
    ]);
  }
  const customDomains = facts.customDomains.value;
  if (customDomains.length > 0) {
    return {
      state: "PUBLIC_EXPOSED",
      reasons: [
        {
          code: "custom-domains-present",
          detail: `R2 bucket "${facts.bucketName}" has ${customDomains.length} custom domain(s) attached (${customDomains
            .map((d) => d.domain)
            .join(", ")}); owner bootstrap is refused and the domains are never auto-detached`,
        },
      ],
    };
  }

  const proof: R2PrivacyProof = Object.freeze({
    proofKind: "r2-private-readback",
    state: "PRIVATE_VERIFIED",
    accountId: facts.accountId,
    bucketName: facts.bucketName,
    jurisdiction: facts.jurisdiction ?? null,
    managedDomainEnabled: false,
    customDomainCount: 0,
    readAtMs: facts.readAtMs,
  });
  return { state: "PRIVATE_VERIFIED", reasons: [], proof };
}

// ---------------------------------------------------------------------------
// TOCTOU gate: a proof is a snapshot, so writes require freshness
// ---------------------------------------------------------------------------

/** Default maximum proof age; any write older than this must re-read. */
export const R2_PRIVACY_PROOF_MAX_AGE_MS = 60_000;

export function r2ProofIsFresh(
  proof: R2PrivacyProof,
  nowMs: number,
  maxAgeMs: number = R2_PRIVACY_PROOF_MAX_AGE_MS,
): boolean {
  const age = nowMs - proof.readAtMs;
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}

export type R2BootstrapGate =
  | {
      allowed: true;
      state: "PRIVATE_VERIFIED";
      proof: R2PrivacyProof;
      expiresAtMs: number;
    }
  | {
      allowed: false;
      state: R2PrivacyState;
      reason: string;
      /** True when a fresh re-read of the three surfaces is required. */
      requiresRefresh: boolean;
    };

/**
 * Write-side gate for the owner bootstrap: PRIVATE_VERIFIED + fresh proof allows the one-time
 * bootstrap to proceed; PUBLIC_EXPOSED refuses outright (no refresh helps
 * until the human changes the bucket); UNKNOWN and stale proofs require a
 * fresh re-read. No arm/secret mutation can be derived from a non-fresh or
 * non-private decision here.
 */
export function gateR2Bootstrap(
  decision: R2PrivacyDecision,
  nowMs: number,
  maxAgeMs: number = R2_PRIVACY_PROOF_MAX_AGE_MS,
): R2BootstrapGate {
  if (decision.state !== "PRIVATE_VERIFIED") {
    return {
      allowed: false,
      state: decision.state,
      reason: decision.reasons.map((r) => r.detail).join("; "),
      requiresRefresh: decision.state === "UNKNOWN",
    };
  }
  if (!r2ProofIsFresh(decision.proof, nowMs, maxAgeMs)) {
    const age = nowMs - decision.proof.readAtMs;
    return {
      allowed: false,
      state: "PRIVATE_VERIFIED",
      reason: `R2 private proof is stale (age ${age}ms > ${maxAgeMs}ms); re-read the three privacy surfaces immediately before any write`,
      requiresRefresh: true,
    };
  }
  return {
    allowed: true,
    state: "PRIVATE_VERIFIED",
    proof: decision.proof,
    expiresAtMs: decision.proof.readAtMs + maxAgeMs,
  };
}
