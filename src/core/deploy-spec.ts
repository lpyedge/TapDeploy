export type PrimitiveInputValue = string | boolean | number;

export function isPrimitiveInputValue(v: unknown): v is PrimitiveInputValue {
  return typeof v === "string" || typeof v === "boolean" || typeof v === "number";
}

export type SecretPolicy =
  | "generate-once"
  | "prompt-on-install"
  | "preserve-only"
  // Upgrade: the user supplies a new value that replaces the existing secret.
  | "replace";

export interface ReleaseFile {
  path: string;
  size: number;
  sha256: string;
  // publisher-declared Cloudflare Pages upload hash
  // (32-hex; BLAKE3(base64(contents)+extension), see cloudflare/pages/manifest).
  // Only meaningful for Pages release assets. It is part of the approved release
  // identity (bound into the plan digest), so a browser-supplied Pages manifest
  // can be validated against an approved hash instead of accepting arbitrary
  // 32-hex strings. Absent for Workers artifacts (never computed there).
  pagesHash?: string;
  workersHash?: string;
}

// How the Worker uses a queue: "producer" binds it, "consumer" registers the
// Worker as the queue's consumer, "both" does both on the same queue.
export type QueueRole = "producer" | "consumer" | "both";

// Connection origin fields the installer forwards only when creating a
// hyperdrive config. Never logged; write-only secrets are stripped on any read.
export interface HyperdriveOriginInput {
  database: string;
  host?: string;
  port?: number;
  scheme?: "postgres" | "postgresql" | "mysql";
  user?: string;
  password?: string;
  access_client_id?: string;
  access_client_secret?: string;
}

export interface R2BindingSpec {
  binding: string;
  bucketName: string;
  createIfMissing: boolean;
  // The config lets the user bind another resource on upgrade (`upgradeKeep: false`).
  changeOnUpgrade?: true;
}

// D1 database binding spec resolved from a manifest declaration + input.
// `databaseName` is the authoritative chosen name; `createIfMissing` allows the
// installer to create an absent D1 database (never delete/migrate). A declared
// `databaseId` (V3 Wrangler `database_id`) is an identity claim that must be
// verified against the live account: it is never recreated, and a name/id
// mismatch fails closed instead of silently rebinding.
export interface D1BindingSpec {
  binding: string;
  databaseName: string;
  createIfMissing: boolean;
  // The config lets the user bind another resource on upgrade (`upgradeKeep: false`).
  changeOnUpgrade?: true;
  databaseId?: string;
}

// KV namespace binding spec resolved from a manifest declaration + input.
// `namespaceName` is the authoritative chosen name; `createIfMissing` allows the
// installer to create an absent namespace (never mutate existing keys).
// A declared `namespaceId` (V3 Wrangler `kv_namespaces[].id`) is a provider
// identity claim, never a creation title: the live account is verified by id
// and a missing/foreign/ambiguous id fails closed instead of provisioning a
// namespace named by the id.
export interface KvBindingSpec {
  binding: string;
  namespaceName: string;
  createIfMissing: boolean;
  // The config lets the user bind another resource on upgrade (`upgradeKeep: false`).
  changeOnUpgrade?: true;
  namespaceId?: string;
}

// Queue binding spec resolved from a manifest declaration + input.
// `queueName` is the authoritative chosen name; `createIfMissing` allows the
// installer to create an absent queue (never drain/delete). `role` distinguishes
// a producer binding from a consumer trigger registration. `binding` is
// absent for a consumer-only queue (wrangler `queues.consumers` carries no
// producer binding, so no Worker environment name exists); `consumer` carries
// the declared consumer settings for the trigger registration.
// Structural mirror of resources/queues `DeclaredQueueConsumer` so this pure
// spec module stays dependency-free.
export interface QueueConsumerSpec {
  queue: string;
  type: "worker";
  max_batch_size?: number;
  max_batch_timeout?: number;
  max_retries?: number;
  max_concurrency?: number | null;
  retry_delay?: number;
  dead_letter_queue?: string;
}

export interface QueueBindingSpec {
  binding?: string;
  queueName: string;
  createIfMissing: boolean;
  // The config lets the user bind another resource on upgrade (`upgradeKeep: false`).
  changeOnUpgrade?: true;
  role?: QueueRole;
  consumer?: QueueConsumerSpec;
}

// Workflow binding + definition spec resolved from the wrangler config.
// A workflow is a carrier-declared account entity (unique per account): the
// binding rides the Worker version metadata exactly, and the definition
// (class_name + the exact direct schedule set) is applied through the
// Workflows API after the carrier version is active. `className` must be
// exported by the unit's entry module (verified before release sealing).
export interface WorkflowBindingSpec {
  binding: string;
  name: string;
  className: string;
  /** The full desired direct cron set; the declared set is authoritative. */
  schedules: string[];
}

// Hyperdrive config binding spec resolved from a manifest declaration +
// input. `configName` is the authoritative chosen name; `createIfMissing` allows
// the installer to create an absent config (never rotate credentials). `origin`
// is applied only on create and never logged.
export interface HyperdriveBindingSpec {
  binding: string;
  configName: string;
  createIfMissing: boolean;
  origin?: HyperdriveOriginInput;
  // Wrangler `id` from the release: an identity claim about the publisher's
  // account, resolved to a live config (or the operator's choice) at plan time.
  configId?: string;
}

// Vectorize index binding spec resolved from a manifest declaration +
// input. `indexName` is the authoritative chosen name; `createIfMissing` allows
// the installer to create an absent index. An index's dimension/metric
// configuration is immutable on the live resource, so it is never silently
// changed in place; `config` applies only on create.
export interface VectorizeBindingSpec {
  binding: string;
  indexName: string;
  createIfMissing: boolean;
  // The config lets the user bind another resource on upgrade (`upgradeKeep: false`).
  changeOnUpgrade?: true;
  config?: VectorizeIndexInputConfig;
}

// Vectorize index configuration applied only when an index is actually created.
// Either explicit {dimensions, metric} or a model preset; never mutated in place.
export interface VectorizeIndexInputConfig {
  dimensions?: number;
  metric?: "cosine" | "euclidean" | "dot-product";
  preset?: string;
}

// Secrets Store binding spec resolved from a manifest declaration + input.
// `storeName` is the authoritative chosen store; `createIfMissing` allows the
// installer to create an absent store. A Worker binds a specific secret inside
// the store by `secretName`; `value` is write-only and is applied only on the
// first create, never read back or logged.
export interface SecretsStoreBindingSpec {
  binding: string;
  storeName: string;
  createIfMissing: boolean;
  secretName?: string;
  secretCreateIfMissing?: boolean;
  secretScopes?: string[];
  // Write-only secret value, forwarded only on create. Never logged/persisted.
  secretValue?: string;
  // Wrangler `store_id` from the release (identity claim, resolved at plan time).
  storeId?: string;
}

export interface SecretsStoreSecretSpec {
  binding: string;
  secretName: string;
  storeId: string;
  storeName: string;
  secretCreateIfMissing: boolean;
  secretScopes?: string[];
}

// Runtime-binding kinds (Workers AI / Browser Rendering). These are NOT
// creatable per-app account resources; they are declared and bound, period. No
// create/preserve lifecycle, no account list to verify, and no provision scope
// beyond the enclosing Worker target's admin scope. A config kind maps to a
// canonical runtime-binding type which emits a specific Worker binding shape.
export type RuntimeBindingType = "ai" | "browser-rendering";

// Resolved runtime binding on the DeploySpec / WranglerProjection. `type` is the
// canonical runtime-binding kind; the deploy step maps it to the official
// Worker binding shape (`ai` -> {type:"ai",name}, `browser-rendering` ->
// {type:"browser",name}).
export interface RuntimeBindingSpec {
  binding: string;
  type: RuntimeBindingType;
}

// opt-in custom-domain / Worker-route / DNS changes. Each entry is an
// explicit, pre-authorized intent the operator picked inside the one-shot
// envelope; nothing is auto-applied. The installer never bulk-modifies a zone
// and never deletes DNS on an ordinary Worker upgrade.
//
// `workers-route`: a zone-scoped URL pattern mapped to this Worker.
// `workers-custom-domain` / `pages-custom-domain`: a hostname attached directly
//   to the target (Cloudflare creates the DNS record + certificate).
// `dns-record`: a raw DNS record created/updated in a chosen zone.
export type ConfigDomainKind =
  | "workers-route"
  | "workers-custom-domain"
  | "pages-custom-domain"
  | "dns-record";

// Resolved opt-in domain/route/DNS change on the DeploySpec. `hostname` /
// `zoneName` are the operator-supplied values; `zoneId` is resolved against the
// live snapshot at plan time so a write only ever targets the selected zone.
// How a domain entry treats an existing match: keep it, replace it after the
// operator's explicit confirmation, or (custom domains on upgrade) remove it.
export type DomainUpdateAction = "preserve" | "explicit-change" | "detach";

export interface DomainEntrySpec {
  kind: ConfigDomainKind;
  // The canonical hostname (routes/dns/custom domains) or the route pattern
  // (workers-route). For a route this is the URL pattern, e.g. "*.example.com/*".
  hostname: string;
  zoneName?: string;
  zoneId?: string;
  recordType?: string;
  recordContent?: string;
  ttl?: number;
  proxied?: boolean;
  updateAction?: DomainUpdateAction;
}

export interface AssetConfig {
  directory: string;
  binding?: string;
  run_worker_first?: boolean | string[];
  html_handling?: string;
  not_found_handling?: string;
}

export interface WranglerProjection {
  name: string;
  services?: Array<{ binding: string; service: string; entrypoint?: string }>;
  // a Workers release always has a worker entrypoint (`main`). A Pages
  // release has no worker module, so `main` is absent (static assets only).
  main?: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  assets?: AssetConfig;
  // explicit workers.dev publication intent (true/false/absent) carried
  // from the normalized Wrangler config. Only `true` plans a graph action;
  // `false`/absent leaves the live setting untouched (never disabled).
  workers_dev?: boolean;
  r2_buckets: { binding: string; bucket_name: string }[];
  d1_databases?: { binding: string; database_name: string }[];
  kv_namespaces?: { binding: string; id: string }[];
  // Queue producer bindings and Hyperdrive config bindings carried through
  // the wrangler projection so the deploy metadata builder can bind them.
  // `binding` is absent for a consumer-only queue (trigger registration, no env
  // binding).
  queues?: { binding?: string; queue_name: string; role?: QueueRole }[];
  // Workflow bindings carried through the wrangler projection so the
  // deploy metadata builder binds `{type:"workflow", name, workflow_name,
  // class_name, script_name?}` into the version. `script_name` is carried only
  // when the declaration named this same script explicitly; an external
  // script_name is refused before the projection exists. The schedules are not
  // part of the version metadata; they are applied through the Workflows API
  // (see DeploySpec.cloudflare.workflows).
  workflows?: { binding: string; name: string; class_name: string; script_name?: string }[];
  // Durable Object bindings carried through the wrangler projection so
  // the deploy metadata builder binds `{type:"durable_object_namespace",
  // name, class_name}` into the version (own script only; script_name is
  // omitted exactly as wrangler sends it). Validated pure new-class migrations
  // ride the same atomic upload verbatim (see `migrations` below).
  durableObjects?: { name: string; class_name: string }[];
  migrations?: { tag: string; new_classes?: string[]; new_sqlite_classes?: string[] }[];
  // rate-limit metadata bindings carried through the wrangler projection
  // so the deploy metadata builder can bind them. These are version metadata
  // only — never account/zone rate-limit rule provisioning.
  ratelimits?: { name: string; namespace_id: string; limit: number; period: number }[];
  hyperdrive?: { binding: string; id: string }[];
  // Vectorize + Secrets Store bindings carried through the wrangler
  // projection so the deploy metadata builder can bind them.
  vectorize?: { binding: string; index_name: string }[];
  secrets_store_secrets?: {
    binding: string;
    store_id: string;
    secret_name: string;
  }[];
  // Runtime-binding projections (Workers AI / Browser Rendering). Each
  // entry carries the binding (env var name); the deploy step maps the `type`
  // to the official Worker/Pages version binding shape.
  ai?: { binding: string }[];
  browser?: { binding: string }[];
  crons: string[];
  vars?: Record<string, string | number | boolean>;
}

export interface DeploySpec {
  schemaVersion: 1;
  project: {
    id: string;
    version: string;
    homepage?: string;
  };
  // `worker` is set for a Workers release; a Pages release has no worker
  // module (it is static assets + optional prebuilt `_worker.js` bundle).
  worker?: ReleaseFile;
  workerBundle?: ReleaseFile;
  assets: ReleaseFile[];
  inputs: Record<string, PrimitiveInputValue>;
  cloudflare: {
    workerName: string;
    r2: R2BindingSpec[];
    d1: D1BindingSpec[];
    kv: KvBindingSpec[];
    queues: QueueBindingSpec[];
    // carrier-declared Workflow definitions. Optional: absent means "no
    // Workflow declared". Never
    // present for a Pages release (workflows require a Worker carrier; the V3
    // plan refuses otherwise). A consumer must treat absent as "none" and fail
    // closed on any declared workflow it cannot verify.
    workflows?: WorkflowBindingSpec[];
    hyperdrive: HyperdriveBindingSpec[];
    vectorize: VectorizeBindingSpec[];
    secretsStore: SecretsStoreBindingSpec[];
    // runtime bindings (Workers AI / Browser Rendering). Binding-only, no
    // account resource or lifecycle.
    runtimeBindings: RuntimeBindingSpec[];
    cron: string[];
    secrets: Record<string, SecretPolicy>;
    // opt-in custom-domain / Worker-route / DNS changes. Only ever applied
    // inside the preauthorized envelope; never bulk-modifies a zone. Absent for
    // a release that declares no domain/route/DNS intent.
    domains?: DomainEntrySpec[];
    // Pages target identity + environment projection. Absent for Workers.
    pages?: {
      projectName: string;
      productionBranch?: string;
      vars?: Record<string, string>;
    };
  };
  ui?: {
    description?: string;
    onboardingUrl?: string;
  };
  wrangler: WranglerProjection;
  // the target deployment kind. "workers" is the existing path; "pages"
  // routes to the Pages direct-upload deploy steps (never the Workers version
  // API).
  targetKind: "workers" | "pages";
}
