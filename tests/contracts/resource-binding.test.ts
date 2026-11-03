import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import {
  bucketActionFor,
  databaseActionFor,
  namespaceActionFor,
  queueActionFor,
  vectorizeActionFor,
} from "../../src/cloudflare/resources/index.js";
import { ROUTES } from "../../src/cloudflare/client/routes.js";
import {
  planBucketActions,
  createR2Buckets,
  planDatabaseActions,
  createD1Databases,
  planNamespaceActions,
  createKvNamespaces,
  planQueueActions,
  createQueues,
  registerQueueConsumers,
  planVectorizeIndexActions,
  createVectorizeIndexes,
  reconcileRateLimits,
} from "../../src/core/deploy/bindings.js";
import {
  applySecrets,
  prepareSecretBindings,
  checkSecretInheritance,
  resolveSecretActions,
} from "../../src/core/deploy/secrets.js";
import {
  dnsRecordActionFor,
  dnsCollisionReason,
} from "../../src/cloudflare/resources/dns.js";
import { workerRouteActionFor } from "../../src/cloudflare/resources/routes.js";
import type { DeploySpec, DomainEntrySpec } from "../../src/core/deploy-spec.js";
import type { TargetSnapshot } from "../../src/core/planning/types.js";
import type { DeployStepContext } from "../../src/core/deploy/steps.js";
const ACCOUNT = "b".repeat(32);
const SCRIPT_NAME = "tapdeploy-tmp-resources";
const BUCKET_NAME = "tapdeploy-tmp-bucket";
const WORKER_CONTENT = "export default { async fetch() { return new Response('ok'); } }";
const WORKER_SHA = createHash("sha256").update(WORKER_CONTENT).digest("hex");
const WORKER_SIZE = Buffer.byteLength(WORKER_CONTENT);

function makeContext(overrides: Partial<DeployStepContext> = {}): DeployStepContext {
  const spec = {
    schemaVersion: 1,
    project: { id: "fixture/resources", version: "0.2.0" },
    worker: { path: "worker/main.mjs", size: WORKER_SIZE, sha256: WORKER_SHA },
    assets: [],
    inputs: {},
    cloudflare: {
      workerName: SCRIPT_NAME,
      r2: [{ binding: "BUCKET", bucketName: BUCKET_NAME, createIfMissing: true }],
      d1: [],
      kv: [],
      queues: [],
      hyperdrive: [],
      vectorize: [],
      secretsStore: [],
      runtimeBindings: [],
      cron: ["*/5 * * * *"],
      secrets: { API_TOKEN: "generate-once" },
    },
    wrangler: {
      name: SCRIPT_NAME,
      main: "./worker/main.mjs",
      compatibility_date: "2026-10-10",
      r2_buckets: [{ binding: "BUCKET", bucket_name: BUCKET_NAME }],
      crons: ["*/5 * * * *"],
    },
    targetKind: "workers",
  } satisfies DeploySpec;
  const snapshot: TargetSnapshot = {
    accountId: ACCOUNT,
    workerName: SCRIPT_NAME,
    workerExists: false,
    versions: [],
    activeDeploymentVersionIds: [],
    r2Buckets: [],
    d1Databases: [],
    kvNamespaces: [],
    queues: [],
    hyperdriveConfigs: [],
    vectorizeIndexes: [],
    secretsStores: [],
    secretsStoreSecrets: [],
    secretNames: [],
    scheduleCrons: [],
    rateLimitCount: 0,
  };
  return {
    client: {} as DeployStepContext["client"],
    accountId: ACCOUNT,
    workerName: SCRIPT_NAME,
    spec,
    snapshot,
    accessToken: "tok",
    ...overrides,
  };
}

describe("the Cloudflare route table never deletes a stored resource", () => {

  it("has no R2 object content route and no DELETE route except the declared domain/route/DNS removes", () => {
    // DELETE is only allowed on the zone-scoped DNS record / route / custom
    // domain remove routes; a Worker/R2/D1/KV resource is never deletable.
    // the only object-path route is the existence probe (r2ObjectExists, a
    // GET whose body is cancelled unread); no PUT/POST/DELETE ever addresses
    // an object key.
    const removable = new Set([
      "deleteDnsRecord",
      "deleteWorkerRoute",
      "detachWorkerDomain",
      "deletePagesDomain",
    ]);
    for (const route of Object.values(ROUTES)) {
      if (route.method === "DELETE") {
        expect(removable.has(route.id)).toBe(true);
      }
      const path = route.path({ accountId: ACCOUNT, bucketName: "b", scriptName: "s" });
      if (path.includes("/objects")) {
        expect(route.id).toBe("r2ObjectExists");
        expect(route.method).toBe("GET");
      }
    }
  });
});

describe("R2 bucket actions", () => {
  it("preserves an existing bucket by identity", () => {
    const action = bucketActionFor(
      { binding: "BUCKET", bucketName: BUCKET_NAME, createIfMissing: true },
      [{ name: BUCKET_NAME, id: "bucket-1" }],
    );
    expect(action).toMatchObject({ action: "preserve", id: "bucket-1" });
  });

  it("creates only when the bucket is missing and createIfMissing is set", () => {
    expect(
      bucketActionFor(
        { binding: "BUCKET", bucketName: BUCKET_NAME, createIfMissing: true },
        [],
      ),
    ).toMatchObject({ action: "create" });
  });

  it("fails closed when the bucket is missing and createIfMissing is false", () => {
    expect(
      bucketActionFor(
        { binding: "BUCKET", bucketName: BUCKET_NAME, createIfMissing: false },
        [],
      ),
    ).toMatchObject({ action: "conflict" });
  });

  it("plans every declared binding against the live bucket list", () => {
    const ctx = makeContext();
    expect(planBucketActions(ctx.spec, ctx.snapshot)).toEqual([
      { binding: "BUCKET", bucketName: BUCKET_NAME, action: "create" },
    ]);
  });

  it("no-ops when no R2 binding is declared", async () => {
    const ctx = makeContext();
    ctx.spec.cloudflare.r2 = [];
    const outcome = await createR2Buckets(ctx, {});
    expect(outcome).toEqual({ ok: true, result: { skipped: true, buckets: [] } });
  });

  it("refuses to create anything when a declared binding conflicts", async () => {
    const ctx = makeContext();
    ctx.spec.cloudflare.r2 = [
      { binding: "BUCKET", bucketName: BUCKET_NAME, createIfMissing: false },
    ];
    const createR2Bucket = vi.fn();
    ctx.client = { createR2Bucket } as unknown as DeployStepContext["client"];
    const outcome = await createR2Buckets(ctx, {});
    expect(outcome).toMatchObject({ ok: false, error: { kind: "conflict" } });
    expect(createR2Bucket).not.toHaveBeenCalled();
  });
});

describe("D1 + KV resource actions", () => {
  it("preserves an existing D1 database by identity", () => {
    const action = databaseActionFor(
      { binding: "DB", databaseName: "my-db", createIfMissing: true },
      [{ name: "my-db", id: "db-1" }],
    );
    expect(action).toMatchObject({ action: "preserve", id: "db-1" });
  });

  it("creates a D1 database only when missing and createIfMissing is set", () => {
    expect(
      databaseActionFor({ binding: "DB", databaseName: "my-db", createIfMissing: true }, []),
    ).toMatchObject({ action: "create" });
  });

  it("fails closed when a D1 database is missing and createIfMissing is false", () => {
    expect(
      databaseActionFor(
        { binding: "DB", databaseName: "my-db", createIfMissing: false },
        [],
      ),
    ).toMatchObject({ action: "conflict" });
  });

  it("preserves an existing KV namespace by identity", () => {
    const action = namespaceActionFor(
      { binding: "KV", namespaceName: "my-ns", createIfMissing: true },
      [{ name: "my-ns", id: "ns-1" }],
    );
    expect(action).toMatchObject({ action: "preserve", id: "ns-1" });
  });

  it("creates a KV namespace only when missing and createIfMissing is set", () => {
    expect(
      namespaceActionFor({ binding: "KV", namespaceName: "my-ns", createIfMissing: true }, []),
    ).toMatchObject({ action: "create" });
  });

  it("fails closed when a KV namespace is missing and createIfMissing is false", () => {
    expect(
      namespaceActionFor(
        { binding: "KV", namespaceName: "my-ns", createIfMissing: false },
        [],
      ),
    ).toMatchObject({ action: "conflict" });
  });

  it("D1 step no-ops when no binding is declared", async () => {
    const ctx = makeContext();
    ctx.spec.cloudflare.d1 = [];
    const outcome = await createD1Databases(ctx, {});
    expect(outcome).toEqual({ ok: true, result: { skipped: true, databases: [] } });
  });

  it("KV step no-ops when no binding is declared", async () => {
    const ctx = makeContext();
    ctx.spec.cloudflare.kv = [];
    const outcome = await createKvNamespaces(ctx, {});
    expect(outcome).toEqual({ ok: true, result: { skipped: true, namespaces: [] } });
  });

  it("plans declared D1 + KV bindings against their live lists", () => {
    const ctx = makeContext();
    ctx.spec.cloudflare.d1 = [{ binding: "DB", databaseName: "my-db", createIfMissing: true }];
    ctx.spec.cloudflare.kv = [{ binding: "KV", namespaceName: "my-ns", createIfMissing: true }];
    expect(planDatabaseActions(ctx.spec, ctx.snapshot)).toMatchObject([
      { binding: "DB", databaseName: "my-db", action: "create" },
    ]);
    expect(planNamespaceActions(ctx.spec, ctx.snapshot)).toMatchObject([
      { binding: "KV", namespaceName: "my-ns", action: "create" },
    ]);
  });
});

describe("Queue resource actions", () => {
  it("preserves an existing Queue by identity", () => {
    const action = queueActionFor(
      { binding: "Q", queueName: "my-queue", createIfMissing: true },
      [{ name: "my-queue", id: "queue-id-1" }],
    );
    expect(action).toEqual({ binding: "Q", queueName: "my-queue", action: "preserve", id: "queue-id-1" });
  });

  it("creates a Queue only when missing and createIfMissing is set", () => {
    const action = queueActionFor(
      { binding: "Q", queueName: "my-queue", createIfMissing: true },
      [],
    );
    expect(action).toEqual({ binding: "Q", queueName: "my-queue", action: "create" });
  });

  it("fails closed when a Queue is missing and createIfMissing is false", () => {
    const action = queueActionFor(
      { binding: "Q", queueName: "my-queue", createIfMissing: false },
      [],
    );
    expect(action.action).toBe("conflict");
  });

  it("Queue step no-ops when no binding is declared", async () => {
    const ctx = makeContext();
    const outcome = await createQueues(ctx, {});
    expect(outcome).toEqual({ ok: true, result: { skipped: true, queues: [] } });
  });

  it("plans declared Queue bindings against their live list", () => {
    const ctx = makeContext();
    ctx.spec.cloudflare.queues = [
      { binding: "Q", queueName: "my-queue", createIfMissing: true, role: "producer" },
    ];
    expect(planQueueActions(ctx.spec, ctx.snapshot)).toMatchObject([
      { binding: "Q", queueName: "my-queue", action: "create" },
    ]);
  });

  it("consumer-role queue step registers a consumer trigger via the queue consumers endpoint", async () => {
    const ctx = makeContext();
    ctx.spec.cloudflare.queues = [
      { binding: "CQ", queueName: "my-queue", createIfMissing: true, role: "consumer" },
    ];
    // a consumer is only registered against a Worker that exists and is
    // actually serving the active deployment (activate has run).
    ctx.snapshot.workerExists = true;
    ctx.snapshot.activeDeploymentVersionIds = ["version-1"];
    ctx.snapshot.queues = [{ name: "my-queue", id: "queue-id-1" }];
    ctx.client.listQueueConsumers = vi.fn().mockResolvedValue([]);
    ctx.client.createQueueConsumer = vi.fn().mockResolvedValue({
      consumer_id: "consumer-id-1",
      script_name: SCRIPT_NAME,
    });
    const outcome = await registerQueueConsumers(ctx, {});
    expect(outcome.ok).toBe(true);
    expect(ctx.client.createQueueConsumer).toHaveBeenCalledWith(
      "queue-id-1",
      { script_name: SCRIPT_NAME },
    );
  });

  it("both-role queue is bound to the Worker and also registered as its consumer", async () => {
    const ctx = makeContext();
    ctx.spec.cloudflare.queues = [{ binding: "JOBS", queueName: "my-queue", createIfMissing: true, role: "both" }];
    ctx.snapshot.workerExists = true;
    ctx.snapshot.activeDeploymentVersionIds = ["version-1"];
    ctx.snapshot.queues = [{ name: "my-queue", id: "queue-id-1" }];
    ctx.client.listQueueConsumers = vi.fn().mockResolvedValue([]);
    ctx.client.createQueueConsumer = vi.fn().mockResolvedValue({ consumer_id: "consumer-id-1", script_name: SCRIPT_NAME });
    expect((await registerQueueConsumers(ctx, {})).ok).toBe(true);
    expect(ctx.client.createQueueConsumer).toHaveBeenCalledWith("queue-id-1", { script_name: SCRIPT_NAME });
    expect(planQueueActions(ctx.spec, ctx.snapshot)).toMatchObject([{ binding: "JOBS", queueName: "my-queue", action: "preserve" }]);
  });

  it("consumer-role queue step fails when the declared queue is not present", async () => {
    const ctx = makeContext();
    ctx.spec.cloudflare.queues = [
      { binding: "CQ", queueName: "missing-queue", createIfMissing: true, role: "consumer" },
    ];
    ctx.snapshot.workerExists = true;
    ctx.snapshot.activeDeploymentVersionIds = ["version-1"];
    ctx.snapshot.queues = [];
    const outcome = await registerQueueConsumers(ctx, {});
    expect(outcome.ok).toBe(false);
  });

  // a consumer trigger designates the script the queue delivers to, so
  // registering it against a missing Worker or a Worker with no active
  // deployment would silently start draining to the wrong target. Both must
  // fail closed before any queue write.
  it("consumer registration fails closed when the Worker is missing", async () => {
    const ctx = makeContext();
    ctx.spec.cloudflare.queues = [
      { binding: "CQ", queueName: "my-queue", createIfMissing: true, role: "consumer" },
    ];
    ctx.snapshot.workerExists = false;
    ctx.snapshot.activeDeploymentVersionIds = ["version-1"];
    ctx.snapshot.queues = [{ name: "my-queue", id: "queue-id-1" }];
    ctx.client.createQueueConsumer = vi.fn();
    const outcome = await registerQueueConsumers(ctx, {});
    expect(outcome).toMatchObject({ ok: false, error: { kind: "worker-missing" } });
    expect(ctx.client.createQueueConsumer).not.toHaveBeenCalled();
  });

  it("consumer registration fails closed when no deployment is active", async () => {
    const ctx = makeContext();
    ctx.spec.cloudflare.queues = [
      { binding: "CQ", queueName: "my-queue", createIfMissing: true, role: "consumer" },
    ];
    ctx.snapshot.workerExists = true;
    ctx.snapshot.activeDeploymentVersionIds = [];
    ctx.snapshot.queues = [{ name: "my-queue", id: "queue-id-1" }];
    ctx.client.createQueueConsumer = vi.fn();
    const outcome = await registerQueueConsumers(ctx, {});
    expect(outcome).toMatchObject({ ok: false, error: { kind: "worker-missing" } });
    expect(ctx.client.createQueueConsumer).not.toHaveBeenCalled();
  });

  it("creates missing Queue bindings via the provider and preserves existing ones", async () => {
    const ctx = makeContext();
    ctx.spec.cloudflare.queues = [
      { binding: "NEW", queueName: "new-queue", createIfMissing: true, role: "producer" },
      { binding: "OLD", queueName: "my-queue", createIfMissing: true, role: "producer" },
    ];
    ctx.snapshot.queues = [{ name: "my-queue", id: "queue-id-1" }];
    ctx.client.createQueue = vi.fn().mockResolvedValue({
      id: "new-queue-id",
      name: "new-queue",
      queue_id: "new-queue-id",
      queue_name: "new-queue",
    });
    const outcome = await createQueues(ctx, {});
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const result = outcome.result as { queues: unknown[] };
      expect(result.queues).toEqual([
        { binding: "NEW", queueName: "new-queue", action: "create", id: "new-queue-id" },
        { binding: "OLD", queueName: "my-queue", action: "preserve", id: "queue-id-1" },
      ]);
    }
    expect(ctx.client.createQueue).toHaveBeenCalledWith({ queue_name: "new-queue" });
  });
});

describe("Vectorize resource actions", () => {
  it("preserves an existing Vectorize index by identity", () => {
    const action = vectorizeActionFor(
      { binding: "VZ", indexName: "my-index", createIfMissing: true },
      [{ name: "my-index", id: "vz-id-1" }],
    );
    expect(action).toEqual({ binding: "VZ", indexName: "my-index", action: "preserve", id: "vz-id-1" });
  });

  it("creates a Vectorize index only when missing and createIfMissing is set", () => {
    const action = vectorizeActionFor(
      { binding: "VZ", indexName: "my-index", createIfMissing: true },
      [],
    );
    expect(action).toEqual({ binding: "VZ", indexName: "my-index", action: "create" });
  });

  it("fails closed when a Vectorize index is missing and createIfMissing is false", () => {
    const action = vectorizeActionFor(
      { binding: "VZ", indexName: "my-index", createIfMissing: false },
      [],
    );
    expect(action.action).toBe("conflict");
  });

  it("Vectorize step no-ops when no binding is declared", async () => {
    const ctx = makeContext();
    const outcome = await createVectorizeIndexes(ctx, {});
    expect(outcome).toEqual({ ok: true, result: { skipped: true, indexes: [] } });
  });

  it("plans declared Vectorize bindings against their live list", () => {
    const ctx = makeContext();
    ctx.spec.cloudflare.vectorize = [
      { binding: "VZ", indexName: "my-index", createIfMissing: true },
    ];
    expect(planVectorizeIndexActions(ctx.spec, ctx.snapshot)).toMatchObject([
      { binding: "VZ", indexName: "my-index", action: "create" },
    ]);
  });

  it("creates missing Vectorize indexes via the provider, preserving existing ones", async () => {
    const ctx = makeContext();
    ctx.spec.cloudflare.vectorize = [
      { binding: "NEW", indexName: "new-index", createIfMissing: true, config: { dimensions: 768, metric: "cosine" } },
      { binding: "OLD", indexName: "my-index", createIfMissing: true },
    ];
    ctx.snapshot.vectorizeIndexes = [{ name: "my-index", id: "vz-id-1" }];
    ctx.client.createVectorizeIndex = vi.fn().mockResolvedValue({
      id: "new-vz-id",
      name: "new-index",
      config: { dimensions: 768, metric: "cosine" },
    });
    const outcome = await createVectorizeIndexes(ctx, {});
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const result = outcome.result as { indexes: unknown[] };
      expect(result.indexes).toEqual([
        { binding: "NEW", indexName: "new-index", action: "create", id: "new-vz-id" },
        { binding: "OLD", indexName: "my-index", action: "preserve", id: "vz-id-1" },
      ]);
    }
    expect(ctx.client.createVectorizeIndex).toHaveBeenCalledWith(
      expect.objectContaining({ name: "new-index", config: { dimensions: 768, metric: "cosine" } }),
    );
  });

  it("never creates a Vectorize index without explicit dimensions and metric", async () => {
    const ctx = makeContext();
    ctx.spec.cloudflare.vectorize = [{ binding: "NEW", indexName: "new-index", createIfMissing: true }];
    ctx.snapshot.vectorizeIndexes = [];
    ctx.client.createVectorizeIndex = vi.fn();
    const outcome = await createVectorizeIndexes(ctx, {});
    expect(outcome.ok).toBe(false);
    expect(ctx.client.createVectorizeIndex).not.toHaveBeenCalled();
  });
});

describe("rate-limit metadata from settings bindings", () => {

  it("preserves existing rate limits from the documented settings route without writing", async () => {
    const ctx = makeContext();
    ctx.snapshot.rateLimitCount = 1;
    const getWorkerSettings = vi.fn(async () => ({
      bindings: [{ name: "rl", type: "ratelimit" }],
      compatibility_date: "2026-10-10",
    }));
    ctx.client = { getWorkerSettings } as unknown as DeployStepContext["client"];
    const outcome = await reconcileRateLimits(ctx, {});
    expect(outcome).toMatchObject({ ok: true });
    expect((outcome as { result: { preserved: unknown[] } }).result.preserved).toHaveLength(1);
    expect(getWorkerSettings).toHaveBeenCalledTimes(1);
  });

  it("treats a missing script or missing scope as absent (install), not an error", async () => {
    const ctx = makeContext();
    for (const kind of ["not-found", "forbidden", "unauthorized"]) {
      const getWorkerSettings = vi.fn(async () => {
        const e = new Error("boom") as Error & { kind: string };
        e.kind = kind;
        throw e;
      });
      ctx.client = { getWorkerSettings } as unknown as DeployStepContext["client"];
      const outcome = await reconcileRateLimits(ctx, {});
      expect(outcome).toMatchObject({ ok: true });
      expect((outcome as { result: { preserved: unknown[] } }).result.preserved).toHaveLength(0);
    }
  });

  it("fails closed if a manifest ever declares rate limits (v1 unsupported)", async () => {
    const ctx = makeContext();
    const getWorkerSettings = vi.fn();
    ctx.client = { getWorkerSettings } as unknown as DeployStepContext["client"];
    const outcome = await reconcileRateLimits(ctx, { rateLimits: [{ name: "rl" }] });
    expect(outcome).toMatchObject({ ok: false, error: { kind: "unsupported-resource" } });
    expect(getWorkerSettings).not.toHaveBeenCalled();
  });
});

describe("secret resolution and inheritance", () => {
  function spec(secrets: DeploySpec["cloudflare"]["secrets"]): DeploySpec {
    const ctx = makeContext();
    ctx.spec.cloudflare.secrets = secrets;
    return ctx.spec;
  }
  function snapshot(secretNames: string[]): TargetSnapshot {
    const ctx = makeContext();
    ctx.snapshot.secretNames = secretNames;
    return ctx.snapshot;
  }

  it("creates a declared secret on install when a value is supplied", () => {
    expect(resolveSecretActions(spec({ API_TOKEN: "generate-once" }), snapshot([]), { API_TOKEN: "v" })).toEqual([
      { name: "API_TOKEN", policy: "generate-once", action: "create", reason: "install-create" },
    ]);
  });

  it("generate-once creates without a browser value (server-generated)", () => {
    expect(resolveSecretActions(spec({ API_TOKEN: "generate-once" }), snapshot([]), {})).toEqual([
      { name: "API_TOKEN", policy: "generate-once", action: "create", reason: "install-create" },
    ]);
  });

  it("fails when a required secret has no supplied value", () => {
    expect(resolveSecretActions(spec({ API_TOKEN: "prompt-on-install" }), snapshot([]), {})).toEqual([
      { name: "API_TOKEN", policy: "prompt-on-install", action: "fail", reason: "missing-value" },
    ]);
  });

  it("fails a preserve-only secret that does not exist", () => {
    expect(resolveSecretActions(spec({ API_TOKEN: "preserve-only" }), snapshot([]), { API_TOKEN: "v" })).toEqual([
      { name: "API_TOKEN", policy: "preserve-only", action: "fail", reason: "preserve-only-absent" },
    ]);
  });

  it("preserves an existing secret and never overwrites it", () => {
    expect(
      resolveSecretActions(spec({ API_TOKEN: "generate-once" }), snapshot(["API_TOKEN"]), {
        API_TOKEN: "new",
      }),
    ).toEqual([
      { name: "API_TOKEN", policy: "generate-once", action: "preserve", reason: "exists-preserve" },
    ]);
  });

  it("rejects inheriting a secret from a not-currently-deployed version", () => {
    expect(
      checkSecretInheritance({
        deployedVersionId: "version-1",
        latestVersionId: "version-2",
        inheritedFromVersionId: "version-2",
      }),
    ).toMatchObject({ ok: false, reason: "inherit-source-not-deployed" });
  });

  it("accepts inheriting from the deployed version and the no-inherit case", () => {
    expect(
      checkSecretInheritance({
        deployedVersionId: "version-1",
        latestVersionId: "version-2",
        inheritedFromVersionId: "version-1",
      }),
    ).toEqual({ ok: true });
    expect(checkSecretInheritance({})).toEqual({ ok: true });
  });

  it("does not write an existing secret even when a value is supplied", async () => {
    const ctx = makeContext();
    ctx.snapshot.secretNames = ["API_TOKEN"];
    const updateSecret = vi.fn();
    ctx.client = { updateSecret } as unknown as DeployStepContext["client"];
    const outcome = await applySecrets(ctx, { secrets: { API_TOKEN: "new" } });
    expect(outcome).toMatchObject({ ok: true });
    expect(updateSecret).not.toHaveBeenCalled();
  });

  it("fails with missing-secret and writes nothing when a prompt value is absent", async () => {
    const ctx = makeContext();
    // prompt-on-install requires a browser value; generate-once does not.
    ctx.spec.cloudflare.secrets = { API_TOKEN: "prompt-on-install" };
    const updateSecret = vi.fn();
    ctx.client = { updateSecret } as unknown as DeployStepContext["client"];
    const outcome = await applySecrets(ctx, { secrets: {} });
    expect(outcome).toMatchObject({ ok: false, error: { kind: "missing-secret" } });
    expect(updateSecret).not.toHaveBeenCalled();
  });

  it("generate-once generates server-side without a browser value", async () => {
    const ctx = makeContext();
    ctx.spec.cloudflare.secrets = { API_TOKEN: "generate-once" };
    // the worker-missing guard requires the script to exist before any
    // create is written (a first install runs create-worker first).
    ctx.snapshot.workerExists = true;
    const updateSecret = vi.fn();
    ctx.client = { updateSecret } as unknown as DeployStepContext["client"];
    const prepared = prepareSecretBindings(ctx, {});
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error("secret preparation failed");
    expect(String(prepared.bindings[0]!.text).length).toBeGreaterThan(16);
    // Only private upload metadata receives the generated value; the legacy
    // route is disabled instead of creating another provider version.
    const outcome = await applySecrets(ctx, { secrets: {} });
    expect(outcome).toMatchObject({ ok: false, error: { kind: "missing-secret" } });
    expect(updateSecret).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome)).not.toContain(String(prepared.bindings[0]!.text));
  });

  it("generate-once ignores a supplied browser value (server-generated)", async () => {
    const ctx = makeContext();
    ctx.spec.cloudflare.secrets = { API_TOKEN: "generate-once" };
    // the worker-missing guard requires the script to exist first.
    ctx.snapshot.workerExists = true;
    const updateSecret = vi.fn();
    ctx.client = { updateSecret } as unknown as DeployStepContext["client"];
    const prepared = prepareSecretBindings(ctx, { API_TOKEN: "browser-supplied" });
    if (!prepared.ok) throw new Error("secret preparation failed");
    const used = String(prepared.bindings[0]!.text);
    const outcome = await applySecrets(ctx, { secrets: { API_TOKEN: "browser-supplied" } });
    expect(outcome).toMatchObject({ ok: false, error: { kind: "missing-secret" } });
    expect(updateSecret).not.toHaveBeenCalled();
    expect(used).not.toBe("browser-supplied");
    expect(used.length).toBeGreaterThan(16);
    expect(JSON.stringify(outcome)).not.toContain(used);
    expect(JSON.stringify(outcome)).not.toContain("browser-supplied");
  });

  // a first install never writes a secret against a script that does not
  // exist (the install order runs create-worker first), so a direct/retried
  // apply-secrets call against a never-created Worker must fail closed before
  // any write.
  it("fails closed on worker-missing before writing any create", async () => {
    const ctx = makeContext();
    ctx.spec.cloudflare.secrets = { API_TOKEN: "generate-once" };
    ctx.snapshot.workerExists = false;
    const updateSecret = vi.fn();
    ctx.client = { updateSecret } as unknown as DeployStepContext["client"];
    const outcome = await applySecrets(ctx, { secrets: {} });
    expect(outcome).toMatchObject({ ok: false, error: { kind: "worker-missing" } });
    expect(updateSecret).not.toHaveBeenCalled();
  });

  it("a missing browser value fails as missing-secret before the worker-missing check", async () => {
    const ctx = makeContext();
    ctx.spec.cloudflare.secrets = { API_TOKEN: "prompt-on-install" };
    ctx.snapshot.workerExists = false;
    const updateSecret = vi.fn();
    ctx.client = { updateSecret } as unknown as DeployStepContext["client"];
    const outcome = await applySecrets(ctx, { secrets: {} });
    expect(outcome).toMatchObject({ ok: false, error: { kind: "missing-secret" } });
    expect(updateSecret).not.toHaveBeenCalled();
  });

  it("preserve-only resolutions stay write-free without a worker-missing failure", async () => {
    const ctx = makeContext();
    ctx.spec.cloudflare.secrets = { API_TOKEN: "generate-once" };
    ctx.snapshot.secretNames = ["API_TOKEN"];
    ctx.snapshot.workerExists = false;
    const updateSecret = vi.fn();
    ctx.client = { updateSecret } as unknown as DeployStepContext["client"];
    const outcome = await applySecrets(ctx, { secrets: {} });
    expect(outcome).toMatchObject({
      ok: true,
      result: { secrets: [{ name: "API_TOKEN", action: "preserve" }] },
    });
    expect(updateSecret).not.toHaveBeenCalled();
  });

  it("refuses an inherit source that is not the deployed version before writing", async () => {
    const ctx = makeContext();
    ctx.snapshot.activeDeploymentVersionIds = ["version-1"];
    ctx.snapshot.latestVersionId = "version-2";
    const updateSecret = vi.fn();
    ctx.client = { updateSecret } as unknown as DeployStepContext["client"];
    const outcome = await applySecrets(ctx, {
      secrets: { API_TOKEN: "v" },
      inheritFromVersionId: "version-2",
    });
    expect(outcome).toMatchObject({ ok: false, error: { kind: "inherit-source-unavailable" } });
    expect(updateSecret).not.toHaveBeenCalled();
  });
});

describe("domain/route/DNS action planning", () => {
  const entry: DomainEntrySpec = {
    kind: "dns-record",
    hostname: "www.example.com",
    recordType: "A",
    recordContent: "192.0.2.1",
  };

  it("never mutates when the release declares no domain intent", () => {
    const diff = dnsRecordActionFor(entry, []);
    expect(diff).toMatchObject({ action: "create", hostname: "www.example.com" });
  });

  it("blocks A/AAAA vs CNAME collision at the same name", () => {
    const reason = dnsCollisionReason("www.example.com", "A", [
      { id: "r1", name: "www.example.com", type: "CNAME", content: "target.example.com" },
    ]);
    expect(reason).toMatch(/cannot coexist with a CNAME/i);
  });

  it("blocks NS coexistence with any other record at the same name", () => {
    const reason = dnsCollisionReason("example.com", "NS", [
      { id: "r1", name: "example.com", type: "A", content: "192.0.2.1" },
    ]);
    expect(reason).toMatch(/NS record.*cannot coexist/i);
  });

  it("preserves an existing same-name same-type record by identity", () => {
    const diff = dnsRecordActionFor(entry, [
      { id: "r1", name: "www.example.com", type: "A", content: "192.0.2.1" },
    ]);
    expect(diff).toMatchObject({ action: "preserve", id: "r1" });
  });

  it("only overwrites an existing record under explicit-change", () => {
    const diff = dnsRecordActionFor(
      { ...entry, updateAction: "explicit-change" },
      [{ id: "r1", name: "www.example.com", type: "A", content: "192.0.2.1" }],
    );
    expect(diff).toMatchObject({ action: "update", id: "r1" });
  });

  it("creates a route when the pattern is absent, preserves when present", () => {
    expect(workerRouteActionFor({ kind: "workers-route", hostname: "example.com/*" }, []))
      .toMatchObject({ action: "create" });
    expect(workerRouteActionFor(
      { kind: "workers-route", hostname: "example.com/*" },
      [{ id: "r1", pattern: "example.com/*" }],
    )).toMatchObject({ action: "preserve", id: "r1" });
  });
});
