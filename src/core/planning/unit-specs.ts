// The sealed per-unit deployment specs and bundles of a release, derived from
// the server-verified wrangler projection of each unit (never from anything the
// browser sent): rate limits, queues, workflows, Durable Objects, routes and
// every binding family become explicit spec entries, or the release is refused
// with an exact reason before any provider read. Pure: no provider access.

import type { ConfigV3 } from "../../manifest/config-v3.js";
import { plannedUnits } from "../../manifest/config-v3.js";
import type { WranglerV3DurableObjectBinding, WranglerV3Migration, WranglerV3Workflow } from "../../manifest/wrangler-v3.js";
import type { DeploySpec, DomainEntrySpec, PrimitiveInputValue, SecretPolicy } from "../deploy-spec.js";
import { planRateLimitBindings } from "../../cloudflare/resources/rate-limits.js";
import { planWranglerCarrierActions } from "../deploy/wrangler-binding-plan.js";
import type { DeployBundle } from "../../release/deploy-bundle.js";
import { declaredSecretPolicies, inputVars, workerNameOverride } from "./request-inputs.js";

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

type Planned<T> = { ok: true; value: T } | { ok: false; detail: string };

/** A prepared executable unit whose required parts are known to be present. */
type ValidatedUnit = PreparedUnit & Required<Pick<PreparedUnit, "canonicalWrangler" | "wranglerPath" | "wranglerSha256" | "wranglerEffectiveHash" | "modules" | "assets">>;

/** One prepared Worker or Pages unit, validated, with the helpers the planners share. */
interface UnitContext {
  unitId: string;
  unit: ValidatedUnit;
  wrangler: Record<string, unknown>;
  kind: "worker" | "pages";
  name: string;
  array: (key: string) => Record<string, unknown>[];
  /** A resource is created by its Worker unless a config `resources` entry already provides it. */
  create: (resourceKind: string, resourceName: string) => boolean;
}

function isBinding(value: unknown): value is { binding: string } {
  return typeof value === "object" && value !== null && typeof (value as { binding?: unknown }).binding === "string";
}

// Rate limits are Worker version metadata bindings only: never account/zone
// rule provisioning. The official binding contract is validated here (before
// any provider read) and the exact entries ride through the wrangler echo.
function planRateLimits({ unitId, array }: UnitContext): Planned<Array<{ name: string; namespace_id: string; limit: number; period: number }>> {
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
  return { ok: true, value: ratelimits };
}

// queues are normalized from wrangler `queueProducers`/`queueConsumers`
// (never a raw `queues: []`). A producer binds in the Worker version; a
// consumer registers a provider trigger on the queue's consumers
// subresource, so it carries its declared settings and an explicit per-queue
// role. `create` is allowed only when no resource-only unit already
// guarantees the queue by name.
function planQueues({ array, create }: UnitContext): DeploySpec["cloudflare"]["queues"] {
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
  return queueSpecs;
}

  // workflows are normalized through the shared carrier planner
  // (never a raw `workflows: []`). A definition declared by another Worker
  // (`script_name`) fails closed before any provider read; an own-script
  // definition carries its exact version-metadata binding plus the full
  // declared direct schedule set, which is applied through the Workflows API
  // after the carrier version is active. The 2026 class-keyed `exports`
  // declaration has no TapDeploy path — the wrangler parser refuses it.
function planWorkflows({ unitId, kind, array }: UnitContext): Planned<WranglerV3Workflow[]> {
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
  return { ok: true, value: parsedWorkflows };
}

  // durable object bindings + migrations are normalized here (shape is
  // re-checked defensively although the parser validated it) and planned
  // through the shared carrier planner. A Pages release cannot host a DO
  // (prepare already refuses; this is defense in depth).
function planDurableObjects({ unitId, kind, wrangler }: UnitContext): Planned<{ durableObjects: WranglerV3DurableObjectBinding[]; migrations: WranglerV3Migration[] }> {
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
  return { ok: true, value: { durableObjects: parsedDurableObjects, migrations: parsedMigrations } };
}

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
function planRoutes({ unitId, kind, array }: UnitContext): Planned<DomainEntrySpec[]> {
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
  return { ok: true, value: routeSpecs };
}

interface CarrierPlan {
  durableObjectEcho: NonNullable<DeploySpec["wrangler"]["durableObjects"]>;
  migrationEcho: NonNullable<DeploySpec["wrangler"]["migrations"]>;
  workflowSpecs: DeploySpec["cloudflare"]["workflows"];
  workflowEcho: NonNullable<DeploySpec["wrangler"]["workflows"]>;
}

// Workflows and Durable Objects are planned through the shared carrier planner;
// their bindings are metadata-only and ride the atomic version upload.
function planCarrier(
  { unitId, name }: UnitContext,
  parsedWorkflows: WranglerV3Workflow[],
  parsedDurableObjects: WranglerV3DurableObjectBinding[],
  parsedMigrations: WranglerV3Migration[],
): Planned<CarrierPlan> {
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
  return { ok: true, value: { durableObjectEcho, migrationEcho, workflowSpecs, workflowEcho } };
}

// Declared inputs ride into a Worker as variables; a name the release already
// sets would silently override the publisher's value.
function unitVariables({ unitId, kind, wrangler }: UnitContext, variables: Record<string, string | number | boolean>): Planned<DeploySpec["wrangler"]["vars"]> {
  const releaseVars = (wrangler.vars ?? {}) as Record<string, unknown>;
  const clash = kind === "worker" ? Object.keys(variables).find((key) => Object.hasOwn(releaseVars, key)) : undefined;
  if (clash) return { ok: false, detail: `input "${clash}" collides with a variable the release already sets in unit ${unitId}` };
  return { ok: true, value: kind === "worker" && Object.keys(variables).length > 0 ? { ...releaseVars, ...variables } as DeploySpec["wrangler"]["vars"] : wrangler.vars as DeploySpec["wrangler"]["vars"] };
}


/** Everything planned for a unit before its spec is assembled. */
interface UnitPlan extends CarrierPlan {
  ratelimits: Array<{ name: string; namespace_id: string; limit: number; period: number }>;
  queueSpecs: DeploySpec["cloudflare"]["queues"];
  routeSpecs: DomainEntrySpec[];
  unitVars: DeploySpec["wrangler"]["vars"];
}

interface ReleaseFacts {
  config: ConfigV3;
  manifestDigest: string;
  archiveSha256: string;
  inputs: Record<string, PrimitiveInputValue>;
  secretPolicies: Record<string, SecretPolicy>;
}

function buildUnitSpec(ctx: UnitContext, plan: UnitPlan, { config, manifestDigest, inputs, secretPolicies }: ReleaseFacts): DeploySpec {
  const { unit, kind, name, wrangler, array, create } = ctx;
  const { ratelimits, queueSpecs, routeSpecs, durableObjectEcho, migrationEcho, workflowSpecs, workflowEcho, unitVars } = plan;
  return {
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
      hyperdrive: array("hyperdrive").flatMap((entry) => typeof entry.binding === "string" && typeof entry.id === "string" ? [{ binding: entry.binding, configName: entry.id, configId: entry.id }] : []),
      vectorize: array("vectorize").flatMap((entry) => typeof entry.binding === "string" && typeof entry.indexName === "string" ? [{ binding: entry.binding, indexName: entry.indexName, createIfMissing: false }] : []),
      secretsStore: array("secretsStoreSecrets").flatMap((entry) => typeof entry.binding === "string" && typeof entry.storeId === "string" && typeof entry.secretName === "string" ? [{ binding: entry.binding, storeName: entry.storeId, storeId: entry.storeId, secretName: entry.secretName }] : []),
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
      crons: wrangler.crons as string[], vars: unitVars as Record<string, string | number | boolean>,
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
}

function buildUnitBundle({ unit, kind, name }: UnitContext, { archiveSha256, manifestDigest }: ReleaseFacts): DeployBundle {
  return {
    schemaVersion: 1, appName: name, targetKind: kind === "worker" ? "workers" : "pages",
    ...(unit.mainModule ? { mainModule: unit.mainModule.path } : {}),
    modules: unit.modules.map((module) => ({ name: module.path, kind: module.mime === "application/wasm" ? "wasm" : "esm", mime: module.mime, size: module.size, sha256: module.sha256 })),
    assets: unit.assets, config: { path: unit.wranglerPath, size: 0, sha256: unit.wranglerSha256 },
    source: { archiveBytes: 0, archiveSha256, manifestDigest }, wranglerEffectiveHash: unit.wranglerEffectiveHash, bundleDigest: unit.bundleDigest,
  };
}


/** Validates one prepared Worker or Pages unit and names the helpers the planners share. */
function unitContext(unitId: string, unit: PreparedUnit | undefined, declared: ReturnType<typeof plannedUnits> & object, workerName: string | undefined): Planned<UnitContext> {
  if (!unit || !unit.canonicalWrangler || !unit.wranglerPath || !unit.wranglerSha256 || !unit.wranglerEffectiveHash) return { ok: false, detail: `missing prepared executable unit ${unitId}` };
  const wrangler = unit.canonicalWrangler as Record<string, unknown>;
  const kind = wrangler.kind;
  // Operator rename (validated by the caller): worker-kind only. Pages project
  // names stay release-declared.
  const name = kind === "worker" && workerName !== undefined ? workerName : wrangler.name;
  if ((kind !== "worker" && kind !== "pages") || typeof name !== "string" || !Array.isArray(unit.modules) || !Array.isArray(unit.assets)) return { ok: false, detail: `invalid prepared unit ${unitId}` };
  if (kind === "worker" && !unit.mainModule) return { ok: false, detail: `prepared Worker ${unitId} has no main module` };
  const create = (resourceKind: string, resourceName: string) => !declared.some((candidate) => candidate.kind === "resources" && candidate.resources?.some((resource) => resource.kind === resourceKind && resource.name === resourceName));
  const array = (key: string): Record<string, unknown>[] => Array.isArray(wrangler[key]) ? wrangler[key] as Record<string, unknown>[] : [];
  const validated: ValidatedUnit = { ...unit, canonicalWrangler: unit.canonicalWrangler, wranglerPath: unit.wranglerPath, wranglerSha256: unit.wranglerSha256, wranglerEffectiveHash: unit.wranglerEffectiveHash, modules: unit.modules, assets: unit.assets };
  return { ok: true, value: { unitId, unit: validated, wrangler, kind, name, array, create } };
}

function planUnit(ctx: UnitContext, facts: ReleaseFacts, variables: Record<string, string | number | boolean>): Planned<{ spec: DeploySpec; bundle: DeployBundle }> {
  const ratelimits = planRateLimits(ctx);
  if (!ratelimits.ok) return ratelimits;
  const queueSpecs = planQueues(ctx);
  const workflows = planWorkflows(ctx);
  if (!workflows.ok) return workflows;
  const durable = planDurableObjects(ctx);
  if (!durable.ok) return durable;
  const routes = planRoutes(ctx);
  if (!routes.ok) return routes;
  const carrier = planCarrier(ctx, workflows.value, durable.value.durableObjects, durable.value.migrations);
  if (!carrier.ok) return carrier;
  const unitVars = unitVariables(ctx, variables);
  if (!unitVars.ok) return unitVars;
  const plan: UnitPlan = { ...carrier.value, ratelimits: ratelimits.value, queueSpecs, routeSpecs: routes.value, unitVars: unitVars.value };
  return { ok: true, value: { spec: buildUnitSpec(ctx, plan, facts), bundle: buildUnitBundle(ctx, facts) } };
}

/**
 * The sealed specs, bundles and per-unit proofs of a prepared release. The
 * operator's Worker name applies only when the release has exactly one Worker:
 * with two or more (or none) the release names are kept instead of failing late.
 */
export function preparedGraphInputs(
  config: ConfigV3,
  rawUnits: Record<string, unknown>[],
  archiveSha256: string,
  manifestDigest: string,
  inputs: Record<string, PrimitiveInputValue>,
  suppliedSecrets: ReadonlySet<string> = new Set(),
): { ok: true; specs: Record<string, DeploySpec>; bundles: Record<string, DeployBundle>; proofs: Record<string, unknown> } | { ok: false; detail: string } {
  const byId = new Map((rawUnits as PreparedUnit[]).map((unit) => [unit.unitId, unit]));
  const declared = plannedUnits(config) ?? [];
  const facts: ReleaseFacts = { config, manifestDigest, archiveSha256, inputs, secretPolicies: declaredSecretPolicies(config, suppliedSecrets) };
  const variables = inputVars(config, inputs);
  const workerName = workerNameOverride(config, inputs);
  if (!workerName.ok) return workerName;
  const executableIds = declared.length ? declared.filter((unit) => unit.kind !== "resources").map((unit) => unit.id) : ["main"];
  const workerCount = executableIds.filter((unitId) => ((byId.get(unitId)?.canonicalWrangler ?? {}) as { kind?: unknown }).kind === "worker").length;
  if (workerName.value !== undefined && workerCount !== 1) return { ok: false, detail: "inputs.workerName requires exactly one worker unit" };
  const specs: Record<string, DeploySpec> = {};
  const bundles: Record<string, DeployBundle> = {};
  const proofs: Record<string, unknown> = {};
  for (const unitId of executableIds) {
    const ctx = unitContext(unitId, byId.get(unitId), declared, workerName.value);
    if (!ctx.ok) return ctx;
    const planned = planUnit(ctx.value, facts, variables);
    if (!planned.ok) return planned;
    specs[unitId] = planned.value.spec;
    bundles[unitId] = planned.value.bundle;
    proofs[unitId] = ctx.value.unit;
  }
  for (const unit of declared.filter((candidate) => candidate.kind === "resources")) {
    const prepared = byId.get(unit.id);
    if (!prepared || prepared.bundleDigest.length === 0) return { ok: false, detail: `missing prepared resource unit ${unit.id}` };
    proofs[unit.id] = prepared;
  }
  return { ok: true, specs, bundles, proofs };
}

/** The specs the step route dispatches for resource-only units: provisioning intent, no carrier. */
export function resourceOnlyDispatchSpecs(config: ConfigV3, manifestDigest: string, inputs: Record<string, PrimitiveInputValue>): Record<string, DeploySpec> {
  return Object.fromEntries((plannedUnits(config) ?? []).filter((unit) => unit.kind === "resources").map((unit) => [unit.id, {
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
