// Config-bounded one-shot OAuth transaction.
//
// A single OAuth transaction is prepared from a validated Config V3 and is
// sealed into the `__Host-tapdeploy_oauth_tx` cookie. It records the canonical
// config hash, the derived one-shot scope set (the exact consent scope string),
// the declared capabilities, the app/source policy and the modes covered
// (install AND upgrade). Binding the config hash into the sealed transaction
// means:
//   - the callback cannot be replayed for a *different* config, and
//   - a changed config requires a fresh transaction (no silent reuse).
//
// The config is never the source of privilege: the scope planner derives the
// scope set from the code registry. Pure and runtime-agnostic. No provider
// call, no secrets, no DB.

import type { ConfigV3, V3Capability } from "../manifest/config-v3.js";
import { computeConfigV3Id, effectiveCapabilities } from "../manifest/config-v3.js";
import { planScopesForConfigV3 } from "./scope-planner.js";

/**
 * The sealed OAuth transaction: the canonical V3 config hash plus the declared
 * symbolic capabilities (never raw scopes) and a snapshot of the app/source
 * policy.
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
  // Nonsecret app identity + source policy bound into the session.
  appId: string;
  source: { defaultUrl?: string; allowLocalZip: boolean; expectedSha256?: string };
  units: Array<{ id: string; kind: "worker" | "pages" | "resources"; wrangler?: string; resources?: Array<{ kind: string; name: string }> }>;
  // Resources the user may swap on upgrade (`upgrade.switchable`).
  switchable?: string[];
  // The modes covered by this single OAuth (install AND upgrade).
  modes: Array<"install" | "upgrade">;
}

/**
 * Prepare the config-bounded one-shot OAuth transaction for a Config V3: derive
 * the scope bundle from the declared symbolic capabilities (never authored by
 * the config, never a raw scope) and bind the canonical V3 hash + the
 * capability set + the app/source policy into the sealed transaction. A scope
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
    appId: config.app.id,
    source: {
      ...(config.source.defaultUrl !== undefined
        ? { defaultUrl: config.source.defaultUrl }
        : {}),
      allowLocalZip: config.source.allowLocalZip ?? true,
      ...(config.source.expectedSha256 !== undefined
        ? { expectedSha256: config.source.expectedSha256 }
        : {}),
    },
    units: (config.units ?? []).map((unit) => ({
      id: unit.id,
      kind: unit.kind,
      ...(unit.wrangler ? { wrangler: unit.wrangler } : {}),
      ...(unit.resources ? { resources: unit.resources.map((resource) => ({ kind: resource.kind, name: resource.name })) } : {}),
    })),
    ...(config.upgrade?.switchable?.length ? { switchable: [...config.upgrade.switchable] } : {}),
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
