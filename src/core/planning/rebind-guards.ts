// Rebind guards: an upgrade must not silently move a Worker binding to a
// different account resource, and an outside rebind between plan and write
// blocks. Read-only: nothing here mutates.

import type { DeploySpec } from "../deploy-spec.js";
import type { ExpectedTarget, PlanGuard, TargetSnapshot } from "./types.js";

// refuse a declared binding that would silently rebind to a different
// account resource on upgrade. Each family compares the deployed binding target
// (if present) against the spec's declared target:
//   r2                  bucket_name   (name)        -> spec bucketName
//   d1                  id            (id)          -> declared database id
//   kv                  namespace_id  (id)          -> declared namespace id
//   queue               queue_name    (name)        -> spec queueName
//   vectorize           index_name    (name)        -> spec indexName
//   secrets_store       {store_id, secret_name}     -> spec storeName/secretName
// A binding that is absent on the deployed Worker (new binding) or whose target
// matches is left alone, as is one the config lets the user swap on upgrade
// (`changeOnUpgrade`); only an unapproved remap is blocked. Ids are resolved
// against the live account-resource snapshot so a rename is not mistaken for a
// rebind. Missing worker/scope yields an empty map and cannot verify (the later
// write fails closed with the real permission error).
export function deployedRebindGuards(
  snapshot: TargetSnapshot,
  spec: DeploySpec,
): PlanGuard[] {
  const guards: PlanGuard[] = [];
  const bindings = snapshot.deployedBindings ?? {};
  // R2: compare bucket name.
  for (const b of spec.cloudflare.r2) {
    const live = bindings.r2?.[b.binding];
    if (live !== undefined && live !== b.bucketName && !b.changeOnUpgrade) {
      guards.push(rebindGuard("r2", b.binding, live, b.bucketName));
    }
  }
  // D1: compare resolved database id.
  const dbIds = new Map(snapshot.d1Databases.map((d) => [d.name, d.id]));
  for (const b of spec.cloudflare.d1) {
    const live = bindings.d1?.[b.binding];
    const declaredId = dbIds.get(b.databaseName);
    if (live !== undefined && declaredId && live !== declaredId && !b.changeOnUpgrade) {
      guards.push(rebindGuard("d1", b.binding, describeBindingId(live), describeBindingId(declaredId)));
    }
  }
  // KV: compare resolved namespace id.
  const nsIds = new Map(snapshot.kvNamespaces.map((n) => [n.name, n.id]));
  for (const b of spec.cloudflare.kv) {
    const live = bindings.kv?.[b.binding];
    const declaredId = nsIds.get(b.namespaceName);
    if (live !== undefined && declaredId && live !== declaredId && !b.changeOnUpgrade) {
      guards.push(rebindGuard("kv", b.binding, describeBindingId(live), describeBindingId(declaredId)));
    }
  }
  // Queue: compare queue name (producer bindings only; a consumer-only queue
  // has no Worker environment binding to rebind).
  for (const b of spec.cloudflare.queues) {
    if (b.binding === undefined) continue;
    const live = bindings.queue?.[b.binding];
    if (live !== undefined && live !== b.queueName && !b.changeOnUpgrade) {
      guards.push(rebindGuard("queue", b.binding, live, b.queueName));
    }
  }
  // Hyperdrive is not compared: the user picks the configuration in the
  // Configure step, so moving to another one is their explicit choice.
  // Vectorize: compare index name.
  for (const b of spec.cloudflare.vectorize) {
    const live = bindings.vectorize?.[b.binding];
    if (live !== undefined && live !== b.indexName && !b.changeOnUpgrade) {
      guards.push(rebindGuard("vectorize", b.binding, live, b.indexName));
    }
  }
  // Secrets Store: compare {store_id, secret_name} resolved from the spec.
  const storeIds = new Map(snapshot.secretsStores.map((s) => [s.name, s.id]));
  for (const b of spec.cloudflare.secretsStore) {
    if (!b.secretName) continue;
    const live = bindings.secretsStore?.[b.binding];
    const storeId = storeIds.get(b.storeName);
    if (live && storeId && (live.storeId !== storeId || live.secretName !== b.secretName)) {
      guards.push(
        rebindGuard(
          "secrets-store",
          b.binding,
          `${b.storeName}/${b.secretName}`,
          `${b.storeName}/${b.secretName}`,
          `expected store ${storeId} secret ${b.secretName} but binding points at store ${live.storeId} secret ${live.secretName}`,
        ),
      );
    }
  }
  return guards;
}

// an outside rebind between plan creation and a write. Compares the
// plan-time deployed binding map (carried in `expected`) against the fresh
// snapshot. An own write that legitimately advances a binding (e.g. the binding
// is being remapped by this very plan after explicit approval) is handled by the
// caller passing the post-approval reference; a genuine outside change blocks.
// a binding that was present at plan time and is now MISSING is drift too
// (`now !== expected`, so undefined is a mismatch). Approved removals are not
// wired yet, so a disappearance is always treated as an outside change.
export function expectedDeployedRebindGuards(
  snapshot: TargetSnapshot,
  expected: ExpectedTarget,
): PlanGuard[] {
  const guards: PlanGuard[] = [];
  const planBindings = expected.deployedBindings ?? {};
  const nowBindings = snapshot.deployedBindings ?? {};
  // R2
  for (const [binding, bucket] of Object.entries(planBindings.r2 ?? {})) {
    const now = nowBindings.r2?.[binding];
    if (now !== bucket) {
      guards.push(rebindGuard("r2", binding, bucket, now ?? "missing", `outside rebind (${bucket} -> ${now ?? "missing"})`));
    }
  }
  // D1
  for (const [binding, id] of Object.entries(planBindings.d1 ?? {})) {
    const now = nowBindings.d1?.[binding];
    if (now !== id) {
      guards.push(rebindGuard("d1", binding, describeBindingId(id), now === undefined ? "missing" : describeBindingId(now)));
    }
  }
  // KV
  for (const [binding, id] of Object.entries(planBindings.kv ?? {})) {
    const now = nowBindings.kv?.[binding];
    if (now !== id) {
      guards.push(rebindGuard("kv", binding, describeBindingId(id), now === undefined ? "missing" : describeBindingId(now)));
    }
  }
  // Queue
  for (const [binding, q] of Object.entries(planBindings.queue ?? {})) {
    const now = nowBindings.queue?.[binding];
    if (now !== q) {
      guards.push(rebindGuard("queue", binding, q, now ?? "missing"));
    }
  }
  // Hyperdrive
  for (const [binding, id] of Object.entries(planBindings.hyperdrive ?? {})) {
    const now = nowBindings.hyperdrive?.[binding];
    if (now !== id) {
      guards.push(rebindGuard("hyperdrive", binding, describeBindingId(id), now === undefined ? "missing" : describeBindingId(now)));
    }
  }
  // Vectorize
  for (const [binding, idx] of Object.entries(planBindings.vectorize ?? {})) {
    const now = nowBindings.vectorize?.[binding];
    if (now !== idx) {
      guards.push(rebindGuard("vectorize", binding, idx, now ?? "missing"));
    }
  }
  // Secrets Store
  for (const [binding, want] of Object.entries(planBindings.secretsStore ?? {})) {
    const now = nowBindings.secretsStore?.[binding];
    if (!now || now.storeId !== want.storeId || now.secretName !== want.secretName) {
      guards.push(
        rebindGuard(
          "secrets-store",
          binding,
          `${want.storeId}/${want.secretName}`,
          now ? `${now.storeId}/${now.secretName}` : "missing",
          `outside rebind (${want.storeId}/${want.secretName} -> ${now ? `${now.storeId}/${now.secretName}` : "missing"})`,
        ),
      );
    }
  }
  return guards;
}

function rebindGuard(
  family: string,
  binding: string,
  before: string,
  after: string,
  detail?: string,
): PlanGuard {
  const code = (family === "r2" ? "r2" : family === "d1" ? "d1" : family === "kv" ? "kv" : family === "queue" ? "queue" : family === "hyperdrive" ? "hyperdrive" : family === "vectorize" ? "vectorize" : "secrets-store") + "-drift";
  return {
    code: code as PlanGuard["code"],
    level: "block",
    detail:
      detail ??
      `Binding "${binding}" currently maps to ${before}; refusing to remap to ${after} without explicit approval`,
  };
}

function describeBindingId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}
