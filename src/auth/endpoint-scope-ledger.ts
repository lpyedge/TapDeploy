// Exhaustive, code-owned scope inventory. These are documented registry
// expectations, NOT proof that an OAuth provider grants any endpoint live.
import { SCOPE_REGISTRY, type ScopeCapability } from "./scope-registry.js";

export interface EndpointScopeEntry {
  capability?: ScopeCapability;
  credential: "oauth" | "asset-jwt";
  reachable: boolean;
  live: "unverified-oauth";
  note?: string;
}
const entry = (capability: ScopeCapability, reachable = true): EndpointScopeEntry => ({ capability, credential: "oauth", reachable, live: "unverified-oauth" });
export const ENDPOINT_SCOPE_LEDGER: Record<string, EndpointScopeEntry> = {
  listAccounts: { credential: "oauth", reachable: true, live: "unverified-oauth", note: "Token-visible accounts; no speculative account.read scope; denial is a visible upstream failure, never a silent empty account list." },
  getAccount: { credential: "oauth", reachable: false, live: "unverified-oauth", note: "Typed adapter only; no installer execution path." },
  listWorkers: entry("worker-admin"), getWorker: entry("worker-admin", false),
  getWorkerSettings: entry("worker-admin"), listVersions: entry("worker-admin"), getVersion: entry("worker-admin"), listDeployments: entry("worker-admin"),
  listWorkerResources: entry("worker-admin"), getWorkerResource: entry("worker-admin"), createWorkerResourceVersion: entry("worker-admin"),
  listSecrets: entry("worker-admin"), getSchedules: entry("worker-admin"), updateSchedules: entry("worker-admin"),
  getAccountSubdomain: entry("worker-admin"), getScriptSubdomain: entry("worker-admin"), setScriptSubdomain: entry("worker-admin"),
  createWorker: entry("worker-admin"), createVersion: entry("worker-admin"), createDeployment: entry("worker-admin"), updateSecret: entry("worker-admin", false),
  startAssetUploadSession: entry("worker-admin"), uploadWorkerAssets: { capability: "worker-admin", credential: "asset-jwt", reachable: true, live: "unverified-oauth", note: "OAuth authorizes session creation, upload uses only temporary provider JWT." },
  listR2Buckets: entry("r2-write"), getR2Bucket: entry("r2-write", false), createR2Bucket: entry("r2-write"),
  getR2ManagedDomain: entry("r2-write"), listR2CustomDomains: entry("r2-write"),
  headR2Object: entry("r2-write"),
  listD1Databases: entry("d1-write"), createD1Database: entry("d1-write"),
  listKvNamespaces: entry("kv-write"), createKvNamespace: entry("kv-write"),
  listQueues: entry("queues-write"), createQueue: entry("queues-write"), listQueueConsumers: entry("queues-write"), createQueueConsumer: entry("queues-write"), putQueueConsumer: entry("queues-write", false),
  // Workflows ride the Worker admin scope (V3_CAPABILITY_META.workflows);
  // no separate Workflows OAuth scope exists.
  listWorkflows: entry("worker-admin"), getWorkflowDetails: entry("worker-admin"), updateWorkflow: entry("worker-admin"),
  listHyperdriveConfigs: entry("hyperdrive-write"), createHyperdriveConfig: entry("hyperdrive-write", false),
  listVectorizeIndexes: entry("vectorize-write"), createVectorizeIndex: entry("vectorize-write"),
  listSecretsStores: entry("secrets-store-write"), createSecretsStore: entry("secrets-store-write", false), listSecretsStoreSecrets: entry("secrets-store-write", false), createSecretsStoreSecret: entry("secrets-store-write", false),
  listPages: entry("page-write"), getPagesProject: entry("page-write"), updatePagesProject: entry("page-write"), createPagesProject: entry("page-write"), getPagesUploadToken: entry("page-write"), createPagesDeployment: entry("page-write"), getPagesDeployment: entry("page-write"), listPagesDeployments: entry("page-write"),
  listZones: entry("zone-read"), listDnsRecords: entry("dns-write"), createDnsRecord: entry("dns-write"), updateDnsRecord: entry("dns-write"), deleteDnsRecord: entry("dns-write"),
  listWorkerRoutes: entry("workers-routes-write"), createWorkerRoute: entry("workers-routes-write"), updateWorkerRoute: entry("workers-routes-write"), deleteWorkerRoute: entry("workers-routes-write", false),
  listWorkerDomains: entry("worker-admin"), attachWorkerDomain: entry("worker-admin"), detachWorkerDomain: entry("worker-admin"),
  listPagesDomains: entry("page-write"), addPagesDomain: entry("page-write"), deletePagesDomain: entry("page-write"),
};
export function endpointScope(id: string): string | undefined {
  const capability = ENDPOINT_SCOPE_LEDGER[id]?.capability;
  return capability ? SCOPE_REGISTRY[capability].scope : undefined;
}
