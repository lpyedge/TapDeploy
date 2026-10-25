// Cloudflare response parsers: account resources (R2, D1, KV, Queues, Workflows, Hyperdrive, Vectorize, Secrets Store).
// Pure functions: they validate and normalize an already-parsed response body
// and throw an invalid-response error on any malformed shape; nothing here
// performs a request or swallows an upstream error.

import type {
  D1Database,
  HyperdriveConfig,
  KvNamespace,
  Queue,
  QueueConsumer,
  R2Bucket,
  R2CustomDomain,
  R2ManagedDomain,
  SecretsStore,
  SecretsStoreSecret,
  VectorizeIndex,
  Workflow,
  WorkflowSchedule,
} from "../models/index.js";
import { makeInvalidResponseError, type CloudflareEnvelope } from "./errors.js";

export function normalizeR2Bucket(item: unknown): R2Bucket {
  if (typeof item !== "object" || item === null) {
    throw makeInvalidResponseError("R2 bucket is not an object");
  }
  const o = item as Record<string, unknown>;
  if (typeof o["name"] !== "string") {
    throw makeInvalidResponseError("R2 bucket missing name");
  }
  const name = o["name"] as string;
  const id = typeof o["id"] === "string" && o["id"].length > 0 ? o["id"] : typeof o["creation_date"] === "string" && Number.isFinite(Date.parse(o["creation_date"])) ? `${name}@${o["creation_date"]}` : undefined;
  if (!id) throw makeInvalidResponseError("R2 bucket incarnation unavailable (id/creation_date); name-only identity cannot be verified");
  return {
    id,
    name,
    creation_date: typeof o["creation_date"] === "string" ? (o["creation_date"] as string) : "",
    ...(typeof o["jurisdiction"] === "string" ? { jurisdiction: o["jurisdiction"] as string } : {}),
    ...(typeof o["location"] === "string" ? { location: o["location"] as string } : {}),
    ...(typeof o["storage_class"] === "string" ? { storage_class: o["storage_class"] as string } : {}),
  };
}

// managed r2.dev domain read. `enabled` must be a boolean — a missing or
// empty response is invalid (fail closed) and must never read as "disabled".
export function normalizeR2ManagedDomain(item: unknown): R2ManagedDomain {
  if (typeof item !== "object" || item === null) {
    throw makeInvalidResponseError("R2 managed domain is not an object");
  }
  const o = item as Record<string, unknown>;
  if (typeof o["enabled"] !== "boolean") {
    throw makeInvalidResponseError("R2 managed domain missing enabled flag");
  }
  return {
    domain: typeof o["domain"] === "string" ? (o["domain"] as string) : "",
    enabled: o["enabled"] as boolean,
  };
}

// custom domain list read. result.domains must be an array; any other
// shape is an invalid response (the guard treats it as UNKNOWN, never empty).
export function normalizeR2CustomDomains(result: unknown): R2CustomDomain[] {
  if (typeof result !== "object" || result === null) {
    throw makeInvalidResponseError("R2 custom domains result is not an object");
  }
  const domains = (result as { domains?: unknown }).domains;
  if (!Array.isArray(domains)) {
    throw makeInvalidResponseError("R2 custom domains result.domains is not an array");
  }
  return domains.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw makeInvalidResponseError("R2 custom domain entry is not an object");
    }
    const o = item as Record<string, unknown>;
    if (typeof o["domain"] !== "string") {
      throw makeInvalidResponseError("R2 custom domain entry missing domain");
    }
    const zoneId =
      typeof o["zoneId"] === "string"
        ? (o["zoneId"] as string)
        : typeof o["zone_id"] === "string"
          ? (o["zone_id"] as string)
          : undefined;
    return {
      domain: o["domain"] as string,
      enabled: typeof o["enabled"] === "boolean" ? (o["enabled"] as boolean) : false,
      ...(zoneId !== undefined ? { zoneId } : {}),
    };
  });
}

// Official D1 list returns result[] with uuid/name/...; normalize to the
// internal D1Database model (mirror uuid into id for a stable identity).
export function parseD1DatabaseList(env: CloudflareEnvelope<unknown>): D1Database[] {
  const result = env.result;
  if (!Array.isArray(result)) {
    throw makeInvalidResponseError("D1 database list result is not an array");
  }
  return result.map((item) => normalizeD1Database(item));
}

export function normalizeD1Database(item: unknown): D1Database {
  if (typeof item !== "object" || item === null) {
    throw makeInvalidResponseError("D1 database is not an object");
  }
  const o = item as Record<string, unknown>;
  const uuid = o["uuid"];
  if (typeof uuid !== "string") {
    throw makeInvalidResponseError("D1 database missing uuid");
  }
  const name = o["name"];
  if (typeof name !== "string") {
    throw makeInvalidResponseError("D1 database missing name");
  }
  return {
    id: uuid,
    uuid,
    name,
    ...(typeof o["created_at"] === "string" ? { created_at: o["created_at"] as string } : {}),
    ...(typeof o["version"] === "string" ? { version: o["version"] as string } : {}),
    ...(typeof o["jurisdiction"] === "string" ? { jurisdiction: o["jurisdiction"] as string } : {}),
    ...(typeof o["file_size"] === "number" ? { file_size: o["file_size"] as number } : {}),
  };
}

// Official KV list returns result[] with id/title/...; normalize to the
// internal KvNamespace model (mirror title into name for identity).
export function parseKvNamespaceList(env: CloudflareEnvelope<unknown>): KvNamespace[] {
  const result = env.result;
  if (!Array.isArray(result)) {
    throw makeInvalidResponseError("KV namespace list result is not an array");
  }
  return result.map((item) => normalizeKvNamespace(item));
}

export function normalizeKvNamespace(item: unknown): KvNamespace {
  if (typeof item !== "object" || item === null) {
    throw makeInvalidResponseError("KV namespace is not an object");
  }
  const o = item as Record<string, unknown>;
  const id = o["id"];
  if (typeof id !== "string") {
    throw makeInvalidResponseError("KV namespace missing id");
  }
  const title = o["title"];
  if (typeof title !== "string") {
    throw makeInvalidResponseError("KV namespace missing title");
  }
  return {
    id,
    title,
    name: title,
    ...(typeof o["jurisdiction"] === "string" &&
    (o["jurisdiction"] === "eu" || o["jurisdiction"] === "fedramp" || o["jurisdiction"] === "us")
      ? { jurisdiction: o["jurisdiction"] as "eu" | "fedramp" | "us" }
      : {}),
    ...(o["mode"] === "instant" ? { mode: "instant" as const } : {}),
    ...(typeof o["supports_url_encoding"] === "boolean" ? { supports_url_encoding: o["supports_url_encoding"] as boolean } : {}),
  };
}

// official Queues list returns result[] with queue_id/queue_name/...;
// normalize to the internal Queue model (mirror queue_id into id and
// queue_name into name for a stable identity).
export function parseQueueList(env: CloudflareEnvelope<unknown>): Queue[] {
  const result = env.result;
  if (!Array.isArray(result)) {
    throw makeInvalidResponseError("Queue list result is not an array");
  }
  return result.map((item) => normalizeQueue(item));
}

export function normalizeQueue(item: unknown): Queue {
  if (typeof item !== "object" || item === null) {
    throw makeInvalidResponseError("Queue is not an object");
  }
  const o = item as Record<string, unknown>;
  const queueId = o["queue_id"];
  if (typeof queueId !== "string") {
    throw makeInvalidResponseError("Queue missing queue_id");
  }
  const queueName = o["queue_name"];
  if (typeof queueName !== "string") {
    throw makeInvalidResponseError("Queue missing queue_name");
  }
  const out: Queue = {
    id: queueId,
    queue_id: queueId,
    queue_name: queueName,
    name: queueName,
  };
  if (typeof o["created_on"] === "string") out.created_on = o["created_on"];
  if (typeof o["producers_total_count"] === "number") out.producers_total_count = o["producers_total_count"];
  if (typeof o["consumers_total_count"] === "number") out.consumers_total_count = o["consumers_total_count"];
  if (Array.isArray(o["producers"])) {
    out.producers = o["producers"].map((p) => {
      if (typeof p !== "object" || p === null) return {};
      const e = p as Record<string, unknown>;
      const entry: { script?: string; bucket_name?: string; type?: string } = {};
      if (typeof e["script"] === "string") entry.script = e["script"];
      if (typeof e["bucket_name"] === "string") entry.bucket_name = e["bucket_name"];
      if (typeof e["type"] === "string") entry.type = e["type"];
      return entry;
    });
  }
  if (Array.isArray(o["consumers"])) {
    out.consumers = o["consumers"].map((c) => normalizeQueueConsumer(c));
  }
  return out;
}

export function normalizeQueueConsumer(item: unknown): QueueConsumer {
  if (typeof item !== "object" || item === null) {
    throw makeInvalidResponseError("Queue consumer is not an object");
  }
  const o = item as Record<string, unknown>;
  const out: QueueConsumer = {};
  if (o["type"] === "worker" || o["type"] === "http_pull") out.type = o["type"];
  if (typeof o["consumer_id"] === "string") out.consumer_id = o["consumer_id"];
  if (typeof o["queue_name"] === "string") out.queue_name = o["queue_name"];
  // The consumers list returns the Worker as `script`; create/put accept `script_name`.
  const script = typeof o["script"] === "string" ? o["script"] : o["script_name"];
  if (typeof script === "string") out.script_name = script;
  if (typeof o["dead_letter_queue"] === "string") out.dead_letter_queue = o["dead_letter_queue"];
  if (typeof o["created_on"] === "string") out.created_on = o["created_on"];
  if (typeof o["settings"] === "object" && o["settings"] !== null) {
    const s = o["settings"] as Record<string, unknown>;
    const settings: QueueConsumer["settings"] = {};
    if (typeof s["batch_size"] === "number") settings.batch_size = s["batch_size"];
    if (typeof s["max_concurrency"] === "number") settings.max_concurrency = s["max_concurrency"];
    if (typeof s["max_retries"] === "number") settings.max_retries = s["max_retries"];
    if (typeof s["max_wait_time_ms"] === "number") settings.max_wait_time_ms = s["max_wait_time_ms"];
    if (typeof s["retry_delay"] === "number") settings.retry_delay = s["retry_delay"];
    if (typeof s["visibility_timeout_ms"] === "number") settings.visibility_timeout_ms = s["visibility_timeout_ms"];
    out.settings = settings;
  }
  return out;
}

export function parseWorkflowList(env: CloudflareEnvelope<unknown>): Workflow[] {
  if (!Array.isArray(env.result)) {
    throw makeInvalidResponseError("Workflow list result is not an array");
  }
  return env.result.map((item) => normalizeWorkflowEntry(item));
}

export function normalizeWorkflowEntry(item: unknown): Workflow {
  if (typeof item !== "object" || item === null) {
    throw makeInvalidResponseError("Workflow is not an object");
  }
  const o = item as Record<string, unknown>;
  const id = o["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw makeInvalidResponseError("Workflow missing id");
  }
  const name = o["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw makeInvalidResponseError("Workflow missing name");
  }
  const className = o["class_name"];
  if (typeof className !== "string" || className.length === 0) {
    throw makeInvalidResponseError("Workflow missing class_name");
  }
  const scriptName = o["script_name"];
  if (typeof scriptName !== "string" || scriptName.length === 0) {
    throw makeInvalidResponseError("Workflow missing script_name");
  }
  const out: Workflow = {
    id,
    name,
    class_name: className,
    script_name: scriptName,
  };
  if (typeof o["created_on"] === "string") out.created_on = o["created_on"];
  if (typeof o["modified_on"] === "string") out.modified_on = o["modified_on"];
  if (typeof o["triggered_on"] === "string") out.triggered_on = o["triggered_on"];
  if (typeof o["instances"] === "number") out.instances = o["instances"];
  if (Array.isArray(o["schedules"])) {
    out.schedules = o["schedules"].map((entry) => {
      if (typeof entry !== "object" || entry === null) {
        throw makeInvalidResponseError("workflow schedule is not an object");
      }
      const s = entry as Record<string, unknown>;
      const cron = s["cron"];
      if (typeof cron !== "string" || cron.length === 0) {
        throw makeInvalidResponseError("workflow schedule missing cron");
      }
      const normalized: WorkflowSchedule = { cron };
      if (typeof s["next_instance"] === "string") normalized.next_instance = s["next_instance"];
      return normalized;
    });
  }
  if (o["script_deleted"] === true) out.script_deleted = true;
  return out;
}

// official Hyperdrive config list returns result[] with id/name/...;
// normalize to the internal HyperdriveConfig model (origin credentials are
// never echoed back by the provider, so they are simply absent here).
export function parseHyperdriveConfigList(env: CloudflareEnvelope<unknown>): HyperdriveConfig[] {
  const result = env.result;
  if (!Array.isArray(result)) {
    throw makeInvalidResponseError("Hyperdrive config list result is not an array");
  }
  return result.map((item) => normalizeHyperdriveConfig(item));
}

function normalizeHyperdriveConfig(item: unknown): HyperdriveConfig {
  if (typeof item !== "object" || item === null) {
    throw makeInvalidResponseError("Hyperdrive config is not an object");
  }
  const o = item as Record<string, unknown>;
  const id = o["id"];
  if (typeof id !== "string") {
    throw makeInvalidResponseError("Hyperdrive config missing id");
  }
  const name = o["name"];
  if (typeof name !== "string") {
    throw makeInvalidResponseError("Hyperdrive config missing name");
  }
  const out: HyperdriveConfig = { id, name };
  if (typeof o["created_on"] === "string") out.created_on = o["created_on"];
  if (typeof o["modified_on"] === "string") out.modified_on = o["modified_on"];
  if (typeof o["caching"] === "object" && o["caching"] !== null) {
    const c = o["caching"] as Record<string, unknown>;
    const caching: HyperdriveConfig["caching"] = {};
    if (typeof c["disabled"] === "boolean") caching.disabled = c["disabled"];
    if (typeof c["max_age"] === "number") caching.max_age = c["max_age"];
    if (typeof c["stale_while_revalidate"] === "number") caching.stale_while_revalidate = c["stale_while_revalidate"];
    out.caching = caching;
  }
  if (typeof o["origin"] === "object" && o["origin"] !== null) {
    const og = o["origin"] as Record<string, unknown>;
    const origin: HyperdriveConfig["origin"] = { database: "" };
    if (typeof og["database"] === "string") origin.database = og["database"];
    if (typeof og["host"] === "string") origin.host = og["host"];
    if (typeof og["port"] === "number") origin.port = og["port"];
    if (og["scheme"] === "postgres" || og["scheme"] === "postgresql" || og["scheme"] === "mysql") {
      origin.scheme = og["scheme"];
    }
    if (typeof og["user"] === "string") origin.user = og["user"];
    out.origin = origin;
  }
  return out;
}

// official Vectorize index list returns result[] with id/name/config/
// description/created_on/modified_on; normalize to the internal VectorizeIndex
// model. config is either {dimensions, metric} or {preset}.
export function parseVectorizeIndexList(env: CloudflareEnvelope<unknown>): VectorizeIndex[] {
  const result = env.result;
  if (!Array.isArray(result)) {
    throw makeInvalidResponseError("Vectorize index list result is not an array");
  }
  return result.map((item) => normalizeVectorizeIndex(item));
}

export function normalizeVectorizeIndex(item: unknown): VectorizeIndex {
  if (typeof item !== "object" || item === null) {
    throw makeInvalidResponseError("Vectorize index is not an object");
  }
  const o = item as Record<string, unknown>;
  // Vectorize v2 officially exposes name/config/created_on, not a UUID.
  // Require an incarnation marker when no legacy id is returned; name alone
  // cannot distinguish deletion/recreation of an approved index.
  const id = typeof o["id"] === "string" && o["id"].length > 0 ? o["id"] :
    typeof o["name"] === "string" && typeof o["created_on"] === "string" && Number.isFinite(Date.parse(o["created_on"])) ? `${o["name"]}@${o["created_on"]}` : undefined;
  const name = o["name"];
  if (typeof id !== "string" || id.length === 0) {
    throw makeInvalidResponseError("Vectorize index incarnation unavailable (id/created_on); name-only identity cannot be verified");
  }
  if (typeof name !== "string" || name.length === 0) {
    throw makeInvalidResponseError("Vectorize index missing name");
  }
  const out: VectorizeIndex = { id, name };
  if (typeof o["description"] === "string") out.description = o["description"];
  if (typeof o["created_on"] === "string") out.created_on = o["created_on"];
  if (typeof o["modified_on"] === "string") out.modified_on = o["modified_on"];
  if (typeof o["config"] === "object" && o["config"] !== null) {
    const cfg = o["config"] as Record<string, unknown>;
    const config: VectorizeIndex["config"] = {};
    if (typeof cfg["dimensions"] === "number") config.dimensions = cfg["dimensions"];
    if (
      cfg["metric"] === "cosine" ||
      cfg["metric"] === "euclidean" ||
      cfg["metric"] === "dot-product"
    ) {
      config.metric = cfg["metric"];
    }
    if (typeof cfg["preset"] === "string") config.preset = cfg["preset"];
    if (Object.keys(config).length > 0) out.config = config;
  }
  return out;
}

// official Secrets Store list returns result[] with id/name/account_id/
// created/modified; normalize to the internal SecretsStore model.
export function parseSecretsStoreList(env: CloudflareEnvelope<unknown>): SecretsStore[] {
  const result = env.result;
  if (!Array.isArray(result)) {
    throw makeInvalidResponseError("Secrets Store list result is not an array");
  }
  return result.map((item) => normalizeSecretsStore(item));
}

function normalizeSecretsStore(item: unknown): SecretsStore {
  if (typeof item !== "object" || item === null) {
    throw makeInvalidResponseError("Secrets Store is not an object");
  }
  const o = item as Record<string, unknown>;
  const id = o["id"];
  const name = o["name"];
  if (typeof id !== "string" || id.length === 0) {
    throw makeInvalidResponseError("Secrets Store missing id");
  }
  if (typeof name !== "string" || name.length === 0) {
    throw makeInvalidResponseError("Secrets Store missing name");
  }
  const out: SecretsStore = { id, name };
  if (typeof o["account_id"] === "string") out.account_id = o["account_id"];
  if (typeof o["created"] === "string") out.created = o["created"];
  if (typeof o["modified"] === "string") out.modified = o["modified"];
  return out;
}

// official Secrets Store secret list returns result[] with id/name/store_id/
// created/modified; the write-only `value` is NEVER present in the read shape.
export function parseSecretsStoreSecretList(env: CloudflareEnvelope<unknown>): SecretsStoreSecret[] {
  const result = env.result;
  if (!Array.isArray(result)) {
    throw makeInvalidResponseError("Secrets Store secret list result is not an array");
  }
  return result.map((item) => normalizeSecretsStoreSecret(item));
}

function normalizeSecretsStoreSecret(item: unknown): SecretsStoreSecret {
  if (typeof item !== "object" || item === null) {
    throw makeInvalidResponseError("Secrets Store secret is not an object");
  }
  const o = item as Record<string, unknown>;
  const id = o["id"];
  const name = o["name"];
  const storeId = o["store_id"];
  if (typeof id !== "string" || id.length === 0) {
    throw makeInvalidResponseError("Secrets Store secret missing id");
  }
  if (typeof name !== "string" || name.length === 0) {
    throw makeInvalidResponseError("Secrets Store secret missing name");
  }
  if (typeof storeId !== "string" || storeId.length === 0) {
    throw makeInvalidResponseError("Secrets Store secret missing store_id");
  }
  return {
    id,
    name,
    store_id: storeId,
    ...(typeof o["created"] === "string" ? { created: o["created"] } : {}),
    ...(typeof o["modified"] === "string" ? { modified: o["modified"] } : {}),
  };
}
