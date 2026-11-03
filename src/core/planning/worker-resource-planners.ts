// The resource families of a Workers release, each planned against the live
// snapshot: preserve what exists, create what is declared and permitted, and
// block what cannot be done safely. Read-only: nothing here mutates, and secret
// values are never part of any plan output.

import { plannedDatabaseActionFor } from "../../cloudflare/resources/d1.js";
import { plannedNamespaceActionFor } from "../../cloudflare/resources/kv.js";
import { consumerRequestFor, declaredQueueConsumerMatches } from "../../cloudflare/resources/queues.js";
import type { DeploySpec } from "../deploy-spec.js";
import { planDomainGuards } from "./plan-domains.js";
import { deployedRebindGuards, expectedDeployedRebindGuards } from "./rebind-guards.js";
import type { ExpectedTarget, PlanGuard, PlanResource, ResourceDiff, SecretPlanSummary, TargetSnapshot } from "./types.js";

/** What every resource-family planner of a Workers release reads and the diffs and guards it adds to. */
export interface PlanContext {
  spec: DeploySpec;
  snapshot: TargetSnapshot;
  expected: ExpectedTarget | undefined;
  isInstall: boolean;
  providedElsewhere: (kind: string, name: string) => boolean;
  providedSkip: (resource: PlanResource, name: string) => ResourceDiff;
  diffs: ResourceDiff[];
  guards: PlanGuard[];
}

// R2
function planR2(c: PlanContext): void {
  const { spec, snapshot, expected, providedElsewhere, providedSkip, diffs, guards } = c;
  const snapshotBucket = new Map(snapshot.r2Buckets.map((b) => [b.name, b.id]));
  for (const binding of spec.cloudflare.r2) {
    const remoteId = snapshotBucket.get(binding.bucketName);
    if (remoteId) {
      diffs.push({
        resource: "r2",
        action: "preserve",
        name: binding.bucketName,
        before: remoteId,
        after: remoteId,
      });
    } else {
      if (binding.createIfMissing) {
        diffs.push({ resource: "r2", action: "create", name: binding.bucketName });
      } else if (providedElsewhere("r2", binding.bucketName)) {
        diffs.push(providedSkip("r2", binding.bucketName));
      } else {
        diffs.push({
          resource: "r2",
          action: "conflict",
          name: binding.bucketName,
          detail: "declared bucket does not exist and createIfMissing=false",
        });
        guards.push({
          code: "r2-drift",
          level: "block",
          detail: `Declared R2 bucket "${binding.bucketName}" is missing and createIfMissing=false`,
        });
      }
    }
  }

  if (expected?.r2BucketIds) {
    for (const [name, id] of Object.entries(expected.r2BucketIds)) {
      const remoteId = snapshotBucket.get(name);
      if (remoteId && remoteId !== id) {
        guards.push({
          code: "r2-drift",
          level: "block",
          detail: `R2 bucket "${name}" identity changed (${id} -> ${remoteId}); refuse to re-deploy onto a changed mapping`,
        });
      }
    }
  }
}

// a declared binding must not silently rebind to a different
// account resource on upgrade. The existing R2 guard above only covers R2;
// this generalizes it to D1/KV/Queue/Hyperdrive/Vectorize/Secrets Store. On
// upgrade, a binding that is already present on the deployed Worker and
// currently points at a resource whose name/id differs from the spec's
// declared target is an unapproved remap and blocks (fail closed). Installs
// and bindings with no deployed entry are unaffected; a missing scope yields an
// empty deployed map and therefore cannot verify (the provider fails closed on
// the later write with the real permission error).
function planDeployedBindingGuards(c: PlanContext): void {
  const { spec, snapshot, expected, isInstall, guards } = c;
  if (!isInstall) {
    guards.push(...deployedRebindGuards(snapshot, spec));
  }

  // expected deployed-binding drift. When the plan reference carries
  // the full deployed binding map, an outside rebind between plan and write
  // blocks even if the spec itself is unchanged.
  if (expected?.deployedBindings) {
    guards.push(...expectedDeployedRebindGuards(snapshot, expected));
  }
}

// D1 databases. Preserve by identity; create only when declared +
// permitted; conflict (missing + createIfMissing=false) blocks. A declared
// provider id is an identity claim verified by plannedDatabaseActionFor: a
// name/id mismatch or an absent id fails closed and is never recreated.
function planD1(c: PlanContext): void {
  const { spec, snapshot, providedElsewhere, providedSkip, diffs, guards } = c;
  const snapshotDatabase = new Map(snapshot.d1Databases.map((d) => [d.name, d.id]));
  for (const binding of spec.cloudflare.d1) {
    if (binding.databaseId !== undefined) {
      const action = plannedDatabaseActionFor(
        { binding: binding.binding, databaseName: binding.databaseName, databaseId: binding.databaseId },
        snapshot.d1Databases,
        { createIfMissing: binding.createIfMissing },
      );
      if (action.action === "preserve") {
        diffs.push({
          resource: "d1",
          action: "preserve",
          name: action.databaseName,
          before: action.id,
          after: action.id,
        });
      } else {
        // With a declared provider id the resolver only ever preserves or
        // conflicts (an id is never recreated); the fallback covers the type
        // union without inventing a creation path.
        const detail = action.action === "conflict"
          ? action.detail
          : `declared database_id for binding "${binding.binding}" cannot be provisioned from a provider id; refusing`;
        diffs.push({
          resource: "d1",
          action: "conflict",
          name: binding.databaseName,
          detail,
        });
        guards.push({
          code: "d1-drift",
          level: "block",
          detail,
        });
      }
      continue;
    }
    const remoteId = snapshotDatabase.get(binding.databaseName);
    if (remoteId) {
      diffs.push({
        resource: "d1",
        action: "preserve",
        name: binding.databaseName,
        before: remoteId,
        after: remoteId,
      });
    } else if (binding.createIfMissing) {
      diffs.push({ resource: "d1", action: "create", name: binding.databaseName });
    } else if (providedElsewhere("d1", binding.databaseName)) {
      diffs.push(providedSkip("d1", binding.databaseName));
    } else {
      diffs.push({
        resource: "d1",
        action: "conflict",
        name: binding.databaseName,
        detail: "declared database does not exist and createIfMissing=false",
      });
      guards.push({
        code: "d1-drift",
        level: "block",
        detail: `Declared D1 database "${binding.databaseName}" is missing and createIfMissing=false`,
      });
    }
  }
}

// KV namespaces. Preserve by identity; create only when declared +
// permitted; conflict (missing + createIfMissing=false) blocks.
// a declared provider id is verified by plannedNamespaceActionFor (the
// same resolver planWranglerResourceActions uses): exactly one live
// namespace by id preserves under its real name, anything else conflicts
// and blocks. A namespace is never created from a wrangler binding.
function planKv(c: PlanContext): void {
  const { spec, snapshot, diffs, guards } = c;
  const snapshotNamespace = new Map(snapshot.kvNamespaces.map((n) => [n.name, n.id]));
  for (const binding of spec.cloudflare.kv) {
    if (binding.namespaceId !== undefined) {
      const action = plannedNamespaceActionFor(
        { binding: binding.binding, namespaceId: binding.namespaceId },
        snapshot.kvNamespaces,
      );
      if (action.action === "preserve") {
        diffs.push({
          resource: "kv",
          action: "preserve",
          name: action.namespaceName,
          before: action.id,
          after: action.id,
        });
      } else {
        // With a declared provider id the resolver only ever preserves or
        // conflicts (a namespace is never created from a wrangler binding);
        // the fallback covers the type union without inventing one.
        const detail = action.action === "conflict"
          ? action.detail
          : `KV namespace for binding "${binding.binding}" cannot be created from a wrangler binding`;
        diffs.push({
          resource: "kv",
          action: "conflict",
          name: binding.namespaceId,
          detail,
        });
        guards.push({
          code: "kv-drift",
          level: "block",
          detail,
        });
      }
      continue;
    }
    const remoteId = snapshotNamespace.get(binding.namespaceName);
    if (remoteId) {
      diffs.push({
        resource: "kv",
        action: "preserve",
        name: binding.namespaceName,
        before: remoteId,
        after: remoteId,
      });
    } else if (binding.createIfMissing) {
      diffs.push({ resource: "kv", action: "create", name: binding.namespaceName });
    } else {
      diffs.push({
        resource: "kv",
        action: "conflict",
        name: binding.namespaceName,
        detail: "declared namespace does not exist and createIfMissing=false",
      });
      guards.push({
        code: "kv-drift",
        level: "block",
        detail: `Declared KV namespace "${binding.namespaceName}" is missing and createIfMissing=false`,
      });
    }
  }
}

// Queues. Preserve by identity; create only when declared + permitted;
// conflict (missing + createIfMissing=false) blocks.
function planQueues(c: PlanContext): void {
  const { spec, snapshot, providedElsewhere, providedSkip, diffs, guards } = c;
  const snapshotQueue = new Map(snapshot.queues.map((q) => [q.name, q.id]));
  for (const binding of spec.cloudflare.queues) {
    const remoteId = snapshotQueue.get(binding.queueName);
    if (remoteId) {
      diffs.push({
        resource: "queue",
        action: "preserve",
        name: binding.queueName,
        before: remoteId,
        after: remoteId,
      });
    } else if (binding.createIfMissing) {
      diffs.push({ resource: "queue", action: "create", name: binding.queueName });
    } else if (providedElsewhere("queue", binding.queueName)) {
      diffs.push(providedSkip("queue", binding.queueName));
    } else {
      diffs.push({
        resource: "queue",
        action: "conflict",
        name: binding.queueName,
        detail: "declared queue does not exist and createIfMissing=false",
      });
      guards.push({
        code: "queue-drift",
        level: "block",
        detail: `Declared Queue "${binding.queueName}" is missing and createIfMissing=false`,
      });
    }
  }
}

// consumer triggers. A consumer/both queue binding registers a trigger
// on the queue's consumers subresource AFTER the Worker version is live, so
// the trigger is its own action with its own receipt. Our own exactly
// matching consumer is preserved (idempotent redeploy), our own consumer with
// different declared settings is updated in place, a foreign consumer is
// refused outright (never overwritten, never a competing consumer added),
// and a queue with no consumer is created.
function planQueueConsumers(c: PlanContext): void {
  const { spec, snapshot, diffs, guards } = c;
  for (const binding of spec.cloudflare.queues) {
    if (binding.role !== "consumer" && binding.role !== "both") continue;
    const liveConsumers = snapshot.queueConsumers?.[binding.queueName] ?? [];
    const own = liveConsumers.find(
      (consumer) => consumer.scriptName === spec.cloudflare.workerName && (consumer.type === undefined || consumer.type === "worker"),
    );
    const foreign = liveConsumers.filter((consumer) => consumer !== own);
    if (foreign.length > 0) {
      diffs.push({
        resource: "queue-consumer",
        action: "conflict",
        name: binding.queueName,
        detail: `queue "${binding.queueName}" already delivers to another consumer; overwriting or competing with it is refused`,
      });
      guards.push({
        code: "queue-drift",
        level: "block",
        detail: `Queue "${binding.queueName}" has a consumer that is not this Worker; refusal before any trigger change`,
      });
      continue;
    }
    const request = consumerRequestFor(
      binding.consumer ?? { queue: binding.queueName, type: "worker" },
      spec.cloudflare.workerName,
    );
    if (!own) {
      diffs.push({ resource: "queue-consumer", action: "create", name: binding.queueName });
    } else if (declaredQueueConsumerMatches(request, { settings: own.settings, dead_letter_queue: own.deadLetterQueue })) {
      diffs.push({
        resource: "queue-consumer",
        action: "preserve",
        name: binding.queueName,
        before: own.consumerId,
        after: own.consumerId,
      });
    } else {
      diffs.push({
        resource: "queue-consumer",
        action: "update",
        name: binding.queueName,
        before: own.consumerId,
        after: own.consumerId,
      });
    }
  }
}

// workflow definitions. A workflow is an account entity whose name is
// unique per account; the class export was verified at prepare and the
// binding rides the version metadata. A missing definition is created after
// the cutover, a definition this exact script+class owns is preserved when
// the declared direct schedule set matches and updated otherwise (the
// declared set is authoritative), and a definition owned by another
// class/script is refused outright — never overwritten. Workflow facts are
// read only when a workflow is declared; without them the plan refuses
// rather than assuming absence.
function planWorkflowDefinitions(c: PlanContext): void {
  const { spec, snapshot, diffs, guards } = c;
  for (const workflow of spec.cloudflare.workflows ?? []) {
    if (snapshot.workflows === undefined) {
      guards.push({
        code: "contradictory-manifest",
        level: "block",
        detail: `Workflow "${workflow.name}" is declared but live account Workflow facts were not read; refusing to plan an unverified definition`,
      });
      continue;
    }
    const live = snapshot.workflows.find((candidate) => candidate.name === workflow.name);
    if (!live) {
      diffs.push({ resource: "workflow", action: "create", name: workflow.name });
      continue;
    }
    if (live.scriptName !== spec.cloudflare.workerName || live.className !== workflow.className) {
      diffs.push({
        resource: "workflow",
        action: "conflict",
        name: workflow.name,
        detail: `workflow "${workflow.name}" is owned by class "${live.className}" of script "${live.scriptName}"; overwriting a foreign definition is refused`,
      });
      guards.push({
        code: "workflow-drift",
        level: "block",
        detail: `Workflow "${workflow.name}" is defined by class "${live.className}" of script "${live.scriptName}"; refusing to rewrite or compete with a foreign definition`,
      });
      continue;
    }
    const declaredSchedules = [...workflow.schedules].sort();
    const liveSchedules = [...live.schedules].sort();
    if (JSON.stringify(declaredSchedules) === JSON.stringify(liveSchedules)) {
      diffs.push({
        resource: "workflow",
        action: "preserve",
        name: workflow.name,
        before: live.id,
        after: live.id,
      });
    } else {
      diffs.push({
        resource: "workflow",
        action: "update",
        name: workflow.name,
        before: live.id,
        after: live.id,
        detail: `direct schedules change from [${liveSchedules.join(", ")}] to [${declaredSchedules.join(", ")}]`,
      });
    }
  }
}

// Hyperdrive configs. Preserve by identity; a missing config blocks (never created).
function planHyperdrive(c: PlanContext): void {
  const { spec, snapshot, diffs, guards } = c;
  const snapshotHyperdrive = new Map(snapshot.hyperdriveConfigs.map((c) => [c.name, c.id]));
  for (const binding of spec.cloudflare.hyperdrive) {
    const remoteId = snapshotHyperdrive.get(binding.configName);
    if (remoteId) {
      diffs.push({
        resource: "hyperdrive",
        action: "preserve",
        name: binding.configName,
        before: remoteId,
        after: remoteId,
      });
    } else {
      diffs.push({
        resource: "hyperdrive",
        action: "conflict",
        name: binding.configName,
        detail: "Hyperdrive configuration not found in this account",
      });
      guards.push({
        code: "hyperdrive-drift",
        level: "block",
        detail: `Binding ${binding.binding} needs a Hyperdrive configuration of this account ("${binding.configName}" was not found). Hyperdrive holds your own database connection: create it in the Cloudflare dashboard, then choose it here.`,
      });
    }
  }
}

// Vectorize indexes. Preserve by identity; create only when declared +
// permitted; conflict (missing + createIfMissing=false) blocks. An existing
// index's dimension/metric config is immutable on the live resource and is
// never silently changed in place.
function planVectorize(c: PlanContext): void {
  const { spec, snapshot, providedElsewhere, providedSkip, diffs, guards } = c;
  const snapshotVectorize = new Map(snapshot.vectorizeIndexes.map((c) => [c.name, c.id]));
  for (const binding of spec.cloudflare.vectorize) {
    const remoteId = snapshotVectorize.get(binding.indexName);
    if (remoteId) {
      diffs.push({
        resource: "vectorize",
        action: "preserve",
        name: binding.indexName,
        before: remoteId,
        after: remoteId,
      });
    } else if (binding.createIfMissing) {
      diffs.push({ resource: "vectorize", action: "create", name: binding.indexName });
    } else if (providedElsewhere("vectorize", binding.indexName)) {
      diffs.push(providedSkip("vectorize", binding.indexName));
    } else {
      diffs.push({
        resource: "vectorize",
        action: "conflict",
        name: binding.indexName,
        detail: "Vectorize index not found in this account",
      });
      guards.push({
        code: "vectorize-drift",
        level: "block",
        detail: `Binding ${binding.binding} needs the Vectorize index "${binding.indexName}", which does not exist in this account. The app's config can declare it (with dimensions and metric) so it is created, or create it first.`,
      });
    }
  }
}

// Secrets Store stores. Preserve by identity; a missing store blocks (never created).
function planSecretsStore(c: PlanContext): void {
  const { spec, snapshot, diffs, guards } = c;
  const snapshotSecretsStore = new Map(snapshot.secretsStores.map((c) => [c.name, c.id]));
  for (const binding of spec.cloudflare.secretsStore) {
    const remoteId = snapshotSecretsStore.get(binding.storeName);
    if (remoteId) {
      diffs.push({
        resource: "secrets-store",
        action: "preserve",
        name: binding.storeName,
        before: remoteId,
        after: remoteId,
      });
    } else {
      diffs.push({
        resource: "secrets-store",
        action: "conflict",
        name: binding.storeName,
        detail: "Secrets Store not found in this account",
      });
      guards.push({
        code: "secrets-store-drift",
        level: "block",
        detail: `Binding ${binding.binding} needs a Secrets Store in this account; create one in the Cloudflare dashboard and add the secret "${binding.secretName ?? ""}" to it.`,
      });
    }
  }

  // Secrets Store secrets. A declared secret that is missing inside a present
  // store conflicts: the installer never creates it (the value is the user's own).
  for (const binding of spec.cloudflare.secretsStore) {
    if (!binding.secretName) continue;
    const storeId = snapshotSecretsStore.get(binding.storeName);
    if (!storeId) continue;
    const secret = snapshot.secretsStoreSecrets.find(
      (s) => s.store_id === storeId && s.secretName === binding.secretName,
    );
    if (secret) {
      diffs.push({
        resource: "secrets-store",
        action: "preserve",
        name: `${binding.storeName}/${binding.secretName}`,
        before: secret.id,
      });
    } else {
      diffs.push({
        resource: "secrets-store",
        action: "conflict",
        name: `${binding.storeName}/${binding.secretName}`,
        detail: "secret not found in the Secrets Store",
      });
      guards.push({
        code: "secrets-store-drift",
        level: "block",
        detail: `Binding ${binding.binding} needs the secret "${binding.secretName}" in your Secrets Store "${binding.storeName}"; add it in the Cloudflare dashboard (its value is yours, never the app's), then plan again.`,
      });
    }
  }
}

// opt-in domain/route/DNS changes. Each entry is an explicit
// pre-authorized intent; the plan only ever diff/guards it, never mutates.
function planDomains(c: PlanContext): void {
  const { spec, snapshot, diffs, guards } = c;
  const domains = spec.cloudflare.domains ?? [];
  if (domains.length > 0) {
    guards.push(...planDomainGuards(diffs, domains, snapshot, spec.cloudflare.workerName));
  }
}

// Secrets: names and policies only, never values.
function planSecrets(c: PlanContext): SecretPlanSummary[] {
  const { spec, snapshot, expected, diffs, guards } = c;
  const secretSummary: SecretPlanSummary[] = [];
  for (const [name, policy] of Object.entries(spec.cloudflare.secrets)) {
    const exists = snapshot.secretNames.includes(name);
    secretSummary.push({ name, policy, exists });
    // Kept when it exists unless the operator supplies a value; a missing
    // optional one left empty is not set.
    diffs.push(policy === "supplied"
      ? { resource: "secret", action: exists ? "update" : "create", name }
      : exists
        ? { resource: "secret", action: "preserve", name }
        : policy === "optional"
          ? { resource: "secret", action: "skip", name, detail: "optional and left empty: not set" }
          : { resource: "secret", action: "create", name });
  }

  if (expected?.secretNames) {
    for (const name of expected.secretNames) {
      if (!snapshot.secretNames.includes(name)) {
        guards.push({
          code: "secret-drift",
          level: "block",
          detail: `Previously tracked secret "${name}" is no longer present; abort to avoid re-creation drift`,
        });
      }
    }
  }
  return secretSummary;
}

// Schedule
function planScheduleAndRateLimits(c: PlanContext): void {
  const { spec, snapshot, isInstall, diffs } = c;
  const cronsEqual =
    JSON.stringify([...spec.cloudflare.cron].sort()) ===
    JSON.stringify([...snapshot.scheduleCrons].sort());
  if (spec.cloudflare.cron.length > 0 || snapshot.scheduleCrons.length > 0) {
    diffs.push({
      resource: "schedule",
      action: cronsEqual ? "preserve" : isInstall ? "create" : "update",
    });
  }

  // Rate limits: v1 declares none; never touch an existing non-empty set.
  if (snapshot.rateLimitCount > 0) {
    diffs.push({ resource: "rate-limit", action: "preserve" });
  }
}

/** Plans every resource family of a Workers release in order; returns the secrets' names and policies for the plan summary. */
export function planWorkerResources(ctx: PlanContext): SecretPlanSummary[] {
  planR2(ctx);
  planDeployedBindingGuards(ctx);
  planD1(ctx);
  planKv(ctx);
  planQueues(ctx);
  planQueueConsumers(ctx);
  planWorkflowDefinitions(ctx);
  planHyperdrive(ctx);
  planVectorize(ctx);
  planSecretsStore(ctx);
  planDomains(ctx);
  const secretSummary = planSecrets(ctx);
  planScheduleAndRateLimits(ctx);
  return secretSummary;
}
