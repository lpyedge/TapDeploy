// V3-only deploy-planning API. Authenticated + CSRF-protected; plans the
// sealed multi-unit graph from the server-issued release proof, gathers live
// remote snapshots through the typed Cloudflare client, and returns the
// nonsecret graph plan bound to the session. Never mutates, and never returns
// secret values.

import type { Context, Hono } from "hono";
import type { AppEnv, TapDeployEnv } from "../app.js";
import { parseCookies } from "../../auth/cookies.js";
import { validateCsrf, validateOrigin } from "../../auth/csrf.js";
import { sessionCookieName, readSession, type SessionPayload } from "../../auth/session.js";
import type { WranglerV3DurableObjectBinding, WranglerV3Migration, WranglerV3Workflow } from "../../manifest/wrangler-v3.js";
import { isPrimitiveInputValue, type DeploySpec, type DomainEntrySpec, type PrimitiveInputValue, type SecretPolicy } from "../../core/deploy-spec.js";
import { planRateLimitBindings } from "../../cloudflare/resources/rate-limits.js";
import { planWranglerCarrierActions } from "../../core/deploy/wrangler-binding-plan.js";
import { validateBootstrapProfile } from "../../core/deploy/bootstrap-profile.js";
import {
  createCloudflareClient,
  type CloudflareApiError,
} from "../../cloudflare/client/index.js";
import { snapshotGraphTargets } from "../../core/planning/snapshot.js";
import { domainEntriesFromChoices } from "../../core/deploy/custom-domains.js";
import { buildGraphDeployPlan, graphPlanReferences } from "../../core/planning/plan.js";
import { buildDeployGraph } from "../../core/planning/deploy-graph.js";
import type { ExpectedTarget } from "../../core/planning/types.js";
import type { DeployBundle } from "../../release/deploy-bundle.js";
import { effectiveCapabilities, type ConfigV3 } from "../../manifest/config-v3.js";
import { loadKey } from "./auth.js";
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
  // The verified bundle proof + digest binding the
  // exact ZIP content, the per-unit drift reference of a previously approved
  // graph plan, and the operator's explicit paid-risk confirmation.
  bundle?: DeployBundle;
  bundleDigest?: string;
  expectedUnits?: Record<string, ExpectedTarget>;
  paidRiskConfirmed?: boolean;
  releaseProof?: unknown;
}

export function attachDeployPlanRoutes(
  app: Hono<AppEnv>,
  env: TapDeployEnv,
): void {
  app.post("/api/deploy/plan", async (c) => planHandler(c, env));
}

async function planHandler(c: Context<AppEnv>, env: TapDeployEnv): Promise<Response> {
  const publicOrigin = env.PUBLIC_ORIGIN ?? "";
  const origin = c.req.header("origin");
  const csrf = c.req.header("x-tapdeploy-csrf");

  const cookies = parseCookies(c.req.raw.headers.get("cookie"));
  const raw = cookies[sessionCookieName(publicOrigin)];
  const key = raw ? await loadKey(env).catch(() => null) : null;
  if (!key || !raw) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  const payload = await readSession(key, raw);
  if (!payload) {
    return c.json({ error: "unauthenticated" }, 401);
  }

  if (!validateOrigin(publicOrigin, origin) || !validateCsrf(payload, csrf)) {
    return c.json({ error: "csrf/origin check failed" }, 403);
  }

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

  // a Config V3 request plans the
  // multi-unit graph. The SERVER — never the browser — re-derives the symbolic
  // capability set the ACTUAL Wrangler config + install policy resolve to and
  // refuses a scope-underdeclared release as a developer error, with zero
  // provider calls and no second OAuth.
  return planGraphV3(c, payload, key, body, accountId);
}

// Config V3 graph-plan handler. It binds the V3 config to the session,
// re-verifies the TapDeploy capability envelope against the release the server derives
// (never the browser's claim), gathers one live snapshot per unit and plans the
// graph. Any structural/scope/cost/drift failure returns a blocked graph plan
// (and no sealed approval), so nothing is ever written from an unapproved graph.
async function planGraphV3(
  c: Context<AppEnv>,
  payload: SessionPayload,
  key: CryptoKey,
  body: DeployPlanBody,
  accountId: string,
): Promise<Response> {
  const bound = await bindConfigToSession({
    sessionConfigHash: payload.configHash,
    configText: body.config?.text,
  });
  if (!bound.ok) {
    const status = bound.error === "config_mismatch" ? 409 : 400;
    return c.json({ error: bound.error, detail: bound.detail }, status);
  }
  const config = bound.config;

  // Graph planning may only proceed from the authenticated prepare proof; the
  // browser never establishes release authority.
  const release = await openVerifiedReleaseContext(key, body.releaseProof, {
    nonce: payload.nonce,
    configHash: bound.configHash,
    sourcePolicyDigest: payload.sourcePolicy ? await (async () => {
      const bytes = new TextEncoder().encode(JSON.stringify(payload.sourcePolicy));
      const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    })() : "",
  }, payload.expiresAt);
  if (!release) return c.json({ error: "INVALID_RELEASE_PROOF" }, 409);
  const declaredUnitIds = (config.units ?? []).map((unit) => unit.id).sort();
  const preparedUnitIds = release.units.map((unit) => typeof unit.unitId === "string" ? unit.unitId : "").sort();
  if (declaredUnitIds.length > 0 && (declaredUnitIds.length !== preparedUnitIds.length || declaredUnitIds.some((id, index) => id !== preparedUnitIds[index]))) {
    return c.json({ error: "RELEASE_UNIT_MISMATCH" }, 409);
  }
  if (body.bundle !== undefined || body.bundleDigest !== undefined || body.expectedUnits !== undefined) {
    return c.json({ error: "BROWSER_GRAPH_AUTHORITY_REJECTED" }, 409);
  }
  // AEAD authenticates a payload, but each purpose/version still needs semantic
  // validation before it becomes graph input. Resource-only units have an empty
  // tagged Wrangler object; executable units must retain their normalized name.
  for (const unit of release.units) {
    if (!unit || typeof unit !== "object" || Array.isArray(unit) || typeof unit.unitId !== "string" ||
        typeof unit.bundleDigest !== "string" || !unit.canonicalWrangler || typeof unit.canonicalWrangler !== "object" || Array.isArray(unit.canonicalWrangler)) {
      return c.json({ error: "INVALID_RELEASE_PROOF" }, 409);
    }
  }

  const prepared = preparedGraphInputs(config, release.units, release.archiveSha256, release.manifestDigest, normalizeV3Inputs(config, body.inputs));
  if (!prepared.ok) return c.json({ error: "INVALID_RELEASE_PROOF", detail: prepared.detail }, 409);
  const specs = prepared.specs;
  // Operator-chosen custom domains join the unit's sealed domain entries.
  const chosen = domainEntriesFromChoices(body.domains, Object.fromEntries(Object.entries(specs).map(([unitId, spec]) => [unitId, spec.targetKind])));
  if (!chosen.ok) return c.json({ error: "INVALID_DOMAIN_CHOICE", detail: chosen.detail }, 400);
  for (const [unitId, entries] of Object.entries(chosen.entries)) {
    const cloudflare = specs[unitId]!.cloudflare;
    cloudflare.domains = [...(cloudflare.domains ?? []), ...entries];
  }

  const installPolicies = (config.install?.policies ?? []).map((policy) => policy.kind);
  const graph = buildDeployGraph({
    accountId,
    units: config.units?.map((unit) => ({ ...unit, services: specs[unit.id]?.wrangler.services })),
    specs,
    ...(release.combinedUnitRootDigest ? { bundleDigest: release.combinedUnitRootDigest } : {}),
  });
  const resolvedCapabilities = [...new Set([...resolvedCapabilitiesForGraph(graph, installPolicies), ...release.units.flatMap(unit => {
    const wrangler = unit.canonicalWrangler as Record<string, unknown>;
    return [...(Array.isArray(wrangler.workflows) && wrangler.workflows.length ? ["workflows"] : []), ...(Array.isArray(wrangler.durableObjects) && wrangler.durableObjects.length ? ["durable-objects"] : []), ...(Array.isArray(wrangler.routes) && wrangler.routes.length ? ["routes", "zone"] : [])];
  })])];

  // Developer-scope gate: refuse BEFORE any provider read/write.
  const coverage = authorizeGraphIntent({
    declaredCapabilities: effectiveCapabilities(config),
    resolvedCapabilities,
    installPolicies,
  });
  if (!coverage.ok) {
    return c.json(
      { error: coverage.error, detail: coverage.detail, undeclared: coverage.undeclared },
      409,
    );
  }

  // These normalized features require provider operations that the graph
  // dispatcher cannot yet verify. Refuse the entire graph before its first
  // provider read/write rather than dropping metadata or partially deploying.
  // ratelimits are no longer refused here — they are version metadata
  // bindings (never account/zone rule provisioning), verified at projection
  // and bound into the Worker version below. queue producers/consumers are
  // no longer refused — `preparedGraphInputs` normalizes them into explicit
  // per-queue roles (producer binds in the version; consumer registers a
  // provider trigger after the cutover). workflows are no longer refused —
  // the carrier class export is verified at prepare, the binding rides the
  // exact version metadata, and the definition + direct schedules are applied
  // through the Workflows API after the cutover and read back exactly (an
  // external `script_name` still fails closed in `preparedGraphInputs`; the
  // 2026 top-level `exports` field is refused by the wrangler parser).
  // durable_objects/migrations are no longer blanket-refused either —
  // `preparedGraphInputs` (pure, no provider reads) plans only the
  // strictly-bound subset (own script, exported class, pure new-class
  // migrations with exact binding cover, unique tags) and fails closed with
  // exact codes on renames/deletes, foreign scripts, environments, empty
  // entries, duplicate tags and uncovered classes. `transferred_classes`
  // never reaches the plan (parser refusal).
  // wrangler `routes` are no longer blanket-refused either — zone-scoped
  // patterns convert to explicit `workers-route` domain entries below (one
  // declaration, one zone, add-only). Anything else (custom domains, missing
  // zones, unmanaged mutations) fails closed in `preparedGraphInputs`.
  // Only the guarded-bootstrap policy refusals below can populate this list.
  const unsupported: string[] = [];
  // guarded R2 owner bootstrap is no longer blanket-refused. Each
  // install policy is structurally validated here (known kind, well-formed
  // profile, resolvable unit and R2 binding in the sealed spec) before any
  // provider read; invalid declarations fail closed with an explicit reason.
  // Fresh/Resume/Upgrade decisions and privacy proofs stay at the version
  // upload step, where they are re-verified against fresh snapshots.
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
  if (unsupported.length) return c.json({ error: "UNSUPPORTED_GRAPH_OPERATION", features: [...new Set(unsupported)].sort() }, 409);

  const client = createCloudflareClient({ accessToken: payload.accessToken });
  let snapshots;
  try {
    snapshots = await snapshotGraphTargets(client, { accountId, graph });
  } catch (error) {
    if (isUpstreamError(error)) {
      return c.json({ error: "upstream", upstream: error.kind }, 502);
    }
    throw error;
  }

  // The operator's New / Upgrade choice is checked against the live account
  // before anything is planned: New never updates an existing Worker and
  // Upgrade never creates one.
  const mode = body.mode === "upgrade" ? "upgrade" : "install";
  const modeConflicts = graph.units.filter((unit) => unit.kind === "worker").flatMap((unit) => {
    const exists = snapshots[unit.id]?.workerExists;
    const name = specs[unit.id]?.cloudflare.workerName ?? unit.name;
    if (mode === "install" && exists === true) return [`a Worker named "${name}" already exists in this account; choose Upgrade existing to update it, or use another name`];
    if (mode === "upgrade" && exists === false) return [`there is no Worker named "${name}" in this account to upgrade; choose New, or pick an existing Worker`];
    return [];
  });
  if (modeConflicts.length) return c.json({ error: "TARGET_MODE_CONFLICT", detail: modeConflicts.join("; ") }, 409);

  // resolve each Wrangler-declared KV provider id to exactly one live
  // namespace name on the fresh snapshot. The resolved name (not the id) is
  // sealed into the spec so dispatch, binding metadata and readback all use
  // the verified identity; a missing/ambiguous id is left unresolved and the
  // plan blocks below with a kv-drift guard before any write.
  const hyperdriveChoices = bindingChoices(body.bindings);
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

  const graphPlan = await buildGraphDeployPlan(
    {
      graph,
      accountId,
      configHash: bound.configHash,
      snapshots,
      specs,
       bundles: prepared.bundles,
      declaredCapabilities: effectiveCapabilities(config),
      resolvedCapabilities,
      installPolicies,
      ...(body.expectedUnits ? { expected: body.expectedUnits } : {}),
      ...(body.targetKind ? { intent: { targetKind: body.targetKind } } : {}),
      paidRiskConfirmed: body.paidRiskConfirmed === true,
    },
    { salt: payload.csrf },
  );

  const references = graphPlanReferences(graphPlan);
  if (graphPlan.blocked) return c.json({ authenticated: true, graphPlan, references, approval: undefined, executionContext: undefined, paidRisk: graphPlan.cost });
  const contextBase = {
    kind: "tapdeploy-graph-execution/v1" as const, protocolVersion: 1 as const,
    nonce: payload.nonce, configHash: bound.configHash, appId: release.appId, accountId, expiresAt: Math.min(release.expiresAt, payload.expiresAt),
    sourceKind: release.sourceKind, sourcePolicyDigest: release.sourcePolicyDigest, archiveSha256: release.archiveSha256, manifestDigest: release.manifestDigest,
    graphPlanDigest: graphPlan.digest,
    canonicalNonsecretGraphPlan: JSON.parse(canonicalJson(graphPlan)) as Record<string, unknown>,
    topoOrder: graph.topoOrder,
    dependencies: graph.dependencies.map(({ dependent, dependency }) => ({ dependent, dependency })),
    expectedPerUnitReferences: references as Record<string, unknown>,
    approvedDiffsWithActionIds: graphPlan.units.flatMap((unit) => unit.diffs.map((diff) => ({ unitId: unit.unitId, actionId: graphActionId({ unitId: unit.unitId, resource: diff.resource, action: diff.action, ...(diff.name ? { name: diff.name } : {}) }), resource: diff.resource, action: diff.action, ...(diff.name ? { name: diff.name } : {}) }))),
    perUnitCanonicalSpecs: { ...specs, ...resourceOnlyDispatchSpecs(config, release.manifestDigest, normalizeV3Inputs(config, body.inputs)) } as unknown as Record<string, unknown>,
    perUnitWranglerAndBundleProofs: prepared.proofs,
    capabilityClosure: { declared: effectiveCapabilities(config), resolved: resolvedCapabilities },
    costPosture: graphPlan.cost as unknown as Record<string, unknown>, approvedMode: body.mode === "upgrade" ? "upgrade" : "install",
    optionalBootstrapPolicyIdentity: { policies: config.install?.policies ?? [] },
  };
  const executionContextDigest = await graphExecutionContextDigest(contextBase);
  let executionContext;
  try { executionContext = await sealGraphExecutionContext(key, { ...contextBase, executionContextDigest }); }
  catch { return c.json({ error: "SEALED_CONTEXT_TOO_LARGE" }, 409); }
  const approval = await sealGraphPlanApproval(key, {
         nonce: payload.nonce,
         configHash: bound.configHash,
         accountId,
         digest: graphPlan.digest,
         references,
         executionContextDigest,
         expiresAt: payload.expiresAt,
       });
  return c.json({
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
    paidRisk: {
      operations: graphPlan.cost.operations,
      requiresConfirmation: graphPlan.cost.requiresConfirmation,
      confirmed: graphPlan.cost.confirmed,
      blockedUnknownCost: graphPlan.cost.blockedUnknownCost,
    },
  });
}

function resourceOnlyDispatchSpecs(config: ConfigV3, manifestDigest: string, inputs: Record<string, PrimitiveInputValue>): Record<string, DeploySpec> {
  return Object.fromEntries((config.units ?? []).filter((unit) => unit.kind === "resources").map((unit) => [unit.id, {
    schemaVersion: 1, project: { id: config.app.id, version: manifestDigest.slice(0, 16) }, assets: [], inputs,
    cloudflare: {
      workerName: "",
      r2: (unit.resources ?? []).filter((r) => r.kind === "r2").map((r) => ({ binding: "", bucketName: r.name, createIfMissing: r.mode === "ensure" })),
      d1: (unit.resources ?? []).filter((r) => r.kind === "d1").map((r) => ({ binding: "", databaseName: r.name, createIfMissing: r.mode === "ensure" })),
      kv: (unit.resources ?? []).filter((r) => r.kind === "kv").map((r) => ({ binding: "", namespaceName: r.name, createIfMissing: r.mode === "ensure" })),
      queues: (unit.resources ?? []).filter((r) => r.kind === "queue").map((r) => ({ binding: "", queueName: r.name, createIfMissing: r.mode === "ensure" })),
      vectorize: (unit.resources ?? []).filter((r) => r.kind === "vectorize").map((r) => ({ binding: "", indexName: r.name, createIfMissing: r.mode === "ensure", ...(r.dimensions !== undefined && r.metric !== undefined ? { config: { dimensions: r.dimensions, metric: r.metric } } : {}) })),
      workflows: [], hyperdrive: [], secretsStore: [], runtimeBindings: [], cron: [], secrets: {},
    },
    wrangler: {} as DeploySpec["wrangler"], targetKind: "workers",
  } satisfies DeploySpec]));
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

function isBinding(value: unknown): value is { binding: string } {
  return typeof value === "object" && value !== null && typeof (value as { binding?: unknown }).binding === "string";
}

function normalizeInputs(
  raw: Record<string, unknown> | undefined,
): Record<string, PrimitiveInputValue> {
  const out: Record<string, PrimitiveInputValue> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (isPrimitiveInputValue(v)) {
      out[k] = v;
    }
  }
  return out;
}

type PreparedUnit = {
  unitId: string;
  wranglerPath?: string;
  wranglerSha256?: string;
  wranglerEffectiveHash?: string;
  canonicalWrangler?: Record<string, unknown>;
  mainModule?: { path: string; sha256: string; size: number };
  modules?: Array<{ path: string; sha256: string; size: number; mime: string }>;
  assets?: Array<{ path: string; sha256: string; size: number }>;
  bundleDigest: string;
};

function normalizeV3Inputs(config: ConfigV3, raw: Record<string, unknown> | undefined): Record<string, PrimitiveInputValue> {
  const allowed = new Set((config.inputs ?? []).filter((input) => input.type !== "secret").map((input) => input.key));
  // Operator-renamable Worker identity (see preparedGraphInputs): always
  // allowed through so install can set the name even when the config declares
  // no workerName input. Server-side validation still applies.
  allowed.add("workerName");
  return Object.fromEntries(Object.entries(normalizeInputs(raw)).filter(([key]) => allowed.has(key)));
}

export function preparedGraphInputs(
  config: ConfigV3,
  rawUnits: Record<string, unknown>[],
  archiveSha256: string,
  manifestDigest: string,
  inputs: Record<string, PrimitiveInputValue>,
): { ok: true; specs: Record<string, DeploySpec>; bundles: Record<string, DeployBundle>; proofs: Record<string, unknown> } | { ok: false; detail: string } {
  const units = rawUnits as PreparedUnit[];
  const declared = config.units ?? [];
  const byId = new Map(units.map((unit) => [unit.unitId, unit]));
  const specs: Record<string, DeploySpec> = {};
  const bundles: Record<string, DeployBundle> = {};
  const proofs: Record<string, unknown> = {};
  // secret declarations come from bounded config inputs (type secret).
  // The key doubles as the Worker binding name (validated binding-safe); the
  // policy defaults to prompt-on-install because a generate requirement can
  // never be inferred. Values are never projected here — they travel
  // per-step in args.secrets and are never sealed.
  const secretPolicies: Record<string, SecretPolicy> = {};
  for (const input of config.inputs ?? []) {
    if (input.type === "secret" && typeof input.key === "string" && input.key.length > 0) {
      secretPolicies[input.key] = input.secretPolicy === "generate-once" ? "generate-once" : "prompt-on-install";
    }
  }
  // Operator-renamable Worker identity. The release wrangler name is only a
  // publisher default: on install the operator always sets the target name
  // (prefilled from the release), and upgrade means entering an existing name.
  // A declared non-secret `workerName` input adds publisher-side constraints;
  // without one only the Cloudflare-safe baseline applies. Validation is
  // server-side and fail-closed; multi-executable releases keep release names
  // (a flat input cannot address one unit of several).
  const workerNameDecl = (config.inputs ?? []).find((input) => input.type !== "secret" && input.key === "workerName");
  const rawWorkerName = inputs.workerName;
  let workerNameOverride: string | undefined;
  if (rawWorkerName !== undefined) {
    if (typeof rawWorkerName !== "string") return { ok: false, detail: "inputs.workerName must be a string" };
    const validation = workerNameDecl?.validation ?? {};
    if (typeof validation.minLength === "number" && rawWorkerName.length < validation.minLength) return { ok: false, detail: `inputs.workerName is shorter than minLength ${validation.minLength}` };
    if (typeof validation.maxLength === "number" && rawWorkerName.length > validation.maxLength) return { ok: false, detail: `inputs.workerName exceeds maxLength ${validation.maxLength}` };
    if (typeof validation.pattern === "string") {
      let pattern: RegExp;
      try {
        pattern = new RegExp(`^(?:${validation.pattern})$`);
      } catch {
        return { ok: false, detail: "inputs.workerName has an invalid declared pattern" };
      }
      if (!pattern.test(rawWorkerName)) return { ok: false, detail: "inputs.workerName does not satisfy the declared pattern" };
    }
    if (!/^[a-z0-9-]{1,63}$/.test(rawWorkerName)) return { ok: false, detail: "inputs.workerName must match ^[a-z0-9-]{1,63}$" };
    workerNameOverride = rawWorkerName;
  }
  const executableIds = declared.length ? declared.filter((unit) => unit.kind !== "resources").map((unit) => unit.id) : ["main"];
  // The override addresses worker-kind units only, so a worker+pages(+resources)
  // release is unambiguous as long as it carries exactly one worker. Two or
  // more workers (or none) keep release names instead of failing late at plan.
  const workerExecutableIds = executableIds.filter((unitId) => ((byId.get(unitId)?.canonicalWrangler ?? {}) as { kind?: unknown }).kind === "worker");
  if (workerNameOverride !== undefined && workerExecutableIds.length !== 1) return { ok: false, detail: "inputs.workerName requires exactly one worker unit" };
  for (const unitId of executableIds) {
    const unit = byId.get(unitId);
    if (!unit || !unit.canonicalWrangler || !unit.wranglerPath || !unit.wranglerSha256 || !unit.wranglerEffectiveHash) return { ok: false, detail: `missing prepared executable unit ${unitId}` };
    const wrangler = unit.canonicalWrangler as Record<string, unknown>;
    const kind = wrangler.kind;
    // Operator rename (validated above): worker-kind only. Pages project names
    // stay release-declared.
    const name = kind === "worker" && workerNameOverride !== undefined ? workerNameOverride : wrangler.name;
    if ((kind !== "worker" && kind !== "pages") || typeof name !== "string" || !Array.isArray(unit.modules) || !Array.isArray(unit.assets)) return { ok: false, detail: `invalid prepared unit ${unitId}` };
    if (kind === "worker" && !unit.mainModule) return { ok: false, detail: `prepared Worker ${unitId} has no main module` };
    const create = (resourceKind: string, resourceName: string) => !declared.some((candidate) => candidate.kind === "resources" && candidate.resources?.some((resource) => resource.kind === resourceKind && resource.name === resourceName));
    const array = (key: string): Record<string, unknown>[] => Array.isArray(wrangler[key]) ? wrangler[key] as Record<string, unknown>[] : [];
    // rate limits are Worker version metadata bindings only — never
    // account/zone rule provisioning. Validate the official binding contract
    // here (before any provider read) and carry the exact entries through the
    // wrangler echo for the version upload.
    const ratelimits: Array<{ name: string; namespace_id: string; limit: number; period: number }> = [];
    for (const entry of array("ratelimits")) {
      if (typeof entry.name !== "string" || typeof entry.namespace_id !== "string" || typeof entry.limit !== "number" || typeof entry.period !== "number") {
        return { ok: false, detail: `invalid ratelimits entry for unit ${unitId}` };
      }
      ratelimits.push({ name: entry.name, namespace_id: entry.namespace_id, limit: entry.limit, period: entry.period });
    }
    try {
      planRateLimitBindings(ratelimits, []);
    } catch (error) {
      return { ok: false, detail: `invalid ratelimits for unit ${unitId}: ${error instanceof Error ? error.message : String(error)}` };
    }
    // queues are normalized from wrangler `queueProducers`/`queueConsumers`
    // (never a raw `queues: []`). A producer binds in the Worker version; a
    // consumer registers a provider trigger on the queue's consumers
    // subresource, so it carries its declared settings and an explicit per-queue
    // role. `create` is allowed only when no resource-only unit already
    // guarantees the queue by name.
    const queueProducers = array("queueProducers").flatMap((entry) => typeof entry.binding === "string" && typeof entry.queue === "string" ? [{ binding: entry.binding, queue: entry.queue }] : []);
    const queueConsumers = array("queueConsumers").flatMap((entry) => {
      if (typeof entry.queue !== "string") return [];
      return [{
        queue: entry.queue,
        type: "worker" as const,
        ...(typeof entry.max_batch_size === "number" ? { max_batch_size: entry.max_batch_size } : {}),
        ...(typeof entry.max_batch_timeout === "number" ? { max_batch_timeout: entry.max_batch_timeout } : {}),
        ...(typeof entry.max_retries === "number" ? { max_retries: entry.max_retries } : {}),
        ...(typeof entry.max_concurrency === "number" ? { max_concurrency: entry.max_concurrency } : entry.max_concurrency === null ? { max_concurrency: null } : {}),
        ...(typeof entry.retry_delay === "number" ? { retry_delay: entry.retry_delay } : {}),
        ...(typeof entry.dead_letter_queue === "string" ? { dead_letter_queue: entry.dead_letter_queue } : {}),
      }];
    });
    const consumerByQueue = new Map(queueConsumers.map((consumer) => [consumer.queue, consumer]));
    const producerQueues = new Set(queueProducers.map((producer) => producer.queue));
    const queueSpecs: DeploySpec["cloudflare"]["queues"] = [
      ...queueProducers.map((producer) => ({
        binding: producer.binding,
        queueName: producer.queue,
        createIfMissing: create("queue", producer.queue),
        role: (consumerByQueue.has(producer.queue) ? "both" : "producer") as "producer" | "both",
        ...(consumerByQueue.has(producer.queue) ? { consumer: consumerByQueue.get(producer.queue) } : {}),
      })),
      ...queueConsumers.flatMap((consumer) => producerQueues.has(consumer.queue) ? [] : [{
        queueName: consumer.queue,
        createIfMissing: create("queue", consumer.queue),
        role: "consumer" as const,
        consumer,
      }]),
    ];
    // workflows are normalized through the shared carrier planner
    // (never a raw `workflows: []`). A definition declared by another Worker
    // (`script_name`) fails closed before any provider read; an own-script
    // definition carries its exact version-metadata binding plus the full
    // declared direct schedule set, which is applied through the Workflows API
    // after the carrier version is active. The 2026 class-keyed `exports`
    // declaration has no TapDeploy path — the wrangler parser refuses it.
    const rawWorkflows = array("workflows");
    const parsedWorkflows: WranglerV3Workflow[] = rawWorkflows.flatMap((entry) => {
      if (typeof entry.name !== "string" || typeof entry.binding !== "string" || typeof entry.class_name !== "string") return [];
      return [{
        name: entry.name,
        binding: entry.binding,
        class_name: entry.class_name,
        ...(typeof entry.script_name === "string" ? { script_name: entry.script_name } : {}),
        ...(Array.isArray(entry.schedules) ? { schedules: entry.schedules.filter((value): value is string => typeof value === "string") } : {}),
      }];
    });
    if (parsedWorkflows.length !== rawWorkflows.length) return { ok: false, detail: `invalid workflows entry for unit ${unitId}` };
    if (kind === "pages" && parsedWorkflows.length > 0) return { ok: false, detail: `unit ${unitId}: workflows require a Worker carrier; a Pages release cannot host a Workflow definition` };
    const workflowNames = new Set<string>();
    for (const workflow of parsedWorkflows) {
      if (workflowNames.has(workflow.name)) return { ok: false, detail: `unit ${unitId}: workflow name "${workflow.name}" is declared more than once; Workflow names are unique per account` };
      workflowNames.add(workflow.name);
    }
    // durable object bindings + migrations are normalized here (shape is
    // re-checked defensively although the parser validated it) and planned
    // through the shared carrier planner. A Pages release cannot host a DO
    // (prepare already refuses; this is defense in depth).
    const rawDurableObjects = Array.isArray(wrangler.durableObjects) ? wrangler.durableObjects : [];
    const parsedDurableObjects: WranglerV3DurableObjectBinding[] = [];
    for (const entry of rawDurableObjects) {
      if (typeof entry !== "object" || entry === null) return { ok: false, detail: `invalid durable_objects entry for unit ${unitId}` };
      const record = entry as Record<string, unknown>;
      if (typeof record["name"] !== "string" || typeof record["class_name"] !== "string") return { ok: false, detail: `invalid durable_objects entry for unit ${unitId}` };
      parsedDurableObjects.push({
        name: record["name"],
        class_name: record["class_name"],
        ...(typeof record["script_name"] === "string" ? { script_name: record["script_name"] } : {}),
        ...(typeof record["environment"] === "string" ? { environment: record["environment"] } : {}),
      });
    }
    const rawMigrations = Array.isArray(wrangler.migrations) ? wrangler.migrations : [];
    const parsedMigrations: WranglerV3Migration[] = [];
    for (const entry of rawMigrations) {
      if (typeof entry !== "object" || entry === null) return { ok: false, detail: `invalid migrations entry for unit ${unitId}` };
      const record = entry as Record<string, unknown>;
      if (typeof record["tag"] !== "string") return { ok: false, detail: `invalid migrations entry for unit ${unitId}` };
      const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
      const migration: WranglerV3Migration = { tag: record["tag"] };
      for (const key of ["new_classes", "new_sqlite_classes", "deleted_classes"] as const) {
        const value = record[key];
        if (value === undefined) continue;
        if (!stringArray(value)) return { ok: false, detail: `invalid migrations entry for unit ${unitId}` };
        migration[key] = value;
      }
      if (record["renamed_classes"] !== undefined) {
        if (!Array.isArray(record["renamed_classes"])) return { ok: false, detail: `invalid migrations entry for unit ${unitId}` };
        migration.renamed_classes = record["renamed_classes"] as WranglerV3Migration["renamed_classes"];
      }
      parsedMigrations.push(migration);
    }
    if (kind === "pages" && (parsedDurableObjects.length > 0 || parsedMigrations.length > 0)) return { ok: false, detail: `unit ${unitId}: durable objects require a Worker carrier; a Pages release cannot host a Durable Object` };
    // wrangler routes convert to explicit zone-scoped workers-route
    // domain entries — the original Wrangler declaration stays the source of
    // truth; no TapDeploy domain DSL is introduced. Strict and narrow:
    // - custom_domain routes are not zone routes (hostname ownership is a
    //   different verification surface): refused, never partially applied;
    // - every pattern needs an explicit zone_name. Zones are resolved by name
    //   against the live snapshot and an explicit zone_id is cross-checked;
    //   a zone_id alone is not trusted and hostname inference is refused;
    // - duplicate patterns refused; pages units refuse routes outright.
    // updateAction stays "preserve": absent patterns are created (add-only);
    // an existing pattern is left untouched and verified, never rewritten —
    // a foreign-routed pattern fails closed at the step with zero writes.
    const rawRoutes = array("routes");
    const routeSpecs: DomainEntrySpec[] = [];
    if (kind === "pages" && rawRoutes.length > 0) return { ok: false, detail: `unit ${unitId}: routes require a Worker carrier; a Pages release cannot declare routes` };
    const routePatterns = new Set<string>();
    for (const entry of rawRoutes) {
      const pattern = typeof entry.pattern === "string" ? entry.pattern : undefined;
      if (!pattern) return { ok: false, detail: `invalid routes entry for unit ${unitId}` };
      if (entry.custom_domain === true) return { ok: false, detail: `unit ${unitId}: custom-domain route "${pattern}" is not a zone-scoped route; custom hostnames are refused` };
      if (typeof entry.zone_name !== "string" || entry.zone_name.length === 0) return { ok: false, detail: `unit ${unitId}: route "${pattern}" declares no zone; declare zone_name explicitly (no zone inference, no zone_id-only routes)` };
      if (routePatterns.has(pattern)) return { ok: false, detail: `unit ${unitId}: route pattern "${pattern}" is declared more than once` };
      routePatterns.add(pattern);
      routeSpecs.push({
        kind: "workers-route",
        hostname: pattern,
        zoneName: entry.zone_name as string,
        ...(typeof entry.zone_id === "string" ? { zoneId: entry.zone_id as string } : {}),
        updateAction: "preserve",
      });
    }
    const doBindingNames = new Set<string>();
    for (const durableObject of parsedDurableObjects) {
      if (doBindingNames.has(durableObject.name)) return { ok: false, detail: `unit ${unitId}: durable object binding "${durableObject.name}" is declared more than once; binding names must be unique in the version metadata` };
      doBindingNames.add(durableObject.name);
    }
    const carrier = planWranglerCarrierActions(
      { workflows: parsedWorkflows, durableObjects: parsedDurableObjects, migrations: parsedMigrations, services: [] },
      { scriptName: name, verifiedServiceTargets: [] },
    );
    if (!carrier.ok) return { ok: false, detail: `unit ${unitId}: ${carrier.issues.map((issue) => `${issue.code} ${issue.detail}`).join("; ")}` };
    // Durable Object bindings are metadata-only (no plan diffs, like
    // service bindings): the binding rides the atomic version upload and the
    // validated pure new-class migrations ride with it verbatim.
    const durableObjectEcho: NonNullable<DeploySpec["wrangler"]["durableObjects"]> = [];
    for (const durableObject of carrier.plan.durableObjects) {
      durableObjectEcho.push({ name: durableObject.binding, class_name: durableObject.className });
    }
    const migrationEcho: NonNullable<DeploySpec["wrangler"]["migrations"]> = [];
    for (const migration of carrier.plan.migrations) {
      migrationEcho.push({
        tag: migration.tag,
        ...(migration.new_classes !== undefined ? { new_classes: [...migration.new_classes] } : {}),
        ...(migration.new_sqlite_classes !== undefined ? { new_sqlite_classes: [...migration.new_sqlite_classes] } : {}),
      });
    }
    const workflowSpecs: DeploySpec["cloudflare"]["workflows"] = [];
    const workflowEcho: NonNullable<DeploySpec["wrangler"]["workflows"]> = [];
    for (const workflow of carrier.plan.workflows) {
      workflowSpecs.push({
        binding: workflow.binding,
        name: workflow.workflowName,
        className: workflow.className,
        schedules: workflow.schedules,
      });
      workflowEcho.push({
        binding: workflow.binding,
        name: workflow.workflowName,
        class_name: workflow.className,
        ...(workflow.metadata.script_name !== undefined ? { script_name: workflow.metadata.script_name } : {}),
      });
    }
    specs[unitId] = {
      schemaVersion: 1,
      project: { id: config.app.id, version: manifestDigest.slice(0, 16) },
      ...(kind === "worker" ? { worker: { path: unit.mainModule!.path, size: unit.mainModule!.size, sha256: unit.mainModule!.sha256 } } : {}),
      assets: unit.assets,
      inputs,
      cloudflare: {
        workerName: name,
        r2: array("r2Buckets").flatMap((entry) => typeof entry.binding === "string" && typeof entry.bucketName === "string" ? [{ binding: entry.binding, bucketName: entry.bucketName, createIfMissing: create("r2", entry.bucketName) }] : []),
        d1: array("d1Databases").flatMap((entry) => typeof entry.binding === "string" && typeof entry.databaseName === "string" ? [{ binding: entry.binding, databaseName: entry.databaseName, createIfMissing: create("d1", entry.databaseName), ...(typeof entry.databaseId === "string" ? { databaseId: entry.databaseId } : {}) }] : []),
        // the Wrangler KV id is a provider identity claim, never a
        // creation title. It travels as `namespaceId` (verified by id against
        // the fresh snapshot; the live name is resolved into `namespaceName`
        // after snapshot, never invented). Creation from a wrangler binding
        // is always refused; only an explicit resource-only `kv` unit with a
        // real name may provision by name.
        kv: array("kvNamespaces").flatMap((entry) => typeof entry.binding === "string" && typeof entry.namespaceId === "string" ? [{ binding: entry.binding, namespaceName: entry.namespaceId, namespaceId: entry.namespaceId, createIfMissing: false }] : []),
        queues: queueSpecs, workflows: workflowSpecs, domains: routeSpecs,
        // Hyperdrive / Secrets Store ids are claims about the publisher's
        // account: the handle starts as the claimed id and is resolved against
        // the installing account (or the operator's choice) after the snapshot.
        // Nothing here is ever created: a missing config, store or secret
        // blocks the plan. A Vectorize index is created only by a resource-only
        // unit that declares its dimensions and metric.
        hyperdrive: array("hyperdrive").flatMap((entry) => typeof entry.binding === "string" && typeof entry.id === "string" ? [{ binding: entry.binding, configName: entry.id, configId: entry.id, createIfMissing: false }] : []),
        vectorize: array("vectorize").flatMap((entry) => typeof entry.binding === "string" && typeof entry.indexName === "string" ? [{ binding: entry.binding, indexName: entry.indexName, createIfMissing: false }] : []),
        secretsStore: array("secretsStoreSecrets").flatMap((entry) => typeof entry.binding === "string" && typeof entry.storeId === "string" && typeof entry.secretName === "string" ? [{ binding: entry.binding, storeName: entry.storeId, storeId: entry.storeId, createIfMissing: false, secretName: entry.secretName, secretCreateIfMissing: false }] : []),
        runtimeBindings: [
          ...(isBinding(wrangler.ai) ? [{ binding: wrangler.ai.binding, type: "ai" as const }] : []),
          ...(isBinding(wrangler.browser) ? [{ binding: wrangler.browser.binding, type: "browser-rendering" as const }] : []),
        ],
        cron: Array.isArray(wrangler.crons) ? wrangler.crons.filter((value): value is string => typeof value === "string") : [],
        // Config secrets bind to Worker units only: a V3 Pages unit is static
        // (Functions are refused), so a project secret would be inert and was
        // never shown or prompted for.
        secrets: kind === "worker" ? { ...secretPolicies } : {},
        // the provider requires an explicit production branch at project
        // create (Cloudflare 8000033). Prefer the release-declared value;
        // otherwise default to "main" (never silently omitted).
        ...(kind === "pages" ? { pages: { projectName: name, productionBranch: typeof wrangler.production_branch === "string" && wrangler.production_branch ? (wrangler.production_branch as string) : "main" } } : {}),
      },
      wrangler: {
        name, ...(unit.mainModule ? { main: unit.mainModule.path } : {}),
        compatibility_date: wrangler.compatibility_date as string,
        compatibility_flags: wrangler.compatibility_flags as string[],
        ...(typeof wrangler.workers_dev === "boolean" ? { workers_dev: wrangler.workers_dev } : {}),
        r2_buckets: array("r2Buckets").map((entry) => ({ binding: entry.binding as string, bucket_name: entry.bucketName as string })),
        d1_databases: array("d1Databases").map((entry) => ({ binding: entry.binding as string, database_name: entry.databaseName as string })),
        kv_namespaces: array("kvNamespaces").map((entry) => ({ binding: entry.binding as string, id: entry.namespaceId as string })),
        crons: wrangler.crons as string[], vars: wrangler.vars as Record<string, string | number | boolean>,
        ...(ratelimits.length > 0 ? { ratelimits } : {}),
        ...(queueSpecs.length > 0 ? { queues: queueSpecs.map((queue) => ({ ...(queue.binding !== undefined ? { binding: queue.binding } : {}), queue_name: queue.queueName, ...(queue.role !== undefined ? { role: queue.role } : {}) })) } : {}),
        ...(workflowEcho.length > 0 ? { workflows: workflowEcho } : {}),
        ...(durableObjectEcho.length > 0 ? { durableObjects: durableObjectEcho } : {}),
        ...(migrationEcho.length > 0 ? { migrations: migrationEcho } : {}),
        services: array("services").map((entry) => ({ binding: entry.binding as string, service: entry.service as string, ...(typeof entry.entrypoint === "string" ? { entrypoint: entry.entrypoint } : {}) })),
        ...(array("hyperdrive").length > 0 ? { hyperdrive: array("hyperdrive").map((entry) => ({ binding: entry.binding as string, id: entry.id as string })) } : {}),
        ...(array("vectorize").length > 0 ? { vectorize: array("vectorize").map((entry) => ({ binding: entry.binding as string, index_name: entry.indexName as string })) } : {}),
        ...(array("secretsStoreSecrets").length > 0 ? { secrets_store_secrets: array("secretsStoreSecrets").map((entry) => ({ binding: entry.binding as string, store_id: entry.storeId as string, secret_name: entry.secretName as string })) } : {}),
        ...(isBinding(wrangler.ai) ? { ai: [{ binding: wrangler.ai.binding }] } : {}),
        ...(isBinding(wrangler.browser) ? { browser: [{ binding: wrangler.browser.binding }] } : {}),
        ...(kind === "pages" ? { assets: { directory: wrangler.pages_build_output_dir as string } } : wrangler.assets ? { assets: { ...(wrangler.assets as DeploySpec["wrangler"]["assets"]), directory: (wrangler.assets as Record<string, unknown>).directoryPath as string } } : {}),
      }, targetKind: kind === "worker" ? "workers" : "pages",
    };
    bundles[unitId] = {
      schemaVersion: 1, appName: name, targetKind: kind === "worker" ? "workers" : "pages",
      ...(unit.mainModule ? { mainModule: unit.mainModule.path } : {}),
      modules: unit.modules.map((module) => ({ name: module.path, kind: module.mime === "application/wasm" ? "wasm" : "esm", mime: module.mime, size: module.size, sha256: module.sha256 })),
      assets: unit.assets, config: { path: unit.wranglerPath, size: 0, sha256: unit.wranglerSha256 },
      source: { archiveBytes: 0, archiveSha256, manifestDigest }, wranglerEffectiveHash: unit.wranglerEffectiveHash, bundleDigest: unit.bundleDigest,
    };
    proofs[unitId] = unit;
  }
  for (const unit of declared.filter((candidate) => candidate.kind === "resources")) {
    const prepared = byId.get(unit.id);
    if (!prepared || prepared.bundleDigest.length === 0) return { ok: false, detail: `missing prepared resource unit ${unit.id}` };
    proofs[unit.id] = prepared;
  }
  return { ok: true, specs, bundles, proofs };
}


function isUpstreamError(error: unknown): error is CloudflareApiError {
  return typeof error === "object" && error !== null && "kind" in error;
}
