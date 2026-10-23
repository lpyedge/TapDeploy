// Read-only deploy planning. Produces a normalized diff and guard list from the
// release spec, operator inputs and an actual remote snapshot. Unsafe targets
// and unclear resources always abort (blocked plan) — nothing is written from
// this module. Secret values are never part of any plan output.

import type { ProjectionIssue } from "./types.js";
import {
  bundleProofMaterial,
  computeGraphPlanDigest,
  computePlanDigest,
  resolveActiveOwnership,
  type GraphPlanActiveSecretProof,
  type GraphPlanResourceIdentity,
  type GraphPlanSyntheticTarget,
} from "./digest.js";
import type {
  DeployPlan,
  ExpectedTarget,
  PlanGuard,
  PlanInput,
  PlanResource,
  ResourceDiff,
  TargetSnapshot,
} from "./types.js";
import type { DeploySpec } from "../deploy-spec.js";
import { domainBaseline, planReference, resourceBaselineDrift } from "./drift.js";
import { canonicalJson } from "./digest.js";
import { resourceCapabilityIssues } from "../deploy/resource-validation.js";
import {
  authorizeGraphIntent,
  type GraphIntentAuthorization,
} from "../config-envelope.js";
import { planDomainGuards } from "./plan-domains.js";
import { planWorkerResources } from "./worker-resource-planners.js";
import { unsupportedGraphDiffs } from "./graph-operation-support.js";
import type {
  DeploymentGraph,
  GraphGuard,
  GraphIdentityKind,
  GraphUnit,
  GraphUnitKind,
} from "./deploy-graph.js";
import type { UnitResourceKind } from "./deployment-units.js";
import type { DeployBundle } from "../../release/deploy-bundle.js";

export interface BuildPlanOptions {
  salt: string;
  // A frozen baseline (the reference of an approved plan) the live state is
  // compared with: any difference is drift.
  expected?: ExpectedTarget;
  // What the operator asked for when planning (not a baseline, never drift).
  intent?: { targetKind?: "workers" | "pages" };
  // Graph resource ids (`<kind>:<name>`) another unit of the same release
  // creates: a missing one here is that unit's create, not a conflict.
  providedByOtherUnits?: ReadonlySet<string>;
}

export async function buildDeployPlan(
  input: PlanInput,
  snapshot: TargetSnapshot,
  opts: BuildPlanOptions,
): Promise<DeployPlan> {
  const spec = input.spec;
  const providedElsewhere = (kind: string, name: string) => opts.providedByOtherUnits?.has(`${kind}:${name}`) === true;
  // The binding waits for the creating unit's receipt; nothing is written here.
  const providedSkip = (resource: PlanResource, name: string): ResourceDiff => ({ resource, action: "skip", name, detail: "created by another unit of this release before this unit deploys" });

  if (!spec || (input.projectionIssues?.length ?? 0) > 0) {
    return blockedPlan(snapshot, input.projectionIssues ?? [], opts.salt);
  }

  const guards: PlanGuard[] = [];
  for (const detail of resourceCapabilityIssues(spec, snapshot, opts.providedByOtherUnits)) guards.push({ code: "contradictory-manifest", level: "block", detail });
  const diffs: ResourceDiff[] = [];

  if (!snapshot.accountId) {
    guards.push({
      code: "missing-account",
      level: "block",
      detail: "No account is bound to the session",
    });
  }

  const expected = opts.expected;
  if (expected) for (const detail of resourceBaselineDrift(expected, snapshot)) guards.push({ code: "remote-drift", level: "block", detail });
  if (expected?.domainBaseline && canonicalJson(expected.domainBaseline) !== canonicalJson(domainBaseline(snapshot, expected.domainBaseline.names))) {
    guards.push({ code: "domain-drift", level: "block", detail: "approved domain/route/DNS identity or configuration changed; no mutation permitted" });
  }
  if (expected?.accountId && snapshot.accountId && expected.accountId !== snapshot.accountId) {
    guards.push({
      code: "wrong-account",
      level: "block",
      detail: `Plan was bound to account ${expected.accountId} but the session is bound to ${snapshot.accountId}`,
    });
  }

  // a plan built for one target kind must not be replayed against a
  // different kind. E.g. a Workers plan cannot be re-confirmed as a Pages deploy.
  // Skip when the release itself targets Pages (handled in buildPagesDeployPlan).
  const askedKind = opts.intent?.targetKind ?? expected?.targetKind;
  if (spec.targetKind !== "pages" && askedKind && askedKind !== "workers") {
    guards.push({
      code: "wrong-target-kind",
      level: "block",
      detail: `Plan was bound to target kind "${askedKind}" but this release targets Workers`,
    });
  }

  // a Pages release plans through its own path (Pages project + deployment),
  // never the Workers scripts/versions plan. It shares the read-only planning
  // contract (diffs/guards/digest) but the resource families differ.
  if (spec.targetKind === "pages") {
    return buildPagesDeployPlan({ spec }, snapshot, opts, guards);
  }

  const isInstall = !snapshot.workerExists;
  if (spec.assets.some(asset => !asset.workersHash || !/^[0-9a-f]{32}$/.test(asset.workersHash))) guards.push({ code: "contradictory-manifest", level: "block", detail: "Worker static assets require approved official workersHash values; integrity SHA alone cannot identify provider uploads" });
  // ownership is bound to the specific project identity AND
  // resolved only against the ACTUALLY ACTIVE deployment version(s) that are
  // serving traffic. A historical version's marker is an assertion about the
  // past, not evidence that the current deployment belongs to this project.
  // An unresolvable (no active deployment) or split active version set, an
  // unmanaged worker, or a worker managed by another project all fail closed
  // (wrong-project-owner / unrelated-worker) rather than being silently adopted.
  if (!isInstall) {
    const ownership = resolveActiveOwnership(
      snapshot.versions,
      snapshot.activeDeploymentVersionIds ?? [],
      spec.project.id,
    );
    if (!ownership.owned) {
      guards.push({ code: "unrelated-worker", level: "block", detail: ownership.detail });
    }
  }

  if (expected && !isInstall && expected.activeDeploymentId !== snapshot.activeDeploymentId) {
    guards.push({
      code: "remote-drift",
      level: "block",
      detail: "Remote active deployment changed since the plan was created; re-plan before writing",
    });
  }

  if (
    expected &&
    !isInstall &&
    expected.latestVersionId !== undefined &&
    expected.latestVersionId !== snapshot.latestVersionId
  ) {
    guards.push({
      code: "stale-deployed-version",
      level: "block",
      detail: "Remote latest version changed; the plan is based on a stale deployed version",
    });
  }

  // Worker + static assets + deployment
  if (isInstall) {
    diffs.push({ resource: "worker", action: "create", name: spec.cloudflare.workerName });
    if (spec.assets.length > 0) {
      diffs.push({ resource: "static-assets", action: "create", name: spec.cloudflare.workerName });
    }
    diffs.push({ resource: "deployment", action: "create", name: spec.cloudflare.workerName });
  } else {
    diffs.push({ resource: "worker", action: "update", name: spec.cloudflare.workerName });
    if (spec.assets.length > 0) {
      diffs.push({ resource: "static-assets", action: "update", name: spec.cloudflare.workerName });
    }
    diffs.push({
      resource: "deployment",
      action: "create",
      name: spec.cloudflare.workerName,
      before: snapshot.activeDeploymentId,
    });
  }
  // explicit workers.dev intent. Only a declared `true` plans an enable
  // action (idempotent at the step: no write when already on, verified URL in
  // both cases). `false`/absent plans nothing: an externally-managed exposed
  // Worker is never disabled or hijacked, and nothing is auto-exposed.
  if (spec.wrangler.workers_dev === true) {
    diffs.push({ resource: "workers-dev", action: "create", name: spec.cloudflare.workerName });
  }

  const secretSummary = planWorkerResources({ spec, snapshot, expected, isInstall, providedElsewhere, providedSkip, diffs, guards });

  const digest = await computePlanDigest(
    {
      spec,
      accountId: snapshot.accountId,
      workerName: spec.cloudflare.workerName,
      activeDeploymentId: snapshot.activeDeploymentId,
      diffSummary: diffs.map((d) => ({
        resource: d.resource,
        action: d.action,
        name: d.name,
      })),
      inputs: spec.inputs,
    },
    opts.salt,
  );

  return {
    kind: isInstall ? "install" : "upgrade",
    accountId: snapshot.accountId,
    workerName: spec.cloudflare.workerName,
    projectId: spec.project.id,
    projectVersion: spec.project.version,
    activeDeploymentId: snapshot.activeDeploymentId,
    diffs,
    guards,
    secretSummary,
    digest,
    blocked: guards.some((g) => g.level === "block"),
    targetKind: "workers",
  };
}

// Pages direct-upload plan. A Pages release has no worker module; it plans
// a Pages project (create on install / preserve on upgrade) and a deployment
// create. The project name is the target identity; the active deployment id is
// the drift reference. Ownership on upgrade is the operator's explicit selection
// of an existing project. Cron schedules and Workers rate-limit bindings
// are rejected before mutation.
async function buildPagesDeployPlan(
  input: PlanInput,
  snapshot: TargetSnapshot,
  opts: BuildPlanOptions,
  guards: PlanGuard[],
): Promise<DeployPlan> {
  const spec = input.spec!;
  const projectName = spec.cloudflare.pages?.projectName ?? spec.cloudflare.workerName;
  const isInstall = !snapshot.pagesProjectExists;
  const diffs: ResourceDiff[] = [];
  if (!isInstall && (!snapshot.pagesProjectId || snapshot.pagesOwnerProjectId !== spec.project.id)) {
    guards.push({ code: "wrong-project-owner", level: "block", detail: "Existing Pages project is unmarked or belongs to another TapDeploy project; automatic adoption is disabled" });
  }

  // Pages secrets map to env_vars.secret_text; Cron remains Worker-only.
  if (spec.cloudflare.cron.length > 0) {
    guards.push({
      code: "unsupported-pages-resource",
      level: "block",
      detail: "Cron schedules are not supported for a Pages deployment",
    });
  }

  const expected = opts.expected;
  if (expected?.pagesProjectId && expected.pagesProjectId !== snapshot.pagesProjectId) {
    guards.push({ code: "remote-drift", level: "block", detail: "Selected immutable Pages project identity changed" });
  }
  const askedKind = opts.intent?.targetKind ?? expected?.targetKind;
  if (askedKind && askedKind !== "pages") {
    guards.push({
      code: "wrong-target-kind",
      level: "block",
      detail: `Plan was bound to target kind "${askedKind}" but this release targets Pages`,
    });
  }
  if (expected?.accountId && snapshot.accountId && expected.accountId !== snapshot.accountId) {
    guards.push({
      code: "wrong-account",
      level: "block",
      detail: `Plan was bound to account ${expected.accountId} but the session is bound to ${snapshot.accountId}`,
    });
  }

  // a silent outside deploy between plan and write is detected as drift.
  if (
    expected &&
    !isInstall &&
    expected.activeDeploymentId !== undefined &&
    expected.activeDeploymentId !== snapshot.pagesActiveDeploymentId
  ) {
    guards.push({
      code: "remote-drift",
      level: "block",
      detail: "Remote Pages deployment changed since the plan was created; re-plan before writing",
    });
  }

  if (isInstall) {
    diffs.push({ resource: "pages-project", action: "create", name: projectName });
  } else {
    diffs.push({
      resource: "pages-project",
      action: "preserve",
      name: projectName,
      before: snapshot.pagesActiveDeploymentId,
    });
  }
  diffs.push({
    resource: "deployment",
    action: isInstall ? "create" : "create",
    name: projectName,
    ...(isInstall ? {} : { before: snapshot.pagesActiveDeploymentId }),
  });
  if (spec.assets.length > 0) {
    diffs.push({ resource: "static-assets", action: isInstall ? "create" : "update", name: projectName });
  }
  const domains = spec.cloudflare.domains ?? [];
  if (domains.length > 0) {
    guards.push(...planDomainGuards(diffs, domains, snapshot, projectName));
  }

  const digest = await computePlanDigest(
    {
      spec,
      accountId: snapshot.accountId,
      workerName: projectName,
      activeDeploymentId: snapshot.pagesActiveDeploymentId,
      diffSummary: diffs.map((d) => ({ resource: d.resource, action: d.action, name: d.name })),
      inputs: spec.inputs,
    },
    opts.salt,
  );

  return {
    kind: isInstall ? "install" : "upgrade",
    accountId: snapshot.accountId,
    workerName: projectName,
    projectId: spec.project.id,
    projectVersion: spec.project.version,
    activeDeploymentId: snapshot.pagesActiveDeploymentId,
    ...(!isInstall && snapshot.pagesProjectId ? { pagesProjectId: snapshot.pagesProjectId } : {}),
    diffs,
    guards,
    secretSummary: Object.entries(spec.cloudflare.secrets).map(([name, policy]) => ({ name, policy, exists: snapshot.secretNames.includes(name) })),
    digest,
    blocked: guards.some((g) => g.level === "block"),
    targetKind: "pages",
  };
}

function blockedPlan(
  snapshot: TargetSnapshot,
  issues: ProjectionIssue[],
  salt: string,
): DeployPlan {
  const guard: PlanGuard = {
    code: "contradictory-manifest",
    level: "block",
    detail: issues.length > 0
      ? `Manifest conflicts: ${issues.map((i) => `${i.kind}:${i.field}`).join("; ")}`
      : "Manifest could not be projected",
  };  return {
    kind: "blocked",
    accountId: snapshot.accountId,
    workerName: "",
    projectId: "",
    projectVersion: "",
    diffs: [],
    guards: [guard],
    secretSummary: [],
    digest: `blocked:${salt}`,
    blocked: true,
    targetKind: "workers",
  };
}

// ---------------------------------------------------------------------------
// multi-unit graph plan.
//
// `buildDeployPlan` plans ONE release. A multi-unit release is a DeploymentGraph
//: every unit is planned against its OWN live resource/active-state
// snapshot, the graph's structural guards are surfaced as blocking guards, the
// server re-verifies that the declared TapDeploy capabilities cover what the ACTUAL
// Wrangler config + install policy resolve to, and the paid-risk/destructive/
// unsupported posture is evaluated BEFORE any write. The whole graph is then
// bound into one plan digest (see computeGraphPlanDigest).
//
// Fail-closed rules (all `block`):
//   - the graph is not executable (cycle/duplicate/cross-account/contention…)
//   - a unit's snapshot or normalized spec is missing
//   - a unit snapshot belongs to a different account
//   - the declared capabilities do not cover the resolved set (developer error)
//   - a destructive (delete/overwrite) operation would run
//   - a metered operation has unknown cost / lacks explicit confirmation
//   - a required bundle is missing or targets the wrong kind
// A partial graph is never an atomic transaction: nothing here deletes or rolls
// back another unit's existing resources; the caller re-plans from live state.
// ---------------------------------------------------------------------------

export type GraphPlanGuardCode =
  | "graph-blocked"
  | "unit-blocked"
  | "scope-underdeclared"
  | "unknown-capability"
  | "unknown-cost"
  | "paid-risk-unconfirmed"
  | "destructive-operation"
  | "unsupported-operation"
  | "wrong-account"
  | "snapshot-missing"
  | "bundle-missing"
  | "bundle-mismatch";

export interface GraphPlanGuard {
  code: GraphPlanGuardCode;
  level: "block" | "warn";
  detail: string;
  unitId?: string;
}

export interface GraphPlanCostOperation {
  unitId: string;
  resource: string;
  action: string;
  name?: string;
}

export interface GraphPlanCost {
  operations: GraphPlanCostOperation[];
  requiresConfirmation: boolean;
  confirmed: boolean;
  blockedUnknownCost: boolean;
}

export interface GraphPlanUnitPlan {
  unitId: string;
  kind: GraphUnitKind;
  identity: GraphIdentityKind;
  name: string;
  requiresBundle: boolean;
  /** The normalized per-unit plan for a Worker/Pages unit; null for resource-only. */
  plan: DeployPlan | null;
  diffs: ResourceDiff[];
  guards: PlanGuard[];
  resourceIdentities: GraphPlanResourceIdentity[];
  /** Synthetic (planned) provider targets; never a live readback. */
  targets: GraphPlanSyntheticTarget[];
  /** Secrets proven present on this unit's ACTIVE deployment at plan time. */
  activeSecretProof: GraphPlanActiveSecretProof[];
}

export interface GraphDeployPlan {
  ok: boolean;
  blocked: boolean;
  accountId: string;
  configHash: string;
  requiresBundle: boolean;
  bundleDigest: string | null;
  units: GraphPlanUnitPlan[];
  guards: GraphPlanGuard[];
  /** Raw structural graph guards, kept for traceability. */
  graphGuards: GraphGuard[];
  cost: GraphPlanCost;
  scopeCoverage: GraphIntentAuthorization;
  digest: string;
  targets: GraphPlanSyntheticTarget[];
  activeSecretProof: GraphPlanActiveSecretProof[];
  resourceIdentities: GraphPlanResourceIdentity[];
}

export interface GraphCostPolicy {
  mode?: "free-preferred" | "block-unknown-cost";
  requireExplicitPaidConfirmation?: boolean;
}

export interface GraphDeployPlanInput {
  graph: DeploymentGraph;
  /** The one-shot authorized account this release runs as. */
  accountId: string;
  /** Canonical Config V3 hash sealed into the session. */
  configHash: string;
  /** One live resource/active-state snapshot per unit id. */
  snapshots: Readonly<Record<string, TargetSnapshot>>;
  /** Normalized per-unit specs (worker/pages units); resource-only units carry none. */
  specs: Readonly<Record<string, DeploySpec>>;
  /** bundle proof; required when the graph has a bundle-consuming unit. */
  bundle?: DeployBundle | null;
  /**
   * Server-derived bundle proofs for a prepared multi-unit release.  This is
   * intentionally a map keyed by unit id: a graph must never use one unit's
   * artifact identity to authorize another unit.
   */
  bundles?: Readonly<Record<string, DeployBundle>>;
  /** Symbolic capabilities declared by the Config V3 envelope. */
  declaredCapabilities: readonly string[];
  /** Symbolic capabilities the ACTUAL release resolves to (server-derived). */
  resolvedCapabilities: readonly string[];
  /** Install-policy kinds present (each maps to a required capability). */
  installPolicies?: readonly string[];
  costPolicy?: GraphCostPolicy;
  paidRiskConfirmed?: boolean;
  /** Per-unit drift reference (from an approved plan). */
  expected?: Readonly<Record<string, ExpectedTarget>>;
  intent?: { targetKind?: "workers" | "pages" };
}

export interface GraphDeployPlanOptions {
  salt: string;
}

const DEFAULT_GRAPH_COST_POLICY: Required<GraphCostPolicy> = {
  mode: "free-preferred",
  requireExplicitPaidConfirmation: true,
};

const GRAPH_METERED_RESOURCE_KINDS: ReadonlySet<string> = new Set([
  "r2",
  "d1",
  "kv",
  "queue",
  "hyperdrive",
  "vectorize",
  "secrets-store",
]);

const GRAPH_METERED_ACTIONS: ReadonlySet<string> = new Set(["create", "update", "attach"]);

const GRAPH_DESTRUCTIVE_ACTIONS: ReadonlySet<string> = new Set(["conflict", "detach"]);

// The one removal the operator can request: unbinding a custom domain from its
// own unit on upgrade (an explicit choice in the plan request, re-verified at
// the step). Every other detach stays a blocking destructive operation.
const OPERATOR_REMOVABLE_RESOURCES: ReadonlySet<string> = new Set(["worker-custom-domain", "pages-custom-domain"]);

const GRAPH_PLAN_RESOURCE_KINDS: ReadonlySet<string> = new Set([
  "r2",
  "d1",
  "kv",
  "queue",
  "hyperdrive",
  "vectorize",
  "secrets-store",
]);

function inventoryFor(
  snapshot: TargetSnapshot | undefined,
  kind: UnitResourceKind,
): { name: string; id: string }[] {
  if (!snapshot) {
    return [];
  }
  switch (kind) {
    case "r2":
      return snapshot.r2Buckets;
    case "d1":
      return snapshot.d1Databases;
    case "kv":
      return snapshot.kvNamespaces;
    case "queue":
      return snapshot.queues;
    case "hyperdrive":
      return snapshot.hyperdriveConfigs;
    case "vectorize":
      return snapshot.vectorizeIndexes;
    case "secrets-store":
      return snapshot.secretsStores;
    default:
      return [];
  }
}

function driftGuardCodeFor(kind: UnitResourceKind): PlanGuard["code"] {
  switch (kind) {
    case "r2":
      return "r2-drift";
    case "d1":
      return "d1-drift";
    case "kv":
      return "kv-drift";
    case "queue":
      return "queue-drift";
    case "hyperdrive":
      return "hyperdrive-drift";
    case "vectorize":
      return "vectorize-drift";
    case "secrets-store":
      return "secrets-store-drift";
    default:
      return "contradictory-manifest";
  }
}

// Resource identities the approved plan resolves: preserved resources carry the
// live provider id (proof of the current mapping); planned creates carry the
// planned name only. Sorted by node id for a deterministic digest.
function resourceIdentitiesForPlan(plan: DeployPlan): GraphPlanResourceIdentity[] {
  const byId = new Map<string, GraphPlanResourceIdentity>();
  for (const diff of plan.diffs) {
    if (diff.name === undefined) {
      continue;
    }
    const id = `${diff.resource}:${diff.name}`;
    if (diff.action === "preserve" && diff.before !== undefined) {
      byId.set(id, { id, kind: diff.resource, name: diff.name, remoteId: diff.before });
    } else if (diff.action === "create" && !byId.has(id)) {
      byId.set(id, { id, kind: diff.resource, name: diff.name });
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// A resource-only unit carries no Worker/Pages carrier: its plan is derived from
// the graph's resource references and the unit's own account-resource snapshot.
function buildResourceOnlyUnitPlan(
  unit: GraphUnit,
  graph: DeploymentGraph,
  snapshot: TargetSnapshot | undefined,
  input: GraphDeployPlanInput,
  guards: GraphPlanGuard[],
): GraphPlanUnitPlan {
  const diffs: ResourceDiff[] = [];
  const unitGuards: PlanGuard[] = [];
  const resourceIdentities: GraphPlanResourceIdentity[] = [];
  if (snapshot && snapshot.accountId && snapshot.accountId !== input.accountId) {
    guards.push({
      code: "wrong-account",
      level: "block",
      unitId: unit.id,
      detail: `resource-only unit "${unit.id}" was snapshotted from account ${snapshot.accountId} but this release is authorized for ${input.accountId}`,
    });
  }
  for (const resource of graph.resources) {
    const ref = resource.refs.find((candidate) => candidate.unitId === unit.id);
    if (ref === undefined || !GRAPH_PLAN_RESOURCE_KINDS.has(resource.kind)) {
      continue;
    }
    const planResource = resource.kind as PlanResource;
    const name = resource.name;
    const remote =
      name !== undefined
        ? inventoryFor(snapshot, resource.kind).find((item) => item.name === name)
        : undefined;
    if (remote) {
      diffs.push({ resource: planResource, action: "preserve", name, before: remote.id, after: remote.id });
      resourceIdentities.push({ id: resource.id, kind: resource.kind, name, remoteId: remote.id });
    } else if (ref.disposition === "create-if-missing") {
      diffs.push({ resource: planResource, action: "create", name });
      resourceIdentities.push({ id: resource.id, kind: resource.kind, name });
    } else {
      diffs.push({
        resource: planResource,
        action: "conflict",
        name,
        detail: `declared ${resource.kind} "${name ?? resource.id}" does not exist and the unit only binds an existing resource`,
      });
      unitGuards.push({
        code: driftGuardCodeFor(resource.kind),
        level: "block",
        detail: `Declared ${resource.kind} "${name ?? resource.id}" is missing and the unit binds an existing resource`,
      });
    }
  }
  return {
    unitId: unit.id,
    kind: unit.kind,
    identity: unit.identity,
    name: unit.name,
    requiresBundle: false,
    plan: null,
    diffs,
    guards: unitGuards,
    resourceIdentities,
    targets: [],
    activeSecretProof: [],
  };
}

async function buildGraphUnitPlan(
  unit: GraphUnit,
  graph: DeploymentGraph,
  input: GraphDeployPlanInput,
  opts: GraphDeployPlanOptions,
  guards: GraphPlanGuard[],
): Promise<GraphPlanUnitPlan> {
  const snapshot = input.snapshots[unit.id];
  if (unit.kind === "resource-only") {
    return buildResourceOnlyUnitPlan(unit, graph, snapshot, input, guards);
  }
  const spec = input.specs[unit.id];
  if (!snapshot || !spec) {
    guards.push({
      code: "snapshot-missing",
      level: "block",
      unitId: unit.id,
      detail: `unit "${unit.id}" has no ${snapshot ? "normalized spec" : "live snapshot"}; refusing to plan a unit it cannot verify`,
    });
    return {
      unitId: unit.id,
      kind: unit.kind,
      identity: unit.identity,
      name: unit.name,
      requiresBundle: unit.requiresBundle,
      plan: null,
      diffs: [],
      guards: [],
      resourceIdentities: [],
      targets: [],
      activeSecretProof: [],
    };
  }
  if (snapshot.accountId && snapshot.accountId !== input.accountId) {
    guards.push({
      code: "wrong-account",
      level: "block",
      unitId: unit.id,
      detail: `unit "${unit.id}" was snapshotted from account ${snapshot.accountId} but this release is authorized for ${input.accountId}`,
    });
  }
  const expected = input.expected?.[unit.id];
  const providedByOtherUnits = new Set(graph.resources.filter((resource) => resource.creators.some((creator) => creator !== unit.id)).map((resource) => resource.id));
  const plan = await buildDeployPlan({ spec }, snapshot, {
    salt: opts.salt,
    ...(expected !== undefined ? { expected } : {}),
    ...(input.intent !== undefined ? { intent: input.intent } : {}),
    providedByOtherUnits,
  });
  const target: GraphPlanSyntheticTarget = {
    unitId: unit.id,
    identity: unit.identity,
    name: plan.workerName,
    synthetic: true,
  };
  const activeSecretProof: GraphPlanActiveSecretProof[] = plan.secretSummary
    .filter((secret) => secret.exists)
    .map((secret) => ({ unitId: unit.id, name: secret.name, provenActive: true }));
  return {
    unitId: unit.id,
    kind: unit.kind,
    identity: unit.identity,
    name: unit.name,
    requiresBundle: unit.requiresBundle,
    plan,
    diffs: plan.diffs,
    guards: plan.guards,
    resourceIdentities: resourceIdentitiesForPlan(plan),
    targets: [target],
    activeSecretProof,
  };
}

function assessGraphCost(
  units: GraphPlanUnitPlan[],
  input: GraphDeployPlanInput,
): GraphPlanCost {
  const operations: GraphPlanCostOperation[] = [];
  for (const unit of units) {
    for (const diff of unit.diffs) {
      if (
        GRAPH_METERED_RESOURCE_KINDS.has(diff.resource) &&
        GRAPH_METERED_ACTIONS.has(diff.action)
      ) {
        operations.push({
          unitId: unit.unitId,
          resource: diff.resource,
          action: diff.action,
          ...(diff.name !== undefined ? { name: diff.name } : {}),
        });
      }
    }
  }
  const policy: Required<GraphCostPolicy> = {
    ...DEFAULT_GRAPH_COST_POLICY,
    ...(input.costPolicy ?? {}),
  };
  const anyMetered = operations.length > 0;
  return {
    operations,
    requiresConfirmation: anyMetered && policy.requireExplicitPaidConfirmation === true,
    confirmed: input.paidRiskConfirmed === true,
    blockedUnknownCost: anyMetered && policy.mode === "block-unknown-cost",
  };
}

export async function buildGraphDeployPlan(
  input: GraphDeployPlanInput,
  opts: GraphDeployPlanOptions,
): Promise<GraphDeployPlan> {
  const guards: GraphPlanGuard[] = [];
  const graph = input.graph;

  // 1. Structural fail closed: a non-executable graph blocks every unit.
  if (!graph.ok) {
    guards.push({
      code: "graph-blocked",
      level: "block",
      detail: `the deployment graph is not executable (${graph.guards.length} structural guard(s)); no unit may be written`,
    });
  }

  // 2. Server-side capability coverage recheck (developer error, no second OAuth).
  const scopeCoverage = authorizeGraphIntent({
    declaredCapabilities: input.declaredCapabilities,
    resolvedCapabilities: input.resolvedCapabilities,
    ...(input.installPolicies !== undefined ? { installPolicies: input.installPolicies } : {}),
  });
  if (!scopeCoverage.ok) {
    guards.push({
      code:
        scopeCoverage.error === "UNKNOWN_CAPABILITY"
          ? "unknown-capability"
          : "scope-underdeclared",
      level: "block",
      detail:
        scopeCoverage.detail ??
        "the release requires capabilities the config did not declare",
    });
  }

  // 3. Per-unit plans, each against its own snapshot (pure; no provider writes).
  const units: GraphPlanUnitPlan[] = [];
  for (const unit of graph.units) {
    units.push(await buildGraphUnitPlan(unit, graph, input, opts, guards));
  }

  // 4. Unit-level blocks + unsupported operations.
  for (const unit of units) {
    if (unit.plan?.blocked) {
      const reasons = unit.guards
        .filter((guard) => guard.level === "block")
        .map((guard) => `${guard.detail} (${guard.code})`);
      guards.push({
        code: "unit-blocked",
        level: "block",
        unitId: unit.unitId,
        detail: `unit "${unit.unitId}": ${reasons.length > 0 ? reasons.join("; ") : "plan is blocked"}`,
      });
    }
    for (const guard of unit.guards) {
      if (guard.level === "block" && guard.code.startsWith("unsupported-")) {
        guards.push({
          code: "unsupported-operation",
          level: "block",
          unitId: unit.unitId,
          detail: guard.detail,
        });
      }
    }
  }

  // Operation coverage gate: every dispatchable diff must resolve to
  // an exact supported phase sequence in the shared catalog. Unsupported diffs
  // block the plan before any approval is sealed, so no provider write can
  // follow (worker static-assets and secret create/update stay refused until
  // wire their exact phases).
  // A conflict in a unit that is already blocked is explained by that unit's
  // guard; it is not repeated as an unsupported or destructive operation.
  const blockedUnits = new Set(units.filter((unit) => unit.plan?.blocked).map((unit) => unit.unitId));
  const isExplainedConflict = (unitId: string, action: string) => action === "conflict" && blockedUnits.has(unitId);
  for (const bad of unsupportedGraphDiffs(units).filter((diff) => !isExplainedConflict(diff.unitId, diff.action))) {
    guards.push({
      code: "unsupported-operation",
      level: "block",
      unitId: bad.unitId,
      detail: bad.detail,
    });
  }

  // 5. Destructive operations fail closed before any write.
  const destructive = units.flatMap((unit) =>
    unit.diffs
      .filter((diff) => GRAPH_DESTRUCTIVE_ACTIONS.has(diff.action) && !(diff.action === "detach" && OPERATOR_REMOVABLE_RESOURCES.has(diff.resource)) && !isExplainedConflict(unit.unitId, diff.action))
      .map((diff) => ({ unitId: unit.unitId, diff })),
  );
  if (destructive.length > 0) {
    guards.push({
      code: "destructive-operation",
      level: "block",
      detail: `${destructive.length} operation(s) would delete or overwrite an existing resource (${destructive
        .map(({ unitId, diff }) => `${unitId}:${diff.resource}${diff.name !== undefined ? `:${diff.name}` : ""}`)
        .join(", ")}); TapDeploy never auto-deletes or rolls back existing resources`,
    });
  }

  // 6. Paid-risk posture.
  const cost = assessGraphCost(units, input);
  if (cost.blockedUnknownCost) {
    guards.push({
      code: "unknown-cost",
      level: "block",
      detail:
        "the config refuses to authorize a metered operation whose cost cannot be determined; refusing before any write",
    });
  } else if (cost.requiresConfirmation && !cost.confirmed) {
    guards.push({
      code: "paid-risk-unconfirmed",
      level: "block",
      detail:
        "this plan contains metered operations that require an explicit, plan-bound paid-risk confirmation before any write",
    });
  }

  // 7. Bundle binding.
  const bundles = input.bundles ?? (input.bundle ? Object.fromEntries(
    graph.units.filter((unit) => unit.requiresBundle).map((unit) => [unit.id, input.bundle!]),
  ) : {});
  for (const unit of graph.units.filter((candidate) => candidate.requiresBundle)) {
    if (!bundles[unit.id]) {
      guards.push({
        code: "bundle-missing",
        level: "block",
        unitId: unit.id,
        detail: `unit "${unit.id}" needs a server-derived prebuilt bundle proof`,
      });
    }
  }
  for (const unit of graph.units.filter((candidate) => candidate.requiresBundle)) {
    const bundle = bundles[unit.id];
    const expectedKind = unit.identity === "pages-project" ? "pages" : "workers";
    if (bundle && bundle.targetKind !== expectedKind) {
      guards.push({
        code: "bundle-mismatch",
        level: "block",
        unitId: unit.id,
        detail: `unit "${unit.id}" bundle targets ${bundle.targetKind} but needs ${expectedKind}`,
      });
    }
  }

  // 8. Bind the whole graph into one digest.
  const targets = units.flatMap((unit) => unit.targets);
  const activeSecretProof = units.flatMap((unit) => unit.activeSecretProof);
  const resourceIdentities = units
    .flatMap((unit) => unit.resourceIdentities)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const digest = await computeGraphPlanDigest(
    {
      accountId: input.accountId,
      configHash: input.configHash,
        bundle: input.bundle ? bundleProofMaterial(input.bundle) : null,
        unitBundles: Object.entries(bundles)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([unitId, bundle]) => ({ unitId, bundle: bundleProofMaterial(bundle) })),
      units: units.map((unit) => ({
        unitId: unit.unitId,
        kind: unit.kind,
        identity: unit.identity,
        name: unit.name,
        requiresBundle: unit.requiresBundle,
        actions: unit.diffs.map((diff) => ({
          resource: diff.resource,
          action: diff.action,
          ...(diff.name !== undefined ? { name: diff.name } : {}),
        })),
        // bind the complete sorted cron set per unit (nameless diffs
        // alone cannot distinguish two cron sets).
        crons: [...(input.specs[unit.unitId]?.cloudflare.cron ?? [])].sort(),
      })),
      resourceIdentities,
      cost: {
        operations: cost.operations.map((operation) => ({
          resource: operation.resource,
          action: operation.action,
          ...(operation.name !== undefined ? { name: operation.name } : {}),
        })),
        requiresConfirmation: cost.requiresConfirmation,
        blockedUnknownCost: cost.blockedUnknownCost,
      },
      targets,
      activeSecretProof,
    },
    opts.salt,
  );

  const blocked = guards.some((guard) => guard.level === "block");
  return {
    ok: !blocked,
    blocked,
    accountId: input.accountId,
    configHash: input.configHash,
    requiresBundle: graph.requiresBundle,
    bundleDigest: graph.bundleDigest,
    units,
    guards,
    graphGuards: graph.guards,
    cost,
    scopeCoverage,
    digest,
    targets,
    activeSecretProof,
    resourceIdentities,
  };
}

// The per-unit drift references of an approved graph plan: each Worker/Pages
// unit's `planReference` is compared against a fresh snapshot before any write
// (detectGraphDrift in drift.ts). Resource-only units have no carrier drift
// reference; their resource identities are bound into the plan digest instead.
export function graphPlanReferences(plan: GraphDeployPlan): Record<string, ExpectedTarget> {
  const references: Record<string, ExpectedTarget> = {};
  for (const unit of plan.units) {
    if (unit.plan) {
      references[unit.unitId] = planReference(unit.plan);
    }
  }
  return references;
}
