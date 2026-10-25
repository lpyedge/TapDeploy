// Canonical digest and ownership marker for deployment plans. The digest binds
// only the immutable approved release/target identity (release artifact hashes,
// account, worker name and the form values) with a session-bound salt. It
// deliberately excludes mutable remote-derived state (active deployment
// identity and the normalized diff summary): a successful own write changes
// that state, and the frozen approved digest must remain valid across own
// steps. External drift is still rejected via the explicit expected
// target guards in plan.ts/drift.ts, not via the digest. WebCrypto only, for
// Node/Workers parity.

import type { DeploySpec } from "../deploy-spec.js";
import type { DeployBundle } from "../../release/deploy-bundle.js";

// Marker recorded in the worker version message so a target can be identified
// as managed by this installer (ownership check). Writes must
// stamp this marker on the version it creates.
export const TAPDEPLOY_MANAGED_MARKER = "managed-by-tapdeploy";

export interface VersionRef {
  id: string;
  number?: number;
  message?: string;
}

// the project owner stamped on a single version message, or undefined
// when the version carries no installer ownership marker. The message is
// `${projectId} v${version} ${TAPDEPLOY_MANAGED_MARKER}` (see steps.ts versionMessage);
// the project id is the token before the first space. A bare marker yields
// undefined.
function versionOwnerProjectId(version: VersionRef): string | undefined {
  const message = version.message;
  if (!message?.includes(TAPDEPLOY_MANAGED_MARKER)) {
    return undefined;
  }
  const firstSpace = message.indexOf(" ");
  return firstSpace > 0 ? message.slice(0, firstSpace) : undefined;
}

// the outcome of resolving upgrade ownership against the active deployment.
export interface ActiveOwnershipVerdict {
  // The active version(s) are installer-managed by exactly this project.
  owned: boolean;
  // The active version(s) are installer-managed but by a different project.
  managedOther: boolean;
  // The active deployment is split across versions with inconsistent ownership.
  ambiguous: boolean;
  // The active deployment version could not be resolved at all.
  unresolved: boolean;
  // Operator-facing explanation; empty when owned.
  detail: string;
}

// resolve upgrade ownership from the ACTUALLY ACTIVE deployment version(s),
// never from the full historical version list. A prior version's marker is an
// assertion about the past, not evidence that the currently-serving deployment
// belongs to this project. Fail closed (owned=false) when the active version set
// is missing/unresolvable, when traffic is split across versions with
// inconsistent ownership, or when the current owner is unmanaged or another
// project.
export function resolveActiveOwnership(
  versions: VersionRef[],
  activeVersionIds: string[],
  projectId: string | undefined,
): ActiveOwnershipVerdict {
  const ids = (activeVersionIds ?? []).filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  if (ids.length === 0) {
    return {
      owned: false,
      managedOther: false,
      ambiguous: false,
      unresolved: true,
      detail:
        "Target worker already exists but no active deployment version is resolvable; refusing to adopt a worker whose current owner cannot be confirmed",
    };
  }

  const byId = new Map(versions.map((v) => [v.id, v]));
  const active: VersionRef[] = [];
  for (const id of ids) {
    const v = byId.get(id);
    if (!v) {
      return {
        owned: false,
        managedOther: false,
        ambiguous: false,
        unresolved: true,
        detail:
          "Target worker already exists but its active deployment version is missing from the version list; refusing to adopt a worker whose current owner cannot be confirmed",
      };
    }
    active.push(v);
  }

  // Distinct installer owners among the active versions. A bare marker (no
  // project token) counts as an owner distinct from any named project so a split
  // between a named project and an unnamed marker is still ambiguous.
  const owners = new Set<string>();
  let managed = false;
  for (const v of active) {
    const owner = versionOwnerProjectId(v);
    if (owner !== undefined) {
      managed = true;
      owners.add(owner);
    } else if (v.message?.includes(TAPDEPLOY_MANAGED_MARKER)) {
      managed = true;
      owners.add("");
    }
  }

  if (owners.size > 1) {
    return {
      owned: false,
      managedOther: false,
      ambiguous: true,
      unresolved: false,
      detail:
        "Target worker's active deployment is split across versions with inconsistent installer project ownership; refusing to adopt an ambiguous target",
    };
  }

  if (!managed) {
    return {
      owned: false,
      managedOther: false,
      ambiguous: false,
      unresolved: false,
      detail:
        "Target worker already exists but none of its active deployment versions carry the installer marker; adopting an unknown/unmanaged worker is not supported in v1",
    };
  }

  if (projectId === undefined) {
    return { owned: true, managedOther: false, ambiguous: false, unresolved: false, detail: "" };
  }

  const owner = [...owners][0];
  if (owner === projectId) {
    return { owned: true, managedOther: false, ambiguous: false, unresolved: false, detail: "" };
  }
  return {
    owned: false,
    managedOther: true,
    ambiguous: false,
    unresolved: false,
    detail: `Target worker already exists and is managed by a different installer project (expected "${projectId}"); adopting an unrelated/mismatched worker is not supported in v1`,
  };
}

// Reliable stable JSON stringify: sorted keys, arrays in order, no whitespace.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  return "null";
}

// a graph action is addressed by the exact normalized plan diff, not by a
// browser-provided ordinal.  Canonical JSON makes the unit/action identity
// stable across Node and Workers and avoids delimiter-collision ambiguity.
export interface GraphActionIdentity {
  unitId: string;
  resource: string;
  action: string;
  name?: string;
}

export function graphActionId(identity: GraphActionIdentity): string {
  return `tapdeploy-graph-action:${canonicalJson(identity)}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface PlanDigestMaterial {
  spec: DeploySpec;
  accountId: string;
  workerName: string;
  inputs: Record<string, string | number | boolean>;
}

export async function computePlanDigest(
  material: PlanDigestMaterial,
  salt: string,
): Promise<string> {
  // Form inputs may carry secret values; hashing them here is one-way and the
  // digest is the only place they influence output, so nothing leaks.
  // Live remote state (active deployment, diffs) is deliberately not hashed: own
  // writes legitimately advance it (R2 create/preserve, secret create/preserve,
  // deployment cutover), so hashing it would turn the first own mutation into a
  // plan_stale for every consecutive step.
  const payload = canonicalJson({
    // Bind the entire immutable deployment intent, not only artifact bytes.
    // Otherwise a caller could add bindings/DNS or change runtime settings after
    // approval while retaining the same digest. Remote snapshot state remains
    // excluded so our own resource creation/cutover does not stale later steps.
    spec: material.spec,
    // a Pages release has no worker module; its immutable artifact identity
    // is the asset hashes (and optional prebuilt `_worker.js` bundle). A Workers
    // release binds the worker module sha.
    a: material.spec.worker?.sha256 ?? material.spec.workerBundle?.sha256 ?? "",
    b: material.spec.assets.map((a) => `${a.path}:${a.sha256}`),
    c: material.accountId,
    d: material.workerName,
    g: material.inputs,
    salt,
  });
  return sha256Hex(payload);
}

// canonical binding material for the immutable prebuilt DeployBundle. Plan
// approval and every deploy step consume this same material, so the approved
// bundle identity (module/asset bytes, effective Wrangler config and the
// verified ZIP source digest) cannot drift between approval and execution. A
// pure projection: bundle building stays in src/release/deploy-bundle.ts.
export function bundleProofMaterial(bundle: DeployBundle): {
  bundleDigest: string;
  wranglerEffectiveHash: string;
  mainModule: string | null;
  modules: { name: string; mime: string; size: number; sha256: string }[];
  assets: { path: string; size: number; sha256: string }[];
  source: { archiveSha256: string; manifestDigest: string };
} {
  return {
    bundleDigest: bundle.bundleDigest,
    wranglerEffectiveHash: bundle.wranglerEffectiveHash,
    mainModule: bundle.mainModule ?? null,
    modules: bundle.modules.map((module) => ({
      name: module.name,
      mime: module.mime,
      size: module.size,
      sha256: module.sha256,
    })),
    assets: bundle.assets.map((asset) => ({
      path: asset.path,
      size: asset.size,
      sha256: asset.sha256,
    })),
    source: {
      archiveSha256: bundle.source.archiveSha256,
      manifestDigest: bundle.source.manifestDigest,
    },
  };
}

// ---------------------------------------------------------------------------
// multi-unit graph plan digest.
//
// The single-target digest above binds ONE release's immutable intent. A
// multi-unit release needs the whole graph bound instead: the session account,
// the Config V3 hash, the bundle proof (ZIP + every module/asset + the
// effective Wrangler hash), EVERY unit's resolved actions, the account resource
// identities and the paid-risk posture. A changed source archive, a swapped
// module byte, a different account/config, a changed unit action, a changed
// resource identity or a changed cost posture all change this digest.
//
// Synthetic (planned) targets are recorded separately from the secrets proven
// present on the ACTIVE deployment: a planned target can never be presented as
// live proof, and live proof can never be mistaken for a planned target.
// ---------------------------------------------------------------------------

interface GraphPlanUnitAction {
  unitId: string;
  kind: string;
  identity: string;
  name: string;
  requiresBundle: boolean;
  actions: { resource: string; action: string; name?: string }[];
  // the unit-bound complete sorted cron set. A changed cron expression
  // changes the digest even though the schedule diff itself stays nameless;
  // the sealed per-unit spec remains the dispatch authority.
  crons: string[];
}

export interface GraphPlanSyntheticTarget {
  unitId: string;
  identity: string;
  name: string;
  /** Always true: a plan target is a planned identity, never a live readback. */
  synthetic: true;
}

export interface GraphPlanActiveSecretProof {
  unitId: string;
  name: string;
  /** True only when the secret was proven present on the active deployment. */
  provenActive: true;
}

export interface GraphPlanResourceIdentity {
  id: string;
  kind: string;
  name?: string;
  /** Live provider identity when the resource already exists (preserve). */
  remoteId?: string;
}

interface GraphPlanCostMaterial {
  operations: { resource: string; action: string; name?: string }[];
  requiresConfirmation: boolean;
  blockedUnknownCost: boolean;
}

export interface GraphPlanDigestMaterial {
  accountId: string;
  configHash: string;
  /** bundle proof (ZIP + modules + effective Wrangler hash); null when resource-only. */
  bundle: ReturnType<typeof bundleProofMaterial> | null;
  /** Per-unit artifact identities for V3 prepared multi-unit releases. */
  unitBundles?: { unitId: string; bundle: ReturnType<typeof bundleProofMaterial> }[];
  units: GraphPlanUnitAction[];
  resourceIdentities: GraphPlanResourceIdentity[];
  cost: GraphPlanCostMaterial;
  targets: GraphPlanSyntheticTarget[];
  activeSecretProof: GraphPlanActiveSecretProof[];
}

export async function computeGraphPlanDigest(
  material: GraphPlanDigestMaterial,
  salt: string,
): Promise<string> {
  const payload = canonicalJson({
    kind: "tapdeploy-graph-plan",
    accountId: material.accountId,
    configHash: material.configHash,
    bundle: material.bundle,
    unitBundles: material.unitBundles ?? [],
    units: material.units,
    resourceIdentities: material.resourceIdentities,
    cost: material.cost,
    targets: material.targets,
    activeSecretProof: material.activeSecretProof,
    salt,
  });
  return sha256Hex(payload);
}
