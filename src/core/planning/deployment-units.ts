// Explicit deployment-unit resolver.
//
// A project is modeled as independent DeploymentUnits / Resources / Triggers / Bindings / Edges instead
// of a root Worker or Pages project: a Worker is only the execution carrier for
// custom code and never needs an HTTP fetch root; managed resources exist
// beside it. This module is the pure, shared resolver for that model. It turns
// a validated DeploySpec (the same normalized form the planner already
// consumes) into an explicit graph whose nodes carry stable ids, so plan,
// preview and (later) rollback/replay can address units, resources, triggers
// and bindings by reference instead of re-deriving structure ad hoc.
//
// Scope discipline: classification only. No provider calls, no network,
// no secret material (secret VALUES are never read from the spec and never
// emitted; only policy names/policies appear).

import type {
  ConfigDomainKind,
  DomainUpdateAction,
  DeploySpec,
  QueueRole,
  SecretPolicy,
} from "../deploy-spec.js";

// ---------------------------------------------------------------------------
// Build route selection
// ---------------------------------------------------------------------------

// The routes the installer can satisfy TODAY without bundling or remote build:
// prebuilt artifacts uploaded directly (Worker script multipart or Pages direct
// upload). Nothing is bundled or built remotely.
export type BuildRouteId =
  | "workers-direct-upload"
  | "pages-direct-upload"
  | "pages-direct-upload-functions";

export interface BuildRouteDecision {
  route: BuildRouteId;
  prebuilt: true;
  notes: string;
}

export interface BuildRouteInput {
  targetKind: "workers" | "pages";
  hasWorkerModule: boolean;
  hasPagesFunctionBundle: boolean;
}

export function selectBuildRoute(input: BuildRouteInput): BuildRouteDecision {
  if (input.targetKind === "workers") {
    return {
      route: "workers-direct-upload",
      prebuilt: true,
      notes: input.hasWorkerModule
        ? "prebuilt ESM worker module uploaded without bundling; compatibility flags travel with the release"
        : "no worker module declared; route selected but the unit carries no uploadable entrypoint",
    };
  }
  return input.hasPagesFunctionBundle
    ? {
        route: "pages-direct-upload-functions",
        prebuilt: true,
        notes: "prebuilt Pages project including a prebuilt _worker.js function bundle",
      }
    : {
        route: "pages-direct-upload",
        prebuilt: true,
        notes: "prebuilt static assets only; no function bundle and no HTTP root",
      };
}

// ---------------------------------------------------------------------------
// Graph nodes
// ---------------------------------------------------------------------------

export type DeploymentUnitKind = "worker" | "pages-static" | "pages-functions";

export interface DeploymentUnit {
  id: string;
  kind: DeploymentUnitKind;
  name: string;
  entrypoint?: string;
  assetCount: number;
  // A carrier is never required to expose an HTTP fetch root. Routes, custom
  // domains and DNS are opt-in exposure edges below, never implied by the unit.
  requiresHttpRoot: false;
  buildRoute: BuildRouteDecision;
}

export type UnitResourceKind =
  | "r2"
  | "d1"
  | "kv"
  | "queue"
  // an account Workflow definition declared by the carrier (unique name
  // per account; applied through the Workflows API after the cutover).
  | "workflow"
  | "hyperdrive"
  | "vectorize"
  | "secrets-store"
  | "runtime"
  | "secret";

export type ResourceDisposition =
  | "create-if-missing"
  | "bind-existing"
  | "bind-only"
  | "policy";

export interface UnitResourceNode {
  id: string;
  kind: UnitResourceKind;
  // The Worker/Pages env binding name (or the secret policy key). Absent for a
  // consumer-only queue: a consumer trigger is registered on the queue's
  // consumers subresource and carries no environment binding.
  binding?: string;
  // Resolved resource name where one exists (`undefined` for bind-only kinds).
  // Never a secret value.
  name?: string;
  // For queues: producer binds, consumer registers a trigger, both does both.
  role?: QueueRole;
  disposition: ResourceDisposition;
  // Secret nodes carry the policy only; values are write-only and never appear.
  secretPolicy?: SecretPolicy;
}

export type TriggerKind = "cron" | "queue-consumer";

export interface UnitTriggerNode {
  id: string;
  kind: TriggerKind;
  unitId: string;
  cron?: string;
  queueName?: string;
}

export interface UnitBindingEdge {
  unitId: string;
  resourceId: string;
  // Absent for a consumer-only queue: the queue is provisioned/used but
  // carries no environment binding.
  binding?: string;
}

export interface UnitExposureEdge {
  unitId: string;
  kind: ConfigDomainKind;
  hostname: string;
  zoneName?: string;
  updateAction?: DomainUpdateAction;
}

export type UnitGuardCode =
  | "missing-worker-entrypoint"
  | "missing-pages-identity"
  | "duplicate-binding"
  | "duplicate-node-id"
  | "trigger-requires-worker"
  | "exposure-requires-hostname";

export interface UnitGuard {
  code: UnitGuardCode;
  message: string;
}

export interface DeploymentUnitPlan {
  units: DeploymentUnit[];
  resources: UnitResourceNode[];
  triggers: UnitTriggerNode[];
  bindings: UnitBindingEdge[];
  exposures: UnitExposureEdge[];
  guards: UnitGuard[];
  ok: boolean;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export function resolveDeploymentUnits(spec: DeploySpec): DeploymentUnitPlan {
  const guards: UnitGuard[] = [];
  const resources: UnitResourceNode[] = [];

  // Exactly one target per release (the single-target carrier today): derive
  // the unit from the declared target kind without assuming an HTTP root.
  const hasWorkerModule = Boolean(spec.worker);
  const hasPagesFunctionBundle = Boolean(spec.workerBundle);

  let unit: DeploymentUnit;
  if (spec.targetKind === "workers") {
    if (!spec.worker) {
      guards.push({
        code: "missing-worker-entrypoint",
        message: "workers target has no worker module declared; nothing is uploadable",
      });
    }
    unit = {
      id: `worker:${spec.cloudflare.workerName}`,
      kind: "worker",
      name: spec.cloudflare.workerName,
      entrypoint: spec.worker?.path,
      assetCount: spec.assets.length,
      requiresHttpRoot: false,
      buildRoute: selectBuildRoute({
        targetKind: "workers",
        hasWorkerModule,
        hasPagesFunctionBundle: false,
      }),
    };
  } else {
    if (!spec.cloudflare.pages) {
      guards.push({
        code: "missing-pages-identity",
        message: "pages target has no project identity; nothing is addressable",
      });
    }
    unit = {
      id: `pages:${spec.cloudflare.pages?.projectName ?? ""}`,
      kind: hasPagesFunctionBundle ? "pages-functions" : "pages-static",
      name: spec.cloudflare.pages?.projectName ?? "",
      entrypoint: spec.workerBundle?.path,
      assetCount: spec.assets.length,
      requiresHttpRoot: false,
      buildRoute: selectBuildRoute({
        targetKind: "pages",
        hasWorkerModule: false,
        hasPagesFunctionBundle,
      }),
    };
  }
  const units: DeploymentUnit[] = [unit];

  // Independent resources. Queue producers bind, consumers additionally
  // register a trigger (handled below); runtime bindings and secrets have no
  // account resource identity.
  for (const r of spec.cloudflare.r2) {
    resources.push({
      id: `r2:${r.bucketName}`,
      kind: "r2",
      binding: r.binding,
      name: r.bucketName,
      disposition: r.createIfMissing ? "create-if-missing" : "bind-existing",
    });
  }
  for (const r of spec.cloudflare.d1) {
    resources.push({
      id: `d1:${r.databaseName}`,
      kind: "d1",
      binding: r.binding,
      name: r.databaseName,
      disposition: r.createIfMissing ? "create-if-missing" : "bind-existing",
    });
  }
  for (const r of spec.cloudflare.kv) {
    resources.push({
      id: `kv:${r.namespaceName}`,
      kind: "kv",
      binding: r.binding,
      name: r.namespaceName,
      disposition: r.createIfMissing ? "create-if-missing" : "bind-existing",
    });
  }
  for (const r of spec.cloudflare.queues) {
    resources.push({
      id: `queue:${r.queueName}`,
      kind: "queue",
      ...(r.binding !== undefined ? { binding: r.binding } : {}),
      name: r.queueName,
      role: r.role,
      disposition: r.createIfMissing ? "create-if-missing" : "bind-existing",
    });
  }
  // workflows are carrier-declared account entities. The carrier owns
  // creation intent (the definition is applied through the Workflows API after
  // the cutover, never by a resource-only unit); the account-unique node id is
  // shared across units so a duplicate name is an explicit graph guard.
  for (const r of spec.cloudflare.workflows ?? []) {
    resources.push({
      id: `workflow:${r.name}`,
      kind: "workflow",
      binding: r.binding,
      name: r.name,
      disposition: "create-if-missing",
    });
  }
  for (const r of spec.cloudflare.hyperdrive) {
    resources.push({
      id: `hyperdrive:${r.configName}`,
      kind: "hyperdrive",
      binding: r.binding,
      name: r.configName,
      disposition: r.createIfMissing ? "create-if-missing" : "bind-existing",
    });
  }
  for (const r of spec.cloudflare.vectorize) {
    resources.push({
      id: `vectorize:${r.indexName}`,
      kind: "vectorize",
      binding: r.binding,
      name: r.indexName,
      disposition: r.createIfMissing ? "create-if-missing" : "bind-existing",
    });
  }
  for (const r of spec.cloudflare.secretsStore) {
    resources.push({
      id: `secrets-store:${r.storeName}${r.secretName ? `/${r.secretName}` : ""}`,
      kind: "secrets-store",
      binding: r.binding,
      name: r.storeName,
      disposition: r.createIfMissing ? "create-if-missing" : "bind-existing",
    });
  }
  for (const r of spec.cloudflare.runtimeBindings) {
    resources.push({
      id: `runtime:${r.type}:${r.binding}`,
      kind: "runtime",
      binding: r.binding,
      name: r.type,
      disposition: "bind-only",
    });
  }
  for (const [key, policy] of Object.entries(spec.cloudflare.secrets)) {
    resources.push({
      id: `secret:${key}`,
      kind: "secret",
      binding: key,
      disposition: "policy",
      secretPolicy: policy,
    });
  }

  // Triggers: crons target the Worker carrier; queue consumers are registered
  // against the queue. A Pages carrier cannot host either (fail closed).
  const triggers: UnitTriggerNode[] = [];
  const addCrons = (crons: string[]): void => {
    for (const cron of crons) {
      if (spec.targetKind !== "workers") {
        guards.push({
          code: "trigger-requires-worker",
          message: `cron "${cron}" targets a ${spec.targetKind} release; cron triggers require a Worker carrier`,
        });
        continue;
      }
      triggers.push({ id: `cron:${cron}`, kind: "cron", unitId: unit.id, cron });
    }
  };
  addCrons(spec.cloudflare.cron);
  for (const r of spec.cloudflare.queues) {
    if (r.role !== "consumer" && r.role !== "both") {
      continue;
    }
    if (spec.targetKind !== "workers") {
      guards.push({
        code: "trigger-requires-worker",
        message: `queue consumer for "${r.queueName}" targets a ${spec.targetKind} release; queue consumers require a Worker carrier`,
      });
      continue;
    }
    triggers.push({
      id: `queue-consumer:${r.queueName}`,
      kind: "queue-consumer",
      unitId: unit.id,
      queueName: r.queueName,
    });
  }

  // Bindings: one edge per resource node (secret policies materialize a
  // version secret bound by name, so they are edges too). A consumer-only
  // queue carries no binding identity.
  const bindings: UnitBindingEdge[] = resources.map((r) => ({
    unitId: unit.id,
    resourceId: r.id,
    ...(r.binding !== undefined ? { binding: r.binding } : {}),
  }));

  // Exposure edges are explicit opt-in only (semantics preserved).
  const exposures: UnitExposureEdge[] = [];
  for (const d of spec.cloudflare.domains ?? []) {
    if (!d.hostname) {
      guards.push({
        code: "exposure-requires-hostname",
        message: `domain entry of kind "${d.kind}" has no resolved hostname`,
      });
      continue;
    }
    exposures.push({
      unitId: unit.id,
      kind: d.kind,
      hostname: d.hostname,
      ...(d.zoneName !== undefined ? { zoneName: d.zoneName } : {}),
      updateAction: d.updateAction,
    });
  }

  // Fail-closed guards: duplicate binding names and duplicate node ids.
  const bindingCounts = new Map<string, number>();
  for (const r of resources) {
    if (r.binding === undefined) continue;
    bindingCounts.set(r.binding, (bindingCounts.get(r.binding) ?? 0) + 1);
  }
  for (const [binding, count] of bindingCounts) {
    if (count > 1) {
      guards.push({
        code: "duplicate-binding",
        message: `binding "${binding}" is declared ${count} times across resources`,
      });
    }
  }
  const seenIds = new Set<string>();
  for (const r of resources) {
    if (seenIds.has(r.id)) {
      guards.push({
        code: "duplicate-node-id",
        message: `resource node "${r.id}" is declared more than once`,
      });
    }
    seenIds.add(r.id);
  }

  // Deterministic ordering so plan/rollback references are stable across runs.
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const byId = (a: { id: string }, b: { id: string }): number => cmp(a.id, b.id);
  resources.sort(byId);
  triggers.sort(byId);
  bindings.sort((a, b) => cmp(a.resourceId, b.resourceId) || cmp(a.binding ?? "", b.binding ?? ""));
  exposures.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.hostname, b.hostname));

  // De-duplicate identical triggers while preserving the sorted order.
  const dedupedTriggers = triggers.filter(
    (t, i) => i === 0 || t.id !== triggers[i - 1]?.id,
  );

  const notes = [
    "units never require an HTTP fetch root; exposure edges are explicit opt-in and never implied by the target kind",
    "prebuilt-only: this resolver selects direct-upload routes and never claims bundling or remote builds",
    "secret values are write-only and never read or emitted; secret nodes carry policy names only",
  ];

  return {
    units,
    resources,
    triggers: dedupedTriggers,
    bindings,
    exposures,
    guards,
    ok: guards.length === 0,
    notes,
  };
}
