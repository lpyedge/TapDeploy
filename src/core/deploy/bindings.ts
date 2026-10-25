// Resource-binding deploy steps. These own the steps that turn declared
// resources into live Cloudflare state: R2 bucket creation and rate-limit
// preservation. They are deliberately narrow: create only what was declared and
// permitted, preserve everything else by identity, never delete. Upstream
// failures are normalized here so no raw Cloudflare detail ever reaches the
// browser. This module also hosts the shared step-outcome helpers used by the
// deploy step engine and the secret step.

import {
  ResourceConflictError,
  UnsupportedResourceError,
  bucketActionFor,
  ensureR2Bucket,
  readPreservedRateLimits,
  databaseActionFor,
  ensureD1Database,
  namespaceActionFor,
  ensureKvNamespace,
  plannedNamespaceActionFor,
  queueActionFor,
  ensureQueue,
  registerQueueConsumer,
  consumerRequestFor,
  declaredQueueConsumerMatches,
  vectorizeActionFor,
  ensureVectorizeIndex,
  type BucketAction,
  type DatabaseAction,
  type NamespaceAction,
  type QueueAction,
  type VectorizeAction,
} from "../../cloudflare/resources/index.js";
import type { DeploySpec, VectorizeIndexInputConfig } from "../deploy-spec.js";
import type { TargetSnapshot } from "../planning/types.js";
import type { DeployStepContext } from "./steps.js";

export interface DeployStepFail {
  ok: false;
  error: { kind: string; retryAfterSeconds?: number; detail: string };
}

export interface DeployStepOk {
  ok: true;
  result: unknown;
}

export type DeployStepOutcome = DeployStepOk | DeployStepFail;

export function stepOk(result: unknown): DeployStepOk {
  return { ok: true, result };
}

export function stepFail(kind: string, detail: string): DeployStepFail {
  return { ok: false, error: { kind, detail } };
}

const SAFE_UPSTREAM_DETAIL: Record<string, string> = {
  unauthorized: "Cloudflare API rejected the credentials",
  forbidden: "Cloudflare API denied access",
  "not-found": "Cloudflare resource was not found",
  conflict: "Cloudflare resource state conflict",
  "rate-limited": "Cloudflare rate limit exceeded",
  server: "Cloudflare API reported a server error",
  network: "Cloudflare API is unreachable",
  "invalid-response": "Cloudflare API returned an invalid response",
};

// Account plan limits the operator can act on. The provider's own text is not
// forwarded (it may carry account specifics); the numeric code is.
const PLAN_LIMIT_DETAIL: Record<number, string> = {
  10072: "this account has reached its Workers plan limit for cron triggers (Workers Free allows 5 per account); remove unused cron triggers or upgrade the plan, then deploy again",
};

// Normalize any thrown error into a step failure. Local resource errors carry an
// authored, safe message; upstream Cloudflare errors keep the stable kind and
// the numeric Cloudflare error code (the raw message is logged server-side only).
export function toStepFailure(error: unknown): DeployStepFail {
  if (
    error instanceof UnsupportedResourceError ||
    error instanceof ResourceConflictError
  ) {
    return stepFail(error.kind, error.message);
  }
  const e = error as { kind?: string; retryAfterSeconds?: number; status?: number; detail?: { code?: unknown; message?: unknown } };
  if (typeof e?.kind !== "string" || e.kind.length === 0) {
    return stepFail("upstream", "deploy step failed");
  }
  const code = typeof e.detail?.code === "number" ? e.detail.code : undefined;
  if (code !== undefined || typeof e.detail?.message === "string") {
    console.error(`[tapdeploy] Cloudflare step error kind=${e.kind} status=${e.status ?? "?"} code=${code ?? "?"} message=${String(e.detail?.message ?? "").slice(0, 300)}`);
  }
  const base = (code !== undefined ? PLAN_LIMIT_DETAIL[code] : undefined) ?? SAFE_UPSTREAM_DETAIL[e.kind] ?? "Cloudflare API error";
  return {
    ok: false,
    error: {
      kind: e.kind,
      retryAfterSeconds:
        typeof e.retryAfterSeconds === "number" ? e.retryAfterSeconds : undefined,
      detail: code !== undefined ? `${base} (Cloudflare error ${code})` : base,
    },
  };
}


// Pure: what would happen to each declared D1 binding, given the live databases.
export function planDatabaseActions(
  spec: DeploySpec,
  snapshot: TargetSnapshot,
): DatabaseAction[] {
  return spec.cloudflare.d1.map((binding) =>
    databaseActionFor(binding, snapshot.d1Databases),
  );
}

interface CreateD1DatabasesResult {
  databases: {
    binding: string;
    databaseName: string;
    action: "create" | "preserve";
    id: string;
  }[];
}

// Create explicitly-declared missing D1 databases; preserve existing ones.
export async function createD1Databases(
  ctx: DeployStepContext,
  _args: Record<string, unknown>,
): Promise<DeployStepOutcome> {
  if (ctx.spec.cloudflare.d1.length === 0) {
    return stepOk({ skipped: true, databases: [] } satisfies { skipped: true; databases: CreateD1DatabasesResult["databases"] });
  }
  const actions = planDatabaseActions(ctx.spec, ctx.snapshot);
  const conflict = actions.find((a) => a.action === "conflict");
  if (conflict && conflict.action === "conflict") {
    return stepFail("conflict", conflict.detail);
  }
  try {
    const databases: CreateD1DatabasesResult["databases"] = [];
    for (const action of actions) {
      if (action.action === "preserve") {
        databases.push({
          binding: action.binding,
          databaseName: action.databaseName,
          action: "preserve",
          id: action.id,
        });
        continue;
      }
      const created = await ensureD1Database(ctx.client, {
        databaseName: action.databaseName,
        createIfMissing: true,
        knownDatabases: ctx.snapshot.d1Databases,
      });
      databases.push({
        binding: action.binding,
        databaseName: action.databaseName,
        action: created.action,
        id: created.id,
      });
    }
    return stepOk({ databases } satisfies CreateD1DatabasesResult);
  } catch (error) {
    return toStepFailure(error);
  }
}

// Pure: what would happen to each declared KV binding, given the live namespaces.
// a declared provider id is verified by plannedNamespaceActionFor (the
// same resolver the plan uses): preserve under the real live name, or conflict
// that the step refuses. A namespace is never created from a wrangler binding.
export function planNamespaceActions(
  spec: DeploySpec,
  snapshot: TargetSnapshot,
): NamespaceAction[] {
  return spec.cloudflare.kv.map((binding) =>
    binding.namespaceId !== undefined
      ? plannedNamespaceActionFor(
          { binding: binding.binding, namespaceId: binding.namespaceId },
          snapshot.kvNamespaces,
        )
      : namespaceActionFor(binding, snapshot.kvNamespaces),
  );
}

interface CreateKvNamespacesResult {
  namespaces: {
    binding: string;
    namespaceName: string;
    action: "create" | "preserve";
    id: string;
  }[];
}

// Create explicitly-declared missing KV namespaces; preserve existing ones.
export async function createKvNamespaces(
  ctx: DeployStepContext,
  _args: Record<string, unknown>,
): Promise<DeployStepOutcome> {
  if (ctx.spec.cloudflare.kv.length === 0) {
    return stepOk({ skipped: true, namespaces: [] } satisfies { skipped: true; namespaces: CreateKvNamespacesResult["namespaces"] });
  }
  const actions = planNamespaceActions(ctx.spec, ctx.snapshot);
  const conflict = actions.find((a) => a.action === "conflict");
  if (conflict && conflict.action === "conflict") {
    return stepFail("conflict", conflict.detail);
  }
  try {
    const namespaces: CreateKvNamespacesResult["namespaces"] = [];
    for (const action of actions) {
      if (action.action === "preserve") {
        namespaces.push({
          binding: action.binding,
          namespaceName: action.namespaceName,
          action: "preserve",
          id: action.id,
        });
        continue;
      }
      const created = await ensureKvNamespace(ctx.client, {
        namespaceName: action.namespaceName,
        createIfMissing: true,
        knownNamespaces: ctx.snapshot.kvNamespaces,
      });
      namespaces.push({
        binding: action.binding,
        namespaceName: action.namespaceName,
        action: created.action,
        id: created.id,
      });
    }
    return stepOk({ namespaces } satisfies CreateKvNamespacesResult);
  } catch (error) {
    return toStepFailure(error);
  }
}

// Pure: what would happen to each declared R2 binding, given the live buckets.
export function planBucketActions(
  spec: DeploySpec,
  snapshot: TargetSnapshot,
): BucketAction[] {
  return spec.cloudflare.r2.map((binding) =>
    bucketActionFor(binding, snapshot.r2Buckets),
  );
}

interface CreateR2BucketsResult {
  buckets: {
    binding: string;
    bucketName: string;
    action: "create" | "preserve";
    id: string;
  }[];
}

// Create explicitly-declared missing buckets; preserve existing ones untouched.
export async function createR2Buckets(
  ctx: DeployStepContext,
  _args: Record<string, unknown>,
): Promise<DeployStepOutcome> {
  // absent optionals are a successful no-op, not a failure. The
  // browser SKIPs them; the server succeeds so retries and direct calls stay
  // green for releases without R2.
  if (ctx.spec.cloudflare.r2.length === 0) {
    return stepOk({ skipped: true, buckets: [] } satisfies { skipped: true; buckets: CreateR2BucketsResult["buckets"] });
  }
  const actions = planBucketActions(ctx.spec, ctx.snapshot);
  const conflict = actions.find((a) => a.action === "conflict");
  if (conflict && conflict.action === "conflict") {
    return stepFail("conflict", conflict.detail);
  }
  try {
    const buckets: CreateR2BucketsResult["buckets"] = [];
    for (const action of actions) {
      if (action.action === "preserve") {
        buckets.push({
          binding: action.binding,
          bucketName: action.bucketName,
          action: "preserve",
          id: action.id,
        });
        continue;
      }
      const created = await ensureR2Bucket(ctx.client, {
        bucketName: action.bucketName,
        createIfMissing: true,
        knownBuckets: ctx.snapshot.r2Buckets,
      });
      buckets.push({
        binding: action.binding,
        bucketName: action.bucketName,
        action: created.action,
        id: created.id,
      });
    }
    return stepOk({ buckets } satisfies CreateR2BucketsResult);
  } catch (error) {
    return toStepFailure(error);
  }
}

// Read the live rate-limit metadata and verify it is preserved untouched. v1
// declares none; any declaration fails closed.
export async function reconcileRateLimits(
  ctx: DeployStepContext,
  args: Record<string, unknown>,
): Promise<DeployStepOutcome> {
  if (args.rateLimits !== undefined && args.rateLimits !== null) {
    return stepFail(
      "unsupported-resource",
      "rate-limit declarations are not supported in v1",
    );
  }
  try {
    const result = await readPreservedRateLimits(ctx.client, ctx.workerName);
    return stepOk(result);
  } catch (error) {
    return toStepFailure(error);
  }
}

// Queues. Pure: what would happen to each declared queue binding given the
// live queues.
export function planQueueActions(
  spec: DeploySpec,
  snapshot: TargetSnapshot,
): QueueAction[] {
  return spec.cloudflare.queues.map((binding) =>
    queueActionFor(binding, snapshot.queues),
  );
}

interface CreateQueuesResult {
  queues: {
    binding?: string;
    queueName: string;
    action: "create" | "preserve";
    id: string;
  }[];
}

// Create explicitly-declared missing queues; preserve existing ones. Consumer
// triggers are registered separately (via registerQueueConsumer) after the queue
// is ensured so the membership is tied to the live queue id.
export async function createQueues(
  ctx: DeployStepContext,
  _args: Record<string, unknown>,
): Promise<DeployStepOutcome> {
  if (ctx.spec.cloudflare.queues.length === 0) {
    return stepOk({ skipped: true, queues: [] } satisfies { skipped: true; queues: CreateQueuesResult["queues"] });
  }
  const actions = planQueueActions(ctx.spec, ctx.snapshot);
  const conflict = actions.find((a) => a.action === "conflict");
  if (conflict && conflict.action === "conflict") {
    return stepFail("conflict", conflict.detail);
  }
  try {
    const queues: CreateQueuesResult["queues"] = [];
    for (const action of actions) {
      if (action.action === "preserve") {
        queues.push({
          ...(action.binding !== undefined ? { binding: action.binding } : {}),
          queueName: action.queueName,
          action: "preserve",
          id: action.id,
        });
        continue;
      }
      const created = await ensureQueue(ctx.client, {
        queueName: action.queueName,
        createIfMissing: true,
        knownQueues: ctx.snapshot.queues,
      });
      queues.push({
        ...(action.binding !== undefined ? { binding: action.binding } : {}),
        queueName: action.queueName,
        action: created.action,
        id: created.id,
      });
    }
    return stepOk({ queues } satisfies CreateQueuesResult);
  } catch (error) {
    return toStepFailure(error);
  }
}

// Register (create-or-update) the consumer trigger for a declared consumer
// queue binding. The consumer is attached to the live queue id resolved from the
// snapshot; no queue message is drained or deleted. the decision is made
// from the fresh per-queue consumer facts (preserve our own exactly matching
// consumer, update our own when the declared settings differ, create when the
// queue has none) and any consumer that is not this exact Worker refuses
// before a write, so a replay never touches another consumer and never adds a
// competing one.
// a consumer trigger designates the SCRIPT the queue delivers to, so it is
// only safe after the correct Worker version is live. The install order runs this
// step after activate; a direct/retried call against a missing Worker or a Worker
// with no active deployment fails closed so a consumer never starts draining
// messages before the cutover.
export async function registerQueueConsumers(
  ctx: DeployStepContext,
  _args: Record<string, unknown>,
): Promise<DeployStepOutcome> {
  const consumers = ctx.spec.cloudflare.queues.filter((q) => q.role === "consumer" || q.role === "both");
  if (consumers.length === 0) {
    return stepOk({ skipped: true, consumers: [] });
  }
  if (!ctx.snapshot.workerExists) {
    return stepFail(
      "worker-missing",
      "cannot register queue consumers: the target Worker does not exist (create-worker must run first)",
    );
  }
  if ((ctx.snapshot.activeDeploymentVersionIds?.length ?? 0) === 0) {
    return stepFail(
      "worker-missing",
      "cannot register queue consumers: the target Worker has no active deployment yet (activate must run first)",
    );
  }
  try {
    const registered: { binding?: string; queueName: string; consumerId: string; action: "create" | "preserve" | "update" }[] = [];
    for (const binding of consumers) {
      const queue = ctx.snapshot.queues.find((q) => q.name === binding.queueName);
      if (!queue) {
        return stepFail(
          "conflict",
          `Queue "${binding.queueName}" for consumer binding "${binding.binding ?? binding.queueName}" is not present`,
        );
      }
      const live = ctx.snapshot.queueConsumers?.[binding.queueName] ?? [];
      const own = live.find(
        (consumer) => consumer.scriptName === ctx.workerName && (consumer.type === undefined || consumer.type === "worker"),
      );
      if (live.some((consumer) => consumer !== own)) {
        return stepFail(
          "conflict",
          `Queue "${binding.queueName}" already delivers to a consumer that is not this Worker; refusing to add a competing consumer`,
        );
      }
      const request = consumerRequestFor(
        binding.consumer ?? { queue: binding.queueName, type: "worker" },
        ctx.workerName,
      );
      const identity = { ...(binding.binding ? { binding: binding.binding } : {}), queueName: binding.queueName };
      if (own && declaredQueueConsumerMatches(request, { settings: own.settings, dead_letter_queue: own.deadLetterQueue })) {
        registered.push({ ...identity, consumerId: own.consumerId, action: "preserve" });
        continue;
      }
      const consumerId = await registerQueueConsumer(
        ctx.client,
        queue.id,
        own?.consumerId,
        request,
        ctx.beforeMutation,
      );
      registered.push({ ...identity, consumerId, action: own ? "update" : "create" });
    }
    return stepOk({ consumers: registered });
  } catch (error) {
    return toStepFailure(error);
  }
}

// ---------------------------------------------------------------------------
// workflow definitions. A Workflow is an account entity addressed by an
// account-unique name. The carrier class export was verified against the
// prebuilt module exports at prepare, and this step additionally requires the
// exact `{type:"workflow"}` binding to be present in the ACTIVE version
// metadata before it runs. It only ever creates a missing definition or
// updates one owned by this exact Worker script + class; a foreign definition
// refuses before any write. Every write is followed by a GET readback that
// must report the exact identity and the exact sorted direct schedule set
// (the official PUT response omits schedules, so the readback is the only
// proof), and the direct schedule set is authoritative: a definition this
// script owns is updated to exactly the declared set.
// ---------------------------------------------------------------------------

interface ApplyWorkflowsResult {
  workflows: Array<{
    binding: string;
    name: string;
    className: string;
    scriptName: string;
    schedules: string[];
    action: "create" | "update" | "preserve";
  }>;
}

export async function applyWorkflows(
  ctx: DeployStepContext,
  _args: Record<string, unknown>,
): Promise<DeployStepOutcome> {
  const declared = ctx.spec.cloudflare.workflows ?? [];
  if (declared.length === 0) {
    return stepOk({ skipped: true, workflows: [] } satisfies { skipped: true; workflows: ApplyWorkflowsResult["workflows"] });
  }
  if (!ctx.snapshot.workerExists) {
    return stepFail(
      "worker-missing",
      "cannot apply workflows: the target Worker does not exist (create-worker must run first)",
    );
  }
  if ((ctx.snapshot.activeDeploymentVersionIds?.length ?? 0) === 0) {
    return stepFail(
      "worker-missing",
      "cannot apply workflows: the target Worker has no active deployment yet (activate must run first)",
    );
  }
  if (ctx.snapshot.workflows === undefined) {
    return stepFail(
      "validation",
      "account Workflow facts were not read for this snapshot; refusing to apply workflows unverified",
    );
  }
  // The class must be live first: the exact approved binding must be present in
  // the ACTIVE version metadata. Never apply a Workflow the active version does
  // not bind.
  const activeBindings = ctx.snapshot.activeBindings ?? [];
  for (const workflow of declared) {
    const bound = activeBindings.some((binding) => {
      if (binding === null || typeof binding !== "object") return false;
      const entry = binding as Record<string, unknown>;
      return (
        entry["type"] === "workflow" &&
        entry["name"] === workflow.binding &&
        entry["workflow_name"] === workflow.name &&
        entry["class_name"] === workflow.className
      );
    });
    if (!bound) {
      return stepFail(
        "validation",
        `the active Worker version does not carry the exact workflow binding "${workflow.binding}" (${workflow.name}/${workflow.className}); refusing to apply the Workflow before the approved class is live`,
      );
    }
  }
  try {
    const applied: ApplyWorkflowsResult["workflows"] = [];
    for (const workflow of declared) {
      const schedules = [...workflow.schedules].sort();
      const live = ctx.snapshot.workflows.find((candidate) => candidate.name === workflow.name);
      if (live && (live.scriptName !== ctx.workerName || live.className !== workflow.className)) {
        return stepFail(
          "conflict",
          `Workflow "${workflow.name}" is owned by class "${live.className}" of script "${live.scriptName}"; refusing to rewrite a foreign definition`,
        );
      }
      if (live && JSON.stringify([...live.schedules].sort()) === JSON.stringify(schedules)) {
        applied.push({
          binding: workflow.binding,
          name: workflow.name,
          className: workflow.className,
          scriptName: ctx.workerName,
          schedules,
          action: "preserve",
        });
        continue;
      }
      await ctx.beforeMutation?.();
      await ctx.client.updateWorkflow(workflow.name, {
        class_name: workflow.className,
        script_name: ctx.workerName,
        ...(schedules.length > 0 ? { schedules: schedules.map((cron) => ({ cron })) } : {}),
      });
      // The official PUT response does not include schedules: read the exact
      // live definition back before reporting the action.
      const readback = await ctx.client.getWorkflow(workflow.name);
      const readbackSchedules = (readback.schedules ?? []).map((schedule) => schedule.cron).sort();
      if (
        readback.name !== workflow.name ||
        readback.class_name !== workflow.className ||
        readback.script_name !== ctx.workerName ||
        JSON.stringify(readbackSchedules) !== JSON.stringify(schedules)
      ) {
        return stepFail(
          "validation",
          `Workflow "${workflow.name}" readback does not match the declared definition (class "${readback.class_name}", script "${readback.script_name}", schedules [${readbackSchedules.join(", ")}]); the definition is not reported as applied`,
        );
      }
      applied.push({
        binding: workflow.binding,
        name: workflow.name,
        className: workflow.className,
        scriptName: ctx.workerName,
        schedules,
        action: live ? "update" : "create",
      });
    }
    return stepOk({ workflows: applied } satisfies ApplyWorkflowsResult);
  } catch (error) {
    return toStepFailure(error);
  }
}

// An index configuration is complete when it names a preset or both dimensions and metric.
function isCompleteVectorizeConfig(config: VectorizeIndexInputConfig | undefined): config is VectorizeIndexInputConfig {
  return config !== undefined && (config.preset !== undefined || (config.dimensions !== undefined && config.metric !== undefined));
}

// Vectorize indexes. Pure: what would happen to each declared index
// binding given the live indexes.
export function planVectorizeIndexActions(
  spec: DeploySpec,
  snapshot: TargetSnapshot,
): VectorizeAction[] {
  return spec.cloudflare.vectorize.map((binding) =>
    vectorizeActionFor(binding, snapshot.vectorizeIndexes),
  );
}

interface CreateVectorizeIndexesResult {
  indexes: {
    binding: string;
    indexName: string;
    action: "create" | "preserve";
    id: string;
  }[];
}

// Create explicitly-declared missing vectorize indexes; preserve existing ones.
// An existing index is preserved by identity and its dimension/metric config is
// never silently changed in place.
export async function createVectorizeIndexes(
  ctx: DeployStepContext,
  _args: Record<string, unknown>,
): Promise<DeployStepOutcome> {
  if (ctx.spec.cloudflare.vectorize.length === 0) {
    return stepOk({ skipped: true, indexes: [] } satisfies { skipped: true; indexes: CreateVectorizeIndexesResult["indexes"] });
  }
  const actions = planVectorizeIndexActions(ctx.spec, ctx.snapshot);
  // An index is only ever created from an explicit configuration; nothing is defaulted.
  const configFor = (indexName: string) => ctx.spec.cloudflare.vectorize.find((v) => v.indexName === indexName)?.config;
  if (actions.some((action) => action.action === "create" && !isCompleteVectorizeConfig(configFor(action.indexName)))) {
    return stepFail("validation", "Vectorize create requires explicit dimensions and metric; no account mutation performed");
  }
  const conflict = actions.find((a) => a.action === "conflict");
  if (conflict && conflict.action === "conflict") {
    return stepFail("conflict", conflict.detail);
  }
  try {
    const indexes: CreateVectorizeIndexesResult["indexes"] = [];
    for (const action of actions) {
      if (action.action === "preserve") {
        indexes.push({
          binding: action.binding,
          indexName: action.indexName,
          action: "preserve",
          id: action.id,
        });
        continue;
      }
      const config = configFor(action.indexName)!;
      const created = await ensureVectorizeIndex(ctx.client, {
        indexName: action.indexName,
        createIfMissing: true,
        knownIndexes: ctx.snapshot.vectorizeIndexes,
        createRequest: {
          name: action.indexName,
          config: config.preset ? { preset: config.preset } : { dimensions: config.dimensions!, metric: config.metric! },
        },
      });
      indexes.push({
        binding: action.binding,
        indexName: action.indexName,
        action: created.action,
        id: created.id,
      });
    }
    return stepOk({ indexes } satisfies CreateVectorizeIndexesResult);
  } catch (error) {
    return toStepFailure(error);
  }
}
