// Read-only deployment planning types. A plan is derived from the release spec,
// the operator form inputs and an actual snapshot of the remote account; it
// never mutates anything. Diffs carry identity only — secret values must never
// appear in any plan field.

import type { DeploySpec, SecretPolicy } from "../deploy-spec.js";
import type { QueueConsumerSettings } from "../../cloudflare/models/queues.js";

// A structural problem found while turning a prepared release into a
// DeploySpec; any issue blocks the plan before a provider read.
export interface ProjectionIssue {
  kind:
    | "missing-input"
    | "missing-required-input"
    | "invalid-input"
    | "unknown-worker-name-input"
    | "unsupported-binding"
    | "conflicting-r2"
    | "conflicting-binding"
    | "unknown-upgrade-policy"
    | "wrangler";
  field: string;
  detail: string;
}

type PlanKind = "install" | "upgrade" | "blocked";

// the concrete hosting target kind and the install-vs-upgrade mode the plan
// is bound to. Both are derived from the operator's explicit selector (not
// inferred from a bare worker-name input) and are bound into the plan + expected
// target so an account/mode/target change cannot silently re-deploy elsewhere.
type PlanTargetKind = "workers" | "pages";

type PlanAction = "create" | "update" | "preserve" | "conflict" | "skip" | "attach" | "detach";

export type PlanResource =
  | "worker"
  | "static-assets"
  | "deployment"
  | "r2"
  | "d1"
  | "kv"
  | "queue"
  // a consumer trigger registration on the queue's consumers
  // subresource, distinct from the account queue resource itself.
  | "queue-consumer"
  // an account Workflow definition declared by a carrier unit (applied
  // through the Workflows API after the carrier version is active).
  | "workflow"
  | "hyperdrive"
  | "vectorize"
  | "secrets-store"
  | "secret"
  | "schedule"
  | "rate-limit"
  // explicit workers.dev enablement intent (declared workers_dev:true).
  // Dispatched only through the provider-verified publish step; never disabled.
  | "workers-dev"
  // Pages project (the Pages target identity, distinct from a Worker).
  | "pages-project"
  // opt-in domain/route/DNS resources.
  | "dns-record"
  | "worker-route"
  | "worker-custom-domain"
  | "pages-custom-domain";

export interface ResourceDiff {
  resource: PlanResource;
  action: PlanAction;
  name?: string;
  before?: string;
  after?: string;
  detail?: string;
}

type GuardCode =
  | "missing-account"
  | "wrong-account"
  | "wrong-target-kind"
  | "unrelated-worker"
  // the target Worker was deployed another way (no installer marker on its
  // active version); blocks unless the operator confirmed taking it over.
  | "unmanaged-worker"
  | "wrong-project-owner"
  | "r2-drift"
  | "d1-drift"
  | "kv-drift"
  | "queue-drift"
  // a declared Workflow collides with a foreign definition (different
  // class/script) or its live facts were not read; the definition is never
  // overwritten unverified.
  | "workflow-drift"
  | "hyperdrive-drift"
  | "vectorize-drift"
  | "secrets-store-drift"
  | "secret-drift"
  | "remote-drift"
  | "stale-deployed-version"
  | "contradictory-manifest"
  // a Pages target may not carry a resource family unsupported by
   // the Pages deployment config (Cron schedules and unimplemented bindings).
  | "unsupported-pages-resource"
  // a declared zone-scoped domain/route/DNS write could not be safely
  // applied (unsupported kind, missing zone, or a resource owned by another
  // process would be clobbered).
  | "domain-drift";

export interface PlanGuard {
  code: GuardCode;
  level: "block" | "warn";
  detail: string;
}

// Facts about the live remote target, gathered read-only.
export interface TargetSnapshot {
  accountId: string;
  workerName: string;
  workerExists: boolean;
  workerEtag?: string;
  versions: { id: string; number?: number; message?: string }[];
  latestVersionId?: string;
  activeDeploymentId?: string;
  activeDeploymentVersionIds: string[];
  // Binding inventory of the exact, exclusively active immutable version.
  // Undefined means unproven; never substitute latest-uploaded script settings.
  activeBindings?: Array<Record<string, unknown>>;
  r2Buckets: { name: string; id: string }[];
  // live D1 database + KV namespace identities for the account.
  d1Databases: { name: string; id: string }[];
  kvNamespaces: { name: string; id: string }[];
  // live Queue + Hyperdrive config identities for the account.
  queues: { name: string; id: string }[];
  // live consumer triggers per queue name (queue name -> consumers). Read
  // only when the graph declares consumer/both queue bindings; a consumer
  // trigger delivers to exactly one script, so the exact script identity is
  // part of the fact. Settings are the provider-reported consumer settings
  // (never credentials).
  queueConsumers?: Record<string, QueueConsumerFact[]>;
  // live account Workflow definitions, read only when the graph declares
  // a workflow resource (listWorkflows). Each fact is the provider-reported
  // identity (name/class/script) plus the exact live direct schedule set; the
  // plan refuses to touch a definition whose class/script is not this carrier.
  workflows?: WorkflowFact[];
  hyperdriveConfigs: { name: string; id: string; origin?: { database: string; host?: string; port?: number; scheme?: "postgres" | "postgresql" | "mysql"; user?: string } }[];
  // live Vectorize index + Secrets Store identities for the account.
  vectorizeIndexes: { name: string; id: string; config?: { dimensions?: number; metric?: "cosine" | "euclidean" | "dot-product"; preset?: string } }[];
  secretsStores: { name: string; id: string }[];
  secretsStoreSecrets: { secretName: string; id: string; store_id: string }[];
  // live deployed binding identity for every resource family the installer
  // binds (R2, D1, KV, Queue, Hyperdrive, Vectorize, Secrets Store), read from
  // GET .../settings. Each map is binding-name -> the target identity the deployed
  // Worker currently resolves to. Used on upgrade to refuse a silent rebind of a
  // binding to a different resource; never carries credentials or secret values.
  deployedBindings?: DeployedBindingMap;
  secretNames: string[];
  scheduleCrons: string[];
  rateLimitCount: number;
  // Pages target facts. For a Pages snapshot `workerName` is set to the
  // Pages project name, `workerExists` is false and `pagesProjectExists` carries
  // whether the project is present. `pagesActiveDeploymentId` is the canonical /
  // latest deployment id; used to detect a silent outside deploy between plan
  // and write. Empty arrays for a Workers snapshot.
  pagesProjectExists?: boolean;
  pagesProjectId?: string;
  pagesOwnerProjectId?: string;
  pagesActiveDeploymentId?: string;
  pagesActiveDeploymentStatus?: string;
  // The project's provider-assigned `*.pages.dev` hostname; a Pages custom
  // domain's CNAME points at it.
  pagesSubdomain?: string;
  // opt-in domain/route/DNS live facts. `zones` (id + name) is the zone
  // selector; `dnsRecords` (`{zoneId,id,name,type,content}`), `workerRoutes`
  // (`{zoneId,id,pattern,script}`) and `workerDomains` (`{id,hostname}`) are the
  // live identities used for collision detection and exact ownership. Empty when
  // the release declares no domain/route/DNS intent (CAPABILITY_GATED: reads are
  // only performed when a domain need is present).
  zones?: { id: string; name: string }[];
  dnsRecords?: { zoneId: string; id: string; name: string; type: string; content?: string; ttl?: number; proxied?: boolean }[];
  workerRoutes?: { zoneId: string; id: string; pattern: string; script?: string }[];
  workerDomains?: { id: string; hostname: string; service?: string; zone_id?: string }[];
  // Pages custom domains for a Pages target (`{name}`). Only present when a
  // Pages release declares a pages-custom-domain.
  pagesDomains?: { id?: string; domain_id?: string; name: string; status?: string }[];
}

// one live queue consumer trigger. `consumerId` is the provider identity
// used for exact update addressing; `scriptName` is the delivering Worker (may
// be absent for non-worker consumer types, which are never owned). Facts are
// read-only and carry no credentials.
export interface QueueConsumerFact {
  consumerId: string;
  scriptName?: string;
  type?: string;
  settings?: QueueConsumerSettings;
  deadLetterQueue?: string;
}

// one live account Workflow definition. `id` is the provider identity,
// `name` is the account-unique address, `className`/`scriptName` are the
// ownership identity (a definition owned by a different class or script is
// foreign and is never overwritten), and `schedules` is the exact live direct
// cron set. Facts are read-only and carry no credentials.
export interface WorkflowFact {
  id: string;
  name: string;
  className: string;
  scriptName: string;
  schedules: string[];
}

// the full deployed binding identity map read from GET .../settings.
// Each key is the binding "name" (e.g. "DB"); the value is the target identity the
// deployed Worker currently points at. A `*Name` field holds the account resource
// name (R2 bucket, KV namespace, Queue, Vectorize index, Secrets Store secret) and
// a `*Id` field holds the account resource id (D1 database, KV namespace,
// Hyperdrive config, Secrets Store store). Secret values are never present.
export interface DeployedBindingMap {
  r2?: Record<string, string>;
  d1?: Record<string, string>;
  kv?: Record<string, string>;
  queue?: Record<string, string>;
  hyperdrive?: Record<string, string>;
  vectorize?: Record<string, string>;
  secretsStore?: Record<string, { storeId: string; secretName: string }>;
  // Workers AI / Browser Rendering runtime bindings (binding -> canonical type).
  // Read for the post-deploy binding check only; not part of plan drift.
  runtime?: Record<string, "ai" | "browser-rendering">;
}

// Prior plan/revalidation base used to detect drift before any write. This is
// what the second of two near-simultaneous planners compares against.
export interface ExpectedTarget {
  pagesProjectId?: string;
  domainBaseline?: {
    names: string[];
    zones: TargetSnapshot["zones"];
    dnsRecords: TargetSnapshot["dnsRecords"];
    workerRoutes: TargetSnapshot["workerRoutes"];
    workerDomains: TargetSnapshot["workerDomains"];
    pagesDomains: TargetSnapshot["pagesDomains"];
  };
  accountId: string;
  workerName: string;
  activeDeploymentId?: string;
  latestVersionId?: string;
  r2BucketIds?: Record<string, string>;
  // D1 database + KV namespace identities at plan time (name -> id).
  d1DatabaseIds?: Record<string, string>;
  kvNamespaceIds?: Record<string, string>;
  // Queue + Hyperdrive config identities at plan time (name -> id).
  queueIds?: Record<string, string>;
  hyperdriveConfigIds?: Record<string, string>;
  hyperdriveOrigins?: Record<string, NonNullable<TargetSnapshot["hyperdriveConfigs"][number]["origin"]>>;
  vectorizeConfigs?: Record<string, NonNullable<TargetSnapshot["vectorizeIndexes"][number]["config"]>>;
  missingResources?: Partial<Record<"r2BucketIds" | "d1DatabaseIds" | "kvNamespaceIds" | "queueIds" | "hyperdriveConfigIds" | "vectorizeIndexIds" | "secretsStoreIds", string[]>>;
  // Vectorize index + Secrets Store identities at plan time (name -> id).
  vectorizeIndexIds?: Record<string, string>;
  secretsStoreIds?: Record<string, string>;
  // deployed binding map at plan time for every resource family.
  // Compared against the fresh snapshot before each write to catch an outside
  // rebind (binding now pointing at a different R2/D1/KV/Queue/Hyperdrive/
  // Vectorize/Secrets Store resource).
  deployedBindings?: DeployedBindingMap;
  secretNames?: string[];
  // opt-in domain/route/DNS identities at plan time. Compared against the
  // fresh snapshot before each write so a domain/route/DNS change made outside
  // the plan (or by another operator) fails closed rather than being clobbered.
  // A DNS record / route / custom domain that the operator explicitly manages
  // is recorded by its exact id; the installer only ever writes those ids.
  dnsRecordIds?: Record<string, string>;
  workerRouteIds?: Record<string, string>;
  workerDomainIds?: Record<string, string>;
  // the target kind + mode this plan was built for is bound so a changed
  // account/mode/target invalidates the prior plan.
  targetKind?: PlanTargetKind;
  mode?: PlanKind;
}

export interface SecretPlanSummary {
  name: string;
  policy: SecretPolicy;
  exists: boolean;
}

export interface PlanInput {
  spec?: DeploySpec;
  projectionIssues?: ProjectionIssue[];
}

export interface DeployPlan {
  kind: PlanKind;
  accountId: string;
  workerName: string;
  projectId: string;
  projectVersion: string;
  activeDeploymentId?: string;
  // Immutable id of the existing Pages project a preserve plan was built
  // against; the step gate re-proves it live instead of a mutation receipt.
  pagesProjectId?: string;
  diffs: ResourceDiff[];
  guards: PlanGuard[];
  secretSummary: SecretPlanSummary[];
  digest: string;
  blocked: boolean;
  // the target kind this plan is bound to. For v1 Workers-only
  // releases this is always "workers"; a Pages target sets "pages".
  targetKind: PlanTargetKind;
}

// multi-unit execution progress.
// A plan is never an atomic multi-target transaction: every unit carries its
// own state and, once its boundary is sealed, its own receipt digest. A
// partially completed graph resumes from live provider state and never
// auto-rolls back another unit's existing resources.
type UnitProgressState = "pending" | "in-progress" | "succeeded" | "failed" | "skipped";

export interface UnitProgressEntry {
  unitId: string;
  state: UnitProgressState;
  /** Sealed receipt digest once the unit boundary completed; null while pending. */
  receiptDigest: string | null;
}
