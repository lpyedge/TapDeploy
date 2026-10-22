// Resource-adapter registry and support matrix. This is the single place that
// decides which Cloudflare resource kinds the installer supports. Unknown kinds
// fail closed. docs/support.md summarizes it.

import { r2BucketAdapter, R2_BUCKET_SUPPORT } from "./r2.js";
import { rateLimitAdapter, RATE_LIMIT_SUPPORT } from "./rate-limits.js";
import { d1DatabaseAdapter, D1_DATABASE_SUPPORT } from "./d1.js";
import { kvNamespaceAdapter, KV_NAMESPACE_SUPPORT } from "./kv.js";
import { queueAdapter, QUEUE_SUPPORT } from "./queues.js";
import { hyperdriveAdapter, HYPERDRIVE_SUPPORT } from "./hyperdrive.js";
import { vectorizeAdapter, VECTORIZE_SUPPORT } from "./vectorize.js";
import { secretsStoreAdapter, SECRETS_STORE_SUPPORT } from "./secrets-store.js";
import {
  dnsRecordAdapter,
  DNS_RECORD_SUPPORT,
} from "./dns.js";
import {
  workerRouteAdapter,
  WORKER_ROUTE_SUPPORT,
} from "./routes.js";
import {
  workerCustomDomainAdapter,
  pagesCustomDomainAdapter,
  WORKER_CUSTOM_DOMAIN_SUPPORT,
  PAGES_CUSTOM_DOMAIN_SUPPORT,
} from "./domains.js";
import {
  UnsupportedResourceError,
  type ResourceAdapter,
  type ResourceKind,
  type ResourceSupport,
} from "./types.js";

export const RESOURCE_ADAPTERS: Record<string, ResourceAdapter> = {
  "r2-bucket": r2BucketAdapter,
  "rate-limit": rateLimitAdapter,
  "d1-database": d1DatabaseAdapter,
  "kv-namespace": kvNamespaceAdapter,
  queue: queueAdapter,
  hyperdrive: hyperdriveAdapter,
  vectorize: vectorizeAdapter,
  "secrets-store": secretsStoreAdapter,
  // opt-in domain/route/DNS adapters.
  "dns-record": dnsRecordAdapter,
  "worker-route": workerRouteAdapter,
  "worker-custom-domain": workerCustomDomainAdapter,
  "pages-custom-domain": pagesCustomDomainAdapter,
};

// Every resource kind the installer knows about, with its honest verification
// level. Worker/static-assets/cron/secret are handled by the deploy step engine
// and the planning module; they are listed here for the support matrix.
export const RESOURCE_SUPPORT_MATRIX: ResourceSupport[] = [
  {
    kind: "worker",
    label: "Worker script",
    install: "create-declared",
    upgrade: "reconcile",
    deletes: "never",
    verified: "local-contract",
  },
  {
    kind: "static-assets",
    label: "Static assets",
    install: "create-declared",
    upgrade: "reconcile",
    deletes: "never",
    verified: "local-contract",
  },
  R2_BUCKET_SUPPORT,
  {
    kind: "secret",
    label: "Worker secret",
    install: "create-declared",
    upgrade: "preserve",
    deletes: "never",
    verified: "local-contract",
  },
  {
    kind: "cron",
    label: "Cron schedule",
    install: "create-declared",
    upgrade: "reconcile",
    deletes: "never",
    verified: "local-contract",
  },
  RATE_LIMIT_SUPPORT,
  D1_DATABASE_SUPPORT,
  KV_NAMESPACE_SUPPORT,
  QUEUE_SUPPORT,
  HYPERDRIVE_SUPPORT,
  VECTORIZE_SUPPORT,
  SECRETS_STORE_SUPPORT,
  // opt-in domain/route/DNS support rows. These are declaratively managed
  // inside the preauthorized envelope; a delete is only offered after an
  // independent in-app confirmation, never an ordinary upgrade.
  WORKER_ROUTE_SUPPORT,
  WORKER_CUSTOM_DOMAIN_SUPPORT,
  PAGES_CUSTOM_DOMAIN_SUPPORT,
  DNS_RECORD_SUPPORT,
];

export function getResourceAdapter(kind: string): ResourceAdapter {
  const adapter = RESOURCE_ADAPTERS[kind];
  if (!adapter) {
    throw new UnsupportedResourceError(kind);
  }
  return adapter;
}

export function resourceSupportFor(kind: ResourceKind): ResourceSupport {
  const row = RESOURCE_SUPPORT_MATRIX.find((r) => r.kind === kind);
  if (!row) {
    throw new UnsupportedResourceError(kind);
  }
  return row;
}

export * from "./types.js";
export * from "./r2.js";
export * from "./rate-limits.js";
export * from "./d1.js";
export * from "./kv.js";
export * from "./queues.js";
export * from "./hyperdrive.js";
export * from "./vectorize.js";
export * from "./secrets-store.js";
export * from "./mutations.js";
export * from "./dns.js";
export * from "./routes.js";
export * from "./domains.js";
