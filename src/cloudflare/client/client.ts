// Typed, allowlisted Cloudflare v4 management client. It exposes only fixed
// read methods and declared write methods drawn from the ROUTES table; there
// is no generic endpoint proxy. Every request carries a bound account and a
// short-lived access token, and errors are normalized to CloudflareApiError.

import type {
  AccountSummary,
  AssetSessionRequest,
  AssetSessionResult,
  D1CreateRequest,
  D1Database,
  DeploymentCreateRequest,
  DnsRecord,
  DnsRecordCreateRequest,
  DnsRecordUpdateRequest,
  HyperdriveConfig,
  KvNamespace,
  KvNamespaceCreateRequest,
  PagesDeployment,
  PagesDomain,
  PagesDomainAddRequest,
  PagesProject,
  PagesProjectCreateRequest,
  PagesProjectSummary,
  Queue,
  QueueConsumer,
  QueueConsumerRequest,
  QueueCreateRequest,
  R2Bucket,
  R2CustomDomain,
  R2ManagedDomain,
  SecretsStore,
  SecretsStoreSecret,
  VectorizeCreateRequest,
  VectorizeIndex,
  VersionCreateRequest,
  WorkerAssetsUploadResult,
  WorkerDeployment,
  WorkerDomain,
  WorkerDomainAttachRequest,
  WorkerRoute,
  WorkerRouteCreateRequest,
  WorkerRouteUpdateRequest,
  WorkerScheduleMetadata,
  WorkerSubdomainState,
  WorkerScriptMeta,
  WorkerSecretMetadata,
  WorkerSettings,
  WorkerVersionMeta,
  ZoneSummary,
  Workflow,
  WorkflowUpdateRequest,
} from "../models/index.js";
import { encodeVersionModuleParts } from "../models/workers.js";
import {
  makeCloudflareError,
  makeInvalidResponseError,
  makeNetworkError,
  type CloudflareEnvelope,
} from "./errors.js";
import {
  parseWorkerList,
  parseVersionList,
  normalizeVersionItem,
  parseDeploymentList,
  parseAccountSubdomain,
  parseSubdomainState,
  parseSchedules,
  parseScheduleUpdate,
} from "./parse-workers.js";
import {
  normalizeR2Bucket,
  normalizeR2ManagedDomain,
  normalizeR2CustomDomains,
  parseD1DatabaseList,
  normalizeD1Database,
  parseKvNamespaceList,
  normalizeKvNamespace,
  parseQueueList,
  normalizeQueue,
  normalizeQueueConsumer,
  parseWorkflowList,
  normalizeWorkflowEntry,
  parseHyperdriveConfigList,
  parseVectorizeIndexList,
  normalizeVectorizeIndex,
  parseSecretsStoreList,
  parseSecretsStoreSecretList,
} from "./parse-resources.js";
import {
  parsePagesProjectList,
  parsePagesProject,
  normalizeCreatePagesProject,
  parsePagesDeploymentList,
  parsePagesDeployment,
  normalizePagesDeployment,
  parseAssetSessionResult,
  parseZoneList,
  parseDnsRecordList,
  normalizeDnsRecord,
  parseWorkerRouteList,
  normalizeWorkerRoute,
  parseWorkerDomainList,
  normalizeWorkerDomain,
  parsePagesDomainList,
  normalizePagesDomain,
  parseDeleteResult,
} from "./parse-pages-zones.js";
import { routeFor } from "./routes.js";
import { uploadWithActiveInheritance } from "./active-inheritance.js";
import {
  assertAccountId,
  assertResourceId,
  assertScriptName,
  assertWorkflowName,
  assertZoneId,
  buildApiUrl,
  buildWorkerAssetsUploadUrl,
} from "./url-guard.js";

export interface Fetcher {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface CloudflareClientOptions {
  accessToken: string;
  accountId?: string;
  fetcher?: Fetcher;
}

export interface CloudflareApiClient {
  withAccount(accountId: string): CloudflareApiClient;
  listAccounts(): Promise<AccountSummary[]>;
  getAccount(): Promise<AccountSummary>;
  listWorkers(): Promise<WorkerScriptMeta[]>;
  getWorker(scriptName: string): Promise<WorkerScriptMeta>;
  getWorkerSettings(scriptName: string): Promise<WorkerSettings>;
  listVersions(scriptName: string): Promise<WorkerVersionMeta[]>;
  getVersion(scriptName: string, versionId: string): Promise<WorkerVersionMeta>;
  listDeployments(scriptName: string): Promise<WorkerDeployment[]>;
  listR2Buckets(): Promise<R2Bucket[]>;
  getR2Bucket(bucketName: string): Promise<R2Bucket>;
  // privacy read surfaces for the R2 owner-bootstrap guard. Both are
  // read-only; the guard classifies their read-backs, never a wrangler binding.
  getR2ManagedDomain(bucketName: string): Promise<R2ManagedDomain>;
  listR2CustomDomains(bucketName: string): Promise<R2CustomDomain[]>;
  // object existence only: the body of the provider's GET is cancelled
  // unread. Resolves true when the provider answers 200, false on a verified
  // 404; any other outcome throws so the caller fails closed.
  r2ObjectExists(bucketName: string, key: string): Promise<boolean>;
  listSecrets(scriptName: string): Promise<WorkerSecretMetadata[]>;
  getSchedules(scriptName: string): Promise<WorkerScheduleMetadata>;
  // The account's `<subdomain>.workers.dev` name, or undefined when none exists.
  getAccountSubdomain(): Promise<string | undefined>;
  getScriptSubdomain(scriptName: string): Promise<WorkerSubdomainState>;
  setScriptSubdomain(scriptName: string, state: WorkerSubdomainState): Promise<WorkerSubdomainState>;
  startAssetUploadSession(
    scriptName: string,
    request: AssetSessionRequest,
  ): Promise<AssetSessionResult>;
  uploadWorkerAssets(
    uploadJwt: string,
    parts: Record<string, { base64: string; contentType: string }>,
  ): Promise<WorkerAssetsUploadResult>;
  createVersion(
    scriptName: string,
    request: VersionCreateRequest,
  ): Promise<WorkerVersionMeta>;
  createWorker(
    scriptName: string,
    request: VersionCreateRequest,
  ): Promise<WorkerVersionMeta>;
  createDeployment(
    scriptName: string,
    request: DeploymentCreateRequest,
  ): Promise<WorkerDeployment>;
  createR2Bucket(bucketName: string): Promise<R2Bucket>;
  updateSecret(
    scriptName: string,
    secretName: string,
    secretText: string,
  ): Promise<WorkerSecretMetadata>;
  updateSchedules(
    scriptName: string,
    crons: string[],
  ): Promise<WorkerScheduleMetadata>;
  // D1 database management (read + create only; no delete/query proxy).
  listD1Databases(): Promise<D1Database[]>;
  createD1Database(request: D1CreateRequest): Promise<D1Database>;
  // Workers KV namespace management (read + create only; no delete/key proxy).
  listKvNamespaces(): Promise<KvNamespace[]>;
  createKvNamespace(request: KvNamespaceCreateRequest): Promise<KvNamespace>;
  // Cloudflare Queues (read + create only; consumer trigger registration).
  listQueues(): Promise<Queue[]>;
  createQueue(request: QueueCreateRequest): Promise<Queue>;
  createQueueConsumer(queueId: string, request: QueueConsumerRequest): Promise<QueueConsumer>;
  listQueueConsumers(queueId: string): Promise<QueueConsumer[]>;
  putQueueConsumer(queueId: string, consumerId: string, request: QueueConsumerRequest): Promise<QueueConsumer>;
  // Cloudflare Workflows (account list / single definition read; PUT the
  // exact desired definition after the carrier version is active; there is no
  // delete route and no instance proxy).
  listWorkflows(): Promise<Workflow[]>;
  getWorkflow(workflowName: string): Promise<Workflow>;
  updateWorkflow(workflowName: string, request: WorkflowUpdateRequest): Promise<Workflow>;
  // Cloudflare Hyperdrive configs (read only: they hold the user's own database credentials).
  listHyperdriveConfigs(): Promise<HyperdriveConfig[]>;
  // Cloudflare Vectorize indexes (read + create only; no update/delete path,
  // dimension/metric configuration is immutable on the live resource).
  listVectorizeIndexes(): Promise<VectorizeIndex[]>;
  createVectorizeIndex(request: VectorizeCreateRequest): Promise<VectorizeIndex>;
  // Cloudflare central Secrets Store (read only: stores and secrets belong to the user).
  listSecretsStores(): Promise<SecretsStore[]>;
  listSecretsStoreSecrets(storeId: string): Promise<SecretsStoreSecret[]>;
  // Cloudflare Pages projects (read-only target discovery — no mutation here).
  listPages(): Promise<PagesProjectSummary[]>;
  // Pages project management + deployment lifecycle (Pages direct upload).
  // These are the ONLY Pages write routes; there is no reuse of the Workers
  // scripts/versions/deployments API.
  getPagesProject(projectName: string): Promise<PagesProject>;
  createPagesProject(request: PagesProjectCreateRequest): Promise<PagesProject>;
  updatePagesProject(projectName: string, request: Pick<PagesProjectCreateRequest, "deployment_configs">): Promise<PagesProject>;
  getPagesUploadToken(projectName: string): Promise<{ jwt: string }>;
  listPagesDeployments(projectName: string): Promise<PagesDeployment[]>;
  getPagesDeployment(projectName: string, deploymentId: string): Promise<PagesDeployment>;
  // Direct Upload deployment create (multipart/form-data). This is the ONLY
  // Pages deploy write route; it never reuses the Workers scripts/version API.
  createPagesDeployment(projectName: string, form: FormData): Promise<PagesDeployment>;
  // Pages custom domains (a hostname attached directly to the project).
  // list / add / delete. A delete is destructive and is only reached after an
  // independent in-app confirmation.
  listPagesDomains(projectName: string): Promise<PagesDomain[]>;
  addPagesDomain(projectName: string, request: PagesDomainAddRequest): Promise<PagesDomain>;
  deletePagesDomain(projectName: string, domainName: string): Promise<void>;
  // Zone-scoped DNS records + account-scoped zone discovery. DNS records are
  // read list / create / overwrite / remove within one zone (the list endpoint
  // accepts DNS Write, so no separate `dns.read` is requested). The delete route
  // is destructive and is only reached after an independent in-app confirmation.
  listZones(): Promise<ZoneSummary[]>;
  listDnsRecords(zoneId: string): Promise<DnsRecord[]>;
  createDnsRecord(zoneId: string, request: DnsRecordCreateRequest): Promise<DnsRecord>;
  updateDnsRecord(zoneId: string, dnsRecordId: string, request: DnsRecordUpdateRequest): Promise<DnsRecord>;
  deleteDnsRecord(zoneId: string, dnsRecordId: string): Promise<void>;
  // Zone-scoped Workers routes (independent of Worker Admin; Workers Routes
  // Write). list / create / replace / delete within one zone.
  listWorkerRoutes(zoneId: string): Promise<WorkerRoute[]>;
  createWorkerRoute(zoneId: string, request: WorkerRouteCreateRequest): Promise<WorkerRoute>;
  updateWorkerRoute(zoneId: string, routeId: string, request: WorkerRouteUpdateRequest): Promise<WorkerRoute>;
  deleteWorkerRoute(zoneId: string, routeId: string): Promise<void>;
  // Account-scoped Workers custom domains (Workers Routes Write). list /
  // attach / detach. A custom domain points all paths of the hostname at the
  // Worker; Cloudflare creates the DNS record + certificate automatically.
  listWorkerDomains(): Promise<WorkerDomain[]>;
  attachWorkerDomain(request: WorkerDomainAttachRequest): Promise<WorkerDomain>;
  detachWorkerDomain(domainId: string): Promise<void>;
}

// A version uploaded a moment ago can briefly answer 404 on the scripts
// versions API (provider read-after-write lag, live 100146). Only a not-found
// is retried, a few times with a short backoff; any other error, or a lasting
// not-found, surfaces unchanged.
const VERSION_READ_LAG_DELAYS_MS = [400, 800, 1200, 1600];
async function readThroughVersionLag<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      const delay = VERSION_READ_LAG_DELAYS_MS[attempt];
      if ((error as { kind?: string }).kind !== "not-found" || delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export function createCloudflareClient(
  options: CloudflareClientOptions,
): CloudflareApiClient {
  const fetcher = options.fetcher ?? ((input: string | URL, init?: RequestInit) => fetch(input, init));
  const accountId = options.accountId;

  if (accountId) {
    assertAccountId(accountId);
  }

  const read = (routeId: string, parse: (env: CloudflareEnvelope<unknown>) => unknown, ctx: Record<string, string>) =>
    request(routeId, ctx, undefined, parse, fetcher, options.accessToken);

  return {
    withAccount(nextAccountId) {
      assertAccountId(nextAccountId);
      return createCloudflareClient({
        ...options,
        accountId: nextAccountId,
      });
    },

    listAccounts: () =>
      read("listAccounts", (env) => env.result ?? [], {}) as Promise<AccountSummary[]>,

    getAccount: () =>
      withAccountId(accountId, "getAccount", undefined, (env) => env.result, fetcher, options.accessToken) as Promise<AccountSummary>,

    listWorkers: () =>
      withAccountId(accountId, "listWorkers", undefined, parseWorkerList, fetcher, options.accessToken) as Promise<WorkerScriptMeta[]>,

    // the raw GET /workers/scripts/{name} route returns script BYTES, not
    // JSON metadata — it must never be parsed as a JSON envelope. Worker
    // existence/metadata is resolved via the documented list route instead.
    getWorker: (scriptName) =>
      getWorkerViaList(accountId, scriptName, fetcher, options.accessToken),

    getWorkerSettings: (scriptName) =>
      withScript(accountId, scriptName, "getWorkerSettings", undefined, (env) => env.result ?? {}, fetcher, options.accessToken) as Promise<WorkerSettings>,

    listVersions: (scriptName) =>
      withScript(accountId, scriptName, "listVersions", undefined, parseVersionList, fetcher, options.accessToken) as Promise<WorkerVersionMeta[]>,
    getVersion: (scriptName, versionId) => {
      // Worker version IDs are UUIDs, unlike the 32-hex account/resource IDs.
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(versionId)) {
        throw makeInvalidResponseError("invalid Worker version UUID");
      }
      assertScriptName(scriptName);
      const read = () => withAccountId(accountId, "getVersion", undefined, env => {
        const version = normalizeVersionItem(env.result);
        if (version.id !== versionId) throw makeInvalidResponseError("exact version identity mismatch");
        const resources = (env.result as { resources?: { bindings?: unknown } }).resources;
        if (!Array.isArray(resources?.bindings)) throw makeInvalidResponseError("exact version bindings unavailable");
        version.resources = { bindings: resources.bindings.map((entry: unknown) => {
          if (!entry || typeof entry !== "object") throw makeInvalidResponseError("invalid version binding");
          const binding = entry as Record<string, unknown>;
          // Version inventory never carries secret values into planning.
          return binding.type === "secret_text" || binding.type === "secret_key" ? { type: binding.type, name: binding.name } : { ...binding };
        }) };
        const runtime = (env.result as { resources?: { script_runtime?: unknown } }).resources?.script_runtime;
        if (runtime && typeof runtime === "object" && !Array.isArray(runtime)) {
          const config = runtime as Record<string, unknown>;
          version.resources.script_runtime = { compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags };
        }
        return version;
      }, fetcher, options.accessToken, { scriptName, versionId }) as Promise<WorkerVersionMeta>;
      return readThroughVersionLag(read);
    },

    listDeployments: (scriptName) =>
      withScript(accountId, scriptName, "listDeployments", undefined, parseDeploymentList, fetcher, options.accessToken) as Promise<WorkerDeployment[]>,

    listR2Buckets: () =>
      listR2BucketsPaged(accountId, fetcher, options.accessToken),

    getR2Bucket: (bucketName) =>
      withAccountId(accountId, "getR2Bucket", undefined, (env) => normalizeR2Bucket(env.result), fetcher, options.accessToken, { bucketName }) as Promise<R2Bucket>,
    getR2ManagedDomain: (bucketName) =>
      withAccountId(accountId, "getR2ManagedDomain", undefined, (env) => normalizeR2ManagedDomain(env.result), fetcher, options.accessToken, { bucketName }) as Promise<R2ManagedDomain>,
    listR2CustomDomains: (bucketName) =>
      withAccountId(accountId, "listR2CustomDomains", undefined, (env) => normalizeR2CustomDomains(env.result), fetcher, options.accessToken, { bucketName }) as Promise<R2CustomDomain[]>,
    r2ObjectExists: (bucketName, key) =>
      r2ObjectExists(accountId, bucketName, key, fetcher, options.accessToken),

    listSecrets: (scriptName) =>
      withScript(accountId, scriptName, "listSecrets", undefined, (env) => env.result ?? [], fetcher, options.accessToken) as Promise<WorkerSecretMetadata[]>,

    getAccountSubdomain: () =>
      withAccountId(accountId, "getAccountSubdomain", undefined, parseAccountSubdomain, fetcher, options.accessToken) as Promise<string | undefined>,

    getScriptSubdomain: (scriptName) =>
      withScript(accountId, scriptName, "getScriptSubdomain", undefined, parseSubdomainState, fetcher, options.accessToken) as Promise<WorkerSubdomainState>,

    setScriptSubdomain: (scriptName, state) =>
      withScript(accountId, scriptName, "setScriptSubdomain", state, parseSubdomainState, fetcher, options.accessToken) as Promise<WorkerSubdomainState>,

    getSchedules: (scriptName) =>
      withScript(accountId, scriptName, "getSchedules", undefined, parseSchedules, fetcher, options.accessToken) as Promise<WorkerScheduleMetadata>,

    startAssetUploadSession: (scriptName, request) =>
      withScript(accountId, scriptName, "startAssetUploadSession", request, parseAssetSessionResult, fetcher, options.accessToken) as Promise<AssetSessionResult>,

    uploadWorkerAssets: async (uploadJwt, parts) => {
      if (!accountId) {
        return Promise.reject(new Error("Cloudflare account id is required"));
      }
      assertAccountId(accountId);
      return uploadWorkerAssetsWithJwt(accountId, uploadJwt, parts, fetcher);
    },

    createVersion: (scriptName, request) =>
      request.metadata.bindings?.some(binding => binding.type === "inherit")
        ? uploadWithActiveInheritance(accountId, scriptName, request, fetcher, options.accessToken)
        : createVersionMultipart(accountId, scriptName, request, fetcher, options.accessToken) as Promise<WorkerVersionMeta>,

    createWorker: (scriptName, request) =>
      createWorkerMultipart(accountId, scriptName, request, fetcher, options.accessToken) as Promise<WorkerVersionMeta>,

    createDeployment: (scriptName, request) =>
      createDeploymentPercentage(accountId, scriptName, request, fetcher, options.accessToken) as Promise<WorkerDeployment>,

    createR2Bucket: (bucketName) =>
      withAccountId(accountId, "createR2Bucket", { name: bucketName }, (env) => normalizeR2Bucket(env.result), fetcher, options.accessToken) as Promise<R2Bucket>,

    updateSecret: (scriptName, secretName, secretText) =>
      withScript(
        accountId,
        scriptName,
        "updateSecret",
        { name: secretName, text: secretText, type: "secret_text" },
        (env) => env.result,
        fetcher,
        options.accessToken,
      ) as Promise<WorkerSecretMetadata>,

    updateSchedules: (scriptName, crons) =>
      withScript(
        accountId,
        scriptName,
        "updateSchedules",
        crons.map((c) => ({ cron: c })),
        parseScheduleUpdate,
        fetcher,
        options.accessToken,
      ) as Promise<WorkerScheduleMetadata>,

    // D1 database management.
    listD1Databases: () =>
      withAccountId(accountId, "listD1Databases", undefined, parseD1DatabaseList, fetcher, options.accessToken) as Promise<D1Database[]>,

    createD1Database: (request) =>
      withAccountId(accountId, "createD1Database", request, (env) => normalizeD1Database(env.result), fetcher, options.accessToken) as Promise<D1Database>,

    // Workers KV namespace management.
    listKvNamespaces: () =>
      withAccountId(accountId, "listKvNamespaces", undefined, parseKvNamespaceList, fetcher, options.accessToken) as Promise<KvNamespace[]>,

    createKvNamespace: (request) =>
      withAccountId(accountId, "createKvNamespace", request, (env) => normalizeKvNamespace(env.result), fetcher, options.accessToken) as Promise<KvNamespace>,

    // Cloudflare Queues management.
    listQueues: () =>
      withAccountId(accountId, "listQueues", undefined, parseQueueList, fetcher, options.accessToken) as Promise<Queue[]>,

    createQueue: (request) =>
      withAccountId(accountId, "createQueue", request, (env) => normalizeQueue(env.result), fetcher, options.accessToken) as Promise<Queue>,

    createQueueConsumer: (queueId, request) =>
      withAccountId(accountId, "createQueueConsumer", { ...request, type: "worker" }, (env) => normalizeQueueConsumer(env.result), fetcher, options.accessToken, { queueId }) as Promise<QueueConsumer>,
    listQueueConsumers: queueId =>
      withAccountId(accountId, "listQueueConsumers", undefined, env => {
        if (!Array.isArray(env.result)) throw makeInvalidResponseError("queue consumers result must be an array");
        return env.result.map(normalizeQueueConsumer);
      }, fetcher, options.accessToken, { queueId }) as Promise<QueueConsumer[]>,

    putQueueConsumer: (queueId, consumerId, request) =>
      withAccountId(accountId, "putQueueConsumer", { ...request, type: "worker" }, (env) => normalizeQueueConsumer(env.result), fetcher, options.accessToken, { queueId, consumerId }) as Promise<QueueConsumer>,

    // Cloudflare Workflows. The account list is the plan-time fact read;
    // GET verifies one definition; PUT applies the exact desired definition
    // ({class_name, script_name, schedules}). The workflow name is a URL path
    // segment and is validated before any request is built.
    listWorkflows: () =>
      withAccountId(accountId, "listWorkflows", undefined, parseWorkflowList, fetcher, options.accessToken) as Promise<Workflow[]>,
    getWorkflow: workflowName =>
      withAccountId(accountId, "getWorkflowDetails", undefined, (env) => normalizeWorkflowEntry(env.result), fetcher, options.accessToken, { workflowName: checkedWorkflowName(workflowName) }) as Promise<Workflow>,
    updateWorkflow: (workflowName, request) =>
      withAccountId(accountId, "updateWorkflow", request, (env) => normalizeWorkflowEntry(env.result), fetcher, options.accessToken, { workflowName: checkedWorkflowName(workflowName) }) as Promise<Workflow>,

    // Cloudflare Hyperdrive config management.
    listHyperdriveConfigs: () =>
      withAccountId(accountId, "listHyperdriveConfigs", undefined, parseHyperdriveConfigList, fetcher, options.accessToken) as Promise<HyperdriveConfig[]>,

    // Cloudflare Vectorize index management (read + create only).
    listVectorizeIndexes: () =>
      withAccountId(accountId, "listVectorizeIndexes", undefined, parseVectorizeIndexList, fetcher, options.accessToken) as Promise<VectorizeIndex[]>,

    createVectorizeIndex: (request) =>
      withAccountId(accountId, "createVectorizeIndex", request, (env) => normalizeVectorizeIndex(env.result), fetcher, options.accessToken) as Promise<VectorizeIndex>,

    // Cloudflare central Secrets Store (read only).
    listSecretsStores: () =>
      withAccountId(accountId, "listSecretsStores", undefined, parseSecretsStoreList, fetcher, options.accessToken) as Promise<SecretsStore[]>,

    listSecretsStoreSecrets: (storeId) =>
      withAccountId(accountId, "listSecretsStoreSecrets", undefined, parseSecretsStoreSecretList, fetcher, options.accessToken, { storeId }) as Promise<SecretsStoreSecret[]>,

    // Cloudflare Pages projects list (read-only discovery).
    listPages: () =>
      withAccountId(accountId, "listPages", undefined, parsePagesProjectList, fetcher, options.accessToken) as Promise<PagesProjectSummary[]>,

    // Pages project management + deployment lifecycle (Pages direct upload).
    getPagesProject: (projectName) =>
      withAccountId(accountId, "getPagesProject", undefined, parsePagesProject, fetcher, options.accessToken, { projectName }) as Promise<PagesProject>,

    createPagesProject: (request) =>
      withAccountId(accountId, "createPagesProject", request, normalizeCreatePagesProject, fetcher, options.accessToken) as Promise<PagesProject>,
    updatePagesProject: (projectName, request) =>
      withAccountId(accountId, "updatePagesProject", request, parsePagesProject, fetcher, options.accessToken, { projectName }) as Promise<PagesProject>,

    getPagesUploadToken: (projectName) =>
      withAccountId(
        accountId,
        "getPagesUploadToken",
        undefined,
        (env) => {
          const result = env.result as { jwt?: unknown } | undefined;
          if (typeof result?.jwt !== "string" || result.jwt.length === 0) {
            throw makeInvalidResponseError("Pages upload token result missing jwt");
          }
          return { jwt: result.jwt };
        },
        fetcher,
        options.accessToken,
        { projectName },
      ) as Promise<{ jwt: string }>,

    listPagesDeployments: (projectName) =>
      withAccountId(accountId, "listPagesDeployments", undefined, parsePagesDeploymentList, fetcher, options.accessToken, { projectName }) as Promise<PagesDeployment[]>,

    getPagesDeployment: (projectName, deploymentId) =>
      withAccountId(accountId, "getPagesDeployment", undefined, parsePagesDeployment, fetcher, options.accessToken, { projectName, deploymentId }) as Promise<PagesDeployment>,

    createPagesDeployment: (projectName, form) =>
      createPagesDeploymentMultipart(accountId, projectName, form, fetcher, options.accessToken) as Promise<PagesDeployment>,

    // Pages custom domains (a hostname attached directly to the project).
    listPagesDomains: (projectName) =>
      withAccountId(accountId, "listPagesDomains", undefined, parsePagesDomainList, fetcher, options.accessToken, { projectName }) as Promise<PagesDomain[]>,

    addPagesDomain: (projectName, request) =>
      withAccountId(accountId, "addPagesDomain", request, env => normalizePagesDomain(env.result), fetcher, options.accessToken, { projectName }) as Promise<PagesDomain>,

    deletePagesDomain: (projectName, domainName) =>
      withAccountId(accountId, "deletePagesDomain", undefined, parseDeleteResult, fetcher, options.accessToken, { projectName, domainName }) as Promise<void>,

    // Zone-scoped DNS records + account-scoped zone discovery. Reads are
    // wrapped with `withZoneId` so a missing/invalid zone id fails closed before
    // any call. The list endpoint accepts DNS Write; no `dns.read` is requested.
    listZones: () =>
      withAccountId(accountId, "listZones", undefined, parseZoneList, fetcher, options.accessToken) as Promise<ZoneSummary[]>,

    listDnsRecords: (zoneId) =>
      withZoneId(zoneId, "listDnsRecords", undefined, parseDnsRecordList, fetcher, options.accessToken) as Promise<DnsRecord[]>,

    createDnsRecord: (zoneId, request) =>
      withZoneId(zoneId, "createDnsRecord", request, env => normalizeDnsRecord(env.result), fetcher, options.accessToken) as Promise<DnsRecord>,

    updateDnsRecord: (zoneId, dnsRecordId, request) =>
      withZoneAndResourceId(zoneId, dnsRecordId, "updateDnsRecord", request, env => normalizeDnsRecord(env.result), fetcher, options.accessToken, "dnsRecordId") as Promise<DnsRecord>,

    deleteDnsRecord: (zoneId, dnsRecordId) =>
      withZoneAndResourceId(zoneId, dnsRecordId, "deleteDnsRecord", undefined, parseDeleteResult, fetcher, options.accessToken, "dnsRecordId") as Promise<void>,

    // Zone-scoped Workers routes (Workers Routes Write; independent of
    // Worker Admin). Reads are wrapped so a missing/invalid zone id fails closed.
    listWorkerRoutes: (zoneId) =>
      withZoneId(zoneId, "listWorkerRoutes", undefined, parseWorkerRouteList, fetcher, options.accessToken) as Promise<WorkerRoute[]>,

    createWorkerRoute: (zoneId, request) =>
      withZoneId(zoneId, "createWorkerRoute", request, env => normalizeWorkerRoute(env.result), fetcher, options.accessToken) as Promise<WorkerRoute>,

    updateWorkerRoute: (zoneId, routeId, request) =>
      withZoneAndResourceId(zoneId, routeId, "updateWorkerRoute", request, env => normalizeWorkerRoute(env.result), fetcher, options.accessToken, "routeId") as Promise<WorkerRoute>,

    deleteWorkerRoute: (zoneId, routeId) =>
      withZoneAndResourceId(zoneId, routeId, "deleteWorkerRoute", undefined, parseDeleteResult, fetcher, options.accessToken, "routeId") as Promise<void>,

    // Account-scoped Workers custom domains (Workers Routes Write). list /
    // attach / detach.
    listWorkerDomains: () =>
      withAccountId(accountId, "listWorkerDomains", undefined, parseWorkerDomainList, fetcher, options.accessToken) as Promise<WorkerDomain[]>,

    attachWorkerDomain: (request) =>
      withAccountId(accountId, "attachWorkerDomain", request, env => normalizeWorkerDomain(env.result), fetcher, options.accessToken) as Promise<WorkerDomain>,

    detachWorkerDomain: (domainId) =>
      withAccountId(accountId, "detachWorkerDomain", undefined, parseDeleteResult, fetcher, options.accessToken, { domainId }) as Promise<void>,
  };
}

async function getWorkerViaList(
  accountId: string | undefined,
  scriptName: string,
  fetcher: Fetcher,
  accessToken: string,
): Promise<WorkerScriptMeta> {
  if (!accountId) {
    return Promise.reject(new Error("Cloudflare account id is required"));
  }
  assertAccountId(accountId);
  assertScriptName(scriptName);
  const workers = (await withAccountId(
    accountId,
    "listWorkers",
    undefined,
    parseWorkerList,
    fetcher,
    accessToken,
  )) as WorkerScriptMeta[];
  const found = workers.find((w) => w.id === scriptName);
  if (!found) {
    throw makeCloudflareError(
      new Response(null, { status: 404 }),
      { success: false, errors: [{ message: "Worker not found" }] },
    );
  }
  return found;
}

const R2_LIST_MAX_PAGES = 5;
const R2_LIST_PER_PAGE = 100;

async function listR2BucketsPaged(
  accountId: string | undefined,
  fetcher: Fetcher,
  accessToken: string,
): Promise<R2Bucket[]> {
  if (!accountId) {
    return Promise.reject(new Error("Cloudflare account id is required"));
  }
  assertAccountId(accountId);
  const out: R2Bucket[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < R2_LIST_MAX_PAGES; page++) {
    const route = routeFor("listR2Buckets");
    let tail = route.path({ accountId });
    const params = new URLSearchParams({ per_page: String(R2_LIST_PER_PAGE) });
    if (cursor) params.set("cursor", cursor);
    tail += `?${params.toString()}`;
    const url = buildApiUrl(tail);
    let response: Response;
    try {
      response = await fetcher(url, {
        method: route.method,
        headers: await bearerHeaders(accessToken),
      });
    } catch (error) {
      throw makeNetworkError(error);
    }
    const body = await readJsonSafe(response);
    if (!response.ok) {
      throw makeCloudflareError(response, body);
    }
    if (typeof body !== "object" || body === null) {
      throw makeInvalidResponseError("Cloudflare response is not an object");
    }
    const env = body as CloudflareEnvelope<unknown> & {
      result_info?: { cursor?: unknown };
    };
    if (env.success !== true) {
      throw makeInvalidResponseError("Cloudflare response success=false");
    }
    const result = env.result as { buckets?: unknown } | undefined;
    const buckets = result?.buckets;
    if (!Array.isArray(buckets)) {
      throw makeInvalidResponseError("R2 list result.buckets is not an array");
    }
    for (const b of buckets) {
      out.push(normalizeR2Bucket(b));
    }
    const next = env.result_info?.cursor;
    if (typeof next === "string" && next.length > 0) {
      cursor = next;
    } else {
      break;
    }
  }
  return out;
}

// object existence only. GET is the object route's documented read (HEAD is
// not one); its body is cancelled unread, so no object content is consumed.
// Resolves true on 200, false on a verified 404; any other outcome throws so
// the caller fails closed instead of treating absence as proven.
async function r2ObjectExists(
  accountId: string | undefined,
  bucketName: string,
  key: string,
  fetcher: Fetcher,
  accessToken: string,
): Promise<boolean> {
  if (!accountId) {
    return Promise.reject(new Error("Cloudflare account id is required"));
  }
  assertAccountId(accountId);
  if (!bucketName) throw makeInvalidResponseError("R2 bucket name is required");
  if (!key) throw makeInvalidResponseError("R2 object key is required");
  const route = routeFor("r2ObjectExists");
  const url = buildApiUrl(route.path({ accountId, bucketName, objectKey: key }));
  let response: Response;
  try {
    response = await fetcher(url, {
      method: route.method,
      headers: await bearerHeaders(accessToken),
    });
  } catch (error) {
    throw makeNetworkError(error);
  }
  await response.body?.cancel();
  if (response.status === 404) {
    throw makeCloudflareError(response, { success: false, errors: [{ code: 10007, message: "not found" }] });
  }
  if (!response.ok) {
    throw makeCloudflareError(response, undefined);
  }
  return true;
}

// official Workflows responses. `id`/`name`/`class_name`/`script_name`
// are the provider identity a TapDeploy readback verifies exactly; schedules are
// read back through GET (the PUT response omits them) and normalized to their
// exact cron set.
function checkedWorkflowName(workflowName: string): string {
  assertWorkflowName(workflowName);
  return workflowName;
}

// account-level asset batch upload with the session JWT (never OAuth).
// POST /accounts/{accountId}/workers/assets/upload?base64=true,
// multipart/form-data where each part name is the 32-hex upload hash and the
// part body is base64 content with its serving Content-Type.
async function uploadWorkerAssetsWithJwt(
  accountId: string,
  uploadJwt: string,
  parts: Record<string, { base64: string; contentType: string }>,
  fetcher: Fetcher,
): Promise<WorkerAssetsUploadResult> {
  if (typeof uploadJwt !== "string" || uploadJwt.length === 0) {
    throw makeInvalidResponseError("asset upload JWT is required");
  }
  const hashes = Object.keys(parts);
  if (hashes.length === 0) {
    throw makeInvalidResponseError("asset upload requires at least one file part");
  }
  const form = new FormData();
  for (const [hash, part] of Object.entries(parts)) {
    if (!/^[0-9a-f]{32}$/.test(hash)) {
      throw makeInvalidResponseError(`asset upload hash must be 32-hex, got "${hash.slice(0, 16)}…"`);
    }
    if (typeof part.base64 !== "string" || part.base64.length === 0) {
      throw makeInvalidResponseError(`asset upload part "${hash}" is missing base64 content`);
    }
    const blob = new Blob([part.base64], { type: part.contentType || "application/octet-stream" });
    form.append(hash, blob, hash);
  }
  const url = buildWorkerAssetsUploadUrl(accountId);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${uploadJwt}` },
      body: form,
    });
  } catch (error) {
    throw makeNetworkError(error);
  }
  const body = await readJsonSafe(response);
  if (!response.ok) {
    throw makeCloudflareError(response, body);
  }
  if (typeof body !== "object" || body === null || (body as { success?: unknown }).success !== true) {
    throw makeInvalidResponseError("asset upload response success=false");
  }
  const result = (body as { result?: { jwt?: unknown } }).result ?? {};
  if (result.jwt !== undefined && typeof result.jwt !== "string") {
    throw makeInvalidResponseError("asset upload result.jwt is not a string");
  }
  return result.jwt ? { jwt: result.jwt } : {};
}

// official version upload is multipart/form-data with a JSON metadata
// part (main_module required) plus the main module file part. JSON bodies
// with {script, message, assets} are rejected by the provider. Creating a
// new Worker uses the same body but PUT .../workers/scripts/{name} while a
// new version of an existing Worker uses POST .../versions; both share the
// identical multipart metadata + module payload.
async function createVersionMultipart(
  accountId: string | undefined,
  scriptName: string,
  req: VersionCreateRequest,
  fetcher: Fetcher,
  accessToken: string,
): Promise<unknown> {
  return workerUploadMultipart("createVersion", accountId, scriptName, req, fetcher, accessToken);
}

async function createWorkerMultipart(
  accountId: string | undefined,
  scriptName: string,
  req: VersionCreateRequest,
  fetcher: Fetcher,
  accessToken: string,
): Promise<unknown> {
  return workerUploadMultipart("createWorker", accountId, scriptName, req, fetcher, accessToken);
}

async function workerUploadMultipart(
  routeId: "createVersion" | "createWorker",
  accountId: string | undefined,
  scriptName: string,
  req: VersionCreateRequest,
  fetcher: Fetcher,
  accessToken: string,
): Promise<unknown> {
  if (!accountId) {
    return Promise.reject(new Error("Cloudflare account id is required"));
  }
  assertAccountId(accountId);
  assertScriptName(scriptName);
  if (!req || typeof req !== "object") {
    throw makeInvalidResponseError("version request is required");
  }
  const metadata = req.metadata;
  const encoded = encodeVersionModuleParts(req);
  if (!encoded.ok) {
    throw makeInvalidResponseError(`version upload refused: ${encoded.errors.join("; ")}`);
  }
  const route = routeFor(routeId);
  const url = buildApiUrl(route.path({ accountId, scriptName }));
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  // every module (ESM or Wasm) becomes its own multipart part with its
  // exact binary bytes; Wasm never passes through TextDecoder. The entry
  // module's part name equals metadata.main_module, each additional module
  // keeps its canonical name, and the declared content type must already match
  // the module extension or the shared encoder refused the whole set.
  for (const part of encoded.parts) {
    form.append(part.name, new Blob([part.bytes], { type: part.mime }), part.name);
  }
  let response: Response;
  try {
    response = await fetcher(url, {
      method: route.method,
      headers: await bearerHeaders(accessToken),
      body: form,
    });
  } catch (error) {
    throw makeNetworkError(error);
  }
  const body = await readJsonSafe(response);
  if (!response.ok) {
    throw makeCloudflareError(response, body);
  }
  if (typeof body !== "object" || body === null || (body as { success?: unknown }).success !== true) {
    throw makeInvalidResponseError("Cloudflare response success=false");
  }
  const result = (body as CloudflareEnvelope<unknown>).result;
  if (result === undefined) {
    throw makeInvalidResponseError("Cloudflare response missing result");
  }
  return result;
}

// official deployment create requires strategy "percentage" and
// versions: [{version_id, percentage:100}]. Bare {version_id} is rejected.
async function createDeploymentPercentage(
  accountId: string | undefined,
  scriptName: string,
  req: DeploymentCreateRequest,
  fetcher: Fetcher,
  accessToken: string,
): Promise<unknown> {
  if (!accountId) {
    return Promise.reject(new Error("Cloudflare account id is required"));
  }
  assertAccountId(accountId);
  assertScriptName(scriptName);
  if (!req || req.strategy !== "percentage" || !Array.isArray(req.versions) || req.versions.length === 0) {
    throw makeInvalidResponseError("deployment requires strategy percentage with versions");
  }
  for (const v of req.versions) {
    if (typeof v?.version_id !== "string" || v.version_id.length === 0) {
      throw makeInvalidResponseError("deployment version entry missing version_id");
    }
    if (typeof v.percentage !== "number") {
      throw makeInvalidResponseError("deployment version entry missing percentage");
    }
  }
  const total = req.versions.reduce((n, v) => n + (v.percentage ?? 0), 0);
  if (Math.abs(total - 100) > 0.001) {
    throw makeInvalidResponseError("deployment versions percentages must total 100");
  }
  return request("createDeployment", { accountId, scriptName }, req, (env) => env.result, fetcher, accessToken);
}

// Pages Direct Upload deployment create. Multipart/form-data with a
// `manifest` part (JSON map of root path -> 32-hex upload hash) and, when a
// prebuilt `_worker.js` is declared, a `_worker.bundle` file part. Auth is the
// OAuth token (server-side); the upload JWT is only used for the asset bytes.
function createPagesDeploymentMultipart(
  accountId: string | undefined,
  projectName: string,
  form: FormData,
  fetcher: Fetcher,
  accessToken: string,
): Promise<unknown> {
  if (!accountId) {
    return Promise.reject(new Error("Cloudflare account id is required"));
  }
  assertAccountId(accountId);
  const route = routeFor("createPagesDeployment");
  const url = buildApiUrl(route.path({ accountId, projectName }));
  return (async () => {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: route.method,
        headers: await bearerHeaders(accessToken),
        body: form,
      });
    } catch (error) {
      throw makeNetworkError(error);
    }
    const body = await readJsonSafe(response);
    if (!response.ok) {
      throw makeCloudflareError(response, body);
    }
    if (typeof body !== "object" || body === null || (body as { success?: unknown }).success !== true) {
      throw makeInvalidResponseError("Cloudflare response success=false");
    }
    const result = (body as CloudflareEnvelope<unknown>).result;
    if (typeof result !== "object" || result === null) {
      throw makeInvalidResponseError("Cloudflare response missing result");
    }
    return normalizePagesDeployment(result as Record<string, unknown>);
  })();
}

function withAccountId(
  accountId: string | undefined,
  routeId: string,
  payload: unknown,
  parse: (env: CloudflareEnvelope<unknown>) => unknown,
  fetcher: Fetcher,
  accessToken: string,
  extra: Record<string, string> = {},
): Promise<unknown> {
  if (!accountId) {
    return Promise.reject(new Error("Cloudflare account id is required"));
  }
  assertAccountId(accountId);
  return request(routeId, { accountId, ...extra }, payload, parse, fetcher, accessToken);
}

function withScript(
  accountId: string | undefined,
  scriptName: string,
  routeId: string,
  payload: unknown,
  parse: (env: CloudflareEnvelope<unknown>) => unknown,
  fetcher: Fetcher,
  accessToken: string,
): Promise<unknown> {
  if (!accountId) {
    return Promise.reject(new Error("Cloudflare account id is required"));
  }
  assertAccountId(accountId);
  assertScriptName(scriptName);
  return request(routeId, { accountId, scriptName }, payload, parse, fetcher, accessToken);
}

// a zone-scoped call (list / create). A missing or malformed zone id fails
// closed before any fetch, so a caller can never hit an unvalidated path.
function withZoneId(
  zoneId: string,
  routeId: string,
  payload: unknown,
  parse: (env: CloudflareEnvelope<unknown>) => unknown,
  fetcher: Fetcher,
  accessToken: string,
): Promise<unknown> {
  if (!zoneId) {
    return Promise.reject(new Error("Cloudflare zone id is required"));
  }
  assertZoneId(zoneId);
  return request(routeId, { zoneId }, payload, parse, fetcher, accessToken);
}

// a zone-scoped call targeting one existing record/route (overwrite /
// delete). Both ids are validated before any fetch; the resource id is placed
// under `extraKey` so the route path picks up the right path segment.
function withZoneAndResourceId(
  zoneId: string,
  resourceId: string,
  routeId: string,
  payload: unknown,
  parse: (env: CloudflareEnvelope<unknown>) => unknown,
  fetcher: Fetcher,
  accessToken: string,
  extraKey: string,
): Promise<unknown> {
  if (!zoneId) {
    return Promise.reject(new Error("Cloudflare zone id is required"));
  }
  if (!resourceId) {
    return Promise.reject(new Error("Cloudflare resource id is required"));
  }
  assertZoneId(zoneId);
  assertResourceId(resourceId);
  return request(routeId, { zoneId, [extraKey]: resourceId }, payload, parse, fetcher, accessToken);
}

async function request(
  routeId: string,
  ctx: Record<string, string>,
  payload: unknown,
  parse: (env: CloudflareEnvelope<unknown>) => unknown,
  fetcher: Fetcher,
  accessToken: string,
): Promise<unknown> {
  const route = routeFor(routeId);
  const url = buildApiUrl(route.path(ctx));

  let response: Response;
  try {
    const init: RequestInit = {
      method: route.method,
      headers: await bearerHeaders(accessToken),
    };
    if (payload !== undefined) {
      (init.headers as Record<string, string>)["Content-Type"] =
        "application/json";
      init.body = JSON.stringify(payload);
    }
    response = await fetcher(url, init);
  } catch (error) {
    throw makeNetworkError(error);
  }

  const body = await readJsonSafe(response);

  if (!response.ok) {
    throw makeCloudflareError(response, body);
  }

  if (typeof body !== "object" || body === null) {
    throw makeInvalidResponseError("Cloudflare response is not an object");
  }
  const envelope = body as { success?: unknown; result?: unknown };
  if (envelope.success !== true) {
    throw makeInvalidResponseError("Cloudflare response success=false");
  }
  const result = parse(body as CloudflareEnvelope<unknown>);
  if (result === undefined) {
    throw makeInvalidResponseError("Cloudflare response missing result");
  }
  return result;
}

async function bearerHeaders(
  accessToken: string,
): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${accessToken}` };
}

async function readJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
