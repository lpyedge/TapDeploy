// server-side check that a deploy request stays inside the config the
// OAuth session was bound to.
//
// The browser re-sends the nonsecret config text with every plan/step request.
// The server never trusts a caller-supplied hash: it re-validates the config,
// recomputes the canonical hash, requires it to equal the hash sealed into the
// session, and then verifies that the submitted release intent (target kind,
// account resources + lifecycle, cron schedules, domain intents) is contained in
// what the config declares. Anything else is refused BEFORE any provider call.
//
// Pure and runtime-agnostic: no provider call, no storage.

import type { ConfigDomainKind } from "./deploy-spec.js";
import {
  computeConfigV3Id,
  parseConfigV3Text,
  validateConfigV3Entry,
  INSTALL_POLICY_KINDS,
  V3_CAPABILITY_META,
  type ConfigV3,
  type InstallPolicyKind,
  type V3Capability,
} from "../manifest/config-v3.js";
import {
  checkResolvedCapabilitiesWithin,
  DEVELOPER_SCOPE_UNDERDECLARED,
} from "../auth/scope-planner.js";
import type { DeploymentGraph } from "./planning/deploy-graph.js";
import type { UnitResourceKind } from "./planning/deployment-units.js";

type EnvelopeErrorCode =
  | "config_required"
  | "invalid_config"
  | "config_mismatch";

export type EnvelopeResult =
  | { ok: true; config: ConfigV3; configHash: string }
  | { ok: false; error: EnvelopeErrorCode; detail: string };

/**
 * Re-validate the V3 config text a request carries, recompute its canonical
 * hash and require it to equal the hash sealed into the session. A changed config — app identity, source policy
 * or the capability set — yields `config_mismatch`: the request is refused
 * before any provider call and NO second OAuth is triggered; the human starts a
 * new session explicitly.
 */
export async function bindConfigToSession(input: {
  sessionConfigHash: string | undefined;
  configText: unknown;
}): Promise<EnvelopeResult> {
  if (typeof input.configText !== "string" || input.configText.trim() === "") {
    return { ok: false, error: "config_required", detail: "requests must carry the config" };
  }
  const parsed = parseConfigV3Text(input.configText);
  if (!parsed.ok) {
    return { ok: false, error: "invalid_config", detail: parsed.issue.message };
  }
  const entry = validateConfigV3Entry(parsed.value);
  if (!entry.ok || !entry.config) {
    return {
      ok: false,
      error: "invalid_config",
      detail: entry.errors.slice(0, 5).map((e) => `${e.field} ${e.message}`).join("; "),
    };
  }
  const config = entry.config;
  const configHash = await computeConfigV3Id(config);
  if (!input.sessionConfigHash || input.sessionConfigHash !== configHash) {
    return {
      ok: false,
      error: "config_mismatch",
      detail: "the config differs from the one this Cloudflare authorization was granted for; start a new authorization",
    };
  }
  return { ok: true, config, configHash };
}

// ---------------------------------------------------------------------------
// Config V3 graph-intent
// authorization + SERVER-side capability coverage recheck.
//
// The browser shows a permission preview, but the browser is never authoritative:
// the server re-derives the symbolic capability set the ACTUAL release needs
// (every unit's effective Wrangler config plus the install policy) and requires
// the config's declared `capabilities` to cover it. Anything the ZIP resolves
// that the envelope did not pre-declare is a developer error surfaced as
// DEVELOPER_SCOPE_UNDERDECLARED: the request is refused BEFORE any provider call,
// no additional permission is requested and NO second OAuth is triggered. Pure:
// no provider call, no storage, no secret read.
// ---------------------------------------------------------------------------

// The graph resource family -> symbolic V3 capability it needs. `runtime` and
// `secret` are not account resources: a runtime binding needs no per-app scope
// (only the enclosing Worker admin), and a Worker version secret is covered by
// `workers`.
const GRAPH_RESOURCE_CAPABILITY: Partial<Record<UnitResourceKind, V3Capability>> = {
  r2: "r2",
  d1: "d1",
  kv: "kv",
  queue: "queues",
  hyperdrive: "hyperdrive",
  vectorize: "vectorize",
  "secrets-store": "secrets-store",
};

// Runtime binding kinds (graph resource `name` carries the canonical type).
const GRAPH_RUNTIME_CAPABILITY: Partial<Record<string, V3Capability>> = {
  ai: "workers-ai",
  "browser-rendering": "browser-rendering",
};

// Exposure kind -> symbolic capability. Every exposure is zone-scoped, so it
// also needs `zone`. A custom domain needs `dns`: replacing an existing record
// and the Pages CNAME are DNS writes (the attach itself is covered by
// `workers` / `pages`). Both are implied by any HTTP unit (see
// `effectiveCapabilities`).
const GRAPH_EXPOSURE_CAPABILITY: Partial<Record<ConfigDomainKind, V3Capability>> = {
  "dns-record": "dns",
  "workers-route": "routes",
  "workers-custom-domain": "dns",
  "pages-custom-domain": "dns",
};

const GRAPH_EXPOSURE_NEEDS_ZONE: ReadonlySet<ConfigDomainKind> = new Set<ConfigDomainKind>([
  "dns-record",
  "workers-route",
  "workers-custom-domain",
  "pages-custom-domain",
]);

// Built-in install policy kind -> the symbolic capability it requires. The
// private R2 owner bootstrap manages R2 objects, so it needs `r2`.
const INSTALL_POLICY_CAPABILITY: Record<InstallPolicyKind, V3Capability> = {
  "private-r2-owner-bootstrap/v1": "r2",
};

const KNOWN_INSTALL_POLICIES: ReadonlySet<string> = new Set(INSTALL_POLICY_KINDS);

/**
 * Derive the symbolic V3 capability set the ACTUAL release needs from its
 * deployment graph (units' effective Wrangler configs + resolved bindings,
 * triggers and exposures) plus any install-policy kinds. This is the server's
 * independent view; it never trusts a caller-supplied list.
 */
export function resolvedCapabilitiesForGraph(
  graph: Pick<DeploymentGraph, "units" | "resources" | "exposures" | "triggers">,
  installPolicies: readonly string[] = [],
): V3Capability[] {
  const caps = new Set<V3Capability>();
  for (const unit of graph.units) {
    if (unit.identity === "worker-script") caps.add("workers");
    if (unit.identity === "pages-project") caps.add("pages");
  }
  for (const resource of graph.resources) {
    const capability = GRAPH_RESOURCE_CAPABILITY[resource.kind];
    if (capability) caps.add(capability);
    if (resource.kind === "runtime" && resource.name !== undefined) {
      const runtime = GRAPH_RUNTIME_CAPABILITY[resource.name];
      if (runtime) caps.add(runtime);
    }
  }
  for (const exposure of graph.exposures) {
    const capability = GRAPH_EXPOSURE_CAPABILITY[exposure.kind];
    if (capability) caps.add(capability);
    if (GRAPH_EXPOSURE_NEEDS_ZONE.has(exposure.kind)) caps.add("zone");
  }
  for (const policy of installPolicies) {
    const capability = INSTALL_POLICY_CAPABILITY[policy as InstallPolicyKind];
    if (capability) caps.add(capability);
  }
  return [...caps].sort();
}

type GraphIntentErrorCode =
  | typeof DEVELOPER_SCOPE_UNDERDECLARED
  | "UNKNOWN_CAPABILITY";

export interface GraphIntentAuthorizationInput {
  declaredCapabilities: readonly string[];
  resolvedCapabilities: readonly string[];
  installPolicies?: readonly string[];
}

export interface GraphIntentAuthorization {
  ok: boolean;
  /** Resolved capabilities the declared envelope did not cover (sorted). */
  undeclared: string[];
  error?: GraphIntentErrorCode;
  detail?: string;
}

/**
 * Server-side authorization of a Config V3 release intent against the graph's
 * resolved capability set. Fails closed on (a) an unknown resolved symbolic
 * capability, (b) an unrecognized install-policy kind and (c) any resolved
 * capability the declared envelope did not cover. A failure is developer-fixable
 * (`DEVELOPER_SCOPE_UNDERDECLARED`) and NEVER widens scope or restarts OAuth.
 */
export function authorizeGraphIntent(
  input: GraphIntentAuthorizationInput,
): GraphIntentAuthorization {
  const resolved = [...new Set(input.resolvedCapabilities)];
  const unknown = resolved.filter((capability) => !(capability in V3_CAPABILITY_META)).sort();
  if (unknown.length > 0) {
    return {
      ok: false,
      undeclared: unknown,
      error: "UNKNOWN_CAPABILITY",
      detail: `the release resolves unknown capability ids (${unknown.join(", ")}); refusing before any provider call`,
    };
  }
  const policyCapabilities: string[] = [];
  for (const policy of input.installPolicies ?? []) {
    if (!KNOWN_INSTALL_POLICIES.has(policy)) {
      return {
        ok: false,
        undeclared: [],
        error: "UNKNOWN_CAPABILITY",
        detail: `the release declares an unknown install policy kind "${policy}"; refusing before any provider call`,
      };
    }
    policyCapabilities.push(INSTALL_POLICY_CAPABILITY[policy as InstallPolicyKind]);
  }
  const check = checkResolvedCapabilitiesWithin(input.declaredCapabilities, [
    ...resolved,
    ...policyCapabilities,
  ]);
  if (!check.ok) {
    return {
      ok: false,
      undeclared: check.undeclared,
      error: DEVELOPER_SCOPE_UNDERDECLARED,
      detail: check.detail,
    };
  }
  return { ok: true, undeclared: [] };
}
