// Read-only remote snapshot gathering through the typed Cloudflare client used
// by planning and pre-write drift checks. Missing resources map to "absent"
// rather than errors. capability-gated — schedules/rate-limit bindings are
// only queried for an existing worker. Explicitly requested resource discovery
// fails closed on missing permissions; undeclared resource lists are
// skipped by the API; a need left unspecified is read optionally (a missing
// permission yields an empty list). Any real API failure
// (network, server) still propagates so the planner cannot build from partial
// facts. Rate-limit presence is derived from the documented worker settings
// bindings (GET .../settings), not the undocumented /rate-limits path.

import type { ConfigDomainKind } from "../deploy-spec.js";
import type { CloudflareApiClient, CloudflareApiError } from "../../cloudflare/client/index.js";
import type { WorkerScriptMeta, PagesProject } from "../../cloudflare/models/index.js";
import type { TargetSnapshot, DeployedBindingMap, QueueConsumerFact, WorkflowFact } from "./types.js";
import type { DeploymentGraph } from "./deploy-graph.js";
import { PAGES_PROJECT_MARKER } from "./pages-identity.js";

export interface SnapshotNeeds {
  r2?: boolean;
  d1?: boolean;
  kv?: boolean;
  queues?: boolean;
  // per-queue consumer trigger facts (listQueueConsumers). Read only when
  // the release declares consumer/both queue roles.
  queueConsumers?: boolean;
  // account Workflow definitions (listWorkflows). Read only when the graph
  // declares a workflow resource; never part of a default read set (the
  // Workflows permission is distinct from the other resource scopes).
  workflows?: boolean;
  hyperdrive?: boolean;
  vectorize?: boolean;
  secretsStore?: boolean;
  schedules?: boolean;
  rateLimits?: boolean;
  secrets?: boolean;
  // opt-in domain/route/DNS. When true (a domain need is present) the zone /
  // DNS record / route / custom-domain reads run; otherwise they are skipped so a
  // release that declares no domain intent never demands zone.read / DNS scope.
  domains?: boolean;
  domainKinds?: ConfigDomainKind[];
  zoneNames?: string[];
}

export interface SnapshotOptions {
  accountId: string;
  workerName: string;
  needs?: SnapshotNeeds;
  // when "pages", the worker-oriented reads are skipped and Pages project /
  // deployment state is gathered instead. Defaults to "workers".
  targetKind?: "workers" | "pages";
}

function isNotFound(error: unknown): boolean {
  const e = error as CloudflareApiError;
  return typeof e === "object" && e !== null && e.kind === "not-found";
}

function isMissingScope(error: unknown): boolean {
  const e = error as CloudflareApiError;
  return (
    typeof e === "object" &&
    e !== null &&
    (e.kind === "forbidden" || e.kind === "unauthorized")
  );
}

async function getWorkerOrNull(
  client: CloudflareApiClient,
  workerName: string,
): Promise<WorkerScriptMeta | undefined> {
  try {
    return await client.getWorker(workerName);
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function snapshotTarget(
  client: CloudflareApiClient,
  opts: SnapshotOptions,
): Promise<TargetSnapshot> {
  if (opts.targetKind === "pages") {
    return snapshotPagesTarget(client, opts);
  }
  const accountClient = client.withAccount(opts.accountId);
  const worker = await getWorkerOrNull(accountClient, opts.workerName);
  const workerExists = worker !== undefined;
  const workerEtag = worker?.etag;
  const needs = opts.needs ?? {};

  const versions = workerExists
    ? await accountClient.listVersions(opts.workerName)
    : [];
  const deployments = workerExists
    ? await accountClient.listDeployments(opts.workerName)
    : [];

  const activeDeployment = deployments[0];
  const activeIds = [...new Set((activeDeployment?.versions ?? []).map(v => v.version_id))];
  if (activeIds.some(id => !id) || activeIds.length > 2) throw new Error("ambiguous active version inventory");
  const activeDetails = await Promise.all(activeIds.map(id => accountClient.getVersion(opts.workerName, id)));
  for (const version of activeDetails) {
    if (!versions.some(v => v.id === version.id)) versions.push(version);
  }
  const activeBindings = activeDetails.length === 1 ? activeDetails[0]?.resources?.bindings as Array<Record<string, unknown>> : undefined;
  // Unrelated minimal releases (absent worker, no cron/rate-limit need) must not
  // trigger schedule/rate-limit reads at all.
  const scheduleCrons =
    workerExists && needs.schedules !== false
      ? await readSchedules(accountClient, opts.workerName, needs.schedules === true)
      : [];
  const rateLimitCount =
    activeBindings ? activeBindings.filter(b => b.type === "ratelimit").length : workerExists && needs.rateLimits !== false
      ? await readRateLimitCount(accountClient, opts.workerName)
      : 0;
  const secretNames = activeBindings
    ? activeBindings.filter(b => b.type === "secret_text" || b.type === "secret_key").map(b => String(b.name))
    : workerExists && needs.secrets !== false
      ? (await accountClient.listSecrets(opts.workerName)).map((s) => s.name) : [];
  const r2Buckets =
    needs.r2 !== false ? await readR2Buckets(accountClient, needs.r2 === true) : [];
  const d1Databases =
    needs.d1 !== false ? await readD1Databases(accountClient, needs.d1 === true) : [];
  const kvNamespaces =
    needs.kv !== false ? await readKvNamespaces(accountClient, needs.kv === true) : [];
  const queues =
    needs.queues !== false ? await readQueues(accountClient, needs.queues === true) : [];
  // live consumer triggers per queue, read only when the release declares
  // consumer/both queue roles. The triggers are attached to the queues read
  // above; a missing Queues scope maps to {} when the read is optional and
  // fails closed when the plan genuinely needs the facts.
  const queueConsumers =
    needs.queueConsumers !== false && needs.queues !== false
      ? await readQueueConsumers(accountClient, queues, needs.queueConsumers === true)
      : {};
  // live account Workflow definitions, read only when the release declares
  // a workflow. Never read by default: the Workflows permission is not implied
  // by any other resource scope. `undefined` means "not read" (the plan refuses
  // to touch a declared workflow without facts, never assumes absence).
  const workflows =
    needs.workflows === true ? await readWorkflows(accountClient, true) : undefined;
  const hyperdriveConfigs =
    needs.hyperdrive !== false ? await readHyperdriveConfigs(accountClient, needs.hyperdrive === true) : [];
  const vectorizeIndexes =
    needs.vectorize !== false ? await readVectorizeIndexes(accountClient, needs.vectorize === true) : [];
  const secretsStores =
    needs.secretsStore !== false ? await readSecretsStores(accountClient, needs.secretsStore === true) : [];
  // the secrets inside each store, only when the store list was read.
  const secretsStoreSecrets = needs.secretsStore !== false
    ? await readSecretsStoreSecrets(accountClient, secretsStores, needs.secretsStore === true)
    : [];
  // full deployed binding identity map for every resource family; feeds the
  // upgrade rebind guards. Missing permission is not an empty verified map.
  const deployedBindings =
    workerExists ? await readDeployedBindings(accountClient, opts.workerName, activeBindings) : {};

  // opt-in domain/route/DNS facts. Capability-gated: only gathered when the
  // release declares a domain/route/DNS intent, so a minimal release never
  // demands zone.read / DNS scope (DNS Write does not imply Zone Read).
  const domainFacts = needs.domains !== false
    ? await readDomainFacts(accountClient, needs.domainKinds, needs.zoneNames)
    : undefined;

  return {
    accountId: opts.accountId,
    workerName: opts.workerName,
    workerExists,
    workerEtag,
    versions: versions.map((v) => ({
      id: v.id,
      number: v.number,
      message: v.message,
    })),
    latestVersionId: versions[0]?.id,
    activeDeploymentId: activeDeployment?.id,
    activeDeploymentVersionIds:
      activeDeployment?.versions.map((v) => v.version_id) ?? [],
    ...(activeBindings ? { activeBindings } : {}),
    r2Buckets,
    d1Databases,
    kvNamespaces,
    queues,
    queueConsumers,
    hyperdriveConfigs,
    vectorizeIndexes,
    secretsStores,
    secretsStoreSecrets,
    deployedBindings,
    secretNames,
    scheduleCrons,
    rateLimitCount,
    ...(workflows !== undefined ? { workflows } : {}),
    ...(domainFacts ?? {}),
  };
}

// gather read-only Pages target facts for a Pages release. The project is
// read by name; a missing project maps to "absent" (install). The canonical /
// latest deployment status is captured so a silent outside deploy between plan
// and write is detectable. Worker-oriented reads are never done for a Pages
// target; Pages is a distinct runtime. Only a real 404 means an absent
// project; missing permission must never be interpreted as a fresh install.
async function snapshotPagesTarget(
  client: CloudflareApiClient,
  opts: SnapshotOptions,
): Promise<TargetSnapshot> {
  const projectName = opts.workerName;
  const accountClient = client.withAccount(opts.accountId);
  let project: PagesProject | undefined;
  let activeDeploymentId: string | undefined;
  let activeDeploymentStatus: string | undefined;
  let pagesDomains: { id?: string; domain_id?: string; name: string; status?: string }[] = [];
  // Zone / DNS / Worker-domain facts only for a Pages unit with domain entries.
  const domainFacts = opts.needs?.domains === true && opts.needs.domainKinds !== undefined
    ? await readDomainFacts(accountClient, opts.needs.domainKinds, opts.needs.zoneNames)
    : undefined;
  try {
    project = await accountClient.getPagesProject(projectName);
    const canonical = project.canonical_deployment;
    const latest = project.latest_deployment;
    // The newest deployment is the one a graph run creates and verifies;
    // production (canonical) keeps serving the previous one until it succeeds.
    const deployment = latest ?? canonical;
    if (deployment?.id) {
      activeDeploymentId = deployment.id;
    }
    if (latest?.latest_stage?.status) {
      activeDeploymentStatus = latest.latest_stage.status;
    } else if (canonical?.latest_stage?.status) {
      activeDeploymentStatus = canonical.latest_stage.status;
    }
  } catch (error) {
    if (isNotFound(error)) {
      project = undefined;
    } else {
      throw error;
    }
  }

  // A new Pages project has no domains endpoint yet. Read it only after proving
  // the project exists; a denied required read is not an empty safe list.
  if (project && opts.needs?.domains !== false) {
    pagesDomains = (await accountClient.listPagesDomains(projectName)).map((d) => ({
      id: d.id,
      domain_id: d.domain_id,
      name: d.name,
      ...(d.status ? { status: d.status } : {}),
    }));
  }

  return {
    accountId: opts.accountId,
    workerName: projectName,
    workerExists: false,
    versions: [],
    activeDeploymentVersionIds: [],
    r2Buckets: opts.needs?.r2 === true ? await readR2Buckets(accountClient, true) : [],
    d1Databases: opts.needs?.d1 === true ? await readD1Databases(accountClient, true) : [],
    kvNamespaces: opts.needs?.kv === true ? await readKvNamespaces(accountClient, true) : [],
    queues: [],
    hyperdriveConfigs: [],
    vectorizeIndexes: [],
    secretsStores: [],
    secretsStoreSecrets: [],
    secretNames: Object.entries(project?.deployment_configs?.production?.env_vars ?? {}).filter(([, value]) => value.type === "secret_text").map(([name]) => name),
    scheduleCrons: [],
    rateLimitCount: 0,
    deployedBindings: {},
    pagesProjectExists: project !== undefined,
    pagesProjectId: project?.id,
    pagesOwnerProjectId: project?.deployment_configs?.production?.env_vars?.[PAGES_PROJECT_MARKER]?.type === "plain_text" ? project.deployment_configs.production.env_vars[PAGES_PROJECT_MARKER]!.value : undefined,
    pagesActiveDeploymentId: activeDeploymentId,
    pagesActiveDeploymentStatus: activeDeploymentStatus,
    ...(project?.subdomain ? { pagesSubdomain: project.subdomain } : {}),
    ...(pagesDomains.length > 0 ? { pagesDomains } : {}),
    ...(domainFacts ?? {}),
  };
}

async function readSchedules(
  client: CloudflareApiClient,
  workerName: string,
  required = false,
): Promise<string[]> {
  try {
    return (await client.getSchedules(workerName)).crons ?? [];
  } catch (error) {
    if (isNotFound(error) || (isMissingScope(error) && !required)) {
      return [];
    }
    throw error;
  }
}

async function readR2Buckets(
  client: CloudflareApiClient,
  required = false,
): Promise<{ name: string; id: string }[]> {
  try {
    return (await client.listR2Buckets()).map((b) => ({
      name: b.name,
      id: b.id,
    }));
  } catch (error) {
    // Missing R2 scope must not fail a minimal Worker release that declares no
    // R2 bindings. The plan treats absent scope as no visible buckets;
    // a later create step fails closed with the real permission error.
    if (isMissingScope(error) && !required) {
      return [];
    }
    throw error;
  }
}

// read the live D1 databases for an account; a missing D1 scope maps to
// empty so a release that declares no D1 bindings never fails, while a later
// create step fails closed with the real permission error.
async function readD1Databases(
  client: CloudflareApiClient,
  required = false,
): Promise<{ name: string; id: string }[]> {
  try {
    return (await client.listD1Databases()).map((d) => ({
      name: d.name,
      id: d.id,
    }));
  } catch (error) {
    if (isMissingScope(error) && !required) {
      return [];
    }
    throw error;
  }
}

// read the live KV namespaces for an account; a missing KV scope maps to
// empty so a release that declares no KV bindings never fails.
async function readKvNamespaces(
  client: CloudflareApiClient,
  required = false,
): Promise<{ name: string; id: string }[]> {
  try {
    const namespaces = await client.listKvNamespaces();
    // Official KV list returns result[] with id + title; normalize name to the
    // human-readable identity like the model does.
    return namespaces.map((n) => ({ name: n.name || n.title, id: n.id }));
  } catch (error) {
    if (isMissingScope(error) && !required) {
      return [];
    }
    throw error;
  }
}

// read the live Queues for an account; a missing Queues scope maps to
// empty so a release that declares no queue bindings never fails.
async function readQueues(
  client: CloudflareApiClient,
  required = false,
): Promise<{ name: string; id: string }[]> {
  try {
    const queues = await client.listQueues();
    return queues.map((q) => ({ name: q.name || q.queue_name, id: q.id || q.queue_id }));
  } catch (error) {
    if (isMissingScope(error) && !required) {
      return [];
    }
    throw error;
  }
}

// read the live consumer triggers of the given queues (queue name ->
// consumers). Only called when a release declares consumer/both queue roles.
// A consumer without a provider identity cannot be addressed or proven, so the
// whole read fails closed rather than pretending the queue has none.
async function readQueueConsumers(
  client: CloudflareApiClient,
  queues: { name: string; id: string }[],
  required = false,
): Promise<Record<string, QueueConsumerFact[]>> {
  const out: Record<string, QueueConsumerFact[]> = {};
  try {
    for (const queue of queues) {
      const consumers = await client.listQueueConsumers(queue.id);
      out[queue.name] = consumers.map((consumer) => {
        if (typeof consumer.consumer_id !== "string" || !consumer.consumer_id) {
          throw new Error(`queue "${queue.name}" has a consumer without a provider identity`);
        }
        return {
          consumerId: consumer.consumer_id,
          ...(typeof consumer.script_name === "string" && consumer.script_name ? { scriptName: consumer.script_name } : {}),
          ...(typeof consumer.type === "string" ? { type: consumer.type } : {}),
          ...(consumer.settings !== undefined ? { settings: consumer.settings } : {}),
          ...(typeof consumer.dead_letter_queue === "string" ? { deadLetterQueue: consumer.dead_letter_queue } : {}),
        };
      });
    }
    return out;
  } catch (error) {
    if (isMissingScope(error) && !required) {
      return out;
    }
    throw error;
  }
}

// read every live account Workflow definition. Only called when a release
// declares a workflow (required=true); a missing Workflows permission fails
// closed, it is never interpreted as "no workflows". A definition without a
// provider identity (id/name/class/script) makes the fact unverifiable and
// fails the snapshot rather than inventing one.
async function readWorkflows(
  client: CloudflareApiClient,
  required = false,
): Promise<WorkflowFact[]> {
  try {
    const workflows = await client.listWorkflows();
    return workflows.map((workflow) => {
      if (!workflow.id || !workflow.name || !workflow.class_name || !workflow.script_name) {
        throw new Error(`workflow "${workflow.name || "<unnamed>"}" is missing its provider identity`);
      }
      return {
        id: workflow.id,
        name: workflow.name,
        className: workflow.class_name,
        scriptName: workflow.script_name,
        schedules: (workflow.schedules ?? []).map((schedule) => schedule.cron),
      };
    });
  } catch (error) {
    if (isMissingScope(error) && !required) {
      return [];
    }
    throw error;
  }
}

// read the live Hyperdrive configs for an account; a missing scope maps to
// empty so a release that declares no hyperdrive bindings never fails.
async function readHyperdriveConfigs(
  client: CloudflareApiClient,
  required = false,
): Promise<TargetSnapshot["hyperdriveConfigs"]> {
  try {
    const configs = await client.listHyperdriveConfigs();
    return configs.map(c => ({ name: c.name, id: c.id, ...(c.origin ? { origin: { database: c.origin.database, host: c.origin.host, port: c.origin.port, scheme: c.origin.scheme, user: c.origin.user } } : {}) }));
  } catch (error) {
    if (isMissingScope(error) && !required) {
      return [];
    }
    throw error;
  }
}

// read the live Vectorize indexes for an account; a missing scope maps to
// empty so a release that declares no vectorize bindings never fails.
async function readVectorizeIndexes(
  client: CloudflareApiClient,
  required = false,
): Promise<TargetSnapshot["vectorizeIndexes"]> {
  try {
    const indexes = await client.listVectorizeIndexes();
    return indexes.map((i) => ({ name: i.name, id: i.id, ...(i.config ? { config: i.config } : {}) }));
  } catch (error) {
    if (isMissingScope(error) && !required) {
      return [];
    }
    throw error;
  }
}

// read the live Secrets Store stores for an account; a missing scope maps
// to empty so a release that declares no secrets-store bindings never fails.
async function readSecretsStores(
  client: CloudflareApiClient,
  required = false,
): Promise<{ name: string; id: string }[]> {
  try {
    const stores = await client.listSecretsStores();
    return stores.map((s) => ({ name: s.name, id: s.id }));
  } catch (error) {
    if (isMissingScope(error) && !required) {
      return [];
    }
    throw error;
  }
}

// read the secrets inside each store (identity only — the secret `value`
// is write-only and is never returned by the provider). A missing scope maps to
// an empty list.
async function readSecretsStoreSecrets(
  client: CloudflareApiClient,
  stores: { name: string; id: string }[],
  required = false,
): Promise<{ secretName: string; id: string; store_id: string }[]> {
  const out: { secretName: string; id: string; store_id: string }[] = [];
  for (const store of stores) {
    try {
      const secrets = await client.listSecretsStoreSecrets(store.id);
      for (const s of secrets) {
        out.push({ secretName: s.name, id: s.id, store_id: s.store_id });
      }
    } catch (error) {
      if (isMissingScope(error) && !required) {
        continue;
      }
      throw error;
    }
  }
  return out;
}

async function readRateLimitCount(
  client: CloudflareApiClient,
  workerName: string,
): Promise<number> {
  try {
    const settings = await client.getWorkerSettings(workerName);
    const bindings = settings?.bindings;
    if (!Array.isArray(bindings)) {
      return 0;
    }
    return bindings.filter((b) => (b as { type?: unknown }).type === "ratelimit").length;
  } catch (error) {
    if (isNotFound(error) || isMissingScope(error)) {
      return 0;
    }
    throw error;
  }
}

// full deployed binding identity map read from GET .../settings.
// Returns the authoritative per-family binding map so the planner can refuse a
// silent rebind of a declared binding on upgrade (and so the UI can show the
// current binding target as "before"). Official entry shapes:
//   r2:            { name, bucket_name }
//   d1:            { name, id }
//   kv:            { name, namespace_id }
//   queue:         { name, queue_name }
//   hyperdrive:    { name, id }
//   vectorize:     { name, index_name }
//   secrets_store: { name, store_id, secret_name }
// Unknown/malformed entries are ignored; missing worker or missing scope maps to
// an empty map (no verified bindings). No secret value is ever present in a
// settings binding for a secret — only the binding/store/secret identity.
async function readDeployedBindings(
  client: CloudflareApiClient,
  workerName: string,
  activeBindings?: Array<Record<string, unknown>>,
): Promise<DeployedBindingMap> {
  try {
    const bindings = activeBindings ?? (await client.getWorkerSettings(workerName))?.bindings;
    if (!Array.isArray(bindings)) {
      return {};
    }
    const r2: Record<string, string> = {};
    const d1: Record<string, string> = {};
    const kv: Record<string, string> = {};
    const queue: Record<string, string> = {};
    const hyperdrive: Record<string, string> = {};
    const vectorize: Record<string, string> = {};
    const secretsStore: Record<string, { storeId: string; secretName: string }> = {};
    const runtime: Record<string, "ai" | "browser-rendering"> = {};
    for (const entry of bindings as Record<string, unknown>[]) {
      const type = entry?.["type"];
      const name = entry?.["name"];
      if (typeof name !== "string" || name.length === 0) {
        continue;
      }
      if (type === "r2_bucket") {
        const bucket = entry["bucket_name"] ?? entry["bucketName"] ?? entry["bucket"];
        if (typeof bucket === "string" && bucket.length > 0) r2[name] = bucket;
      } else if (type === "d1") {
        const id = entry["id"] ?? entry["database_id"] ?? entry["databaseId"];
        if (typeof id === "string" && id.length > 0) d1[name] = id;
      } else if (type === "kv_namespace") {
        const id = entry["namespace_id"] ?? entry["namespaceId"] ?? entry["id"];
        if (typeof id === "string" && id.length > 0) kv[name] = id;
      } else if (type === "queue") {
        const q = entry["queue_name"] ?? entry["queueName"];
        if (typeof q === "string" && q.length > 0) queue[name] = q;
      } else if (type === "hyperdrive") {
        const id = entry["id"] ?? entry["hyperdrive_id"] ?? entry["hyperdriveId"];
        if (typeof id === "string" && id.length > 0) hyperdrive[name] = id;
      } else if (type === "vectorize") {
        const idx = entry["index_name"] ?? entry["indexName"];
        if (typeof idx === "string" && idx.length > 0) vectorize[name] = idx;
      } else if (type === "ai") {
        runtime[name] = "ai";
      } else if (type === "browser") {
        runtime[name] = "browser-rendering";
      } else if (type === "secrets_store_secret") {
        const storeId = entry["store_id"] ?? entry["storeId"];
        const secretName = entry["secret_name"] ?? entry["secretName"];
        if (typeof storeId === "string" && storeId.length > 0 && typeof secretName === "string" && secretName.length > 0) {
          secretsStore[name] = { storeId, secretName };
        }
      }
    }
    return { r2, d1, kv, queue, hyperdrive, vectorize, secretsStore, runtime };
  } catch (error) {
    if (isNotFound(error)) {
      return {};
    }
    throw error;
  }
}

// gather the opt-in domain/route/DNS facts. Zone discovery is separate from
// any specific resource read; a missing zone.read / DNS / Workers-Routes scope
// maps to an empty fact set so a release that declares no domain intent never
// hard-fails on discovery, while a later write fails closed with the real
// permission error. Any real API failure (network/server) still propagates so
// the planner cannot build from partial facts.
// Read the zone list, tolerating a missing zone.read scope (the installer only
// requests zone.read when a zone selector is actually needed, so a release that
// declares no domain intent never hard-fails on discovery). A real API failure
// still propagates so the planner cannot build from partial facts.
async function readZones(
  client: CloudflareApiClient,
  required = false,
): Promise<{ id: string; name: string }[]> {
  try {
    return await client.listZones();
  } catch (error) {
    if (isMissingScope(error) && !required) {
      return [];
    }
    throw error;
  }
}

async function readDomainFacts(
  client: CloudflareApiClient,
  kinds?: ConfigDomainKind[],
  zoneNames?: string[],
): Promise<Pick<
  TargetSnapshot,
  "zones" | "dnsRecords" | "workerRoutes" | "workerDomains"
>> {
  // A custom domain (Worker or Pages) needs the DNS records at its hostname
  // (existing records block or are replaced after consent) and the Worker
  // custom-domain list (a hostname may already be bound to another Worker).
  const customDomains = !kinds || kinds.includes("workers-custom-domain") || kinds.includes("pages-custom-domain");
  const needsDns = !kinds || kinds.includes("dns-record") || customDomains;
  const needsRoutes = !kinds || kinds.includes("workers-route");
  const needsWorkerDomains = customDomains;
  const allZones = needsDns || needsRoutes ? await readZones(client, kinds !== undefined) : [];
  const names = zoneNames?.map((name) => name.toLowerCase());
  const zones = names ? allZones.filter((zone) => names.includes(zone.name.toLowerCase())) : allZones;

  const dnsRecords: { zoneId: string; id: string; name: string; type: string; content?: string; ttl?: number; proxied?: boolean }[] = [];
  const workerRoutes: { zoneId: string; id: string; pattern: string; script?: string }[] = [];
  for (const zone of zones) {
    if (needsDns) {
      try {
        const records = await client.listDnsRecords(zone.id);
        for (const record of records) {
          dnsRecords.push({
            zoneId: zone.id,
            id: record.id,
            name: record.name,
            type: record.type,
            ...(record.content !== undefined ? { content: record.content } : {}),
            ...(record.ttl !== undefined ? { ttl: record.ttl } : {}),
            ...(record.proxied !== undefined ? { proxied: record.proxied } : {}),
          });
        }
      } catch (error) {
        if (kinds !== undefined || !isMissingScope(error)) {
          throw error;
        }
      }
    }
    if (needsRoutes) {
      try {
        const routes = await client.listWorkerRoutes(zone.id);
        for (const route of routes) {
          workerRoutes.push({
            zoneId: zone.id,
            id: route.id,
            pattern: route.pattern,
            ...(route.script !== undefined ? { script: route.script } : {}),
          });
        }
      } catch (error) {
        if (kinds !== undefined || !isMissingScope(error)) {
          throw error;
        }
      }
    }
  }

  let workerDomains: { id: string; hostname: string; service?: string; zone_id?: string }[] = [];
  if (needsWorkerDomains) {
    try {
      const domains = await client.listWorkerDomains();
      workerDomains = domains.map((d) => ({ id: d.id, hostname: d.hostname, service: d.service, ...(d.zone_id ? { zone_id: d.zone_id } : {}) }));
    } catch (error) {
      if (kinds !== undefined || !isMissingScope(error)) {
        throw error;
      }
    }
  }

  return { zones, dnsRecords, workerRoutes, workerDomains };
}

// ---------------------------------------------------------------------------
// per-unit graph snapshots.
//
// A multi-unit release needs ONE live resource/active-state snapshot per unit,
// never one snapshot for the whole release. `snapshotNeedsForGraph` derives the
// read set from the resolved graph (pure, no provider call);
// `snapshotGraphTargets` then gathers one snapshot per unit and keys it by unit
// id, so `buildGraphDeployPlan` can verify each unit against its own facts.
// ---------------------------------------------------------------------------

function snapshotNeedsForGraph(
  graph: Pick<DeploymentGraph, "resources" | "triggers" | "exposures">,
): SnapshotNeeds {
  const kinds = new Set(graph.resources.map((resource) => resource.kind));
  // Domain facts are read only when the release declares domain intent (graph
  // exposures, derived from spec.domains), scoped to the exposure kinds and the
  // zones they name: a routes-only release reads zones plus route tables and
  // never DNS records; a custom domain also reads DNS records of its zone and
  // the Worker custom-domain list.
  const hasExposures = graph.exposures.length > 0;
  const exposureKinds = [...new Set(graph.exposures.map((exposure) => exposure.kind))].sort();
  const exposureZones = [...new Set(graph.exposures.flatMap((exposure) => exposure.zoneName ? [exposure.zoneName.toLowerCase()] : []))].sort();
  return {
    r2: kinds.has("r2"),
    d1: kinds.has("d1"),
    kv: kinds.has("kv"),
    queues: kinds.has("queue"),
    queueConsumers: graph.triggers.some((trigger) => trigger.kind === "queue-consumer"),
    // account Workflow facts are needed whenever any unit declares one.
    workflows: kinds.has("workflow"),
    hyperdrive: kinds.has("hyperdrive"),
    vectorize: kinds.has("vectorize"),
    secretsStore: kinds.has("secrets-store"),
    schedules: graph.triggers.some((trigger) => trigger.kind === "cron"),
    rateLimits: false,
    secrets: kinds.has("secret"),
    domains: hasExposures,
    ...(hasExposures ? { domainKinds: exposureKinds } : {}),
    ...(exposureZones.length > 0 ? { zoneNames: exposureZones } : {}),
  };
}

// A resource-only unit has no Worker/Pages carrier: gather only the account
// resource inventories the graph needs. No worker read, no version read, no
// secret read.
export async function snapshotAccountResources(
  client: CloudflareApiClient,
  opts: { accountId: string; needs?: SnapshotNeeds },
): Promise<TargetSnapshot> {
  const accountClient = client.withAccount(opts.accountId);
  const needs = opts.needs ?? {};
  return {
    accountId: opts.accountId,
    workerName: "",
    workerExists: false,
    versions: [],
    activeDeploymentVersionIds: [],
    r2Buckets: needs.r2 !== false ? await readR2Buckets(accountClient, needs.r2 === true) : [],
    d1Databases: needs.d1 !== false ? await readD1Databases(accountClient, needs.d1 === true) : [],
    kvNamespaces: needs.kv !== false ? await readKvNamespaces(accountClient, needs.kv === true) : [],
    queues: needs.queues !== false ? await readQueues(accountClient, needs.queues === true) : [],
    hyperdriveConfigs:
      needs.hyperdrive !== false
        ? await readHyperdriveConfigs(accountClient, needs.hyperdrive === true)
        : [],
    vectorizeIndexes:
      needs.vectorize !== false
        ? await readVectorizeIndexes(accountClient, needs.vectorize === true)
        : [],
    secretsStores:
      needs.secretsStore !== false
        ? await readSecretsStores(accountClient, needs.secretsStore === true)
        : [],
    secretsStoreSecrets: [],
    secretNames: [],
    scheduleCrons: [],
    rateLimitCount: 0,
    deployedBindings: {},
  };
}

export async function snapshotGraphTargets(
  client: CloudflareApiClient,
  input: { accountId: string; graph: DeploymentGraph },
): Promise<Record<string, TargetSnapshot>> {
  const needs = snapshotNeedsForGraph(input.graph);
  const snapshots: Record<string, TargetSnapshot> = {};
  for (const unit of input.graph.units) {
    if (unit.kind === "resource-only") {
      snapshots[unit.id] = await snapshotAccountResources(client, {
        accountId: input.accountId,
        needs,
      });
      continue;
    }
    snapshots[unit.id] = await snapshotTarget(client, {
      accountId: input.accountId,
      workerName: unit.name,
      targetKind: unit.identity === "pages-project" ? "pages" : "workers",
      needs,
    });
  }
  return snapshots;
}
