// Operator-chosen names for the resources and Pages projects of a release.
//
// The release's names are the publisher's suggestions. At install the operator
// may rename each one; on upgrade the Configure step sends the names the live
// Worker is bound to today, and the plan's rebind guard refuses anything else
// unless the resource's config entry says `upgradeKeep: false`.
// Names are keyed `<kind>:<release name>` (`pages:<unit id>` for a Pages
// project) and applied once, to the prepared units and the config, before any
// spec or graph is built, so every later stage uses the chosen name.

import { plannedUnits, type ConfigV3 } from "../../manifest/config-v3.js";
import type { DeploySpec } from "../deploy-spec.js";

export type RenamableKind = "r2" | "d1" | "kv" | "queue" | "vectorize" | "pages";

export interface ReleaseResourceName {
  key: string;
  kind: RenamableKind;
  name: string;
  /** Worker bindings that use it, to read the live name back on upgrade. */
  bindings: Array<{ unitId: string; binding: string }>;
  /** The config entry says `upgradeKeep: false`: the user may bind another one on upgrade. */
  changeOnUpgrade?: true;
}

interface UnitLike {
  unitId?: unknown;
  canonicalWrangler?: unknown;
}

type Record_ = Record<string, unknown>;

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

function entries(wrangler: Record_, field: string): Record_[] {
  const value = wrangler[field];
  return Array.isArray(value) ? value.filter((entry): entry is Record_ => entry !== null && typeof entry === "object") : [];
}

/** The units part of a config: what listing the renamable names needs. */
export type ConfigUnits = { units?: ReadonlyArray<{ kind: string; resources?: ReadonlyArray<{ kind: string; name: string; upgradeKeep?: boolean }> }> };

/** The renamable names of a release, in a stable order (config units first, then units by id). */
export function releaseResourceNames(units: readonly UnitLike[], config: ConfigUnits): ReleaseResourceName[] {
  const byKey = new Map<string, ReleaseResourceName>();
  const add = (kind: RenamableKind, name: unknown, binding?: { unitId: string; binding: unknown }, changeOnUpgrade?: boolean) => {
    if (typeof name !== "string" || !name) return;
    const key = `${kind}:${name}`;
    const item = byKey.get(key) ?? { key, kind, name, bindings: [] };
    if (changeOnUpgrade) item.changeOnUpgrade = true;
    if (binding && typeof binding.binding === "string") item.bindings.push({ unitId: binding.unitId, binding: binding.binding });
    byKey.set(key, item);
  };
  for (const unit of config.units ?? []) {
    if (unit.kind !== "resources") continue;
    for (const resource of unit.resources ?? []) add(resource.kind as RenamableKind, resource.name, undefined, resource.upgradeKeep === false);
  }
  for (const unit of [...units].sort((a, b) => String(a.unitId).localeCompare(String(b.unitId)))) {
    const unitId = String(unit.unitId);
    const wrangler = (unit.canonicalWrangler ?? {}) as Record_;
    if (wrangler.kind === "pages") {
      if (typeof wrangler.name === "string") byKey.set(`pages:${unitId}`, { key: `pages:${unitId}`, kind: "pages", name: wrangler.name, bindings: [] });
      continue;
    }
    if (wrangler.kind !== "worker") continue;
    for (const entry of entries(wrangler, "r2Buckets")) add("r2", entry.bucketName, { unitId, binding: entry.binding });
    // A D1 binding with a declared database_id names an existing database.
    for (const entry of entries(wrangler, "d1Databases")) if (typeof entry.databaseId !== "string") add("d1", entry.databaseName, { unitId, binding: entry.binding });
    for (const entry of entries(wrangler, "queueProducers")) add("queue", entry.queue, { unitId, binding: entry.binding });
    for (const entry of entries(wrangler, "queueConsumers")) add("queue", entry.queue);
    for (const entry of entries(wrangler, "vectorize")) add("vectorize", entry.indexName, { unitId, binding: entry.binding });
  }
  return [...byKey.values()];
}

/**
 * Apply the operator's names. Every key must name a renamable item of this
 * release, every value must be a valid name, and two items of one kind may not
 * end up with the same name. Returns renamed copies; the inputs are untouched.
 */
export function applyResourceNames<U extends UnitLike>(
  units: readonly U[],
  config: ConfigV3,
  raw: unknown,
): { ok: true; units: U[]; config: ConfigV3 } | { ok: false; detail: string } {
  if (raw === undefined) return { ok: true, units: [...units], config };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, detail: "names must be an object" };
  const known = new Map(releaseResourceNames(units, { units: plannedUnits(config) }).map((item) => [item.key, item]));
  const chosen = new Map<string, string>();
  for (const [key, value] of Object.entries(raw as Record_)) {
    const item = known.get(key);
    if (!item) return { ok: false, detail: `"${key}" is not a renamable name of this release` };
    if (typeof value !== "string" || !NAME_RE.test(value)) return { ok: false, detail: `${key}: "${String(value)}" must be 3–63 lowercase letters, digits or dashes, starting and ending with a letter or digit` };
    if (value !== item.name) chosen.set(key, value);
  }
  const finalName = (item: ReleaseResourceName) => chosen.get(item.key) ?? item.name;
  const taken = new Map<string, string>();
  for (const item of known.values()) {
    const slot = `${item.kind}:${finalName(item)}`;
    if (taken.has(slot)) return { ok: false, detail: `${item.key} and ${taken.get(slot)} would both be named "${finalName(item)}"` };
    taken.set(slot, item.key);
  }
  if (chosen.size === 0) return { ok: true, units: [...units], config };
  const rename = (kind: RenamableKind, name: unknown) => (typeof name === "string" ? chosen.get(`${kind}:${name}`) ?? name : name);
  const renamedUnits = units.map((unit) => {
    const wrangler = (unit.canonicalWrangler ?? {}) as Record_;
    if (wrangler.kind === "pages") {
      const name = chosen.get(`pages:${String(unit.unitId)}`);
      return name ? { ...unit, canonicalWrangler: { ...wrangler, name } } : unit;
    }
    if (wrangler.kind !== "worker") return unit;
    const map = (field: string, key: string, kind: RenamableKind) => entries(wrangler, field).map((entry) => ({ ...entry, [key]: rename(kind, entry[key]) }));
    return {
      ...unit,
      canonicalWrangler: {
        ...wrangler,
        r2Buckets: map("r2Buckets", "bucketName", "r2"),
        d1Databases: entries(wrangler, "d1Databases").map((entry) => (typeof entry.databaseId === "string" ? entry : { ...entry, databaseName: rename("d1", entry.databaseName) })),
        queueProducers: map("queueProducers", "queue", "queue"),
        queueConsumers: map("queueConsumers", "queue", "queue"),
        vectorize: map("vectorize", "indexName", "vectorize"),
      },
    };
  });
  const renamedConfig: ConfigV3 = {
    ...config,
    ...(config.resources ? { resources: config.resources.map((resource) => ({ ...resource, name: rename(resource.kind, resource.name) as string })) } : {}),
  };
  return { ok: true, units: renamedUnits, config: renamedConfig };
}

const BINDING_FAMILY = { r2: "r2", d1: "d1", kv: "kv", queue: "queues", vectorize: "vectorize" } as const;

/**
 * Mark the Worker bindings of the resources whose config entry says
 * `upgradeKeep: false`, so the plan's rebind guard lets an upgrade bind
 * another resource there. Unmarked bindings stay bound to what the Worker
 * uses today.
 */
export function markChangeableOnUpgrade(specs: Record<string, DeploySpec>, units: readonly UnitLike[], config: ConfigUnits): void {
  for (const item of releaseResourceNames(units, config)) {
    if (!item.changeOnUpgrade || item.kind === "pages") continue;
    for (const use of item.bindings) {
      const entries = specs[use.unitId]?.cloudflare[BINDING_FAMILY[item.kind]] as Array<{ binding?: string; changeOnUpgrade?: true }> | undefined;
      for (const entry of entries ?? []) if (entry.binding === use.binding) entry.changeOnUpgrade = true;
    }
  }
}
