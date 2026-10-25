// Fixed Cloudflare v4 route allowlist. The typed client may only ever issue
// requests for these exact routes; each operation maps to its own route and
// there is no generic endpoint proxy. This table is the interception seam
// and the basis of the scope matrix in docs/cloudflare-scope-matrix.md.

type ApiHttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

interface ApiRouteContext {
  accountId?: string;
  scriptName?: string;
  bucketName?: string;
  databaseName?: string;
  namespaceName?: string;
  queueId?: string;
  consumerId?: string;
  hyperdriveId?: string;
  storeId?: string;
  secretId?: string;
  // Pages project name (identity for Pages project/deployment routes).
  projectName?: string;
  deploymentId?: string;
  versionId?: string;
  workerId?: string;
  // zone + record/route identities for the zone-scoped DNS/route routes.
  // A zone is the DNS/route scope; a dns_record_id or route_id targets one
  // existing record/route for an overwrite or detach/delete.
  zoneId?: string;
  dnsRecordId?: string;
  routeId?: string;
  domainId?: string;
  // a Pages custom domain is addressed by its hostname (`name`), not an id.
  domainName?: string;
  // an R2 object key for existence-only reads (metadata, never content).
  objectKey?: string;
  // a Workflow is addressed by its account-unique name, never an id.
  workflowName?: string;
}

export interface ApiRoute {
  id: string;
  label: string;
  method: ApiHttpMethod;
  category: "read" | "write";
  path: (ctx: ApiRouteContext) => string;
}

const prop = encodeURIComponent;

export const ROUTES: Record<string, ApiRoute> = {
  listWorkerResources: {
    id: "listWorkerResources", label: "List immutable Worker identities", method: "GET", category: "read",
    path: c => `/accounts/${prop(c.accountId ?? "")}/workers/workers`,
  },
  getWorkerResource: {
    id: "getWorkerResource", label: "Verify immutable Worker identity", method: "GET", category: "read",
    path: c => `/accounts/${prop(c.accountId ?? "")}/workers/workers/${prop(c.workerId ?? "")}`,
  },
  createWorkerResourceVersion: {
    id: "createWorkerResourceVersion", label: "Prepare Worker version with exact inheritance", method: "POST", category: "write",
    path: c => `/accounts/${prop(c.accountId ?? "")}/workers/workers/${prop(c.workerId ?? "")}/versions?deploy=false`,
  },
  getVersion: {
    id: "getVersion", label: "Get exact Worker version", method: "GET", category: "read",
    path: c => `/accounts/${prop(c.accountId ?? "")}/workers/scripts/${prop(c.scriptName ?? "")}/versions/${prop(c.versionId ?? "")}`,
  },
  updatePagesProject: {
    id: "updatePagesProject", label: "Patch Pages deployment configuration", method: "PATCH", category: "write",
    path: c => `/accounts/${prop(c.accountId ?? "")}/pages/projects/${prop(c.projectName ?? "")}`,
  },
  listAccounts: {
    id: "listAccounts",
    label: "List accounts",
    method: "GET",
    category: "read",
    path: () => "/accounts",
  },
  getAccount: {
    id: "getAccount",
    label: "Get account",
    method: "GET",
    category: "read",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}`,
  },
  listWorkers: {
    id: "listWorkers",
    label: "List worker scripts",
    method: "GET",
    category: "read",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}/workers/scripts`,
  },
  getWorker: {
    id: "getWorker",
    label: "Get worker script (raw download, bytes — NOT JSON metadata)",
    method: "GET",
    category: "read",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/workers/scripts/${prop(c.scriptName ?? "")}`,
  },
  getWorkerSettings: {
    id: "getWorkerSettings",
    label: "Get worker script settings (JSON metadata and bindings)",
    method: "GET",
    category: "read",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/workers/scripts/${prop(c.scriptName ?? "")}/settings`,
  },
  listVersions: {
    id: "listVersions",
    label: "List worker versions",
    method: "GET",
    category: "read",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/workers/scripts/${prop(c.scriptName ?? "")}/versions`,
  },
  listDeployments: {
    id: "listDeployments",
    label: "List worker deployments",
    method: "GET",
    category: "read",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/workers/scripts/${prop(c.scriptName ?? "")}/deployments`,
  },
  listR2Buckets: {
    id: "listR2Buckets",
    label: "List R2 buckets",
    method: "GET",
    category: "read",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}/r2/buckets`,
  },
  getR2Bucket: {
    id: "getR2Bucket",
    label: "Get R2 bucket",
    method: "GET",
    category: "read",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/r2/buckets/${prop(c.bucketName ?? "")}`,
  },
  // R2 privacy reads. The managed r2.dev flag and the custom domain list
  // are the official surfaces that prove a bucket is not publicly exposed.
  getR2ManagedDomain: {
    id: "getR2ManagedDomain",
    label: "Get R2 bucket managed (r2.dev) domain",
    method: "GET",
    category: "read",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/r2/buckets/${prop(c.bucketName ?? "")}/domains/managed`,
  },
  listR2CustomDomains: {
    id: "listR2CustomDomains",
    label: "List R2 bucket custom domains",
    method: "GET",
    category: "read",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/r2/buckets/${prop(c.bucketName ?? "")}/domains/custom`,
  },
  // object existence only (HEAD returns headers, never object bytes).
  // Used to verify guarded-bootstrap marker/owner presence without reading
  // any object contents. A 404 means verified absence; anything else fails.
  headR2Object: {
    id: "headR2Object",
    label: "Check R2 object existence (metadata only, never content)",
    method: "HEAD",
    category: "read",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/r2/buckets/${prop(c.bucketName ?? "")}/objects/${(c.objectKey ?? "").split("/").map(prop).join("/")}`,
  },
  listSecrets: {
    id: "listSecrets",
    label: "List worker secrets",
    method: "GET",
    category: "read",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/workers/scripts/${prop(c.scriptName ?? "")}/secrets`,
  },
  getSchedules: {
    id: "getSchedules",
    label: "Get cron schedules",
    method: "GET",
    category: "read",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/workers/scripts/${prop(c.scriptName ?? "")}/schedules`,
  },
  startAssetUploadSession: {
    id: "startAssetUploadSession",
    label: "Start static assets upload session (official assets-upload-session)",
    method: "POST",
    category: "write",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/workers/scripts/${prop(c.scriptName ?? "")}/assets-upload-session`,
  },
  uploadWorkerAssets: {
    id: "uploadWorkerAssets",
    label: "Upload worker assets batch (account-level, JWT bearer, base64=true)",
    method: "POST",
    category: "write",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}/workers/assets/upload?base64=true`,
  },
  createWorker: {
    id: "createWorker",
    label: "Create worker script",
    method: "PUT",
    category: "write",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/workers/scripts/${prop(c.scriptName ?? "")}`,
  },
  createVersion: {
    id: "createVersion",
    label: "Create worker version",
    method: "POST",
    category: "write",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/workers/scripts/${prop(c.scriptName ?? "")}/versions`,
  },
  createDeployment: {
    id: "createDeployment",
    label: "Create worker deployment",
    method: "POST",
    category: "write",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/workers/scripts/${prop(c.scriptName ?? "")}/deployments`,
  },
  createR2Bucket: {
    id: "createR2Bucket",
    label: "Create R2 bucket",
    method: "POST",
    category: "write",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}/r2/buckets`,
  },
  updateSecret: {
    id: "updateSecret",
    label: "Create or update worker secret",
    method: "PUT",
    category: "write",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/workers/scripts/${prop(c.scriptName ?? "")}/secrets`,
  },
  updateSchedules: {
    id: "updateSchedules",
    label: "Update cron schedules",
    method: "PUT",
    category: "write",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/workers/scripts/${prop(c.scriptName ?? "")}/schedules`,
  },
  // workers.dev publication. The account subdomain is the `<name>.workers.dev`
  // part shared by every Worker of the account; a Worker answers on it only
  // after its own subdomain flag is enabled (an API-created Worker starts
  // disabled).
  getAccountSubdomain: {
    id: "getAccountSubdomain",
    label: "Read the account workers.dev subdomain",
    method: "GET",
    category: "read",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}/workers/subdomain`,
  },
  getScriptSubdomain: {
    id: "getScriptSubdomain",
    label: "Read the Worker workers.dev state",
    method: "GET",
    category: "read",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/workers/scripts/${prop(c.scriptName ?? "")}/subdomain`,
  },
  setScriptSubdomain: {
    id: "setScriptSubdomain",
    label: "Enable the Worker on workers.dev",
    method: "POST",
    category: "write",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/workers/scripts/${prop(c.scriptName ?? "")}/subdomain`,
  },
  // Official D1 database management endpoints (see docs scope matrix).
  // List + Create are the only D1 routes declared; there is no delete/query
  // route and no generic database SQL proxy.
  listD1Databases: {
    id: "listD1Databases",
    label: "List D1 databases",
    method: "GET",
    category: "read",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}/d1/database`,
  },
  createD1Database: {
    id: "createD1Database",
    label: "Create D1 database",
    method: "POST",
    category: "write",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}/d1/database`,
  },
  // Official Workers KV namespace management endpoints. List + Create are the
  // only KV routes declared; there is no delete route and no generic key proxy.
  listKvNamespaces: {
    id: "listKvNamespaces",
    label: "List Workers KV namespaces",
    method: "GET",
    category: "read",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}/storage/kv/namespaces`,
  },
  createKvNamespace: {
    id: "createKvNamespace",
    label: "Create Workers KV namespace",
    method: "POST",
    category: "write",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}/storage/kv/namespaces`,
  },
  // Official Cloudflare Queues management endpoints.
  // List + Create are the only queue routes used for resource provisioning; a
  // consumer trigger is registered via the consumers subresource (create or
  // put). There is no queue delete/drain route and no message proxy.
  listQueues: {
    id: "listQueues",
    label: "List Queues",
    method: "GET",
    category: "read",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}/queues`,
  },
  createQueue: {
    id: "createQueue",
    label: "Create Queue",
    method: "POST",
    category: "write",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}/queues`,
  },
  createQueueConsumer: {
    id: "createQueueConsumer",
    label: "Create Queue consumer",
    method: "POST",
    category: "write",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/queues/${prop(c.queueId ?? "")}/consumers`,
  },
  listQueueConsumers: {
    id: "listQueueConsumers", label: "List queue consumers", method: "GET", category: "read",
    path: c => `/accounts/${prop(c.accountId ?? "")}/queues/${prop(c.queueId ?? "")}/consumers`,
  },
  putQueueConsumer: {
    id: "putQueueConsumer",
    label: "Update Queue consumer",
    method: "PUT",
    category: "write",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/queues/${prop(c.queueId ?? "")}/consumers/${prop(c.consumerId ?? "")}`,
  },
  // Official Cloudflare Workflows endpoints. The account list is the
  // plan-time fact read; GET verifies one definition (idempotency / readback);
  // PUT applies the exact desired definition ({class_name, script_name,
  // schedules}) after the carrier version is active. There is no delete route
  // (destructive, never automatic) and instances are never touched.
  listWorkflows: {
    id: "listWorkflows",
    label: "List Workflows",
    method: "GET",
    category: "read",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}/workflows`,
  },
  getWorkflowDetails: {
    id: "getWorkflowDetails",
    label: "Get Workflow",
    method: "GET",
    category: "read",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/workflows/${prop(c.workflowName ?? "")}`,
  },
  updateWorkflow: {
    id: "updateWorkflow",
    label: "Create or update Workflow",
    method: "PUT",
    category: "write",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/workflows/${prop(c.workflowName ?? "")}`,
  },
  // Official Cloudflare Hyperdrive config list: read only (the configs hold the
  // user's own database credentials, which the provider never echoes back).
  listHyperdriveConfigs: {
    id: "listHyperdriveConfigs",
    label: "List Hyperdrive configs",
    method: "GET",
    category: "read",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}/hyperdrive/configs`,
  },
  // Official Cloudflare Vectorize index endpoints (v2). List + Create are
  // the only index routes used for resource provisioning. An index's
  // dimension/metric configuration is immutable on the live resource, so there
  // is no update route and no delete route (destructive, never automatic).
  listVectorizeIndexes: {
    id: "listVectorizeIndexes",
    label: "List Vectorize indexes",
    method: "GET",
    category: "read",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}/vectorize/v2/indexes`,
  },
  createVectorizeIndex: {
    id: "createVectorizeIndex",
    label: "Create Vectorize index",
    method: "POST",
    category: "write",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}/vectorize/v2/indexes`,
  },
  // Official Cloudflare Secrets Store endpoints, read only: the account's stores
  // and the secret names inside one (secret values are never fetched).
  listSecretsStores: {
    id: "listSecretsStores",
    label: "List Secrets Store stores",
    method: "GET",
    category: "read",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}/secrets_store/stores`,
  },
  listSecretsStoreSecrets: {
    id: "listSecretsStoreSecrets",
    label: "List Secrets Store secrets",
    method: "GET",
    category: "read",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/secrets_store/stores/${prop(c.storeId ?? "")}/secrets`,
  },
  // Official Cloudflare Pages projects list
  // `GET /accounts/{account_id}/pages/projects`. Accepted permission: Pages Read
  // OR Pages Write (per the reference). The result is an array of projects; the
  // endpoint does not accept pagination cursors like most list resources.
  listPages: {
    id: "listPages",
    label: "List Pages projects",
    method: "GET",
    category: "read",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}/pages/projects`,
  },
  // Pages project management + deployment lifecycle. Pages is its own
  // direct-upload target, NOT the Workers scripts/versions/deployments API.
  // Accepted permission: Pages Write (covers list/create/get/deploy).
  getPagesProject: {
    id: "getPagesProject",
    label: "Get Pages project",
    method: "GET",
    category: "read",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/pages/projects/${prop(c.projectName ?? "")}`,
  },
  createPagesProject: {
    id: "createPagesProject",
    label: "Create Pages project",
    method: "POST",
    category: "write",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}/pages/projects`,
  },
  getPagesUploadToken: {
    id: "getPagesUploadToken",
    label: "Get Pages upload token",
    method: "GET",
    category: "read",
    // Official direct-upload JWT endpoint (Scopes: Pages Write). The token is
    // short-lived and scoped to the project; it is never the OAuth token.
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/pages/projects/${prop(c.projectName ?? "")}/upload-token`,
  },
  createPagesDeployment: {
    id: "createPagesDeployment",
    label: "Create Pages deployment",
    method: "POST",
    category: "write",
    // Direct Upload deployment create. Multipart/form-data with a `manifest`
    // part (JSON path -> 32-hex hash) and, for a prebuilt `_worker.js`, a
    // `_worker.bundle` file part. This is the ONLY Pages deploy write route.
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/pages/projects/${prop(c.projectName ?? "")}/deployments`,
  },
  getPagesDeployment: {
    id: "getPagesDeployment",
    label: "Get Pages deployment",
    method: "GET",
    category: "read",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/pages/projects/${prop(c.projectName ?? "")}/deployments/${prop(c.deploymentId ?? "")}`,
  },
  listPagesDeployments: {
    id: "listPagesDeployments",
    label: "List Pages deployments",
    method: "GET",
    category: "read",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/pages/projects/${prop(c.projectName ?? "")}/deployments`,
  },
  // Zone-scoped DNS records. `GET /zones/{zone_id}/dns_records` lists the
  // records in a zone (DNS Write accepted without a separate `dns.read`), and
  // POST/PUT/DELETE create/overwrite/remove a single record. The DELETE route is
  // destructive and is only reachable after an independent in-app confirmation.
  listDnsRecords: {
    id: "listDnsRecords",
    label: "List DNS records in a zone",
    method: "GET",
    category: "read",
    path: (c) => `/zones/${prop(c.zoneId ?? "")}/dns_records`,
  },
  createDnsRecord: {
    id: "createDnsRecord",
    label: "Create a DNS record",
    method: "POST",
    category: "write",
    path: (c) => `/zones/${prop(c.zoneId ?? "")}/dns_records`,
  },
  updateDnsRecord: {
    id: "updateDnsRecord",
    label: "Overwrite a DNS record",
    method: "PUT",
    category: "write",
    path: (c) =>
      `/zones/${prop(c.zoneId ?? "")}/dns_records/${prop(c.dnsRecordId ?? "")}`,
  },
  deleteDnsRecord: {
    id: "deleteDnsRecord",
    label: "Delete a DNS record",
    method: "DELETE",
    category: "write",
    path: (c) =>
      `/zones/${prop(c.zoneId ?? "")}/dns_records/${prop(c.dnsRecordId ?? "")}`,
  },
  // Account-scoped zone discovery. `GET /zones` lists the zones the bound
  // token can manage. Never a mutation; Zone Read is requested only when a zone
  // selector is needed (DNS Write does not imply Zone Read).
  listZones: {
    id: "listZones",
    label: "List zones",
    method: "GET",
    category: "read",
    path: () => "/zones",
  },
  // Zone-scoped Workers routes. Workers Routes Write independently covers
  // list/create/update/delete of routes; it is separate from Worker Admin.
  listWorkerRoutes: {
    id: "listWorkerRoutes",
    label: "List Workers routes in a zone",
    method: "GET",
    category: "read",
    path: (c) => `/zones/${prop(c.zoneId ?? "")}/workers/routes`,
  },
  createWorkerRoute: {
    id: "createWorkerRoute",
    label: "Create a Workers route",
    method: "POST",
    category: "write",
    path: (c) => `/zones/${prop(c.zoneId ?? "")}/workers/routes`,
  },
  updateWorkerRoute: {
    id: "updateWorkerRoute",
    label: "Replace a Workers route",
    method: "PUT",
    category: "write",
    path: (c) =>
      `/zones/${prop(c.zoneId ?? "")}/workers/routes/${prop(c.routeId ?? "")}`,
  },
  deleteWorkerRoute: {
    id: "deleteWorkerRoute",
    label: "Delete a Workers route",
    method: "DELETE",
    category: "write",
    path: (c) =>
      `/zones/${prop(c.zoneId ?? "")}/workers/routes/${prop(c.routeId ?? "")}`,
  },
  // Account-scoped Workers custom domains. A domain is attached to a
  // Worker (PUT) and detached (DELETE); Workers Routes Write covers it. This
  // is separate from the zone-scoped route table.
  listWorkerDomains: {
    id: "listWorkerDomains",
    label: "List Workers custom domains",
    method: "GET",
    category: "read",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}/workers/domains`,
  },
  attachWorkerDomain: {
    id: "attachWorkerDomain",
    label: "Attach a Workers custom domain",
    method: "PUT",
    category: "write",
    path: (c) => `/accounts/${prop(c.accountId ?? "")}/workers/domains`,
  },
  detachWorkerDomain: {
    id: "detachWorkerDomain",
    label: "Detach a Workers custom domain",
    method: "DELETE",
    category: "write",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/workers/domains/${prop(c.domainId ?? "")}`,
  },
  // Pages custom domains are account+project scoped and addressed by
  // hostname, not id: `POST .../domains` adds, `DELETE .../domains/{name}` removes.
  listPagesDomains: {
    id: "listPagesDomains",
    label: "List Pages custom domains",
    method: "GET",
    category: "read",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/pages/projects/${prop(c.projectName ?? "")}/domains`,
  },
  addPagesDomain: {
    id: "addPagesDomain",
    label: "Add a Pages custom domain",
    method: "POST",
    category: "write",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/pages/projects/${prop(c.projectName ?? "")}/domains`,
  },
  deletePagesDomain: {
    id: "deletePagesDomain",
    label: "Delete a Pages custom domain",
    method: "DELETE",
    category: "write",
    path: (c) =>
      `/accounts/${prop(c.accountId ?? "")}/pages/projects/${prop(c.projectName ?? "")}/domains/${prop(c.domainName ?? "")}`,
  },
};

export function routeFor(id: string): ApiRoute {
  const route = ROUTES[id];
  if (!route) {
    throw new Error(`Unknown Cloudflare route: ${id}`);
  }
  return route;
}
