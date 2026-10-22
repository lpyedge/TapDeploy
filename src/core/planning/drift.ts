// Pre-write drift check. A plan is bound to the remote snapshot it was built
// from; before any mutation the remote state is re-read and compared
// against that base. Any identity change means a concurrent planner or manual
// change happened, and the write must abort — zero mutations from a stale plan.

import type { DeployPlan, DeployedBindingMap, ExpectedTarget, TargetSnapshot } from "./types.js";
import { canonicalJson } from "./digest.js";

export function domainBaseline(snapshot: TargetSnapshot, names: string[]): NonNullable<ExpectedTarget["domainBaseline"]> {
  const normalized = [...new Set(names.map(n => n.toLowerCase().replace(/\.$/, "")))].sort();
  const has = (name: string) => normalized.includes(name.toLowerCase().replace(/\.$/, ""));
  const sorted = <T>(items: T[]): T[] => items.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  return {
    names: normalized, zones: sorted([...(snapshot.zones ?? [])]),
    dnsRecords: sorted((snapshot.dnsRecords ?? []).filter(r => has(r.name))),
    workerRoutes: sorted((snapshot.workerRoutes ?? []).filter(r => has(r.pattern))),
    workerDomains: sorted((snapshot.workerDomains ?? []).filter(r => has(r.hostname))),
    pagesDomains: sorted((snapshot.pagesDomains ?? []).filter(r => has(r.name)).map(({ status: _status, ...identity }) => identity)),
  };
}

export interface DriftResult {
  drifted: boolean;
  reasons: string[];
}

export function planReference(plan: DeployPlan, snapshot?: TargetSnapshot): ExpectedTarget {
  const names = plan.diffs.filter(d => ["dns-record", "worker-route", "worker-custom-domain", "pages-custom-domain"].includes(d.resource)).flatMap(d => d.name ? [d.name] : []);
  const pagesProjectId = snapshot?.pagesProjectId ?? plan.pagesProjectId;
  return {
    missingResources: Object.fromEntries(resourceIdentityFamilies.map(([resource, ids]) => [ids, plan.diffs.filter(diff => diff.resource === resource && diff.action === "create" && diff.name).map(diff => diff.name!)])),
    ...(snapshot && names.length ? { domainBaseline: domainBaseline(snapshot, names) } : {}),
    accountId: plan.accountId,
    workerName: plan.workerName,
    ...(pagesProjectId ? { pagesProjectId } : {}),
    activeDeploymentId: plan.activeDeploymentId,
    r2BucketIds: Object.fromEntries(
      plan.diffs
        .filter((d) => d.resource === "r2" && d.action === "preserve" && d.name && d.before)
        .map((d) => [d.name!, d.before!]),
    ),
    // bind D1 + KV identities so a changed resource mapping blocks the write.
    d1DatabaseIds: Object.fromEntries(
      plan.diffs
        .filter((d) => d.resource === "d1" && d.action === "preserve" && d.name && d.before)
        .map((d) => [d.name!, d.before!]),
    ),
    kvNamespaceIds: Object.fromEntries(
      plan.diffs
        .filter((d) => d.resource === "kv" && d.action === "preserve" && d.name && d.before)
        .map((d) => [d.name!, d.before!]),
    ),
    queueIds: Object.fromEntries(
      plan.diffs
        .filter((d) => d.resource === "queue" && d.action === "preserve" && d.name && d.before)
        .map((d) => [d.name!, d.before!]),
    ),
    hyperdriveConfigIds: Object.fromEntries(
      plan.diffs
        .filter((d) => d.resource === "hyperdrive" && d.action === "preserve" && d.name && d.before)
        .map((d) => [d.name!, d.before!]),
    ),
    hyperdriveOrigins: Object.fromEntries((snapshot?.hyperdriveConfigs ?? []).filter(config => config.origin && plan.diffs.some(diff => diff.resource === "hyperdrive" && diff.name === config.name)).map(config => [config.name, { ...config.origin! }])),
    vectorizeConfigs: Object.fromEntries((snapshot?.vectorizeIndexes ?? []).filter(index => index.config && plan.diffs.some(diff => diff.resource === "vectorize" && diff.name === index.name)).map(index => [index.name, { ...index.config! }])),
    vectorizeIndexIds: Object.fromEntries(
      plan.diffs
        .filter((d) => d.resource === "vectorize" && d.action === "preserve" && d.name && d.before)
        .map((d) => [d.name!, d.before!]),
    ),
    // Store identities only: a secret's diff is named `<store>/<secret>` and is
    // not a store, so it never belongs to the store-id baseline.
    secretsStoreIds: Object.fromEntries(
      plan.diffs
        .filter((d) => d.resource === "secrets-store" && d.action === "preserve" && d.name && !d.name.includes("/") && d.before)
        .map((d) => [d.name!, d.before!]),
    ),
    // carry the verified deployed binding map when the caller
    // supplies the snapshot the plan was built from. Older single-arg callers
    // stay compatible (field undefined, drift check skips it).
    ...(snapshot?.workerR2Bindings ? { workerR2Bindings: { ...snapshot.workerR2Bindings } } : {}),
    // carry the full deployed binding map so a rebind of any family
    // between plan and write blocks. The R2 subset is also carried above for
    // backward compatibility with older references.
    ...(snapshot?.deployedBindings
      ? { deployedBindings: cloneDeployedBindings(snapshot.deployedBindings) }
      : {}),
    // Track only secrets that already exist: the drift guard protects a
    // previously-present secret from disappearing. Declared-but-absent secrets
    // are being created by this plan and must not block their own re-plan.
    secretNames: plan.secretSummary.filter((s) => s.exists).map((s) => s.name),
    // bind the target kind + mode so a changed account/mode/target
    // invalidates the plan and prompts re-confirmation.
    targetKind: plan.targetKind,
    mode: plan.kind,
  };
}

export function detectDrift(
  reference: ExpectedTarget,
  current: TargetSnapshot,
): DriftResult {
  const reasons: string[] = [];
  reasons.push(...resourceBaselineDrift(reference, current));
  if (reference.domainBaseline && canonicalJson(reference.domainBaseline) !== canonicalJson(domainBaseline(current, reference.domainBaseline.names))) {
    reasons.push("approved domain/route/DNS identity or configuration changed");
  }

  if (reference.accountId !== current.accountId) {
    reasons.push(`account changed (${reference.accountId} -> ${current.accountId})`);
  }
  if (reference.workerName !== current.workerName) {
    reasons.push(
      `worker name changed (${reference.workerName} -> ${current.workerName})`,
    );
  }
  if (
    reference.activeDeploymentId !== undefined &&
    reference.activeDeploymentId !== current.activeDeploymentId
  ) {
    reasons.push(
      `active deployment id changed (${reference.activeDeploymentId} -> ${current.activeDeploymentId})`,
    );
  }
  if (reference.r2BucketIds) {
    const currentIds = new Map(current.r2Buckets.map((b) => [b.name, b.id]));
    for (const [name, id] of Object.entries(reference.r2BucketIds)) {
      const now = currentIds.get(name);
      if (now !== id) {
        reasons.push(`R2 bucket "${name}" identity changed (${id} -> ${now ?? "missing"})`);
      }
    }
  }
  // D1 database + KV namespace identity drift.
  if (reference.d1DatabaseIds) {
    const currentIds = new Map(current.d1Databases.map((d) => [d.name, d.id]));
    for (const [name, id] of Object.entries(reference.d1DatabaseIds)) {
      const now = currentIds.get(name);
      if (now !== id) {
        reasons.push(`D1 database "${name}" identity changed (${id} -> ${now ?? "missing"})`);
      }
    }
  }
  if (reference.kvNamespaceIds) {
    const currentIds = new Map(current.kvNamespaces.map((n) => [n.name, n.id]));
    for (const [name, id] of Object.entries(reference.kvNamespaceIds)) {
      const now = currentIds.get(name);
      if (now !== id) {
        reasons.push(`KV namespace "${name}" identity changed (${id} -> ${now ?? "missing"})`);
      }
    }
  }
  // Queue + Hyperdrive config identity drift.
  if (reference.queueIds) {
    const currentIds = new Map(current.queues.map((q) => [q.name, q.id]));
    for (const [name, id] of Object.entries(reference.queueIds)) {
      const now = currentIds.get(name);
      if (now !== id) {
        reasons.push(`Queue "${name}" identity changed (${id} -> ${now ?? "missing"})`);
      }
    }
  }
  if (reference.hyperdriveConfigIds) {
    const currentIds = new Map(current.hyperdriveConfigs.map((c) => [c.name, c.id]));
    for (const [name, id] of Object.entries(reference.hyperdriveConfigIds)) {
      const now = currentIds.get(name);
      if (now !== id) {
        reasons.push(`Hyperdrive config "${name}" identity changed (${id} -> ${now ?? "missing"})`);
      }
    }
  }
  // Vectorize index + Secrets Store identity drift.
  if (reference.vectorizeIndexIds) {
    const currentIds = new Map(current.vectorizeIndexes.map((c) => [c.name, c.id]));
    for (const [name, id] of Object.entries(reference.vectorizeIndexIds)) {
      const now = currentIds.get(name);
      if (now !== id) {
        reasons.push(`Vectorize index "${name}" identity changed (${id} -> ${now ?? "missing"})`);
      }
    }
  }
  if (reference.secretsStoreIds) {
    const currentIds = new Map(current.secretsStores.map((c) => [c.name, c.id]));
    for (const [name, id] of Object.entries(reference.secretsStoreIds)) {
      const now = currentIds.get(name);
      if (now !== id) {
        reasons.push(`Secrets Store "${name}" identity changed (${id} -> ${now ?? "missing"})`);
      }
    }
  }
  // deployed binding map drift (binding -> bucket). Only checked
  // when the reference carries it; older references without the field stay
  // compatible and skip this check (spec-vs-snapshot in plan.ts still guards).
  // a binding that was bound at plan time and is now GONE counts as
  // external drift too. An outsider deleting an approved binding must never
  // pass silently; only an explicitly approved removal (not implemented yet)
  // would hand the caller a post-approval reference without the entry.
  if (reference.workerR2Bindings) {
    const currentBindings = current.workerR2Bindings ?? {};
    for (const [binding, bucket] of Object.entries(reference.workerR2Bindings)) {
      const now = currentBindings[binding];
      if (now !== bucket) {
        reasons.push(`R2 binding "${binding}" identity changed (${bucket} -> ${now ?? "missing"})`);
      }
    }
  }

  // full deployed binding map drift. When the reference carries it,
  // an outside rebind of any family (R2/D1/KV/Queue/Hyperdrive/Vectorize/Secrets
  // Store) between plan and write blocks. An own write that legitimately changes
  // a binding target after explicit approval is handled by the caller passing the
  // post-approval reference; a genuine outside change never passes silently.
  // a binding that DISAPPEARED since plan time is external drift, not a
  // no-op. Every family compares `now !== expected`, so missing (undefined) is a
  // mismatch. Approved removals are not wired yet, so there is no exemption.
  if (reference.deployedBindings) {
    const cur = current.deployedBindings ?? {};
    const ref = reference.deployedBindings;
    for (const [binding, bucket] of Object.entries(ref.r2 ?? {})) {
      const now = cur.r2?.[binding];
      if (now !== bucket) {
        reasons.push(`R2 binding "${binding}" rebind (${bucket} -> ${now ?? "missing"})`);
      }
    }
    for (const [binding, id] of Object.entries(ref.d1 ?? {})) {
      const now = cur.d1?.[binding];
      if (now !== id) {
        reasons.push(`D1 binding "${binding}" rebind (${id} -> ${now ?? "missing"})`);
      }
    }
    for (const [binding, id] of Object.entries(ref.kv ?? {})) {
      const now = cur.kv?.[binding];
      if (now !== id) {
        reasons.push(`KV binding "${binding}" rebind (${id} -> ${now ?? "missing"})`);
      }
    }
    for (const [binding, q] of Object.entries(ref.queue ?? {})) {
      const now = cur.queue?.[binding];
      if (now !== q) {
        reasons.push(`Queue binding "${binding}" rebind (${q} -> ${now ?? "missing"})`);
      }
    }
    for (const [binding, id] of Object.entries(ref.hyperdrive ?? {})) {
      const now = cur.hyperdrive?.[binding];
      if (now !== id) {
        reasons.push(`Hyperdrive binding "${binding}" rebind (${id} -> ${now ?? "missing"})`);
      }
    }
    for (const [binding, idx] of Object.entries(ref.vectorize ?? {})) {
      const now = cur.vectorize?.[binding];
      if (now !== idx) {
        reasons.push(`Vectorize binding "${binding}" rebind (${idx} -> ${now ?? "missing"})`);
      }
    }
    for (const [binding, curSS] of Object.entries(ref.secretsStore ?? {})) {
      const now = cur.secretsStore?.[binding];
      if (!now || now.storeId !== curSS.storeId || now.secretName !== curSS.secretName) {
        reasons.push(
          `Secrets Store binding "${binding}" rebind (${curSS.storeId}/${curSS.secretName} -> ${now ? `${now.storeId}/${now.secretName}` : "missing"})`,
        );
      }
    }
  }

  if (reference.secretNames) {
    const currentSecrets = new Set(current.secretNames);
    for (const name of reference.secretNames) {
      if (!currentSecrets.has(name)) {
        reasons.push(`tracked secret "${name}" is no longer present`);
      }
    }
  }

  return { drifted: reasons.length > 0, reasons };
}
const resourceIdentityFamilies = [
  ["r2", "r2BucketIds", "r2Buckets"], ["d1", "d1DatabaseIds", "d1Databases"],
  ["kv", "kvNamespaceIds", "kvNamespaces"], ["queue", "queueIds", "queues"],
  ["hyperdrive", "hyperdriveConfigIds", "hyperdriveConfigs"], ["vectorize", "vectorizeIndexIds", "vectorizeIndexes"],
  ["secrets-store", "secretsStoreIds", "secretsStores"],
] as const;
/**
 * The reference minus the planned-missing resources this run already created
 * under a verified receipt: their appearance is authenticated progress, not
 * drift. Anything else that appeared since planning still drifts.
 */
export function withAuthenticatedCreates(reference: ExpectedTarget, created: ReadonlyArray<{ resource: string; name: string }>): ExpectedTarget {
  if (!reference.missingResources || created.length === 0) return reference;
  const missingResources = { ...reference.missingResources };
  for (const [family, ids] of resourceIdentityFamilies) {
    const names = missingResources[ids];
    if (names) missingResources[ids] = names.filter((name) => !created.some((entry) => entry.resource === family && entry.name === name));
  }
  return { ...reference, missingResources };
}

export function resourceBaselineDrift(reference: ExpectedTarget, current: TargetSnapshot): string[] {
  const reasons: string[] = [];
  for (const [family, ids, inventory] of resourceIdentityFamilies) {
    for (const name of reference.missingResources?.[ids] ?? []) {
      if (!reference[ids]?.[name] && (current[inventory] ?? []).some(item => item.name === name)) reasons.push(`${family} resource appeared without authenticated creation progress; re-plan required`);
    }
  }
  for (const [name, origin] of Object.entries(reference.hyperdriveOrigins ?? {})) {
    if (canonicalJson(current.hyperdriveConfigs.find(config => config.name === name)?.origin) !== canonicalJson(origin)) reasons.push(`Hyperdrive origin for "${name}" changed`);
  }
  for (const [name, config] of Object.entries(reference.vectorizeConfigs ?? {})) {
    if (canonicalJson(current.vectorizeIndexes.find(index => index.name === name)?.config) !== canonicalJson(config)) reasons.push(`Vectorize immutable schema for "${name}" changed`);
  }
  return reasons;
}

// aggregate pre-write drift for a
// multi-unit graph plan. Each unit is compared against ITS OWN fresh snapshot;
// a unit whose snapshot is missing cannot be verified and therefore drifts
// closed. Any changed live identity (account/target/resource/binding) blocks the
// whole write — a multi-unit release is never a partial, best-effort write.
export interface GraphDriftResult extends DriftResult {
  /** Per-unit drift reasons (empty arrays omitted). */
  units: Record<string, string[]>;
}

export function detectGraphDrift(
  references: Readonly<Record<string, ExpectedTarget>>,
  snapshots: Readonly<Record<string, TargetSnapshot>>,
): GraphDriftResult {
  const reasons: string[] = [];
  const units: Record<string, string[]> = {};
  for (const [unitId, reference] of Object.entries(references)) {
    const current = snapshots[unitId];
    if (!current) {
      reasons.push(`unit "${unitId}" has no fresh snapshot; refusing to write from an unverifiable plan`);
      units[unitId] = ["missing fresh snapshot"];
      continue;
    }
    const result = detectDrift(reference, current);
    if (result.drifted) {
      units[unitId] = result.reasons;
      for (const reason of result.reasons) {
        reasons.push(`unit "${unitId}": ${reason}`);
      }
    }
  }
  return { drifted: reasons.length > 0, reasons, units };
}

function cloneDeployedBindings(bindings: DeployedBindingMap): DeployedBindingMap {
  return {
    ...(bindings.r2 ? { r2: { ...bindings.r2 } } : {}),
    ...(bindings.d1 ? { d1: { ...bindings.d1 } } : {}),
    ...(bindings.kv ? { kv: { ...bindings.kv } } : {}),
    ...(bindings.queue ? { queue: { ...bindings.queue } } : {}),
    ...(bindings.hyperdrive ? { hyperdrive: { ...bindings.hyperdrive } } : {}),
    ...(bindings.vectorize ? { vectorize: { ...bindings.vectorize } } : {}),
    ...(bindings.secretsStore ? { secretsStore: { ...bindings.secretsStore } } : {}),
  };
}
