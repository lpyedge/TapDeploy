// Wrangler V3 resource sections: account-resource bindings (R2, D1, KV), queue
// producers/consumers and rate limits. Each function reads the parsed config,
// appends issues in the same order the single-pass parser did, and returns the
// normalized entries. Strict rejections are unchanged: nothing is defaulted.

import type {
  WranglerV3Issue,
  WranglerV3RateLimit,
  WranglerV3R2Bucket,
  WranglerV3D1Database,
  WranglerV3KvNamespace,
  WranglerV3Hyperdrive,
  WranglerV3Vectorize,
  WranglerV3SecretsStoreSecret,
  WranglerV3RuntimeBinding,
  WranglerV3QueueProducer,
  WranglerV3QueueConsumer,
} from "./wrangler-v3-schema.js";
import {
  RATE_LIMIT_PERIODS,
  R2_BUCKET_KEYS,
  R2_BUCKET_REFUSED_KEYS,
  D1_DATABASE_KEYS,
  D1_DATABASE_REFUSED_KEYS,
  KV_NAMESPACE_KEYS,
  KV_NAMESPACE_REFUSED_KEYS,
  HYPERDRIVE_KEYS,
  HYPERDRIVE_REFUSED_KEYS,
  VECTORIZE_KEYS,
  VECTORIZE_REFUSED_KEYS,
  SECRETS_STORE_SECRET_KEYS,
  SECRETS_STORE_SECRET_REFUSED_KEYS,
  RUNTIME_BINDING_KEYS,
  RUNTIME_BINDING_REFUSED_KEYS,
  QUEUES_KEYS,
  QUEUE_PRODUCER_KEYS,
  QUEUE_PRODUCER_REFUSED_KEYS,
  QUEUE_CONSUMER_KEYS,
  QUEUE_CONSUMER_REFUSED_KEYS,
  RATELIMIT_KEYS,
  RATELIMIT_SIMPLE_KEYS,
  isPlainObject,
  isNonEmptyString,
  checkKnownKeys,
  checkResourceEntryKeys,
  checkEntryKeys,
  reportDuplicateTargets,
} from "./wrangler-v3-keys.js";

export function normalizeAccountResourceBindings(
  parsed: Record<string, unknown>,
  issues: WranglerV3Issue[],
): { r2Buckets: WranglerV3R2Bucket[]; d1Databases: WranglerV3D1Database[]; kvNamespaces: WranglerV3KvNamespace[] } {
  // ---- r2_buckets / d1_databases / kv_namespaces (resource projection) --
  // The final Wrangler config is the only resource declaration for a unit. Each
  // entry projects the binding name plus the declared resource handle; declared
  // provider ids stay identity claims (verified later against the live account,
  // never trusted verbatim).
  const r2Buckets: WranglerV3R2Bucket[] = [];
  const rawR2Buckets = parsed["r2_buckets"];
  if (rawR2Buckets !== undefined) {
    if (!Array.isArray(rawR2Buckets)) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "r2_buckets",
        detail: "r2_buckets must be an array",
      });
    } else {
      for (let i = 0; i < rawR2Buckets.length; i++) {
        const item = rawR2Buckets[i];
        const field = `r2_buckets[${i}]`;
        if (!isPlainObject(item)) {
          issues.push({
            code: "INVALID_SHAPE",
            field,
            detail: "r2_buckets entries must be objects",
          });
          continue;
        }
        checkResourceEntryKeys(item, R2_BUCKET_KEYS, R2_BUCKET_REFUSED_KEYS, field, issues);
        const binding = item["binding"];
        const bucketName = item["bucket_name"];
        let valid = true;
        if (!isNonEmptyString(binding)) {
          issues.push({
            code: "INVALID_SHAPE",
            field: `${field}.binding`,
            detail: "r2_buckets binding must be a non-empty string",
          });
          valid = false;
        }
        if (!isNonEmptyString(bucketName)) {
          issues.push({
            code: "INVALID_SHAPE",
            field: `${field}.bucket_name`,
            detail: "r2_buckets bucket_name must be a non-empty string (the only creation handle for a bucket)",
          });
          valid = false;
        }
        if (valid) {
          r2Buckets.push({ binding: binding as string, bucketName: bucketName as string });
        }
      }
    }
  }

  const d1Databases: WranglerV3D1Database[] = [];
  const rawD1Databases = parsed["d1_databases"];
  if (rawD1Databases !== undefined) {
    if (!Array.isArray(rawD1Databases)) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "d1_databases",
        detail: "d1_databases must be an array",
      });
    } else {
      for (let i = 0; i < rawD1Databases.length; i++) {
        const item = rawD1Databases[i];
        const field = `d1_databases[${i}]`;
        if (!isPlainObject(item)) {
          issues.push({
            code: "INVALID_SHAPE",
            field,
            detail: "d1_databases entries must be objects",
          });
          continue;
        }
        checkResourceEntryKeys(item, D1_DATABASE_KEYS, D1_DATABASE_REFUSED_KEYS, field, issues);
        const binding = item["binding"];
        const databaseName = item["database_name"];
        const databaseId = item["database_id"];
        let valid = true;
        if (!isNonEmptyString(binding)) {
          issues.push({
            code: "INVALID_SHAPE",
            field: `${field}.binding`,
            detail: "d1_databases binding must be a non-empty string",
          });
          valid = false;
        }
        if (!isNonEmptyString(databaseName)) {
          issues.push({
            code: "INVALID_SHAPE",
            field: `${field}.database_name`,
            detail: "d1_databases database_name must be a non-empty string (the creation handle for a database)",
          });
          valid = false;
        }
        if (databaseId !== undefined && !isNonEmptyString(databaseId)) {
          issues.push({
            code: "INVALID_SHAPE",
            field: `${field}.database_id`,
            detail: "d1_databases database_id must be a non-empty string when present",
          });
          valid = false;
        }
        if (valid) {
          const entry: WranglerV3D1Database = {
            binding: binding as string,
            databaseName: databaseName as string,
          };
          if (isNonEmptyString(databaseId)) {
            entry.databaseId = databaseId;
          }
          d1Databases.push(entry);
        }
      }
    }
  }

  const kvNamespaces: WranglerV3KvNamespace[] = [];
  const rawKvNamespaces = parsed["kv_namespaces"];
  if (rawKvNamespaces !== undefined) {
    if (!Array.isArray(rawKvNamespaces)) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "kv_namespaces",
        detail: "kv_namespaces must be an array",
      });
    } else {
      for (let i = 0; i < rawKvNamespaces.length; i++) {
        const item = rawKvNamespaces[i];
        const field = `kv_namespaces[${i}]`;
        if (!isPlainObject(item)) {
          issues.push({
            code: "INVALID_SHAPE",
            field,
            detail: "kv_namespaces entries must be objects",
          });
          continue;
        }
        checkResourceEntryKeys(item, KV_NAMESPACE_KEYS, KV_NAMESPACE_REFUSED_KEYS, field, issues);
        const binding = item["binding"];
        const namespaceId = item["id"];
        let valid = true;
        if (!isNonEmptyString(binding)) {
          issues.push({
            code: "INVALID_SHAPE",
            field: `${field}.binding`,
            detail: "kv_namespaces binding must be a non-empty string",
          });
          valid = false;
        }
        if (!isNonEmptyString(namespaceId)) {
          issues.push({
            code: "INVALID_SHAPE",
            field: `${field}.id`,
            detail:
              "kv_namespaces id is required: a KV binding is verified by provider namespace id and is never created from a wrangler binding (the entry carries no title)",
          });
          valid = false;
        }
        if (valid) {
          kvNamespaces.push({ binding: binding as string, namespaceId: namespaceId as string });
        }
      }
    }
  }

  reportDuplicateTargets(r2Buckets, (e) => e.bucketName, "r2_buckets", issues);
  reportDuplicateTargets(d1Databases, (e) => e.databaseName, "d1_databases", issues);
  reportDuplicateTargets(
    d1Databases.filter((e) => e.databaseId !== undefined),
    (e) => (e as WranglerV3D1Database).databaseId as string,
    "d1_databases",
    issues,
  );
  reportDuplicateTargets(kvNamespaces, (e) => e.namespaceId, "kv_namespaces", issues);

  return { r2Buckets, d1Databases, kvNamespaces };
}

export function normalizeQueues(
  parsed: Record<string, unknown>,
  issues: WranglerV3Issue[],
): { queueProducers: WranglerV3QueueProducer[]; queueConsumers: WranglerV3QueueConsumer[] } {
  // ---- queues.producers / queues.consumers ---------------------------------
  // the official Wrangler shape is queues.producers[] + queues.consumers[]
  // (NOT the simplified [{binding, queue}] list). Producers become Worker
  // environment bindings; consumers become consumer-trigger registrations and
  // never produce an environment binding. The old simplified array is refused
  // instead of being reinterpreted as producers.
  const queueProducers: WranglerV3QueueProducer[] = [];
  const queueConsumers: WranglerV3QueueConsumer[] = [];
  const rawQueues = parsed["queues"];
  if (rawQueues !== undefined) {
    if (!isPlainObject(rawQueues)) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "queues",
        detail:
          "queues must be an object with optional producers/consumers arrays (a plain [{binding,queue}] list is not the official shape and is refused)",
      });
    } else {
      checkKnownKeys(rawQueues, QUEUES_KEYS, "queues", issues);
      const rawProducers = rawQueues["producers"];
      if (rawProducers !== undefined) {
        if (!Array.isArray(rawProducers)) {
          issues.push({
            code: "INVALID_SHAPE",
            field: "queues.producers",
            detail: "queues.producers must be an array",
          });
        } else {
          for (let i = 0; i < rawProducers.length; i++) {
            const item = rawProducers[i];
            const field = `queues.producers[${i}]`;
            if (!isPlainObject(item)) {
              issues.push({
                code: "INVALID_SHAPE",
                field,
                detail: "queues.producers entries must be objects",
              });
              continue;
            }
            checkEntryKeys(item, QUEUE_PRODUCER_KEYS, QUEUE_PRODUCER_REFUSED_KEYS, field, issues);
            const binding = item["binding"];
            const queue = item["queue"];
            let valid = true;
            if (!isNonEmptyString(binding)) {
              issues.push({
                code: "INVALID_SHAPE",
                field: `${field}.binding`,
                detail: "queues.producers binding must be a non-empty string",
              });
              valid = false;
            }
            if (!isNonEmptyString(queue)) {
              issues.push({
                code: "INVALID_SHAPE",
                field: `${field}.queue`,
                detail:
                  "queues.producers queue must be a non-empty string naming the queue to bind (the official schema marks it optional, but TapDeploy refuses to guess it)",
              });
              valid = false;
            }
            if (valid) {
              queueProducers.push({ binding: binding as string, queue: queue as string });
            }
          }
        }
      }
      const rawConsumers = rawQueues["consumers"];
      if (rawConsumers !== undefined) {
        if (!Array.isArray(rawConsumers)) {
          issues.push({
            code: "INVALID_SHAPE",
            field: "queues.consumers",
            detail: "queues.consumers must be an array",
          });
        } else {
          for (let i = 0; i < rawConsumers.length; i++) {
            const item = rawConsumers[i];
            const field = `queues.consumers[${i}]`;
            if (!isPlainObject(item)) {
              issues.push({
                code: "INVALID_SHAPE",
                field,
                detail: "queues.consumers entries must be objects",
              });
              continue;
            }
            checkEntryKeys(item, QUEUE_CONSUMER_KEYS, QUEUE_CONSUMER_REFUSED_KEYS, field, issues);
            const queue = item["queue"];
            let valid = true;
            if (!isNonEmptyString(queue)) {
              issues.push({
                code: "INVALID_SHAPE",
                field: `${field}.queue`,
                detail: "queues.consumers queue must be a non-empty string naming the queue to consume",
              });
              valid = false;
            }
            const consumerType = item["type"];
            if (consumerType !== undefined && consumerType !== "worker") {
              issues.push({
                code: "INVALID_SHAPE",
                field: `${field}.type`,
                detail: 'the Wrangler config only supports worker consumers; "type" must be "worker" when present',
              });
              valid = false;
            }
            for (const [key, minimum] of [
              ["max_batch_size", 1],
              ["max_batch_timeout", 0],
              ["max_retries", 0],
              ["retry_delay", 0],
            ] as const) {
              const value = item[key];
              if (value === undefined) {
                continue;
              }
              if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
                issues.push({
                  code: "INVALID_SHAPE",
                  field: `${field}.${key}`,
                  detail: `${key} must be an integer >= ${minimum}`,
                });
                valid = false;
              }
            }
            const rawMaxConcurrency = item["max_concurrency"];
            let maxConcurrency: number | null | undefined;
            if (rawMaxConcurrency === undefined) {
              maxConcurrency = undefined;
            } else if (rawMaxConcurrency === null) {
              maxConcurrency = null;
            } else if (
              typeof rawMaxConcurrency === "number" &&
              Number.isInteger(rawMaxConcurrency) &&
              rawMaxConcurrency >= 1
            ) {
              maxConcurrency = rawMaxConcurrency;
            } else {
              issues.push({
                code: "INVALID_SHAPE",
                field: `${field}.max_concurrency`,
                detail: "max_concurrency must be an integer >= 1 or null (explicitly unlimited)",
              });
              valid = false;
            }
            const deadLetterQueue = item["dead_letter_queue"];
            if (deadLetterQueue !== undefined && !isNonEmptyString(deadLetterQueue)) {
              issues.push({
                code: "INVALID_SHAPE",
                field: `${field}.dead_letter_queue`,
                detail: "dead_letter_queue must be a non-empty string when present",
              });
              valid = false;
            }
            if (valid) {
              const consumer: WranglerV3QueueConsumer = { queue: queue as string, type: "worker" };
              if (typeof item["max_batch_size"] === "number") {
                consumer.max_batch_size = item["max_batch_size"];
              }
              if (typeof item["max_batch_timeout"] === "number") {
                consumer.max_batch_timeout = item["max_batch_timeout"];
              }
              if (typeof item["max_retries"] === "number") {
                consumer.max_retries = item["max_retries"];
              }
              if (maxConcurrency !== undefined) {
                consumer.max_concurrency = maxConcurrency;
              }
              if (typeof item["retry_delay"] === "number") {
                consumer.retry_delay = item["retry_delay"];
              }
              if (isNonEmptyString(deadLetterQueue)) {
                consumer.dead_letter_queue = deadLetterQueue;
              }
              queueConsumers.push(consumer);
            }
          }
        }
      }
    }
  }
  reportDuplicateTargets(queueProducers, (e) => e.queue, "queues.producers", issues);
  // Two consumer declarations for one queue would be an ambiguous trigger
  // configuration; a producer+consumer pair on the same queue stays allowed.
  const consumerQueuesSeen = new Map<string, number>();
  for (let i = 0; i < queueConsumers.length; i++) {
    const queue = queueConsumers[i]!.queue;
    const first = consumerQueuesSeen.get(queue);
    if (first !== undefined) {
      issues.push({
        code: "INVALID_SHAPE",
        field: `queues.consumers[${i}].queue`,
        detail: `queue "${queue}" has multiple consumer declarations (indexes ${first} and ${i}); the trigger configuration is ambiguous`,
      });
    } else {
      consumerQueuesSeen.set(queue, i);
    }
  }

  return { queueProducers, queueConsumers };
}

export function normalizeRateLimits(
  parsed: Record<string, unknown>,
  issues: WranglerV3Issue[],
): WranglerV3RateLimit[] {
  // ---- ratelimits ----------------------------------------------------------
  const ratelimits: WranglerV3RateLimit[] = [];
  const rawRatelimits = parsed["ratelimits"];
  if (rawRatelimits !== undefined) {
    if (!Array.isArray(rawRatelimits)) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "ratelimits",
        detail: "ratelimits must be an array",
      });
    } else {
      for (let i = 0; i < rawRatelimits.length; i++) {
        const item = rawRatelimits[i];
        const field = `ratelimits[${i}]`;
        if (!isPlainObject(item)) {
          issues.push({
            code: "INVALID_SHAPE",
            field,
            detail: "ratelimits entries must be objects",
          });
          continue;
        }
        checkKnownKeys(item, RATELIMIT_KEYS, field, issues);
        const rlName = item["name"];
        const namespaceId = item["namespace_id"];
        const simple = item["simple"];
        let valid = true;
        if (!isNonEmptyString(rlName)) {
          issues.push({
            code: "INVALID_SHAPE",
            field: `${field}.name`,
            detail: "ratelimit name must be a non-empty string",
          });
          valid = false;
        }
        if (!isNonEmptyString(namespaceId)) {
          issues.push({
            code: "INVALID_SHAPE",
            field: `${field}.namespace_id`,
            detail: "ratelimit namespace_id must be a non-empty string",
          });
          valid = false;
        }
        let limit = 0;
        let period = 0;
        if (!isPlainObject(simple)) {
          issues.push({
            code: "INVALID_SHAPE",
            field: `${field}.simple`,
            detail: "ratelimit simple must be an object with limit and period",
          });
          valid = false;
        } else {
          checkKnownKeys(simple, RATELIMIT_SIMPLE_KEYS, `${field}.simple`, issues);
          const rawLimit = simple["limit"];
          const rawPeriod = simple["period"];
          if (
            typeof rawLimit !== "number" ||
            !Number.isInteger(rawLimit) ||
            rawLimit <= 0
          ) {
            issues.push({
              code: "INVALID_SHAPE",
              field: `${field}.simple.limit`,
              detail: "ratelimit limit must be a positive integer",
            });
            valid = false;
          } else {
            limit = rawLimit;
          }
          if (typeof rawPeriod !== "number" || !RATE_LIMIT_PERIODS.has(rawPeriod)) {
            issues.push({
              code: "INVALID_SHAPE",
              field: `${field}.simple.period`,
              detail: "ratelimit period must be one of 10, 60, 600 seconds",
            });
            valid = false;
          } else {
            period = rawPeriod;
          }
        }
        if (valid && isNonEmptyString(rlName) && isNonEmptyString(namespaceId)) {
          ratelimits.push({ name: rlName, namespace_id: namespaceId, limit, period });
        }
      }
    }
  }

  // a declared ratelimit namespace_id is the counters identity. Two
  // entries sharing a namespace_id would share counters (or silently re-point
  // an existing counter set); the duplicate is refused instead of guessed.
  const ratelimitNamespacesSeen = new Map<string, string>();
  for (const ratelimit of ratelimits) {
    const first = ratelimitNamespacesSeen.get(ratelimit.namespace_id);
    if (first !== undefined) {
      issues.push({
        code: "INVALID_SHAPE",
        field: "ratelimits",
        detail: `namespace_id "${ratelimit.namespace_id}" is declared by rate limits "${first}" and "${ratelimit.name}"; counters ownership must stay unique`,
      });
    } else {
      ratelimitNamespacesSeen.set(ratelimit.namespace_id, ratelimit.name);
    }
  }

  return ratelimits;
}

// ---- hyperdrive / vectorize / secrets_store_secrets / ai / browser ----------
// Official Wrangler shapes: arrays of `{binding, id}` / `{binding, index_name}`
// / `{binding, store_id, secret_name}`, and single `{binding}` objects for
// Workers AI and Browser Rendering. Every handle must be explicit; nothing is
// defaulted.
export function normalizePlatformBindings(
  parsed: Record<string, unknown>,
  issues: WranglerV3Issue[],
): { hyperdrive: WranglerV3Hyperdrive[]; vectorize: WranglerV3Vectorize[]; secretsStoreSecrets: WranglerV3SecretsStoreSecret[]; ai?: WranglerV3RuntimeBinding; browser?: WranglerV3RuntimeBinding } {
  const list = <T>(key: string, allowed: ReadonlySet<string>, refused: ReadonlySet<string>, handles: Record<string, string>, build: (values: Record<string, string>) => T): T[] => {
    const raw = parsed[key];
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      issues.push({ code: "INVALID_SHAPE", field: key, detail: `${key} must be an array` });
      return [];
    }
    const out: T[] = [];
    raw.forEach((item, i) => {
      const field = `${key}[${i}]`;
      if (!isPlainObject(item)) {
        issues.push({ code: "INVALID_SHAPE", field, detail: `${key} entries must be objects` });
        return;
      }
      checkResourceEntryKeys(item, allowed, refused, field, issues);
      const values: Record<string, string> = {};
      let valid = true;
      for (const [wranglerKey, label] of Object.entries(handles)) {
        const value = item[wranglerKey];
        if (!isNonEmptyString(value)) {
          issues.push({ code: "INVALID_SHAPE", field: `${field}.${wranglerKey}`, detail: `${key} ${wranglerKey} must be a non-empty string (${label})` });
          valid = false;
        } else {
          values[wranglerKey] = value;
        }
      }
      if (valid) out.push(build(values));
    });
    return out;
  };
  const single = (key: "ai" | "browser"): WranglerV3RuntimeBinding | undefined => {
    const raw = parsed[key];
    if (raw === undefined) return undefined;
    if (!isPlainObject(raw)) {
      issues.push({ code: "INVALID_SHAPE", field: key, detail: `${key} must be an object with a binding` });
      return undefined;
    }
    checkResourceEntryKeys(raw, RUNTIME_BINDING_KEYS, RUNTIME_BINDING_REFUSED_KEYS, key, issues);
    if (!isNonEmptyString(raw["binding"])) {
      issues.push({ code: "INVALID_SHAPE", field: `${key}.binding`, detail: `${key} binding must be a non-empty string` });
      return undefined;
    }
    return { binding: raw["binding"] };
  };
  const hyperdrive = list("hyperdrive", HYPERDRIVE_KEYS, HYPERDRIVE_REFUSED_KEYS, { binding: "the Worker binding name", id: "the Hyperdrive configuration id" }, (v) => ({ binding: v["binding"]!, id: v["id"]! }));
  const vectorize = list("vectorize", VECTORIZE_KEYS, VECTORIZE_REFUSED_KEYS, { binding: "the Worker binding name", index_name: "the index name" }, (v) => ({ binding: v["binding"]!, indexName: v["index_name"]! }));
  const secretsStoreSecrets = list("secrets_store_secrets", SECRETS_STORE_SECRET_KEYS, SECRETS_STORE_SECRET_REFUSED_KEYS, { binding: "the Worker binding name", store_id: "the Secrets Store id", secret_name: "the secret name in the store" }, (v) => ({ binding: v["binding"]!, storeId: v["store_id"]!, secretName: v["secret_name"]! }));
  reportDuplicateTargets(hyperdrive, (e) => e.id, "hyperdrive", issues);
  reportDuplicateTargets(vectorize, (e) => e.indexName, "vectorize", issues);
  reportDuplicateTargets(secretsStoreSecrets, (e) => `${e.storeId}/${e.secretName}`, "secrets_store_secrets", issues);
  const ai = single("ai");
  const browser = single("browser");
  return { hyperdrive, vectorize, secretsStoreSecrets, ...(ai ? { ai } : {}), ...(browser ? { browser } : {}) };
}
