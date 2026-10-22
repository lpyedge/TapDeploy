// Pure plan-time adapters from the normalized Wrangler V3 config to verified
// account actions and Worker version metadata: resource (R2/D1/KV) planning,
// carrier (workflow/Durable Object/service) planning and the single migration
// validator. No provider access and no secrets; the effectful steps that act on
// these plans live in bindings.ts and steps.ts.

import {
  plannedBucketActionFor,
  plannedDatabaseActionFor,
  plannedNamespaceActionFor,
} from "../../cloudflare/resources/index.js";
import type {
  ServiceBindingMetadata,
  WorkflowBindingMetadata,
} from "../../cloudflare/models/workers.js";
import type { TargetSnapshot } from "../planning/types.js";
import type {
  WranglerV3D1Database,
  WranglerV3DurableObjectBinding,
  WranglerV3KvNamespace,
  WranglerV3Migration,
  WranglerV3R2Bucket,
  WranglerV3ServiceBinding,
  WranglerV3Workflow,
} from "../../manifest/wrangler-v3.js";

// ---------------------------------------------------------------------------
// V3 Wrangler resource plan. The final Wrangler config is the only
// resource declaration for a unit (no duplicated config.resources clause).
// Declaration -> verified account action:
//   - create only a verified-missing R2 bucket / D1 database when the unit
//     approves provisioning ("ensure"); "bind-existing" never creates;
//   - an existing resource is reused only through its unique live identity read
//     back from the account snapshot, never from the config verbatim;
//   - a declared provider id (D1 database_id / KV namespace id) is an identity
//     claim: present in the account -> verified reuse; absent -> conflict
//     (creation by name only ever happens without a declared id, and KV
//     namespaces are never created from a wrangler binding: no title handle);
//   - any conflict fails the whole plan (ok:false); no partial provisioning and
//     no declared binding is ever dropped from the plan.
// The result carries the provider binding type + verified identity so the
// Worker/Pages metadata builder can bind exactly the verified resource. The
// input is expected to be normalizeWranglerV3 output; binding-name and
// resource-target collisions are refused there before planning.
// ---------------------------------------------------------------------------

export type WranglerResourceMode = "ensure" | "bind-existing";

export interface WranglerResourceProjection {
  r2Buckets: ReadonlyArray<WranglerV3R2Bucket>;
  d1Databases: ReadonlyArray<WranglerV3D1Database>;
  kvNamespaces: ReadonlyArray<WranglerV3KvNamespace>;
}

export interface PlannedR2BucketBinding {
  binding: string;
  providerType: "r2_bucket";
  bucketName: string;
  action: "create" | "preserve";
  /** Verified live identity; present exactly when the action is preserve. */
  id?: string;
}

export interface PlannedD1DatabaseBinding {
  binding: string;
  providerType: "d1";
  databaseName: string;
  action: "create" | "preserve";
  /** Verified live identity; present exactly when the action is preserve. */
  id?: string;
}

export interface PlannedKvNamespaceBinding {
  binding: string;
  providerType: "kv_namespace";
  /** Verified live provider id (the value bound as `namespace_id`). */
  namespaceId: string;
  /** Live namespace name, so the binding spec can select it by name. */
  namespaceName: string;
  action: "preserve";
}

export interface WranglerResourcePlan {
  r2Buckets: PlannedR2BucketBinding[];
  d1Databases: PlannedD1DatabaseBinding[];
  kvNamespaces: PlannedKvNamespaceBinding[];
}

export type WranglerResourcePlanResult =
  | { ok: true; plan: WranglerResourcePlan }
  | { ok: false; issues: string[] };

export function planWranglerResourceActions(
  projection: WranglerResourceProjection,
  snapshot: Pick<TargetSnapshot, "r2Buckets" | "d1Databases" | "kvNamespaces">,
  mode: WranglerResourceMode,
): WranglerResourcePlanResult {
  const issues: string[] = [];
  const r2Buckets: PlannedR2BucketBinding[] = [];
  for (const declared of projection.r2Buckets) {
    const action = plannedBucketActionFor(declared, snapshot.r2Buckets, {
      createIfMissing: mode === "ensure",
    });
    if (action.action === "conflict") {
      issues.push(action.detail);
      continue;
    }
    r2Buckets.push(
      action.action === "preserve"
        ? {
            binding: action.binding,
            providerType: "r2_bucket",
            bucketName: action.bucketName,
            action: "preserve",
            id: action.id,
          }
        : {
            binding: action.binding,
            providerType: "r2_bucket",
            bucketName: action.bucketName,
            action: "create",
          },
    );
  }
  const d1Databases: PlannedD1DatabaseBinding[] = [];
  for (const declared of projection.d1Databases) {
    const action = plannedDatabaseActionFor(declared, snapshot.d1Databases, {
      createIfMissing: mode === "ensure",
    });
    if (action.action === "conflict") {
      issues.push(action.detail);
      continue;
    }
    d1Databases.push(
      action.action === "preserve"
        ? {
            binding: action.binding,
            providerType: "d1",
            databaseName: action.databaseName,
            action: "preserve",
            id: action.id,
          }
        : {
            binding: action.binding,
            providerType: "d1",
            databaseName: action.databaseName,
            action: "create",
          },
    );
  }
  const kvNamespaces: PlannedKvNamespaceBinding[] = [];
  for (const declared of projection.kvNamespaces) {
    const action = plannedNamespaceActionFor(declared, snapshot.kvNamespaces);
    if (action.action !== "preserve") {
      issues.push(
        action.action === "conflict"
          ? action.detail
          : `KV namespace for binding "${declared.binding}" cannot be created from a wrangler binding`,
      );
      continue;
    }
    kvNamespaces.push({
      binding: action.binding,
      providerType: "kv_namespace",
      namespaceId: action.id,
      namespaceName: action.namespaceName,
      action: "preserve",
    });
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, plan: { r2Buckets, d1Databases, kvNamespaces } };
}

// ---------------------------------------------------------------------------
// carrier features — Workflow / Service / Durable Objects. The final
// Wrangler config is the declaration source. A Workflow carrier is a prebuilt
// Worker class export and never needs an HTTP fetch root:
//   - workflows[] project to the official provider version-metadata binding
//     {name, type:"workflow", workflow_name, class_name, script_name?}; direct
//     schedules are carried as explicit deployment intent (they never ride the
//     version metadata — wrangler applies them through the Workflows API);
//   - a workflow defined by another Worker (script_name) cannot be verified in
//     this release and is refused, never dropped;
//   - service bindings may only target units with a verified identity in this
//     release (single-target carrier: its own script name); every other target
//     fails closed until multi-unit support exists, because binding to an
//     unverified Worker would silently ship a wrong service target;
//   - durable object bindings project to the official provider
//     version-metadata binding {name, type:"durable_object_namespace",
//     class_name} (own script only; script_name is omitted exactly as wrangler
//     sends it for the carrying script). Only the strictly-bound subset
//     plans: every bound class is exported by the entry graph (prepare-time
//     gate) and covered by a pure new-class migration in this release, every
//     new class is bound, tags are unique, and any renamed/deleted class,
//     foreign script, environment, empty entry or duplicate tag fails the
//     whole plan before a single provider write. Validated migrations ride the
//     atomic version upload verbatim; the provider applies known tags as
//     no-ops.
// Every branch is explicit: ok:false fails the whole plan; there is no partial
// plan and no silent omission.
// ---------------------------------------------------------------------------

export interface WranglerCarrierProjection {
  workflows: ReadonlyArray<WranglerV3Workflow>;
  durableObjects: ReadonlyArray<WranglerV3DurableObjectBinding>;
  migrations: ReadonlyArray<WranglerV3Migration>;
  services: ReadonlyArray<WranglerV3ServiceBinding>;
}

export type WranglerCarrierIssueCode =
  | "UNSUPPORTED_EXTERNAL_WORKFLOW"
  | "UNSUPPORTED_EXTERNAL_DO"
  | "UNSUPPORTED_DO_ENVIRONMENT"
  | "DO_MIGRATION_DESTRUCTIVE"
  | "DO_MIGRATION_EMPTY"
  | "DO_MIGRATION_TAG_CONFLICT"
  | "UNSUPPORTED_MIGRATION_HISTORY"
  | "DO_CLASS_UNMIGRATED"
  | "DO_CLASS_UNBOUND"
  | "UNSUPPORTED_SERVICE_BINDING_TARGET";

export interface WranglerCarrierIssue {
  code: WranglerCarrierIssueCode;
  detail: string;
}

export interface PlannedWorkflowBinding {
  binding: string;
  workflowName: string;
  className: string;
  /**
   * Direct schedules. Deployment intent only: wrangler applies them through
   * the Workflows API, never through the version metadata; TapDeploy carries them
   * explicitly so no consumer can silently drop them. the apply-workflows
   * step PUTs the exact definition after the carrier version is active and
   * reads the schedules back.
   */
  schedules: string[];
  /** Exact provider version-metadata binding. */
  metadata: WorkflowBindingMetadata;
}

export interface WranglerCarrierPlan {
  workflows: PlannedWorkflowBinding[];
  durableObjects: PlannedDurableObjectBinding[];
  /**
   * validated migration entries, forwarded verbatim with the version
   * upload (pure new-class additions only). The provider applies them
   * atomically with the version and treats already-applied tags as no-ops,
   * so identical resends need no versioned migration interpreter. Anything
   * else (rename/delete/transfer, empty, duplicate tags, uncovered classes)
   * is an issue below, never forwarded.
   */
  migrations: WranglerV3Migration[];
  services: ServiceBindingMetadata[];
  /** Metadata upload entries: workflow bindings, then DO bindings, then service bindings. */
  metadata: Array<WorkflowBindingMetadata | DurableObjectBindingMetadata | ServiceBindingMetadata>;
  /** Explicit limitations of this plan that no consumer may drop silently. */
  notes: string[];
}

/** a strictly-bound Durable Object binding (own script, exported class, exact migration cover). */
export interface PlannedDurableObjectBinding {
  binding: string;
  className: string;
  /** Exact provider version-metadata binding. */
  metadata: DurableObjectBindingMetadata;
}

export type DurableObjectBindingMetadata = {
  name: string;
  type: "durable_object_namespace";
  class_name: string;
};

export type WranglerCarrierPlanResult =
  | { ok: true; plan: WranglerCarrierPlan }
  | { ok: false; issues: WranglerCarrierIssue[] };

export function planWranglerCarrierActions(
  projection: WranglerCarrierProjection,
  options: {
    /** This unit's script name; the only verified identity in a single-target release. */
    scriptName: string;
    /** Units of this release with a verified identity (allowed service targets). */
    verifiedServiceTargets: ReadonlyArray<string>;
  },
): WranglerCarrierPlanResult {
  const issues: WranglerCarrierIssue[] = [];

  // Durable Objects are no longer blanket-refused. The strictly-bound
  // safe subset plans here; everything else fails closed with an exact code
  // before any provider write. Rules (all checked before mutation):
  // - own script only (`script_name` absent or equal to this script; a foreign
  //   script is an unverifiable target and is refused, never dropped);
  // - no `environment` (cross-environment class identity cannot be verified);
  // - migrations carry pure new-class additions only: any renamed/deleted
  //   class is a destructive veto (TapDeploy never auto-executes history that may
  //   destroy data, and the lean gate forbids a versioned migration
  //   interpreter that could tell past from present);
  // - every migration entry names at least one new class (a tag-only entry is
  //   unknown migration state) and tags are unique within the release;
  // - exact cover both ways: every bound class appears in some entry's
  //   new-class list (a binding without a migration cannot instantiate and
  //   its state is unknown), and every new class is bound (no orphan
  //   namespaces nobody can reach). The static declaration is resent every
  //   deploy and the provider treats re-applied tags as no-ops, so upgrades
  //   satisfy the same cover without history tracking. Class-export proof is
  //   a prepare-time gate (per-unit-bundles), not repeated here.
  const durableObjects: PlannedDurableObjectBinding[] = [];
  const migrations: WranglerV3Migration[] = [];
  const seenTags = new Set<string>();
  for (const migration of projection.migrations) {
    if ((migration.renamed_classes?.length ?? 0) > 0 || (migration.deleted_classes?.length ?? 0) > 0) {
      issues.push({
        code: "DO_MIGRATION_DESTRUCTIVE",
        detail: `migration tag "${migration.tag}" renames or deletes classes; destructive migrations never auto-execute — run them via wrangler directly, never through TapDeploy`,
      });
      continue;
    }
    const fresh = [...(migration.new_classes ?? []), ...(migration.new_sqlite_classes ?? [])];
    if (fresh.length === 0) {
      issues.push({
        code: "DO_MIGRATION_EMPTY",
        detail: `migration tag "${migration.tag}" declares no new classes; a tag-only entry is unknown migration state and is refused rather than forwarded`,
      });
      continue;
    }
    if (seenTags.has(migration.tag)) {
      issues.push({
        code: "DO_MIGRATION_TAG_CONFLICT",
        detail: `migration tag "${migration.tag}" is declared more than once; ambiguous application order is refused`,
      });
      continue;
    }
    seenTags.add(migration.tag);
    migrations.push(migration);
  }
  // The same pure validator the version upload re-checks, so an
  // unrepresentable history is refused here, before any provider write.
  if (issues.length === 0) {
    const uploadable = migrationObjectForUpload(migrations);
    if (!uploadable.ok) issues.push({ code: "UNSUPPORTED_MIGRATION_HISTORY", detail: uploadable.detail });
  }
  const migratedClasses = new Set(migrations.flatMap((migration) => [...(migration.new_classes ?? []), ...(migration.new_sqlite_classes ?? [])]));
  const boundClasses = new Set<string>();
  for (const durableObject of projection.durableObjects) {
    if (durableObject.script_name !== undefined && durableObject.script_name !== options.scriptName) {
      issues.push({
        code: "UNSUPPORTED_EXTERNAL_DO",
        detail: `durable object "${durableObject.name}" is defined by Worker "${durableObject.script_name}"; external class ownership cannot be verified in this release and the binding is refused rather than dropped`,
      });
      continue;
    }
    if (durableObject.environment !== undefined) {
      issues.push({
        code: "UNSUPPORTED_DO_ENVIRONMENT",
        detail: `durable object "${durableObject.name}" declares environment "${durableObject.environment}"; cross-environment class identity cannot be verified and is refused rather than forwarded`,
      });
      continue;
    }
    boundClasses.add(durableObject.class_name);
    durableObjects.push({
      binding: durableObject.name,
      className: durableObject.class_name,
      // Own-script is the provider default: script_name is omitted so the
      // upload carries exactly what wrangler would send for this script.
      metadata: { name: durableObject.name, type: "durable_object_namespace", class_name: durableObject.class_name },
    });
  }
  for (const className of boundClasses) {
    if (!migratedClasses.has(className)) {
      issues.push({
        code: "DO_CLASS_UNMIGRATED",
        detail: `durable object class "${className}" is bound but no migration in this release creates it; declare the new-class migration (resends are idempotent) or the binding is refused`,
      });
    }
  }
  for (const className of migratedClasses) {
    if (!boundClasses.has(className)) {
      issues.push({
        code: "DO_CLASS_UNBOUND",
        detail: `migration creates durable object class "${className}" but no binding in this release references it; orphan namespaces are refused`,
      });
    }
  }
  // The old blanket refusal survives only as documentation: any declaration
  // reaching here is either planned above or carries an exact issue below.

  const workflows: PlannedWorkflowBinding[] = [];
  for (const workflow of projection.workflows) {
    if (workflow.script_name !== undefined && workflow.script_name !== options.scriptName) {
      issues.push({
        code: "UNSUPPORTED_EXTERNAL_WORKFLOW",
        detail: `workflow "${workflow.name}" is defined by Worker "${workflow.script_name}"; external workflow ownership cannot be verified in this release and the binding is refused rather than dropped`,
      });
      continue;
    }
    const metadata: WorkflowBindingMetadata = {
      name: workflow.binding,
      type: "workflow",
      workflow_name: workflow.name,
      class_name: workflow.class_name,
      ...(workflow.script_name !== undefined ? { script_name: workflow.script_name } : {}),
    };
    workflows.push({
      binding: workflow.binding,
      workflowName: workflow.name,
      className: workflow.class_name,
      schedules: [...(workflow.schedules ?? [])],
      metadata,
    });
  }

  const services: ServiceBindingMetadata[] = [];
  for (const service of projection.services) {
    if (!options.verifiedServiceTargets.includes(service.service)) {
      issues.push({
        code: "UNSUPPORTED_SERVICE_BINDING_TARGET",
        detail: `service binding "${service.binding}" targets "${service.service}", which has no verified identity in this release; cross-worker targets fail closed until multi-unit carrier support exists`,
      });
      continue;
    }
    services.push({
      name: service.binding,
      type: "service",
      service: service.service,
      ...(service.environment !== undefined ? { environment: service.environment } : {}),
      ...(service.entrypoint !== undefined ? { entrypoint: service.entrypoint } : {}),
      ...(service.props !== undefined ? { props: service.props } : {}),
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const notes: string[] = [];
  if (workflows.some((workflow) => workflow.schedules.length > 0)) {
    notes.push(
      "workflow schedules are applied through the Workflows API (apply-workflows) after the carrier version is active; they never ride the version metadata",
    );
  }
  if (durableObjects.length > 0) {
    notes.push(
      "durable object bindings and their pure new-class migrations ride the atomic version upload; the provider applies already-known tags as no-ops, so identical resends need no migration interpreter — and the step never claims a migration applied, only that the declaring version was created and read back",
    );
  }
  return {
    ok: true,
    plan: {
      workflows,
      durableObjects,
      migrations,
      services,
      metadata: [...workflows.map((workflow) => workflow.metadata), ...durableObjects.map((durableObject) => durableObject.metadata), ...services],
      notes,
    },
  };
}

/**
 * Fold validated pure new-class migration entries into the single migration
 * object the provider version upload accepts (Cloudflare 10021 rejects the
 * wrangler-style array). Exactly one entry is supported: multi-tag releases
 * need ordered-history interpretation that TapDeploy deliberately does not perform,
 * so they fail closed here instead of a provider 400. TapDeploy never rewrites or
 * squashes tags that may already be deployed. Malformed entries and any field
 * other than tag/new_classes/new_sqlite_classes are refused, never dropped.
 * An empty list means "no migrations" (undefined, never an empty object).
 */
export function migrationObjectForUpload(
  entries: ReadonlyArray<unknown>,
): { ok: true; migration?: { new_tag: string; new_classes?: string[]; new_sqlite_classes?: string[] } } | { ok: false; detail: string } {
  if (entries.length === 0) return { ok: true };
  if (entries.some((m) => typeof m !== "object" || m === null || Array.isArray(m))) return { ok: false, detail: "migration entries must be objects" };
  if (entries.length > 1) {
    return {
      ok: false,
      detail: "multiple migration tags are an ordered history that TapDeploy does not interpret and never rewrites; TapDeploy uploads a single migration object only. Deploy this history with wrangler directly",
    };
  }
  const entry = entries[0] as Record<string, unknown>;
  const unsupported = Object.entries(entry).find(([key, value]) => !["tag", "new_classes", "new_sqlite_classes"].includes(key) && value !== undefined && !(Array.isArray(value) && value.length === 0));
  if (unsupported) return { ok: false, detail: `migration field "${unsupported[0]}" is not supported; only pure new-class additions are uploaded` };
  if (typeof entry.tag !== "string" || entry.tag.length === 0) return { ok: false, detail: "migration tag must be a non-empty string" };
  const pick = (value: unknown): string[] | null => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return null;
    return [...(value as string[])];
  };
  const newClasses = pick(entry.new_classes);
  const newSqliteClasses = pick(entry.new_sqlite_classes);
  if (newClasses === null || newSqliteClasses === null) return { ok: false, detail: "migration class lists must be string arrays" };
  if (newClasses.length + newSqliteClasses.length === 0) return { ok: false, detail: "migration declares no new classes" };
  return {
    ok: true,
    migration: {
      new_tag: entry.tag,
      ...(newClasses.length ? { new_classes: newClasses } : {}),
      ...(newSqliteClasses.length ? { new_sqlite_classes: newSqliteClasses } : {}),
    },
  };
}
