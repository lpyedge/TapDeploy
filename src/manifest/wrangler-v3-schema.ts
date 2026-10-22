// Wrangler V3 config contract: the normalized result types and the field
// status matrix (supported / inert / unsupported). Declarative only: no parsing,
// no validation. The parser lives in wrangler-v3.ts.

export type WranglerV3Kind = "worker" | "pages";

export type WranglerV3IssueCode =
  | "INVALID_JSONC"
  | "INVALID_SHAPE"
  | "UNKNOWN_WRANGLER_FIELD"
  | "UNSUPPORTED_WRANGLER_FEATURE"
  | "UNCOMPILED_ENTRYPOINT"
  | "PATH_ESCAPES_UNIT";

export interface WranglerV3Issue {
  code: WranglerV3IssueCode;
  field: string;
  detail: string;
}

export interface WranglerV3Route {
  pattern: string;
  custom_domain?: boolean;
  zone_id?: string;
  zone_name?: string;
}

export interface WranglerV3RateLimit {
  name: string;
  namespace_id: string;
  limit: number;
  period: number;
}

export interface WranglerV3Workflow {
  name: string;
  binding: string;
  class_name: string;
  script_name?: string;
  // direct cron schedules (official string | string[] normalized to a
  // non-empty array). They never ride the version metadata; the carrier plan
  // carries them explicitly as deployment intent for the Workflows API.
  schedules?: string[];
}

export interface WranglerV3DurableObjectBinding {
  name: string;
  class_name: string;
  script_name?: string;
  environment?: string;
}

export interface WranglerV3Migration {
  tag: string;
  new_classes?: string[];
  new_sqlite_classes?: string[];
  renamed_classes?: { from: string; to: string }[];
  deleted_classes?: string[];
}

export interface WranglerV3ServiceBinding {
  binding: string;
  service: string;
  environment?: string;
  entrypoint?: string;
  // official props passthrough (ctx.props). Opaque JSON: shape-checked
  // and forwarded to the metadata, never interpreted.
  props?: Record<string, unknown>;
}

export interface WranglerV3Rule {
  type: "Text" | "Data" | "CompiledWasm";
  globs: string[];
  fallthrough?: boolean;
}

// resource bindings projected from the final Wrangler config. Each entry
// carries the Worker binding name plus the declared resource handle. Handle
// semantics are per family: R2 identifies a bucket by name (the only creation
// handle; identity is always read back from the account), D1 by name with an
// optional declared uuid, and KV by provider namespace id only. A declared
// provider id is an identity claim to verify against the current account, never
// a creation handle and never taken verbatim from an older environment.
export interface WranglerV3R2Bucket {
  binding: string;
  bucketName: string;
}

export interface WranglerV3D1Database {
  binding: string;
  databaseName: string;
  databaseId?: string;
}

export interface WranglerV3KvNamespace {
  binding: string;
  namespaceId: string;
}

// Worker platform bindings (official Wrangler shapes). Hyperdrive and Secrets
// Store ids are identity claims about the publisher's account; the plan
// resolves them against the installing account. Workers AI and Browser
// Rendering are binding-only (no account resource).
export interface WranglerV3Hyperdrive {
  binding: string;
  id: string;
}

export interface WranglerV3Vectorize {
  binding: string;
  indexName: string;
}

export interface WranglerV3SecretsStoreSecret {
  binding: string;
  storeId: string;
  secretName: string;
}

export interface WranglerV3RuntimeBinding {
  binding: string;
}

// queues carry two distinct roles with different provider effects. A
// producer entry declares a Worker environment binding
// ({type:"queue", name, queue_name}) against the queue name; a consumer entry
// registers a trigger on the queue's consumers subresource and produces NO
// Worker environment binding. The official Wrangler config keeps them as two
// separate arrays (queues.producers / queues.consumers); a queue declared in
// both arrays is allowed (the "both" role: produce to and consume from the
// same queue).
export interface WranglerV3QueueProducer {
  binding: string;
  queue: string;
}

export interface WranglerV3QueueConsumer {
  queue: string;
  /** Official config only supports worker consumers; the default is "worker". */
  type: "worker";
  max_batch_size?: number;
  /** Seconds to fill a batch; projected to provider max_wait_time_ms (×1000). */
  max_batch_timeout?: number;
  max_retries?: number;
  /** null means explicitly unlimited (same provider semantics as unset). */
  max_concurrency?: number | null;
  retry_delay?: number;
  dead_letter_queue?: string;
}

export interface WranglerV3Assets {
  directory: string;
  directoryPath: string;
  binding?: string;
  run_worker_first?: boolean | string[];
  html_handling?: string;
  not_found_handling?: string;
}

export interface WranglerV3Config {
  kind: WranglerV3Kind;
  configPath: string;
  baseDir: string;
  name: string;
  compatibility_date: string;
  compatibility_flags: string[];
  /** Built ESM entry module, resolved relative to the ZIP root. */
  main?: string;
  /** Pages output directory, resolved relative to the ZIP root. */
  pages_build_output_dir?: string;
  /** Pages production branch. Optional; the plan defaults it to "main". */
  production_branch?: string;
  assets?: WranglerV3Assets;
  workers_dev?: boolean;
  routes: WranglerV3Route[];
  vars?: Record<string, string | number | boolean>;
  crons: string[];
  r2Buckets: WranglerV3R2Bucket[];
  d1Databases: WranglerV3D1Database[];
  kvNamespaces: WranglerV3KvNamespace[];
  hyperdrive: WranglerV3Hyperdrive[];
  vectorize: WranglerV3Vectorize[];
  secretsStoreSecrets: WranglerV3SecretsStoreSecret[];
  ai?: WranglerV3RuntimeBinding;
  browser?: WranglerV3RuntimeBinding;
  queueProducers: WranglerV3QueueProducer[];
  queueConsumers: WranglerV3QueueConsumer[];
  ratelimits: WranglerV3RateLimit[];
  workflows: WranglerV3Workflow[];
  durableObjects: WranglerV3DurableObjectBinding[];
  migrations: WranglerV3Migration[];
  services: WranglerV3ServiceBinding[];
  rules: WranglerV3Rule[];
  /** Accepted, reviewed-metadata fields that carry no TapDeploy action. */
  inertFields: string[];
}

export interface WranglerV3Result {
  ok: boolean;
  config?: WranglerV3Config;
  issues: WranglerV3Issue[];
}

export interface WranglerV3Options {
  /** ZIP-relative path of the wrangler config file (default `wrangler.jsonc`). */
  configPath?: string;
}

export type WranglerV3FieldStatus = "supported" | "inert" | "unsupported";

export const WRANGLER_V3_SUPPORTED_FIELDS = [
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "workers_dev",
  "routes",
  "assets",
  "vars",
  "r2_buckets",
  "d1_databases",
  "kv_namespaces",
  "hyperdrive",
  "vectorize",
  "secrets_store_secrets",
  "ai",
  "browser",
  "queues",
  "triggers",
  "ratelimits",
  "workflows",
  "durable_objects",
  "migrations",
  "services",
  "rules",
  "pages_build_output_dir",
  "production_branch",
] as const;

export const WRANGLER_V3_INERT_FIELDS = ["$schema", "observability", "build"] as const;

export const WRANGLER_V3_UNSUPPORTED_FIELDS = [
  // the 2026 top-level `exports` workflow declaration (class-keyed, no
  // binding) has no TapDeploy implementation. It is refused with the accurate
  // "official Wrangler field not implemented" message instead of falling to
  // UNKNOWN_WRANGLER_FIELD; there is no exports-only declaration path — a
  // workflow must be declared through `workflows[]` where the carrier class
  // export, schedule set and provider readback are implemented.
  "exports",
  // Resource bindings without a TapDeploy implementation yet.
  "analytics_engine_datasets",
  "dispatch_namespaces",
  "mtls_certificates",
  "send_email",
  "pipelines",
  "tail_consumers",
  // Legacy static modules: V3 uses built ESM modules + `rules` instead.
  "python_modules",
  "wasm_modules",
  "text_blobs",
  "data_blobs",
  // Deployment/runtime switches without a TapDeploy implementation yet.
  "limits",
  "placement",
  "logpush",
  "cache",
  "unsafe",
  "sites",
  "site",
  "first_party_worker",
  "keep_vars",
  "dev",
  "secrets",
  // Bundler/build semantics: meaningless in a final prebuilt config.
  "no_bundle",
  "minify",
  "upload_source_maps",
  "define",
  "alias",
  "find_additional_modules",
  "preserve_file_names",
  "tsconfig",
  "jsx_factory",
  "jsx_fragment_factory",
  "jsx_import_source",
  "base_dir",
] as const;

export const WRANGLER_V3_FIELD_MATRIX: Readonly<Record<string, WranglerV3FieldStatus>> =
  (() => {
    const matrix: Record<string, WranglerV3FieldStatus> = {};
    for (const f of WRANGLER_V3_SUPPORTED_FIELDS) {
      matrix[f] = "supported";
    }
    for (const f of WRANGLER_V3_INERT_FIELDS) {
      matrix[f] = "inert";
    }
    for (const f of WRANGLER_V3_UNSUPPORTED_FIELDS) {
      matrix[f] = "unsupported";
    }
    return matrix;
  })();
