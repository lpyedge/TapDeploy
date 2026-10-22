// Scope planner: compute ONE deterministic bounded-maximum scope bundle from
// a validated Config V3.
//
// Every OAuth scope comes from the code-owned registry, reached only through
// the config's declared symbolic capabilities, so a config can never author a
// raw scope or expand its own privileges. The bundle covers install AND
// upgrade.
//
// Pure and runtime-agnostic. No provider call, no OAuth, no secrets.

import {
  SCOPE_REGISTRY,
  type ScopeCapability,
} from "./scope-registry.js";
import {
  V3_CAPABILITY_META,
  effectiveCapabilities,
  type ConfigV3,
  type V3Capability,
} from "../manifest/config-v3.js";

export interface ScopeReason {
  scope: string;
  capability: ScopeCapability;
  reason: string;
}

export interface ScopePlan {
  scopes: string[];
  reasons: ScopeReason[];
  // Capabilities the config maps to (for the preview/audit log).
  capabilities: ScopeCapability[];
}

/**
 * The one-shot scope bundle for a validated Config V3: the declared
 * capabilities plus Zone Read + DNS Write whenever the config has an HTTP
 * service, so the operator can bind a custom domain without a second consent.
 */
export function planScopesForConfigV3(config: ConfigV3): ScopePlan {
  return planScopesForCapabilities(effectiveCapabilities(config));
}

/**
 * Compute the single bounded-max one-shot scope bundle for declared symbolic
 * `capabilities`. Every symbolic id must exist in the code-owned V3 capability
 * vocabulary (`V3_CAPABILITY_META`); the mapping to OAuth scopes goes through
 * `SCOPE_REGISTRY`, so the config can never author a raw scope. Unknown ids fail closed (throw) instead
 * of being passed through. Deterministic: deduplicated and sorted.
 */
export function planScopesForCapabilities(
  capabilities: readonly string[],
): ScopePlan {
  const scopes = new Set<string>();
  const reasons = new Map<string, ScopeReason>();
  const registryCapabilities = new Set<ScopeCapability>();

  for (const symbolic of capabilities) {
    const meta = V3_CAPABILITY_META[symbolic as V3Capability];
    if (!meta) {
      throw new Error(`unknown v3 capability "${symbolic}"`);
    }
    for (const capability of meta.scopeCapabilities) {
      const row = SCOPE_REGISTRY[capability];
      scopes.add(row.scope);
      registryCapabilities.add(capability);
      if (!reasons.has(row.scope)) {
        reasons.set(row.scope, {
          scope: row.scope,
          capability,
          reason: row.reason,
        });
      }
    }
  }

  return {
    scopes: [...scopes].sort(),
    reasons: [...reasons.values()].sort((a, b) => a.scope.localeCompare(b.scope)),
    capabilities: [...registryCapabilities].sort(),
  };
}

// ---------------------------------------------------------------------------
// Post-ZIP capability subset check
// ---------------------------------------------------------------------------

/**
 * Stable failure code when the final build ZIP needs capabilities the config
 * did not pre-declare. It is surfaced as a clear developer-fixable error (fix
 * the config, then the human starts a NEW session); the installer must never
 * expand scopes silently, never fall back to a second OAuth and never continue
 * with a missing authorization.
 */
export const DEVELOPER_SCOPE_UNDERDECLARED = "DEVELOPER_SCOPE_UNDERDECLARED" as const;

export interface ResolvedCapabilitiesCheck {
  ok: boolean;
  /** Resolved capability ids the config did not declare (deduplicated, sorted). */
  undeclared: string[];
  error?: typeof DEVELOPER_SCOPE_UNDERDECLARED;
  detail?: string;
}

/**
 * Subset check between the pre-authorized (declared) symbolic capability set
 * bound into the one-shot OAuth transaction and the capability set resolved
 * from the final build ZIP (the units' final Wrangler configs plus the install
 * policies). Anything resolved that was not declared fails closed with
 * `DEVELOPER_SCOPE_UNDERDECLARED`; the error is developer-fixable and no
 * permission is ever requested beyond the one-shot consent.
 */
export function checkResolvedCapabilitiesWithin(
  declared: readonly string[],
  resolved: readonly string[],
): ResolvedCapabilitiesCheck {
  const declaredSet = new Set(declared);
  const undeclared = [...new Set(resolved)]
    .filter((capability) => !declaredSet.has(capability))
    .sort();
  if (undeclared.length === 0) {
    return { ok: true, undeclared: [] };
  }
  return {
    ok: false,
    undeclared,
    error: DEVELOPER_SCOPE_UNDERDECLARED,
    detail:
      `the release ZIP requires capabilities the config did not declare: ${undeclared.join(", ")}. ` +
      "Add them to the config's \"capabilities\" list and begin a new session; " +
      "no additional permission was requested and no authorization was restarted automatically.",
  };
}
