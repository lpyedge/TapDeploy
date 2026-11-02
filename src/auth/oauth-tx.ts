// Config-bounded one-shot OAuth transaction.
//
// A single OAuth transaction is prepared from a validated Config V3 and is
// sealed into the `__Host-tapdeploy_oauth_tx` cookie. It records the canonical
// config hash, the derived one-shot scope set (the exact consent scope string),
// the declared capabilities, the digest of the config's source policy and the
// modes covered (install AND upgrade). Only digests are sealed, never the policy
// itself: a cookie must stay under the browser's 4 KiB limit for every valid
// config. Binding the config hash into the sealed transaction means:
//   - the callback cannot be replayed for a *different* config, and
//   - a changed config requires a fresh transaction (no silent reuse).
//
// The config is never the source of privilege: the scope planner derives the
// scope set from the code registry. Pure and runtime-agnostic. No provider
// call, no secrets, no DB.

import type { ConfigV3, V3Capability } from "../manifest/config-v3.js";
import { computeConfigV3Id, effectiveCapabilities, plannedUnits } from "../manifest/config-v3.js";
import type { PrebuiltReleasePolicy } from "../release/verify-prebuilt-release.js";
import { planScopesForConfigV3 } from "./scope-planner.js";

/**
 * The sealed OAuth transaction: the canonical V3 config hash plus the declared
 * symbolic capabilities (never raw scopes) and the digest of the source policy.
 */
export interface OAuthTxRequest {
  v: 2;
  state: string;
  nonce: string;
  verifier: string;
  issuedAt: number;
  // Canonical SHA-256 of the Config V3 that produced this transaction.
  configHash: string;
  // The exact scope set requested in the consent URL == the v3 scope planner result.
  scopes: string[];
  // The pre-authorized symbolic capability set (declared + implied by HTTP units).
  capabilities: V3Capability[];
  // Digest of `sourcePolicyFromConfig(config)`, bound into the session.
  sourcePolicyDigest: string;
  // The modes covered by this single OAuth (install AND upgrade).
  modes: Array<"install" | "upgrade">;
}

/** The units the source policy carries: what the release must contain. */
export function sourcePolicyUnits(config: ConfigV3): PrebuiltReleasePolicy["units"] {
  return (plannedUnits(config) ?? []).map((unit) => ({
    id: unit.id,
    kind: unit.kind,
    ...(unit.wrangler ? { wrangler: unit.wrangler } : {}),
    ...(unit.resources ? { resources: unit.resources.map((resource) => ({ kind: resource.kind, name: resource.name, upgradeKeep: resource.upgradeKeep })) } : {}),
  }));
}

/** What the config requires of its release: the policy /api/deploy/prepare verifies the ZIP against. */
export function sourcePolicyFromConfig(config: ConfigV3): PrebuiltReleasePolicy {
  return {
    ...(config.source.defaultUrl !== undefined ? { defaultUrl: config.source.defaultUrl } : {}),
    allowLocalZip: config.source.allowLocalZip ?? true,
    ...(config.source.expectedSha256 !== undefined ? { expectedSha256: config.source.expectedSha256 } : {}),
    appId: config.app.id,
    units: sourcePolicyUnits(config),
  };
}

/** SHA-256 hex of a source policy: the identity sessions, release proofs and receipts carry. */
export async function sourcePolicyDigest(policy: PrebuiltReleasePolicy): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(policy)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Prepare the config-bounded one-shot OAuth transaction for a Config V3: derive
 * the scope bundle from the declared symbolic capabilities (never authored by
 * the config, never a raw scope) and bind the canonical V3 hash + the
 * capability set + the source policy digest into the sealed transaction. A scope
 * the OAuth client does not carry is refused by Cloudflare on its consent page
 * (`invalid_scope`). There is no re-authorization path: one config authorizes
 * exactly once.
 */
export async function prepareOAuthTxRequest(
  config: ConfigV3,
  seed: { state: string; nonce: string; verifier: string },
): Promise<OAuthTxRequest> {
  const configHash = await computeConfigV3Id(config);
  const plan = planScopesForConfigV3(config);

  return {
    v: 2,
    state: seed.state,
    nonce: seed.nonce,
    verifier: seed.verifier,
    issuedAt: Date.now(),
    configHash,
    scopes: plan.scopes,
    capabilities: effectiveCapabilities(config),
    sourcePolicyDigest: await sourcePolicyDigest(sourcePolicyFromConfig(config)),
    modes: ["install", "upgrade"],
  };
}

/**
 * OAuth granted-scope verification. Per RFC 6749 §5.2 the `scope` response
 * parameter is OPTIONAL: if omitted, the granted set equals the requested set.
 * If present, it is the granted (subset) set and every requested scope must be
 * present — otherwise a necessary scope was declined. A declined grant is the
 * dedicated `GRANT_MISSING` failure: the caller blocks with a visible error and
 * must NOT re-run authorization.
 */
export function verifyGrantedScopes(
  requested: readonly string[],
  granted: readonly string[] | undefined,
): { ok: boolean; missing: string[] } {
  if (granted === undefined) {
    // Omitted scope in the token response = all requested were granted.
    return { ok: true, missing: [] };
  }
  const grantedSet = new Set(granted);
  const missing = requested.filter((s) => !grantedSet.has(s));
  return { ok: missing.length === 0, missing };
}
