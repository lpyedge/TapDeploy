// Wrangler V3 parser vocabulary: the allowed/refused key tables per entry
// family and the small pure helpers shared by every section of the parser.

import type { WranglerV3Issue } from "./wrangler-v3-schema.js";

export const RATE_LIMIT_PERIODS = new Set([10, 60, 600]);
export const UNCOMPILED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
export const ESM_EXTENSIONS = new Set([".js", ".mjs"]);
export const HTML_HANDLING = new Set([
  "auto-trailing-slash",
  "force-trailing-slash",
  "drop-trailing-slash",
  "none",
]);
export const NOT_FOUND_HANDLING = new Set(["none", "single-page-application", "404-page"]);

export const ASSET_KEYS = new Set([
  "directory",
  "binding",
  "run_worker_first",
  "html_handling",
  "not_found_handling",
]);
export const ROUTE_KEYS = new Set(["pattern", "custom_domain", "zone_id", "zone_name"]);
export const TRIGGER_KEYS = new Set(["crons"]);
// resource-binding entry keys. The official Wrangler schema also carries
// preview/dev-only and jurisdiction variants; they are refused rather than
// silently dropped because the deploy pipeline has no implementation for them
// (jurisdiction also changes which bucket listing an identity must come from).
export const R2_BUCKET_KEYS = new Set(["binding", "bucket_name"]);
export const R2_BUCKET_REFUSED_KEYS = new Set([
  "preview_bucket_name",
  "jurisdiction",
  "remote",
  "local_dev",
]);
export const D1_DATABASE_KEYS = new Set(["binding", "database_name", "database_id"]);
export const D1_DATABASE_REFUSED_KEYS = new Set([
  "preview_database_id",
  "migrations_table",
  "migrations_dir",
]);
export const KV_NAMESPACE_KEYS = new Set(["binding", "id"]);
export const KV_NAMESPACE_REFUSED_KEYS = new Set(["preview_id", "remote"]);
// `localConnectionString` only feeds `wrangler dev`; deploys ignore it, and so
// does TapDeploy (it is never projected or sent).
export const HYPERDRIVE_KEYS = new Set(["binding", "id", "localConnectionString"]);
export const HYPERDRIVE_REFUSED_KEYS = new Set<string>();
export const VECTORIZE_KEYS = new Set(["binding", "index_name"]);
export const VECTORIZE_REFUSED_KEYS = new Set(["remote"]);
export const SECRETS_STORE_SECRET_KEYS = new Set(["binding", "store_id", "secret_name"]);
export const SECRETS_STORE_SECRET_REFUSED_KEYS = new Set<string>();
export const RUNTIME_BINDING_KEYS = new Set(["binding"]);
export const RUNTIME_BINDING_REFUSED_KEYS = new Set(["remote"]);
// official queue entry shapes. producers: binding+queue (the queue name is
// required by TapDeploy even though the official schema marks it optional — the
// installer refuses to guess which queue a producer binds). `delivery_delay`
// (deprecated in Wrangler, no deploy effect) and `remote` (local-dev switch)
// are refused explicitly. Consumers: worker-consumer settings only;
// `visibility_timeout_ms` is refused because the official worker-consumer
// upload never applies it (pulled-message feature without a deploy effect).
export const QUEUES_KEYS = new Set(["producers", "consumers"]);
export const QUEUE_PRODUCER_KEYS = new Set(["binding", "queue"]);
export const QUEUE_PRODUCER_REFUSED_KEYS = new Map<string, string>([
  [
    "delivery_delay",
    "delivery_delay is deprecated in Wrangler and has no deploy effect; remove it instead of relying on it",
  ],
  [
    "remote",
    "remote is a local-development switch without a TapDeploy deploy implementation; refusing to ignore it",
  ],
]);
export const QUEUE_CONSUMER_KEYS = new Set([
  "queue",
  "type",
  "max_batch_size",
  "max_batch_timeout",
  "max_retries",
  "max_concurrency",
  "retry_delay",
  "dead_letter_queue",
]);
export const QUEUE_CONSUMER_REFUSED_KEYS = new Map<string, string>([
  [
    "visibility_timeout_ms",
    "visibility_timeout_ms is not applied to worker consumers by the official upload; refusing to ignore it",
  ],
]);
export const RATELIMIT_KEYS = new Set(["name", "namespace_id", "simple"]);
export const RATELIMIT_SIMPLE_KEYS = new Set(["limit", "period"]);
export const WORKFLOW_KEYS = new Set(["name", "binding", "class_name", "script_name", "schedules"]);
// official workflow fields TapDeploy has no implementation for. They are applied
// by the Workflows API at deploy time, so dropping them would silently change
// runtime behavior; they are refused instead.
export const WORKFLOW_REFUSED_KEYS = new Map<string, string>([
  [
    "limits",
    "workflow limits are applied by the Workflows API at deploy time and have no TapDeploy implementation; refusing to ignore them",
  ],
  [
    "concurrency",
    "workflow concurrency is applied by the Workflows API at deploy time and has no TapDeploy implementation; refusing to ignore it",
  ],
  [
    "default_retention",
    "workflow default_retention is applied by the Workflows API at deploy time and has no TapDeploy implementation; refusing to ignore it",
  ],
]);
export const DURABLE_OBJECT_KEYS = new Set(["name", "class_name", "script_name", "environment"]);
export const SERVICE_KEYS = new Set(["binding", "service", "environment", "entrypoint", "props"]);
export const SERVICE_REFUSED_KEYS = new Map<string, string>([
  [
    "remote",
    "remote is a local-development switch without a TapDeploy deploy implementation; refusing to ignore it",
  ],
]);
export const RULE_KEYS = new Set(["type", "globs", "fallthrough"]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => isNonEmptyString(v));
}

export function extensionOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

export function checkKnownKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
  issues: WranglerV3Issue[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      issues.push({
        code: "UNKNOWN_WRANGLER_FIELD",
        field: `${prefix}.${key}`,
        detail: `field "${key}" is not recognized here and is refused rather than ignored`,
      });
    }
  }
}

// resource-binding entries have an explicit allowed key set; the official
// schema's preview/dev/jurisdiction variants are refused as unsupported (fail
// closed) instead of being treated as unknown fields.
export function checkResourceEntryKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  refused: ReadonlySet<string>,
  prefix: string,
  issues: WranglerV3Issue[],
): void {
  for (const key of Object.keys(obj)) {
    if (allowed.has(key)) {
      continue;
    }
    if (refused.has(key)) {
      issues.push({
        code: "UNSUPPORTED_WRANGLER_FEATURE",
        field: `${prefix}.${key}`,
        detail: `field "${key}" is a preview/dev-only or jurisdiction variant without a TapDeploy V3 deploy implementation; refusing to ignore it`,
      });
      continue;
    }
    issues.push({
      code: "UNKNOWN_WRANGLER_FIELD",
      field: `${prefix}.${key}`,
      detail: `field "${key}" is not recognized here and is refused rather than ignored`,
    });
  }
}

// Shared entry-key gate: each carrier entry family carries its own refusals
// (delivery_delay / remote / workflow limits, ... — fields the official config
// accepts but TapDeploy will not silently drop). Unknown keys stay
// UNKNOWN_WRANGLER_FIELD.
export function checkEntryKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  refused: ReadonlyMap<string, string>,
  prefix: string,
  issues: WranglerV3Issue[],
): void {
  for (const key of Object.keys(obj)) {
    if (allowed.has(key)) {
      continue;
    }
    const refusedDetail = refused.get(key);
    if (refusedDetail !== undefined) {
      issues.push({
        code: "UNSUPPORTED_WRANGLER_FEATURE",
        field: `${prefix}.${key}`,
        detail: refusedDetail,
      });
      continue;
    }
    issues.push({
      code: "UNKNOWN_WRANGLER_FIELD",
      field: `${prefix}.${key}`,
      detail: `field "${key}" is not recognized here and is refused rather than ignored`,
    });
  }
}

// a resource target may be declared only once per family. A duplicate is
// an ambiguous binding identity and fails closed instead of guessing which
// binding owns the resource.
export function reportDuplicateTargets<T extends { binding: string }>(
  entries: ReadonlyArray<T>,
  targetOf: (entry: T) => string,
  fieldLabel: string,
  issues: WranglerV3Issue[],
): void {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const target = targetOf(entry);
    const first = seen.get(target);
    if (first !== undefined) {
      issues.push({
        code: "INVALID_SHAPE",
        field: fieldLabel,
        detail: `resource target "${target}" is declared by bindings "${first}" and "${entry.binding}"; one resource cannot be two bindings`,
      });
    } else {
      seen.set(target, entry.binding);
    }
  }
}

// Resolve a config-relative path (e.g. `main`) against the unit's config
// directory inside the ZIP. Returns the normalized ZIP-relative path, or null
// if the path is absolute, contains NUL, or escapes the ZIP root.
export function resolveZipRelativePath(baseDir: string, relPath: string): string | null {
  if (relPath.includes("\0")) {
    return null;
  }
  const normalized = relPath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return null;
  }
  const segments = [
    ...(baseDir === "" ? [] : baseDir.split("/")),
    ...normalized.split("/"),
  ];
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      if (out.length === 0) {
        return null;
      }
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length > 0 ? out.join("/") : null;
}
