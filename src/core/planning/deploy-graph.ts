// Multi-unit deployment DAG.
//
// A release is modeled as `DeploymentGraph { units, resources, bindings,
// triggers, exposures, dependencies, bundleDigest }`: independent units
// (worker / pages-static / pages-functions / resource-only) with account
// resources beside them — never a Workers/Pages HTTP service as the graph root.
// This module composes the single-target resolver
// (`resolveDeploymentUnits`) into that graph:
//
//   - TapDeploy `units[]` is opt-in. Without it a single-Wrangler release yields one
//     implicit unit (`DEFAULT_V3_UNIT_ID`) whose node equals the resolver
//     classification.
//   - Cross-unit edges that are derivable are derived: creator-first ordering
//     for a shared resource, and service bindings whose target resolves to a
//     unit identity of this release. Only non-derivable cross-unit ordering
//     needs config `dependsOn`.
//   - A release whose units are all resource-only forms a plan with
//     `requiresBundle=false`: ZIP/bundle selection is skipped, but the source
//     model keeps exactly the two modes (URL ZIP / local ZIP) — no third mode
//     is invented for it.
//   - Fail closed before any provider write: cycles, duplicate ids / wrangler
//     paths / identities, cross-account references and unauthorized contention
//     for the same resource BLOCK the graph. This module performs no provider
//     calls, no network and no secret reads (policies only, never values).
//   - The plan is not an atomic multi-target transaction: the graph carries an
//     explicit partial progress table (one state per unit) so partial
//     completion is tracked and resumed from live state without ever rolling
//     back another unit's existing resources.
//
// Node id scoping: account resources keep the canonical resolver ids
// (`r2:<name>`, `queue:<name>`, …) because the name identifies one account
// entity; unit-local nodes (runtime bindings, secret policies, triggers) are
// scoped as `<unitId>/<baseId>` because the same name in two units is not the
// same entity.

import type { ConfigDomainKind, DeploySpec, DomainUpdateAction, QueueRole, SecretPolicy } from "../deploy-spec.js";
import { DEFAULT_V3_UNIT_ID } from "../../manifest/config-v3.js";
import {
  resolveDeploymentUnits,
  type BuildRouteDecision,
  type DeploymentUnitPlan,
  type ResourceDisposition,
  type UnitGuardCode,
  type UnitResourceKind,
} from "./deployment-units.js";
import type { UnitProgressEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Input contract (structurally matches the v3 `units[]` entry)
// ---------------------------------------------------------------------------

export type GraphUnitInputKind = "worker" | "pages" | "resources";

export interface GraphUnitResourceInput {
  kind: "r2" | "kv" | "d1" | "queue" | "vectorize";
  name: string;
  mode: "ensure" | "bind-existing";
}

/** Service binding of the unit's final wrangler config (`{ binding, service }`). */
export interface GraphServiceTargetInput {
  binding: string;
  service: string;
}

/**
 * TapDeploy `units[]` entry. Structurally compatible with `ConfigV3Unit`; the extra
 * fields are the seam the V3 adapter (config envelope) fills so the guards
 * below cannot be bypassed:
 *   - `accountId`: optional per-unit account claim. The v3 schema carries no
 *     account field today; any claim that differs from the authorized session
 *     account BLOCKS the graph (cross-account reference).
 *   - `services`: mapped from the normalized wrangler projection (`services`).
 */
export interface GraphUnitInput {
  id: string;
  kind: GraphUnitInputKind;
  /** Present for worker/pages units: ZIP-relative path to the unit's final wrangler.jsonc. */
  wrangler?: string;
  /** Present for resource-only units. */
  resources?: readonly GraphUnitResourceInput[];
  dependsOn?: readonly string[];
  accountId?: string;
  services?: readonly GraphServiceTargetInput[];
}

export interface DeployGraphInput {
  /** The one-shot authorized account this release runs as. */
  accountId: string;
  /** TapDeploy `units[]` opt-in; absent/empty => implicit single unit. */
  units?: readonly GraphUnitInput[];
  /** Normalized per-unit specs (projections), keyed by unit id. */
  specs: Readonly<Record<string, DeploySpec>>;
  /** bundle digest binding the exact ZIP content; required when a unit needs a bundle. */
  bundleDigest?: string;
}

// ---------------------------------------------------------------------------
// Graph nodes / edges
// ---------------------------------------------------------------------------

export type GraphUnitKind = "worker" | "pages-static" | "pages-functions" | "resource-only";
export type GraphIdentityKind = "worker-script" | "pages-project" | "none";

export interface GraphUnit {
  id: string;
  /** True when synthesized from a single-target release without `units[]`. */
  implicit: boolean;
  kind: GraphUnitKind;
  identity: GraphIdentityKind;
  /** Provider readback identity name (script / Pages project); "" for resource-only. */
  name: string;
  wranglerPath?: string;
  entrypoint?: string;
  assetCount: number;
  requiresHttpRoot: false;
  requiresBundle: boolean;
  buildRoute?: BuildRouteDecision;
}

export interface GraphResourceRef {
  unitId: string;
  /** Env binding name; absent for resource-only unit provisioning intent. */
  binding?: string;
  disposition: ResourceDisposition;
  role?: QueueRole;
}

export interface GraphResource {
  id: string;
  kind: UnitResourceKind;
  name?: string;
  refs: GraphResourceRef[];
  /** Units declaring creation intent for this resource (at most one may). */
  creators: string[];
  secretPolicy?: SecretPolicy;
}

export interface GraphBindingEdge {
  unitId: string;
  resourceId: string;
  /** Absent for `provision-intent` edges (resource-only units carry no env binding). */
  binding?: string;
  kind: "env-binding" | "provision-intent";
}

export interface GraphTriggerNode {
  /** Unit-scoped: `<unitId>/<baseId>`. */
  id: string;
  kind: "cron" | "queue-consumer";
  unitId: string;
  cron?: string;
  queueName?: string;
}

export interface GraphExposureEdge {
  unitId: string;
  kind: ConfigDomainKind;
  hostname: string;
  zoneName?: string;
  updateAction?: DomainUpdateAction;
}

export type GraphDependencyKind =
  | "declared"
  | "resource-order"
  | "service-binding"
  | "queue-consumer";

export interface GraphDependencyEdge {
  /** Runs after `dependency` (the dependency's identity must exist first). */
  dependent: string;
  dependency: string;
  kind: GraphDependencyKind;
  detail: string;
}

export type GraphGuardBaseCode =
  | "missing-unit-spec"
  | "unexpected-unit-spec"
  | "duplicate-unit-id"
  | "duplicate-wrangler-path"
  | "duplicate-name"
  | "target-kind-mismatch"
  | "unknown-dependency"
  | "dependency-cycle"
  | "resource-contention"
  | "unresolved-service-target"
  | "ambiguous-service-target"
  | "duplicate-queue-consumer"
  // two units declaring one account-unique Workflow name.
  | "duplicate-workflow"
  | "ambiguous-exposure"
  | "missing-bundle-digest"
  | "resource-unit-with-wrangler"
  | "missing-wrangler-path"
  | "cross-account-reference";

/** Base codes plus the single-target resolver codes propagated per unit. */
export type GraphGuardCode = GraphGuardBaseCode | UnitGuardCode;

export interface GraphGuard {
  code: GraphGuardCode;
  unitId?: string;
  message: string;
}

export interface DeploymentGraph {
  units: GraphUnit[];
  resources: GraphResource[];
  bindings: GraphBindingEdge[];
  triggers: GraphTriggerNode[];
  exposures: GraphExposureEdge[];
  dependencies: GraphDependencyEdge[];
  bundleDigest: string | null;
  requiresBundle: boolean;
  /** Deterministic (lexicographic-among-ready) topological order; [] on cycle. */
  topoOrder: string[];
  /** Partial progress table: one pending entry per unit, in execution order. */
  progress: UnitProgressEntry[];
  guards: GraphGuard[];
  ok: boolean;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const UNIT_LOCAL_KINDS: ReadonlySet<UnitResourceKind> = new Set<UnitResourceKind>([
  "runtime",
  "secret",
]);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function resourceNodeId(unitId: string, baseId: string, kind: UnitResourceKind): string {
  return UNIT_LOCAL_KINDS.has(kind) ? `${unitId}/${baseId}` : baseId;
}

interface ResolvedUnit {
  id: string;
  implicit: boolean;
  config: GraphUnitInput | null;
  spec: DeploySpec | null;
}

export function buildDeployGraph(input: DeployGraphInput): DeploymentGraph {
  const guards: GraphGuard[] = [];
  const notes: string[] = [];
  const unitInputs = input.units ?? [];
  const explicit = unitInputs.length > 0;
  const resolved: ResolvedUnit[] = [];

  // ---- 1. resolve the unit set (config identity + normalized spec) ----
  if (!explicit) {
    const keys = Object.keys(input.specs).sort(cmp);
    if (keys.length === 0) {
      guards.push({
        code: "missing-unit-spec",
        message: "no units[] declared and no unit spec supplied; the release has no unit",
      });
    } else if (keys.length > 1) {
      guards.push({
        code: "unexpected-unit-spec",
        message:
          `multiple unit specs (${keys.join(", ")}) require an explicit units[] declaration; ` +
          "the implicit single-unit layout accepts exactly one",
      });
    } else {
      const key = keys[0] as string;
      const spec = input.specs[key] as DeploySpec;
      resolved.push({ id: DEFAULT_V3_UNIT_ID, implicit: true, config: null, spec });
    }
  } else {
    const seenIds = new Set<string>();
    for (const unit of [...unitInputs].sort((a, b) => cmp(a.id, b.id))) {
      if (seenIds.has(unit.id)) {
        guards.push({
          code: "duplicate-unit-id",
          unitId: unit.id,
          message: `unit id "${unit.id}" is declared more than once`,
        });
        continue;
      }
      seenIds.add(unit.id);
      resolved.push({ id: unit.id, implicit: false, config: unit, spec: null });
    }

    // Spec matching: worker/pages units need exactly their spec; resource-only
    // units must not carry one; orphan specs are refused (fail closed).
    const unitIds = new Set(resolved.map((r) => r.id));
    for (const r of resolved) {
      const config = r.config as GraphUnitInput;
      if (config.kind === "resources") {
        if (input.specs[r.id] !== undefined) {
          guards.push({
            code: "unexpected-unit-spec",
            unitId: r.id,
            message:
              `unit "${r.id}" is resource-only; a deployment spec was supplied but no ` +
              "Worker/Pages carrier exists",
          });
        }
        continue;
      }
      const spec = input.specs[r.id];
      if (spec === undefined) {
        guards.push({
          code: "missing-unit-spec",
          unitId: r.id,
          message: `unit "${r.id}" (${config.kind}) has no normalized unit spec; nothing can be classified`,
        });
        continue;
      }
      r.spec = spec;
    }
    for (const key of Object.keys(input.specs).sort(cmp)) {
      if (!unitIds.has(key)) {
        guards.push({
          code: "unexpected-unit-spec",
          message: `unit spec "${key}" does not match any declared unit id`,
        });
      }
    }

    // Wrangler paths: exactly one final wrangler per worker/pages unit.
    const pathOwner = new Map<string, string>();
    for (const r of resolved) {
      const config = r.config as GraphUnitInput;
      if (config.kind === "resources") {
        if (config.wrangler !== undefined) {
          guards.push({
            code: "resource-unit-with-wrangler",
            unitId: r.id,
            message:
              `resource-only unit "${r.id}" declares a wrangler path; resources carry no ` +
              "final wrangler config",
          });
        }
        continue;
      }
      if (config.wrangler === undefined || config.wrangler === "") {
        guards.push({
          code: "missing-wrangler-path",
          unitId: r.id,
          message: `unit "${r.id}" (${config.kind}) has no ZIP-relative wrangler path`,
        });
        continue;
      }
      const previous = pathOwner.get(config.wrangler);
      if (previous !== undefined) {
        guards.push({
          code: "duplicate-wrangler-path",
          message: `units "${previous}" and "${r.id}" both map to wrangler path "${config.wrangler}"`,
        });
      } else {
        pathOwner.set(config.wrangler, r.id);
      }
    }
  }

  // ---- 2. cross-account claims ----
  for (const r of resolved) {
    const claim = r.config?.accountId;
    if (claim !== undefined && claim !== input.accountId) {
      guards.push({
        code: "cross-account-reference",
        unitId: r.id,
        message:
          `unit "${r.id}" claims account "${claim}" but this release is authorized for ` +
          `"${input.accountId || "(unknown)"}"; cross-account references are refused`,
      });
    }
  }

  // ---- 3. per-unit resolver pass: units, resources, bindings, triggers, exposures ----
  const units: GraphUnit[] = [];
  const resources = new Map<string, GraphResource>();
  const bindings: GraphBindingEdge[] = [];
  const triggers: GraphTriggerNode[] = [];
  const exposures: GraphExposureEdge[] = [];
  const resolverNotes = new Set<string>();

  const addResourceRef = (
    unitId: string,
    nodeId: string,
    kind: UnitResourceKind,
    name: string | undefined,
    ref: { binding?: string; disposition: ResourceDisposition; role?: QueueRole },
    secretPolicy?: SecretPolicy,
  ): void => {
    let node = resources.get(nodeId);
    if (node === undefined) {
      node = {
        id: nodeId,
        kind,
        refs: [],
        creators: [],
        ...(name !== undefined ? { name } : {}),
        ...(secretPolicy !== undefined ? { secretPolicy } : {}),
      };
      resources.set(nodeId, node);
    }
    const previous = node.refs.find((x) => x.unitId === unitId);
    if (previous !== undefined && previous.disposition !== ref.disposition) {
      guards.push({
        code: "resource-contention",
        unitId,
        message:
          `unit "${unitId}" references "${nodeId}" with conflicting dispositions ` +
          `("${previous.disposition}" and "${ref.disposition}")`,
      });
      return;
    }
    if (previous !== undefined) {
      return; // identical reference repeated; idempotent
    }
    node.refs.push({
      unitId,
      ...(ref.binding !== undefined ? { binding: ref.binding } : {}),
      disposition: ref.disposition,
      ...(ref.role !== undefined ? { role: ref.role } : {}),
    });
    if (ref.disposition === "create-if-missing" && !node.creators.includes(unitId)) {
      node.creators.push(unitId);
    }
  };

  for (const r of resolved) {
    const config = r.config;

    // Resource-only unit: provisioning intent only, no carrier and no bundle.
    if (config?.kind === "resources") {
      units.push({
        id: r.id,
        implicit: false,
        kind: "resource-only",
        identity: "none",
        name: "",
        assetCount: 0,
        requiresHttpRoot: false,
        requiresBundle: false,
      });
      const refs = [...(config.resources ?? [])].sort(
        (a, b) => cmp(a.kind, b.kind) || cmp(a.name, b.name),
      );
      for (const ref of refs) {
        const disposition: ResourceDisposition =
          ref.mode === "ensure" ? "create-if-missing" : "bind-existing";
        const nodeId = `${ref.kind}:${ref.name}`;
        addResourceRef(r.id, nodeId, ref.kind, ref.name, { disposition });
        bindings.push({ unitId: r.id, resourceId: nodeId, kind: "provision-intent" });
      }
      continue;
    }

    // Worker/pages unit without a spec (already guarded): placeholder node so
    // the graph still shows the declared unit and the blocker.
    if (r.spec === null) {
      const isPages = config?.kind === "pages";
      units.push({
        id: r.id,
        implicit: r.implicit,
        kind: isPages ? "pages-static" : "worker",
        identity: isPages ? "pages-project" : "worker-script",
        name: "",
        assetCount: 0,
        requiresHttpRoot: false,
        requiresBundle: true,
      });
      continue;
    }

    const plan: DeploymentUnitPlan = resolveDeploymentUnits(r.spec);
    for (const note of plan.notes) {
      resolverNotes.add(note);
    }
    for (const guard of plan.guards) {
      guards.push({ code: guard.code, unitId: r.id, message: guard.message });
    }
    if (config !== null) {
      const expected: "workers" | "pages" = config.kind === "pages" ? "pages" : "workers";
      if (r.spec.targetKind !== expected) {
        guards.push({
          code: "target-kind-mismatch",
          unitId: r.id,
          message: `unit "${r.id}" is declared as ${config.kind} but its spec targets ${r.spec.targetKind}`,
        });
      }
    }

    const unit = plan.units[0];
    if (unit === undefined) {
      continue; // resolver always emits one unit; defensive only
    }
    units.push({
      id: r.id,
      implicit: r.implicit,
      kind: unit.kind,
      identity: unit.kind === "worker" ? "worker-script" : "pages-project",
      name: unit.name,
      ...(config?.wrangler !== undefined ? { wranglerPath: config.wrangler } : {}),
      ...(unit.entrypoint !== undefined ? { entrypoint: unit.entrypoint } : {}),
      assetCount: unit.assetCount,
      requiresHttpRoot: false,
      requiresBundle: true,
      buildRoute: unit.buildRoute,
    });

    for (const res of plan.resources) {
      const nodeId = resourceNodeId(r.id, res.id, res.kind);
      addResourceRef(
        r.id,
        nodeId,
        res.kind,
        res.name,
        {
          binding: res.binding,
          disposition: res.disposition,
          ...(res.role !== undefined ? { role: res.role } : {}),
        },
        res.secretPolicy,
      );
      bindings.push({
        unitId: r.id,
        resourceId: nodeId,
        ...(res.binding !== undefined ? { binding: res.binding } : {}),
        kind: res.binding !== undefined ? "env-binding" : "provision-intent",
      });
    }

    for (const trigger of plan.triggers) {
      triggers.push({
        id: `${r.id}/${trigger.id}`,
        kind: trigger.kind,
        unitId: r.id,
        ...(trigger.cron !== undefined ? { cron: trigger.cron } : {}),
        ...(trigger.queueName !== undefined ? { queueName: trigger.queueName } : {}),
      });
    }

    for (const exposure of plan.exposures) {
      exposures.push({
        unitId: r.id,
        kind: exposure.kind,
        hostname: exposure.hostname,
        ...(exposure.zoneName !== undefined ? { zoneName: exposure.zoneName } : {}),
        ...(exposure.updateAction !== undefined ? { updateAction: exposure.updateAction } : {}),
      });
    }
  }

  // ---- 4. identity / exposure / consumer consistency ----
  const identitySpaces = new Map<string, string[]>();
  for (const unit of units) {
    if (unit.identity === "none" || unit.name === "") {
      continue;
    }
    const key = `${unit.identity}\u0000${unit.name}`;
    const owners = identitySpaces.get(key) ?? [];
    owners.push(unit.id);
    identitySpaces.set(key, owners);
  }
  for (const [key, owners] of identitySpaces) {
    if (owners.length > 1) {
      const [identity, name] = key.split("\u0000") as [string, string];
      guards.push({
        code: "duplicate-name",
        message: `units ${owners.map((o) => `"${o}"`).join(", ")} resolve to the same ${identity} identity "${name}"`,
      });
    }
  }

  const exposureOwners = new Map<string, string>();
  for (const exposure of [...exposures].sort(
    (a, b) => cmp(a.kind, b.kind) || cmp(a.hostname, b.hostname) || cmp(a.unitId, b.unitId),
  )) {
    const key = `${exposure.kind}\u0000${exposure.hostname}`;
    const owner = exposureOwners.get(key);
    if (owner === undefined) {
      exposureOwners.set(key, exposure.unitId);
      continue;
    }
    const detail = `${exposure.kind} "${exposure.hostname}"`;
    if (owner !== exposure.unitId) {
      guards.push({
        code: "ambiguous-exposure",
        unitId: exposure.unitId,
        message: `${detail} is claimed by units "${owner}" and "${exposure.unitId}"; exposure identity is account-global and cannot have two owners`,
      });
    }
    // same-unit duplicates are idempotent (resolver sorts but does not dedupe)
  }

  const consumerOwners = new Map<string, string[]>();
  for (const trigger of triggers) {
    if (trigger.kind !== "queue-consumer" || trigger.queueName === undefined) {
      continue;
    }
    const owners = consumerOwners.get(trigger.queueName) ?? [];
    if (!owners.includes(trigger.unitId)) {
      owners.push(trigger.unitId);
    }
    consumerOwners.set(trigger.queueName, owners);
  }
  for (const [queueName, owners] of consumerOwners) {
    if (owners.length > 1) {
      guards.push({
        code: "duplicate-queue-consumer",
        message: `queue "${queueName}" is consumed by units ${owners.map((o) => `"${o}"`).join(", ")}; a queue has exactly one consumer identity`,
      });
    }
  }

  // Workflow names are unique per account. Two units declaring the same
  // workflow name would race to define one account entity; refuse both before
  // either can write (the resource-contention guard below fires too; this is
  // the explicit, workflow-specific refusal).
  const workflowOwners = new Map<string, string[]>();
  for (const node of resources.values()) {
    if (node.kind !== "workflow" || node.name === undefined) {
      continue;
    }
    const owners = workflowOwners.get(node.name) ?? [];
    for (const ref of node.refs) {
      if (!owners.includes(ref.unitId)) {
        owners.push(ref.unitId);
      }
    }
    workflowOwners.set(node.name, owners);
  }
  for (const [workflowName, owners] of workflowOwners) {
    if (owners.length > 1) {
      guards.push({
        code: "duplicate-workflow",
        message: `workflow "${workflowName}" is declared by units ${owners.map((o) => `"${o}"`).join(", ")}; Workflow names are unique per account and exactly one carrier may own a definition`,
      });
    }
  }

  // ---- 5. dependencies: declared + derived ----
  const dependencies: GraphDependencyEdge[] = [];
  const edgeKeys = new Set<string>();
  const pushEdge = (
    dependent: string,
    dependency: string,
    kind: GraphDependencyKind,
    detail: string,
  ): void => {
    const key = `${dependent}\u0000${dependency}\u0000${kind}`;
    if (edgeKeys.has(key)) {
      return;
    }
    edgeKeys.add(key);
    dependencies.push({ dependent, dependency, kind, detail });
  };

  const knownIds = new Set(resolved.map((r) => r.id));

  for (const r of resolved) {
    for (const dep of [...(r.config?.dependsOn ?? [])].sort(cmp)) {
      if (!knownIds.has(dep)) {
        guards.push({
          code: "unknown-dependency",
          unitId: r.id,
          message: `unit "${r.id}" depends on unknown unit "${dep}"`,
        });
        continue;
      }
      pushEdge(r.id, dep, "declared", `config dependsOn "${dep}"`);
    }
  }

  // Creator-first ordering: a unit that references a resource ensured by
  // another unit runs after that creator (queue consumers register their
  // trigger only once the queue exists).
  for (const node of [...resources.values()].sort((a, b) => cmp(a.id, b.id))) {
    if (node.creators.length === 0 || node.creators.length > 1) {
      continue; // >1 creator is the resource-contention guard below
    }
    const creator = node.creators[0] as string;
    for (const ref of node.refs) {
      if (ref.unitId === creator) {
        continue;
      }
      const kind: GraphDependencyKind =
        node.kind === "queue" && (ref.role === "consumer" || ref.role === "both")
          ? "queue-consumer"
          : "resource-order";
      const reference =
        ref.binding !== undefined ? `binding "${ref.binding}"` : "provision reference";
      pushEdge(
        ref.unitId,
        creator,
        kind,
        `${reference} to "${node.id}" waits for creator "${creator}"`,
      );
    }
  }

  // Service bindings: the target must resolve to exactly one unit identity of
  // this release (own script included); anything else fails closed.
  const identityName = new Map<string, string>();
  for (const unit of units) {
    identityName.set(unit.id, unit.identity === "none" ? "" : unit.name);
  }
  for (const r of resolved) {
    const services = [...(r.config?.services ?? [])].sort(
      (a, b) => cmp(a.binding, b.binding) || cmp(a.service, b.service),
    );
    for (const service of services) {
      if (service.service === "") {
        guards.push({
          code: "unresolved-service-target",
          unitId: r.id,
          message: `service binding "${service.binding}" has an empty target name`,
        });
        continue;
      }
      const candidates = units.filter((u) => identityName.get(u.id) === service.service);
      if (candidates.length === 0) {
        guards.push({
          code: "unresolved-service-target",
          unitId: r.id,
          message:
            `service binding "${service.binding}" targets "${service.service}", which has no ` +
            "verified identity in this release; external targets fail closed",
        });
        continue;
      }
      if (candidates.length > 1) {
        guards.push({
          code: "ambiguous-service-target",
          unitId: r.id,
          message:
            `service binding "${service.binding}" target "${service.service}" matches units ` +
            `${candidates.map((c) => `"${c.id}"`).join(", ")}; the identity is ambiguous`,
        });
        continue;
      }
      const target = candidates[0] as GraphUnit;
      if (target.id !== r.id) {
        pushEdge(
          r.id,
          target.id,
          "service-binding",
          `service binding "${service.binding}" targets unit "${target.id}"`,
        );
      }
      // Exactly the unit's own script: verified identity, no ordering edge.
    }
  }

  // Resource contention: at most one unit may create/ensure a resource.
  for (const node of [...resources.values()].sort((a, b) => cmp(a.id, b.id))) {
    if (node.creators.length > 1) {
      guards.push({
        code: "resource-contention",
        message:
          `resource "${node.id}" is declared with creation intent by units ` +
          `${node.creators.map((c) => `"${c}"`).join(", ")}; exactly one unit may own creation`,
      });
    }
  }

  // ---- 6. deterministic topological order + partial progress table ----
  const ids = units.map((u) => u.id).sort(cmp);
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const adjacency = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  const pairs = new Set<string>();
  for (const edge of dependencies) {
    pairs.add(`${edge.dependent}\u0000${edge.dependency}`);
  }
  for (const pair of pairs) {
    const [dependent, dependency] = pair.split("\u0000") as [string, string];
    const dependents = adjacency.get(dependency);
    if (dependents === undefined || !indegree.has(dependent)) {
      continue;
    }
    dependents.add(dependent);
    indegree.set(dependent, (indegree.get(dependent) as number) + 1);
  }

  const ready = ids.filter((id) => indegree.get(id) === 0).sort(cmp);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    order.push(id);
    for (const dependent of [...(adjacency.get(id) as Set<string>)].sort(cmp)) {
      const remaining = (indegree.get(dependent) as number) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(cmp);
      }
    }
  }

  let topoOrder: string[] = [];
  if (order.length === ids.length) {
    topoOrder = order;
  } else if (ids.length > 0) {
    const stuck = ids.filter((id) => !order.includes(id));
    guards.push({
      code: "dependency-cycle",
      message:
        `dependency cycle among units: ${stuck.join(" -> ")}; no execution order is ` +
        "derived and no unit may be executed",
    });
  }

  const progress: UnitProgressEntry[] = (topoOrder.length > 0 ? topoOrder : ids).map(
    (unitId) => ({ unitId, state: "pending", receiptDigest: null }),
  );

  // ---- 7. bundle binding + notes ----
  const requiresBundle = units.some((u) => u.requiresBundle);
  const bundleDigest =
    input.bundleDigest !== undefined && input.bundleDigest.trim() !== ""
      ? input.bundleDigest
      : null;
  if (requiresBundle && bundleDigest === null) {
    guards.push({
      code: "missing-bundle-digest",
      message: "a unit needs a prebuilt bundle but no bundle digest was supplied",
    });
  }
  for (const note of resolverNotes) {
    notes.push(note);
  }
  notes.push(
    "the graph root is the release's unit set; no Workers/Pages service is ever treated as a graph root",
    explicit
      ? "TapDeploy units[] is opt-in and declared here; every unit is an independent node"
      : `TapDeploy units[] is opt-in; this release is the implicit single unit "${DEFAULT_V3_UNIT_ID}"`,
    "cross-unit ordering derives from resource creation order and service-binding targets; config dependsOn is only needed for edges that cannot be derived",
    "a plan is not an atomic multi-target transaction: units carry independent progress states and resume from live provider state; another unit's existing resources are never rolled back",
    requiresBundle
      ? "bundle digest binds the exact release content"
      : "all units are resource-only: ZIP/bundle selection is skipped; the source model keeps exactly two modes (URL ZIP / local ZIP) and no third mode exists",
    "unit-local nodes (runtime bindings, secret policies, triggers) are scoped by unit id because the same name in two units is not the same entity; account resources keep canonical ids",
    "secret values are write-only and never read or emitted; secret nodes carry policy names only",
    "no provider writes happen in this module: classification only",
  );

  const bindingKey = (b: GraphBindingEdge): string =>
    `${b.resourceId}\u0000${b.unitId}\u0000${b.kind}\u0000${b.binding ?? ""}`;
  const exposureKey = (e: GraphExposureEdge): string =>
    `${e.kind}\u0000${e.hostname}\u0000${e.unitId}\u0000${e.updateAction ?? ""}`;
  const dedupe = <T,>(items: T[], key: (item: T) => string): T[] => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const k = key(item);
      if (seen.has(k)) {
        return false;
      }
      seen.add(k);
      return true;
    });
  };

  return {
    units: [...units].sort((a, b) => cmp(a.id, b.id)),
    resources: [...resources.values()]
      .map((resource) => ({
        ...resource,
        refs: [...resource.refs].sort(
          (a, b) => cmp(a.unitId, b.unitId) || cmp(a.disposition, b.disposition),
        ),
        creators: [...resource.creators].sort(cmp),
      }))
      .sort((a, b) => cmp(a.id, b.id)),
    bindings: dedupe(bindings, bindingKey).sort(
      (a, b) =>
        cmp(a.resourceId, b.resourceId) ||
        cmp(a.unitId, b.unitId) ||
        cmp(a.kind, b.kind) ||
        cmp(a.binding ?? "", b.binding ?? ""),
    ),
    triggers: [...triggers].sort((a, b) => cmp(a.id, b.id)),
    exposures: dedupe(exposures, exposureKey).sort(
      (a, b) => cmp(a.kind, b.kind) || cmp(a.hostname, b.hostname) || cmp(a.unitId, b.unitId),
    ),
    dependencies: [...dependencies].sort(
      (a, b) => cmp(a.dependent, b.dependent) || cmp(a.dependency, b.dependency) || cmp(a.kind, b.kind),
    ),
    bundleDigest,
    requiresBundle,
    topoOrder,
    progress,
    guards,
    ok: guards.length === 0,
    notes,
  };
}
