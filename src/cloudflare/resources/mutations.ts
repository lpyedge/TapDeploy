// Resource mutation capability matrix.
//
// This is the honest, single source of truth for which mutation operations
// (edit/update, rename, unbind, delete) the installer can actually offer over a
// declared resource. It is deliberately conservative: the installer never
// auto-mutates on upgrade (adapters are create/preserve/conflict; there is no
// auto-delete path), and destructive operations are only surfaced when BOTH the
// config granted the corresponding `management` allow-flag AND the adapter +
// provider actually support the operation. An unsupported capability is never
// reported as success (FAIL oracle) — the picker and plan consult this matrix
// and refuse before any write.
//
// Distinctions encoded here:
//   - `unbind` (remove / change the Worker binding metadata for a resource) is a
//     Worker-version change. It never deletes, drains, or mutates the underlying
//     account resource, so it is offered for account resources that are bound by
//     name/id. It still requires a separate in-app confirmation because it
//     changes what the deployed Worker can access.
//   - `delete` is `unsupported` for every account resource the installer manages:
//     there is no live-verified delete route , and the installer
//     never auto-deletes a shared store on upgrade (PASS oracle). This is not a
//     provider capability gap — it is an explicit safety bound. The row's `note`
//     records why.
//   - `rename` is `unsupported` where the product identity is immutable (D1
//     database name, R2 bucket name, Vectorize index name, Queue name).
//   - `edit` is `supported` only for mutable product settings; immutable fields
//     (e.g. Vectorize dimension/metric, D1 name) are `unsupported`.
//   - pseudo-resources (Workers AI / Browser Rendering runtime bindings, rate
//     limits) expose NO mutation operations.

import type { ResourceKind } from "./types.js";

// The installer's config resource kinds (r2/d1/kv/queues/hyperdrive/vectorize/
// secrets-store/ai/workers-ai/browser-rendering/browser-run) are not the same
// strings as the adapter `ResourceKind` values (r2-bucket/d1-database/
// kv-namespace/queue/…). The mutation matrix is keyed by the adapter kind; this
// map normalizes a config kind (or adapter kind) to the canonical adapter kind
// so the picker (which sees config kinds) resolves the same row.
const CONFIG_KIND_TO_ADAPTER: Record<string, ResourceKind> = {
  r2: "r2-bucket",
  "r2-bucket": "r2-bucket",
  d1: "d1-database",
  "d1-database": "d1-database",
  kv: "kv-namespace",
  "kv-namespace": "kv-namespace",
  queues: "queue",
  queue: "queue",
  hyperdrive: "hyperdrive",
  vectorize: "vectorize",
  "secrets-store": "secrets-store",
  secret: "secret",
  cron: "cron",
  "rate-limit": "rate-limit",
  ratelimit: "rate-limit",
};

function canonicalKind(kind: ResourceKind | string): ResourceKind {
  return CONFIG_KIND_TO_ADAPTER[kind] ?? (kind as ResourceKind);
}

export type MutationOperation = "edit" | "rename" | "unbind" | "delete";

export type MutationSupport =
  | {
      supported: true;
      // Destructive operations require a separate in-app confirmation, never an
      // additional OAuth (the one-shot envelope already covers them).
      requiresSeparateConfirmation: boolean;
      // Human note for the plan / pre-auth review.
      note: string;
    }
  | {
      supported: false;
      // Why the operation is not offered / must not be auto-applied.
      reason: string;
    };

export interface ResourceMutationCapability {
  kind: ResourceKind;
  // Only the operations that apply to the kind are present.
  operations: Partial<Record<MutationOperation, MutationSupport>>;
}

/**
 * The honest mutation capability matrix. Keys must be ResourceKind values the
 * installer's adapter layer registers; any kind not listed here is treated as
 * `unsupported` for every mutation operation (fail closed, never success).
 */
const PROVIDER_MUTATION_POTENTIAL: ResourceMutationCapability[] = [
  {
    kind: "worker",
    operations: {
      edit: {
        supported: true,
        requiresSeparateConfirmation: false,
        note: "A Worker is edited by uploading a new version (create-version) and activating it. This is the normal install/upgrade path, not a separate mutation.",
      },
      unbind: {
        supported: true,
        requiresSeparateConfirmation: true,
        note: "Unbinding a Worker binding + redeploying a new version changes what the deployed Worker can access; the account resource is left intact.",
      },
      delete: {
        supported: false,
        reason: "TapDeploy never deletes a Worker script. There is no live-verified delete path, and a Worker may back a shared/custom domain.",
      },
    },
  },
  {
    kind: "static-assets",
    operations: {
      edit: {
        supported: true,
        requiresSeparateConfirmation: false,
        note: "Static assets are replaced by uploading a new asset set with the version.",
      },
      delete: {
        supported: false,
        reason: "TapDeploy never deletes uploaded assets; the asset set is tied to the Worker version.",
      },
    },
  },
  {
    kind: "r2-bucket",
    operations: {
      edit: {
        supported: false,
        reason: "An R2 bucket has no mutable settings exposed by the installer; its creation identity (name) is fixed.",
      },
      rename: {
        supported: false,
        reason: "R2 bucket names are immutable; renaming would break bindings and is not a supported operation.",
      },
      unbind: {
        supported: true,
        requiresSeparateConfirmation: true,
        note: "Unbind removes the R2 binding from the Worker version; the bucket and its objects are untouched.",
      },
      delete: {
        supported: false,
        reason: "TapDeploy never deletes an R2 bucket. Deleting is irreversible data loss and is outside the one-shot safe-mutation envelope.",
      },
    },
  },
  {
    kind: "d1-database",
    operations: {
      edit: {
        supported: false,
        reason: "A D1 database's name/location settings are not mutable via the installer; there is no implicit SQL migration.",
      },
      rename: {
        supported: false,
        reason: "D1 database names are immutable (Community/API); renaming requires a recreate + data migration, which TapDeploy never does automatically.",
      },
      unbind: {
        supported: true,
        requiresSeparateConfirmation: true,
        note: "Unbind removes the D1 binding from the Worker version; the database and its data are untouched.",
      },
      delete: {
        supported: false,
        reason: "TapDeploy never deletes a D1 database (irreversible data loss); validations/deletes are out of scope.",
      },
    },
  },
  {
    kind: "kv-namespace",
    operations: {
      edit: {
        supported: true,
        requiresSeparateConfirmation: false,
        note: "KV namespace settings are replaceable; TapDeploy does not mutate keys, only the bound namespace identity.",
      },
      rename: {
        supported: false,
        reason: "KV namespace names are immutable; TapDeploy never recreates a namespace.",
      },
      unbind: {
        supported: true,
        requiresSeparateConfirmation: true,
        note: "Unbind removes the KV binding from the Worker version; the namespace and its keys are untouched.",
      },
      delete: {
        supported: false,
        reason: "TapDeploy never deletes a KV namespace (data loss); only the binding is ever changed.",
      },
    },
  },
  {
    kind: "queue",
    operations: {
      edit: {
        supported: true,
        requiresSeparateConfirmation: false,
        note: "Queue settings are updateable when the provider API supports it; TapDeploy updates only the declared consumer trigger, never messages.",
      },
      rename: {
        supported: false,
        reason: "Queue names are immutable; TapDeploy never recreates a queue.",
      },
      unbind: {
        supported: true,
        requiresSeparateConfirmation: true,
        note: "Unbind removes the producer/consumer trigger binding; the queue and its messages are untouched.",
      },
      delete: {
        supported: false,
        reason: "TapDeploy never deletes a queue (consumer messages may still be processed); only the consumer trigger is ever updated.",
      },
    },
  },
  {
    kind: "hyperdrive",
    operations: {
      edit: {
        supported: true,
        requiresSeparateConfirmation: false,
        note: "Hyperdrive connection settings are updateable when supported; origin credentials are never logged and are forwarded only on create.",
      },
      rename: {
        supported: false,
        reason: "Hyperdrive config names are immutable; TapDeploy never recreates a config.",
      },
      unbind: {
        supported: true,
        requiresSeparateConfirmation: true,
        note: "Unbind removes the Hyperdrive binding from the Worker version; the config is untouched.",
      },
      delete: {
        supported: false,
        reason: "TapDeploy never deletes a Hyperdrive config; origin credentials are never rotated by the installer.",
      },
    },
  },
  {
    kind: "vectorize",
    operations: {
      edit: {
        supported: false,
        reason: "A Vectorize index's dimension/metric configuration is immutable on the live resource; TapDeploy never changes it in place.",
      },
      rename: {
        supported: false,
        reason: "Vectorize index names are immutable; TapDeploy never recreates an index.",
      },
      unbind: {
        supported: true,
        requiresSeparateConfirmation: true,
        note: "Unbind removes the Vectorize binding from the Worker version; the index is untouched.",
      },
      delete: {
        supported: false,
        reason: "TapDeploy never deletes a Vectorize index (data loss); only the binding is ever changed.",
      },
    },
  },
  {
    kind: "secrets-store",
    operations: {
      edit: {
        supported: true,
        requiresSeparateConfirmation: true,
        note: "A central Secrets Store secret's value/scopes can be rotated only with explicit consent; the write-only value is never read back.",
      },
      rename: {
        supported: false,
        reason: "Secret/store names are immutable; TapDeploy never recreates a store or secret.",
      },
      unbind: {
        supported: true,
        requiresSeparateConfirmation: true,
        note: "Unbind removes the secret binding from the Worker version; the store and secret are untouched.",
      },
      delete: {
        supported: false,
        reason: "TapDeploy never deletes a Secrets Store store or secret; values are write-only and never echoed.",
      },
    },
  },
  {
    kind: "secret",
    operations: {
      edit: {
        supported: true,
        requiresSeparateConfirmation: false,
        note: "A Worker version secret value is replaced by a new version upload; it is never read back by TapDeploy.",
      },
      unbind: {
        supported: true,
        requiresSeparateConfirmation: true,
        note: "Unbind removes a Worker secret binding; the secret value is preserved in the Worker's secret store.",
      },
      delete: {
        supported: false,
        reason: "TapDeploy never deletes a Worker secret; only a new version may omit a declared secret.",
      },
    },
  },
  {
    kind: "cron",
    operations: {
      edit: {
        supported: true,
        requiresSeparateConfirmation: false,
        note: "Cron schedules are reconciled to the declared set on a new version upload.",
      },
      delete: {
        supported: false,
        reason: "TapDeploy never deletes a schedule independently; it reconciles to the declared set.",
      },
    },
  },
  {
    kind: "rate-limit",
    operations: {
      edit: {
        supported: false,
        reason: "Rate limits are metadata-only in installer v1; TapDeploy reads and preserves the existing set and never writes or declares them.",
      },
      delete: {
        supported: false,
        reason: "TapDeploy never deletes a rate limit; it is metadata-only/preserve.",
      },
    },
  },
];

// A provider method is not an installer capability. Only the full approved
// Worker/asset upgrade has an executable edit path; no account-resource
// edit/unbind operation is wired to authenticated intent and confirmation.
export const RESOURCE_MUTATION_MATRIX: ResourceMutationCapability[] = PROVIDER_MUTATION_POTENTIAL.map(row => ({
  kind: row.kind,
  operations: Object.fromEntries(Object.entries(row.operations).map(([operation, support]) => [operation,
    support?.supported && !(operation === "edit" && ["worker", "static-assets"].includes(row.kind))
      ? { supported: false, reason: "Provider capability is not wired to an approved installer execution path; unavailable in this build" }
      : support,
  ])),
}));
const MATRIX_BY_KIND = new Map(RESOURCE_MUTATION_MATRIX.map((r) => [r.kind, r]));

/**
 * Resolve the mutation capability for a resource kind. Unknown kinds (including
 * pseudo-resources Workers AI / Browser Rendering) return an empty capability —
 * every operation is `unsupported`, so the caller must fail closed rather than
 * report a success. This is how we never report an unsupported capability as
 * success (FAIL oracle).
 */
export function mutationCapabilityFor(kind: ResourceKind | string): ResourceMutationCapability {
  const row = MATRIX_BY_KIND.get(canonicalKind(kind));
  if (!row) {
    return { kind: kind as ResourceKind, operations: {} };
  }
  return row;
}

/**
 * True when the adapter + provider support the given mutation operation for a
 * resource kind. Unknown / pseudo-resource kinds are never supported.
 */
export function supportsMutation(
  kind: ResourceKind | string,
  operation: MutationOperation,
): boolean {
  return mutationCapabilityFor(kind).operations[operation]?.supported === true;
}

/**
 * True when a supported mutation operation is destructive and therefore needs a
 * separate in-app confirmation (never an additional OAuth).
 */
export function mutationRequiresSeparateConfirmation(
  kind: ResourceKind | string,
  operation: MutationOperation,
): boolean {
  const support = mutationCapabilityFor(kind).operations[operation];
  return support?.supported === true && support.requiresSeparateConfirmation === true;
}

/**
 * The ordered list of mutation operations that the installer may surface for a
 * resource kind, limited to those the adapter + provider support AND that the
 * config's `management` allow-flags permit. `configAllows(operation)` returns
 * whether the config granted the matching `management` allow-flag (edit/unbind/
 * delete). Used by the resource picker to gate edit/unbind/delete controls; an
 * operation is never auto-applied, and a destructive op only surfaces when the
 * config granted the matching flag.
 */
export function supportedMutations(
  kind: ResourceKind | string,
  configAllows: (operation: MutationOperation) => boolean,
): Array<{ operation: MutationOperation; requiresSeparateConfirmation: boolean; note: string }> {
  const capability = mutationCapabilityFor(kind);
  const order: MutationOperation[] = ["edit", "rename", "unbind", "delete"];
  const out: Array<{
    operation: MutationOperation;
    requiresSeparateConfirmation: boolean;
    note: string;
  }> = [];
  for (const op of order) {
    const support = capability.operations[op];
    if (!support || !support.supported) {
      continue;
    }
    // The config must declare the matching management allow-flag. We never invent
    // a mutation right, and an unsupported capability is never reported as success.
    if (!configAllows(op)) {
      continue;
    }
    out.push({
      operation: op,
      requiresSeparateConfirmation: support.requiresSeparateConfirmation,
      note: support.note,
    });
  }
  return out;
}
