// V3-only deploy-planning API. Authenticated + CSRF-protected; plans the
// sealed multi-unit graph from the server-issued release proof, gathers live
// remote snapshots through the typed Cloudflare client, and returns the
// nonsecret graph plan bound to the session. Never mutates, and never returns
// secret values.

import type { Context, Hono } from "hono";
import type { AppEnv, TapDeployEnv } from "../app.js";
import type { SessionPayload } from "../../auth/session.js";
import { validateBootstrapProfile } from "../../core/deploy/bootstrap-profile.js";
import {
  createCloudflareClient,
  type CloudflareApiError,
} from "../../cloudflare/client/index.js";
import type { DeploySpec } from "../../core/deploy-spec.js";
import { snapshotGraphTargets } from "../../core/planning/snapshot.js";
import { domainEntriesFromChoices } from "../../core/deploy/custom-domains.js";
import { applyResourceNames, markChangeableOnUpgrade } from "../../core/planning/resource-names.js";
import { normalizeV3Inputs, suppliedSecrets } from "../../core/planning/request-inputs.js";
import { preparedGraphInputs, resourceOnlyDispatchSpecs } from "../../core/planning/unit-specs.js";
import { buildGraphDeployPlan, graphPlanReferences } from "../../core/planning/plan.js";
import { buildDeployGraph } from "../../core/planning/deploy-graph.js";
import type { ExpectedTarget } from "../../core/planning/types.js";
import type { DeployBundle } from "../../release/deploy-bundle.js";
import { effectiveCapabilities, plannedUnits } from "../../manifest/config-v3.js";
import type { InputMode } from "../../manifest/input-validation.js";
import { loadKey } from "./auth.js";
import { authenticate } from "../session-guard.js";
import {
  authorizeGraphIntent,
  bindConfigToSession,
  resolvedCapabilitiesForGraph,
} from "../../core/config-envelope.js";
import { sealGraphPlanApproval } from "../../core/planning/plan-approval.js";
import { openVerifiedReleaseContext } from "../../core/planning/graph-execution-context.js";
import { graphActionId, canonicalJson } from "../../core/planning/digest.js";
import { graphExecutionContextDigest, sealGraphExecutionContext } from "../../core/planning/graph-execution-context.js";

interface DeployPlanBody {
  accountId?: string;
  inputs?: Record<string, unknown>;
  // The nonsecret config this session was authorized for.
  config?: { text?: unknown };
  // explicit target-kind + mode the operator selected, merged into
  // the expected reference so a change invalidates the prior plan.
  targetKind?: "workers" | "pages";
  mode?: "install" | "upgrade" | "blocked";
  // Operator-chosen custom domains per HTTP unit: `{ [unitId]: { bind: [{
  // hostname, zone, replaceExisting? }], remove: [{ hostname, zone }] } }`.
  domains?: unknown;
  // Operator-chosen existing account resources for bindings whose release id
  // belongs to the publisher: `{ [unitId]: { hyperdrive: { [binding]: name } } }`.
  bindings?: unknown;
  // Operator-chosen names for the release's resources and Pages projects:
  // `{ "<kind>:<release name>" | "pages:<unitId>": name }` (resource-names.ts).
  names?: unknown;
  // Names of declared secrets the operator gives a value they would not get by
  // default (an optional one filled in, an existing one replaced); the values
  // are supplied with the deploy steps, never at plan time.
  suppliedSecrets?: unknown;
  // The verified bundle proof + digest binding the
  // exact ZIP content, the per-unit drift reference of a previously approved
  // graph plan, and the operator's explicit paid-risk confirmation.
  bundle?: DeployBundle;
  bundleDigest?: string;
  expectedUnits?: Record<string, ExpectedTarget>;
  paidRiskConfirmed?: boolean;
  // Upgrade only: the operator confirmed taking over a Worker TapDeploy did not
  // deploy (no installer marker on its active version).
  takeoverConfirmed?: boolean;
  releaseProof?: unknown;
}

export function attachDeployPlanRoutes(
  app: Hono<AppEnv>,
  env: TapDeployEnv,
): void {
  app.post("/api/deploy/plan", async (c) => planHandler(c, env));
}

async function planHandler(c: Context<AppEnv>, env: TapDeployEnv): Promise<Response> {
  const auth = await authenticate(c, env);
  if ("denied" in auth) return auth.denied;
  const payload = auth.session;
  const publicOrigin = env.PUBLIC_ORIGIN ?? "";
  const key = await loadKey(env);

  let body: DeployPlanBody;
  try {
    body = (await c.req.json()) as DeployPlanBody;
  } catch {
    return c.json({ error: "invalid json body" }, 400);
  }

  const accountId = body.accountId ?? payload.accountId;
  if (!accountId) {
    return c.json({ error: "accountId is required" }, 400);
  }

  // The SERVER, never the browser, re-derives the symbolic capability set the
  // actual Wrangler config + install policy resolve to and refuses a
  // scope-underdeclared release as a developer error, with zero provider calls
  // and no second OAuth.
  try {
    return await planGraph({ payload, key, body, accountId, publicOrigin, json: (value) => c.json(value) });
  } catch (error) {
    if (error instanceof PlanRefusal) return c.json(error.body, error.status);
    throw error;
  }
}

// A refusal with its HTTP answer, thrown by the planning steps and answered once.
class PlanRefusal extends Error {
  constructor(readonly status: 400 | 409 | 502, readonly body: Record<string, unknown>) {
    super(String(body.error));
  }
}

// Config V3 graph planning. It binds the V3 config to the session, re-verifies
// the TapDeploy capability envelope against the release the server derives
// (never the browser's claim), gathers one live snapshot per unit and plans the
// graph. Any structural/scope/cost/drift failure returns a blocked graph plan
// (and no sealed approval), so nothing is ever written from an unapproved graph.
interface PlanRequest {
  payload: SessionPayload;
  key: CryptoKey;
  body: DeployPlanBody;
  accountId: string;
  publicOrigin: string;
  json: (value: unknown) => Response;
}

/** The config bound to the session and the release the prepare step proved: the only authority planning accepts. */
async function openRelease({ payload, key, body }: PlanRequest) {
  const bound = await bindConfigToSession({ sessionConfigHash: payload.configHash, configText: body.config?.text });
  if (!bound.ok) throw new PlanRefusal(bound.error === "config_mismatch" ? 409 : 400, { error: bound.error, detail: bound.detail });
  // Graph planning may only proceed from the authenticated prepare proof; the
  // browser never establishes release authority.
  const release = await openVerifiedReleaseContext(key, body.releaseProof, {
    nonce: payload.nonce,
    configHash: bound.configHash,
    sourcePolicyDigest: payload.sourcePolicyDigest ?? "",
  }, payload.expiresAt);
  if (!release) throw new PlanRefusal(409, { error: "INVALID_RELEASE_PROOF" });
  const declaredUnitIds = (plannedUnits(bound.config) ?? []).map((unit) => unit.id).sort();
  const preparedUnitIds = release.units.map((unit) => typeof unit.unitId === "string" ? unit.unitId : "").sort();
  if (declaredUnitIds.length > 0 && (declaredUnitIds.length !== preparedUnitIds.length || declaredUnitIds.some((id, index) => id !== preparedUnitIds[index]))) {
    throw new PlanRefusal(409, { error: "RELEASE_UNIT_MISMATCH" });
  }
  if (body.bundle !== undefined || body.bundleDigest !== undefined || body.expectedUnits !== undefined) {
    throw new PlanRefusal(409, { error: "BROWSER_GRAPH_AUTHORITY_REJECTED" });
  }
  // AEAD authenticates a payload, but each purpose/version still needs semantic
  // validation before it becomes graph input. Resource-only units have an empty
  // tagged Wrangler object; executable units must retain their normalized name.
  for (const unit of release.units) {
    if (!unit || typeof unit !== "object" || Array.isArray(unit) || typeof unit.unitId !== "string" ||
        typeof unit.bundleDigest !== "string" || !unit.canonicalWrangler || typeof unit.canonicalWrangler !== "object" || Array.isArray(unit.canonicalWrangler)) {
      throw new PlanRefusal(409, { error: "INVALID_RELEASE_PROOF" });
    }
  }
  if (release.units.some((unit) => {
    const wrangler = unit.canonicalWrangler as Record<string, unknown>;
    return wrangler.kind === "worker" && wrangler.assets;
  })) {
    throw new PlanRefusal(409, { error: "WORKER_ASSETS_UNSUPPORTED", detail: "Worker static assets are disabled: uploaded byte integrity is not verified." });
  }
  return { config: bound.config, configHash: bound.configHash, release };
}

type OpenedRelease = Awaited<ReturnType<typeof openRelease>>;

/**
 * The sealed per-unit specs for this request: the operator's names replace the
 * release's suggestions before any spec or graph exists (the session stays bound
 * to the config as authorized), then inputs, secret replacements and custom
 * domains join the specs they belong to.
 */
function buildSpecs({ body, publicOrigin }: PlanRequest, { config, release }: OpenedRelease, mode: InputMode) {
  const renamed = applyResourceNames(release.units, config, body.names);
  if (!renamed.ok) throw new PlanRefusal(400, { error: "INVALID_RESOURCE_NAME", detail: renamed.detail });
  const inputs = normalizeV3Inputs(config, body.inputs, mode);
  if (!inputs.ok) throw new PlanRefusal(400, { error: "INVALID_INPUT", detail: inputs.detail });
  const supplied = suppliedSecrets(config, body.suppliedSecrets, mode);
  if (!supplied.ok) throw new PlanRefusal(400, { error: "INVALID_INPUT", detail: supplied.detail });
  const prepared = preparedGraphInputs(renamed.config, renamed.units, release.archiveSha256, release.manifestDigest, inputs.inputs, supplied.names);
  if (!prepared.ok) throw new PlanRefusal(409, { error: "INVALID_RELEASE_PROOF", detail: prepared.detail });
  const specs = prepared.specs;
  markChangeableOnUpgrade(specs, release.units, { units: plannedUnits(config) });
  // Operator-chosen custom domains join the unit's sealed domain entries.
  const selfHostname = URL.canParse(publicOrigin) ? new URL(publicOrigin).hostname : undefined;
  const chosen = domainEntriesFromChoices(body.domains, Object.fromEntries(Object.entries(specs).map(([unitId, spec]) => [unitId, spec.targetKind])), selfHostname);
  if (!chosen.ok) throw new PlanRefusal(400, { error: "INVALID_DOMAIN_CHOICE", detail: chosen.detail });
  for (const [unitId, entries] of Object.entries(chosen.entries)) {
    const cloudflare = specs[unitId]!.cloudflare;
    cloudflare.domains = [...(cloudflare.domains ?? []), ...entries];
  }
  return { specs, prepared, planConfig: renamed.config, inputs: inputs.inputs };
}

/** The capabilities the release really needs: the graph's, plus what only the wrangler files reveal. */
function resolveCapabilities(graph: ReturnType<typeof buildDeployGraph>, release: OpenedRelease["release"], installPolicies: string[]) {
  return [...new Set([...resolvedCapabilitiesForGraph(graph, installPolicies), ...release.units.flatMap(unit => {
    const wrangler = unit.canonicalWrangler as Record<string, unknown>;
    return [...(Array.isArray(wrangler.workflows) && wrangler.workflows.length ? ["workflows"] : []), ...(Array.isArray(wrangler.durableObjects) && wrangler.durableObjects.length ? ["durable-objects"] : []), ...(Array.isArray(wrangler.routes) && wrangler.routes.length ? ["routes", "zone"] : [])];
  })])];
}

/** Developer-scope gate: refuse BEFORE any provider read/write. */
function requireCoverage(config: OpenedRelease["config"], resolvedCapabilities: string[], installPolicies: string[]): void {
  const coverage = authorizeGraphIntent({ declaredCapabilities: effectiveCapabilities(config), resolvedCapabilities, installPolicies });
  if (!coverage.ok) throw new PlanRefusal(409, { error: coverage.error, detail: coverage.detail, undeclared: coverage.undeclared });
}

/**
 * Features the graph dispatcher cannot yet verify refuse the whole graph before
 * its first provider read/write rather than dropping metadata or partially
 * deploying. Rate limits, queues, workflows, Durable Objects and zone routes are
 * all planned by `preparedGraphInputs` (or fail closed there with exact codes),
 * so only the guarded-bootstrap policy refusals can populate this list: each
 * install policy is structurally validated here (known kind, well-formed
 * profile, resolvable unit and R2 binding in the sealed spec). Fresh / Resume /
 * Upgrade decisions and privacy proofs stay at the version upload step, where
 * they are re-verified against fresh snapshots.
 */
function requireSupportedOperations(config: OpenedRelease["config"], specs: Record<string, DeploySpec>): void {
  const unsupported: string[] = [];
  for (const rawPolicy of config.install?.policies ?? []) {
    const validated = validateBootstrapProfile(rawPolicy);
    if (!validated.ok) {
      unsupported.push(`guarded-bootstrap:${validated.refusal.code}`);
      continue;
    }
    const unitSpec = specs[validated.value.unitId];
    if (!unitSpec || unitSpec.targetKind !== "workers") {
      unsupported.push("guarded-bootstrap:UNKNOWN_UNIT");
      continue;
    }
    if (!unitSpec.cloudflare.r2.some((binding) => binding.binding === validated.value.r2Binding)) {
      unsupported.push("guarded-bootstrap:BINDING_MISMATCH");
    }
  }
  if (unsupported.length) throw new PlanRefusal(409, { error: "UNSUPPORTED_GRAPH_OPERATION", features: [...new Set(unsupported)].sort() });
}

/**
 * The operator's New / Upgrade choice is checked against the live account
 * before anything is planned: New never updates an existing Worker and
 * Upgrade never creates one.
 */
function requireTargetMode(graph: ReturnType<typeof buildDeployGraph>, snapshots: Record<string, { workerExists?: boolean } | undefined>, specs: Record<string, DeploySpec>, mode: InputMode): void {
  const conflicts = graph.units.filter((unit) => unit.kind === "worker").flatMap((unit) => {
    const exists = snapshots[unit.id]?.workerExists;
    const name = specs[unit.id]?.cloudflare.workerName ?? unit.name;
    if (mode === "install" && exists === true) return [`a Worker named "${name}" already exists in this account; choose Upgrade existing to update it, or use another name`];
    if (mode === "upgrade" && exists === false) return [`there is no Worker named "${name}" in this account to upgrade; choose New, or pick an existing Worker`];
    return [];
  });
  if (conflicts.length) throw new PlanRefusal(409, { error: "TARGET_MODE_CONFLICT", detail: conflicts.join("; ") });
}

/**
 * Resolve the choices that name something in the installing account against
 * the fresh snapshot, so the resolved identity (not the publisher's claim) is
 * sealed into the spec and dispatch, binding metadata and readback all use it.
 */
function resolveAccountChoices(specs: Record<string, DeploySpec>, snapshots: Awaited<ReturnType<typeof snapshotGraphTargets>>, bindings: unknown): void {
  const hyperdriveChoices = bindingChoices(bindings);
  for (const [unitId, spec] of Object.entries(specs)) {
    const snapshot = snapshots[unitId];
    if (!snapshot) continue;
    // A Hyperdrive config wraps the installer's own database: the operator's
    // choice wins, else the release id when it exists in this account. An
    // unresolved binding keeps its claimed handle and the plan blocks on it.
    for (const hd of spec.cloudflare.hyperdrive) {
      const chosen = hyperdriveChoices[unitId]?.[hd.binding];
      const live = chosen !== undefined
        ? snapshot.hyperdriveConfigs.find((config) => config.name === chosen)
        : snapshot.hyperdriveConfigs.find((config) => config.id === hd.configId);
      if (live) hd.configName = live.name;
      else if (chosen !== undefined) hd.configName = chosen;
    }
    // A Secrets Store secret binds inside this account's store: the release
    // store id when it exists here, else the account's only store.
    for (const ss of spec.cloudflare.secretsStore) {
      const store = snapshot.secretsStores.find((candidate) => candidate.id === ss.storeId)
        ?? (snapshot.secretsStores.length === 1 ? snapshot.secretsStores[0] : undefined);
      if (store) ss.storeName = store.name;
    }
    for (const kv of spec.cloudflare.kv) {
      if (!kv.namespaceId) continue;
      const matches = snapshot.kvNamespaces.filter((n) => n.id === kv.namespaceId);
      if (matches.length === 1 && matches[0]) {
        kv.namespaceName = matches[0].name;
      }
    }
  }
}

async function planGraph(request: PlanRequest): Promise<Response> {
  const { payload, key, body, accountId } = request;
  const opened = await openRelease(request);
  const { config, configHash, release } = opened;
  const mode: InputMode = body.mode === "upgrade" ? "upgrade" : "install";
  const { specs, prepared, planConfig, inputs } = buildSpecs(request, opened, mode);

  const installPolicies = (config.install?.policies ?? []).map((policy) => policy.kind);
  const graph = buildDeployGraph({
    accountId,
    units: plannedUnits(planConfig)?.map((unit) => ({ ...unit, services: specs[unit.id]?.wrangler.services })),
    specs,
    ...(release.combinedUnitRootDigest ? { bundleDigest: release.combinedUnitRootDigest } : {}),
  });
  const resolvedCapabilities = resolveCapabilities(graph, release, installPolicies);
  requireCoverage(config, resolvedCapabilities, installPolicies);
  requireSupportedOperations(config, specs);

  const client = createCloudflareClient({ accessToken: payload.accessToken });
  let snapshots;
  try {
    snapshots = await snapshotGraphTargets(client, { accountId, graph });
  } catch (error) {
    if (isUpstreamError(error)) throw new PlanRefusal(502, { error: "upstream", upstream: error.kind });
    throw error;
  }
  requireTargetMode(graph, snapshots, specs, mode);
  resolveAccountChoices(specs, snapshots, body.bindings);

  const graphPlan = await buildGraphDeployPlan(
    {
      graph,
      accountId,
      configHash,
      snapshots,
      specs,
      bundles: prepared.bundles,
      declaredCapabilities: effectiveCapabilities(config),
      resolvedCapabilities,
      installPolicies,
      ...(body.expectedUnits ? { expected: body.expectedUnits } : {}),
      ...(body.targetKind ? { intent: { targetKind: body.targetKind } } : {}),
      paidRiskConfirmed: body.paidRiskConfirmed === true,
      takeoverConfirmed: body.takeoverConfirmed === true,
    },
    { salt: payload.csrf },
  );
  const references = graphPlanReferences(graphPlan);
  if (graphPlan.blocked) return request.json({ authenticated: true, graphPlan, references, approval: undefined, executionContext: undefined, paidRisk: graphPlan.cost });

  const contextBase = {
    kind: "tapdeploy-graph-execution/v1" as const, protocolVersion: 1 as const,
    nonce: payload.nonce, configHash, appId: release.appId, accountId, expiresAt: Math.min(release.expiresAt, payload.expiresAt),
    sourceKind: release.sourceKind, sourcePolicyDigest: release.sourcePolicyDigest, archiveSha256: release.archiveSha256, manifestDigest: release.manifestDigest,
    graphPlanDigest: graphPlan.digest,
    canonicalNonsecretGraphPlan: JSON.parse(canonicalJson(graphPlan)) as Record<string, unknown>,
    topoOrder: graph.topoOrder,
    dependencies: graph.dependencies.map(({ dependent, dependency }) => ({ dependent, dependency })),
    expectedPerUnitReferences: references as Record<string, unknown>,
    approvedDiffsWithActionIds: graphPlan.units.flatMap((unit) => unit.diffs.map((diff) => ({ unitId: unit.unitId, actionId: graphActionId({ unitId: unit.unitId, resource: diff.resource, action: diff.action, ...(diff.name ? { name: diff.name } : {}) }), resource: diff.resource, action: diff.action, ...(diff.name ? { name: diff.name } : {}) }))),
    perUnitCanonicalSpecs: { ...specs, ...resourceOnlyDispatchSpecs(planConfig, release.manifestDigest, inputs) } as unknown as Record<string, unknown>,
    perUnitWranglerAndBundleProofs: prepared.proofs,
    capabilityClosure: { declared: effectiveCapabilities(config), resolved: resolvedCapabilities },
    costPosture: graphPlan.cost as unknown as Record<string, unknown>, approvedMode: mode,
    optionalBootstrapPolicyIdentity: { policies: config.install?.policies ?? [] },
  };
  const executionContextDigest = await graphExecutionContextDigest(contextBase);
  let executionContext;
  try { executionContext = await sealGraphExecutionContext(key, { ...contextBase, executionContextDigest }); }
  catch { throw new PlanRefusal(409, { error: "SEALED_CONTEXT_TOO_LARGE" }); }
  const approval = await sealGraphPlanApproval(key, {
    nonce: payload.nonce,
    configHash,
    accountId,
    digest: graphPlan.digest,
    references,
    executionContextDigest,
    expiresAt: payload.expiresAt,
  });
  return request.json({
    authenticated: true,
    graphPlan,
    references,
    executionContext,
    approval,
    // per-unit bundle digests are nonsecret integrity references. The
    // browser needs them to address bundle-bound steps (the step route rejects
    // a missing/mismatched digest before any read); the digests alone prove
    // nothing about the bytes, which the server rehashes at dispatch.
    bundleDigests: Object.fromEntries(release.units.map((unit) => [String(unit.unitId), String(unit.bundleDigest)])),
    // Non-secret dispatch-order advice: the unit edges already sealed into the
    // execution context. Scheduling only; the step route still verifies every
    // receipt, so a wrong or tampered hint can cost a refusal, never a write.
    schedulerHints: { version: 1 as const, topoOrder: graph.topoOrder, dependencies: contextBase.dependencies },
    paidRisk: {
      operations: graphPlan.cost.operations,
      requiresConfirmation: graphPlan.cost.requiresConfirmation,
      confirmed: graphPlan.cost.confirmed,
      blockedUnknownCost: graphPlan.cost.blockedUnknownCost,
    },
  });
}

// `{ [unitId]: { hyperdrive: { [binding]: configName } } }`; anything else is ignored.
function bindingChoices(raw: unknown): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [unitId, value] of Object.entries(raw as Record<string, unknown>)) {
    const hyperdrive = (value as { hyperdrive?: unknown } | null)?.hyperdrive;
    if (hyperdrive === null || typeof hyperdrive !== "object" || Array.isArray(hyperdrive)) continue;
    const chosen = Object.entries(hyperdrive as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0 && entry[1].length <= 64);
    if (chosen.length > 0) out[unitId] = Object.fromEntries(chosen);
  }
  return out;
}

function isUpstreamError(error: unknown): error is CloudflareApiError {
  return typeof error === "object" && error !== null && "kind" in error;
}
