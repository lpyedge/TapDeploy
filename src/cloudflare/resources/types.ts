// Typed resource-adapter layer for the deploy steps. Each supported Cloudflare
// resource kind has an explicit support row and an adapter. Any kind that is
// not registered fails closed — there is never a generic endpoint fallback.
// No adapter may ever delete a resource.

export type ResourceKind =
  | "worker"
  | "static-assets"
  | "r2-bucket"
  | "secret"
  | "cron"
  | "rate-limit"
  | "d1-database"
  | "kv-namespace"
  | "queue"
  | "hyperdrive"
  | "vectorize"
  | "secrets-store"
  // opt-in domain/route/DNS kinds. These are declaratively managed by the
  // operator inside the preauthorized envelope (never auto-deleted on upgrade).
  | "worker-route"
  | "worker-custom-domain"
  | "pages-custom-domain"
  | "dns-record";

// How far a resource kind has actually been proven. "local-contract" means the
// request/response shape is covered by offline mocks only; "live" means it was
// accepted against a disposable Cloudflare account.
export type VerificationLevel = "local-contract" | "live";

export interface ResourceSupport {
  kind: ResourceKind;
  label: string;
  install: "create-declared" | "preserve" | "not-applicable";
  upgrade: "preserve" | "reconcile";
  // "never": the installer never deletes this kind (e.g. R2 buckets, D1).
  // "explicit": a delete is only offered after an independent in-app confirm
  // in the operator's own domain-management flow, never an ordinary upgrade.
  deletes: "never" | "explicit";
  verified: VerificationLevel;
}

export interface ResourceAdapter {
  support: ResourceSupport;
  // The single mutating entrypoint this adapter exposes. Adapters are
  // dispatch-only; there is no free-form API surface.
  readonly mutation: string;
}

// A resource kind was requested that the installer does not support. Fail
// closed: never fall through to a generic request.
export class UnsupportedResourceError extends Error {
  readonly kind = "unsupported-resource";
  constructor(resourceKind: string) {
    super(`Unsupported Cloudflare resource kind "${resourceKind}"`);
  }
}

// A declared resource cannot be reconciled without risking an overwrite. Fail
// closed rather than recreate or replace an existing resource.
export class ResourceConflictError extends Error {
  readonly kind = "conflict";
  constructor(message: string) {
    super(message);
  }
}
