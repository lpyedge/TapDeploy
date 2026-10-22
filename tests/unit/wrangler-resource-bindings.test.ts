// Oracle: the final Wrangler config is the single resource declaration for
// r2_buckets / d1_databases / kv_namespaces. Planning verifies live identity,
// creates only verified-missing resources when provisioning is approved, and
// fails closed on denied/ambiguous/conflicting states instead of dropping a
// D1/KV binding or mistaking a denial (403) for absence (404).

import { describe, expect, it } from "vitest";

import {
  plannedBucketActionFor,
  plannedDatabaseActionFor,
  plannedNamespaceActionFor,
} from "../../src/cloudflare/resources/index.js";
import {
  createCloudflareClient,
  type CloudflareApiClient,
  type Fetcher,
} from "../../src/cloudflare/client/index.js";
import {
  createKvNamespaces,
  createQueues,
  createR2Buckets,
  planDatabaseActions,
  planNamespaceActions,
  registerQueueConsumers,
} from "../../src/core/deploy/bindings.js";
import {
  planWranglerResourceActions,
  type WranglerResourceProjection,
} from "../../src/core/deploy/wrangler-binding-plan.js";
import type { DeploySpec } from "../../src/core/deploy-spec.js";
import type { DeployStepContext } from "../../src/core/deploy/steps.js";
import { snapshotTarget } from "../../src/core/planning/snapshot.js";
import type { TargetSnapshot } from "../../src/core/planning/types.js";
import {
  normalizeWranglerV3,
  type WranglerV3Config,
  type WranglerV3Result,
} from "../../src/manifest/wrangler-v3.js";

const ACCOUNT = "a".repeat(32);
const BUCKET = "showcase-media";

function config(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "demo",
    main: "worker/main.mjs",
    compatibility_date: "2026-10-10",
    ...overrides,
  });
}

function codes(result: WranglerV3Result): string[] {
  return result.issues.map((issue) => issue.code);
}

function projectionFrom(overrides: Record<string, unknown>): WranglerResourceProjection {
  const result = normalizeWranglerV3(config(overrides));
  expect(result.issues).toEqual([]);
  expect(result.ok).toBe(true);
  return result.config!;
}

function cfError(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ success: false, errors: [{ code: 10000, message }], messages: [], result: null }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function jsonOk(result: unknown): Response {
  return new Response(
    JSON.stringify({ success: true, errors: [], messages: [], result }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function trackedClient(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  calls: { method: string; url: string }[];
  client: CloudflareApiClient;
} {
  const calls: { method: string; url: string }[] = [];
  const fetcher: Fetcher = async (input, init) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url });
    return handler(url, init);
  };
  return {
    calls,
    client: createCloudflareClient({ accessToken: "t", accountId: ACCOUNT, fetcher }),
  };
}

function r2StepContext(
  client: CloudflareApiClient,
  r2Buckets: Array<{ name: string; id: string }>,
): DeployStepContext {
  const spec = {
    schemaVersion: 1,
    targetKind: "workers",
    project: { id: "demo/app", version: "1.0.0" },
    assets: [],
    inputs: {},
    cloudflare: {
      workerName: "demo-worker",
      r2: [{ binding: "MEDIA", bucketName: BUCKET, createIfMissing: true }],
      d1: [],
      kv: [],
      queues: [],
      hyperdrive: [],
      vectorize: [],
      secretsStore: [],
      runtimeBindings: [],
      cron: [],
      secrets: {},
    },
    wrangler: { name: "demo-worker", compatibility_date: "2026-10-10", r2_buckets: [], crons: [] },
  } as unknown as DeploySpec;
  const snapshot = {
    workerExists: false,
    secretNames: [],
    r2Buckets,
    d1Databases: [],
    kvNamespaces: [],
    queues: [],
    hyperdriveConfigs: [],
    vectorizeIndexes: [],
    secretsStores: [],
    secretsStoreSecrets: [],
  } as unknown as TargetSnapshot;
  return {
    spec,
    snapshot,
    workerName: "demo-worker",
    accountId: ACCOUNT,
    accessToken: "t",
    client,
  } as unknown as DeployStepContext;
}

describe("Wrangler resource projection", () => {
  it("projects r2_buckets / d1_databases / kv_namespaces from the final config", () => {
    const result = normalizeWranglerV3(
      config({
        r2_buckets: [{ binding: "MEDIA", bucket_name: BUCKET }],
        d1_databases: [{ binding: "DB", database_name: "app-db", database_id: "db-uuid-1" }],
        kv_namespaces: [{ binding: "CACHE", id: "ns-1" }],
      }),
    );
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    const cfg = result.config!;
    expect(cfg.r2Buckets).toEqual([{ binding: "MEDIA", bucketName: BUCKET }]);
    expect(cfg.d1Databases).toEqual([
      { binding: "DB", databaseName: "app-db", databaseId: "db-uuid-1" },
    ]);
    expect(cfg.kvNamespaces).toEqual([{ binding: "CACHE", namespaceId: "ns-1" }]);
  });

  it("keeps default empty projections for configs without resource bindings", () => {
    const result = normalizeWranglerV3(config());
    expect(result.ok).toBe(true);
    expect(result.config!.r2Buckets).toEqual([]);
    expect(result.config!.d1Databases).toEqual([]);
    expect(result.config!.kvNamespaces).toEqual([]);
  });

  it("requires the creation handle for R2/D1 and the identity for KV", () => {
    const r2 = normalizeWranglerV3(config({ r2_buckets: [{ binding: "MEDIA" }] }));
    expect(r2.ok).toBe(false);
    expect(r2.issues[0]?.code).toBe("INVALID_SHAPE");
    expect(r2.issues[0]?.field).toBe("r2_buckets[0].bucket_name");

    const d1 = normalizeWranglerV3(config({ d1_databases: [{ binding: "DB" }] }));
    expect(d1.ok).toBe(false);
    expect(d1.issues[0]?.field).toBe("d1_databases[0].database_name");

    const kv = normalizeWranglerV3(config({ kv_namespaces: [{ binding: "CACHE" }] }));
    expect(kv.ok).toBe(false);
    expect(kv.issues[0]?.code).toBe("INVALID_SHAPE");
    expect(kv.issues[0]?.field).toBe("kv_namespaces[0].id");
  });

  it("refuses preview/dev-only and jurisdiction variants instead of ignoring them", () => {
    const r2 = normalizeWranglerV3(
      config({
        r2_buckets: [
          { binding: "MEDIA", bucket_name: BUCKET, jurisdiction: "eu" },
          { binding: "MEDIA2", bucket_name: "other", preview_bucket_name: "preview" },
        ],
      }),
    );
    expect(r2.ok).toBe(false);
    expect(codes(r2)).toEqual([
      "UNSUPPORTED_WRANGLER_FEATURE",
      "UNSUPPORTED_WRANGLER_FEATURE",
    ]);
    expect(r2.issues[0]?.field).toBe("r2_buckets[0].jurisdiction");
    expect(r2.issues[1]?.field).toBe("r2_buckets[1].preview_bucket_name");

    const d1 = normalizeWranglerV3(
      config({
        d1_databases: [
          {
            binding: "DB",
            database_name: "app-db",
            preview_database_id: "db-preview",
            migrations_dir: "./migrations",
          },
        ],
      }),
    );
    expect(codes(d1)).toEqual([
      "UNSUPPORTED_WRANGLER_FEATURE",
      "UNSUPPORTED_WRANGLER_FEATURE",
    ]);

    const kv = normalizeWranglerV3(
      config({ kv_namespaces: [{ binding: "CACHE", id: "ns-1", preview_id: "ns-preview", remote: true }] }),
    );
    expect(codes(kv)).toEqual([
      "UNSUPPORTED_WRANGLER_FEATURE",
      "UNSUPPORTED_WRANGLER_FEATURE",
    ]);
  });

  it("refuses unknown entry keys rather than dropping them", () => {
    const result = normalizeWranglerV3(
      config({ r2_buckets: [{ binding: "MEDIA", bucket_name: BUCKET, location_hint: "x" }] }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(["UNKNOWN_WRANGLER_FIELD"]);
    expect(result.issues[0]?.field).toBe("r2_buckets[0].location_hint");
  });

  it("fails duplicate resource targets within a family (name collisions fail)", () => {
    const r2 = normalizeWranglerV3(
      config({
        r2_buckets: [
          { binding: "A", bucket_name: BUCKET },
          { binding: "B", bucket_name: BUCKET },
        ],
      }),
    );
    expect(r2.ok).toBe(false);
    expect(r2.issues[0]?.code).toBe("INVALID_SHAPE");
    expect(r2.issues[0]?.field).toBe("r2_buckets");
    expect(r2.issues[0]?.detail).toContain("cannot be two bindings");

    const d1 = normalizeWranglerV3(
      config({
        d1_databases: [
          { binding: "A", database_name: "app-db" },
          { binding: "B", database_name: "app-db" },
        ],
      }),
    );
    expect(d1.ok).toBe(false);
    expect(d1.issues[0]?.field).toBe("d1_databases");

    const kv = normalizeWranglerV3(
      config({
        kv_namespaces: [
          { binding: "A", id: "ns-1" },
          { binding: "B", id: "ns-1" },
        ],
      }),
    );
    expect(kv.ok).toBe(false);
    expect(kv.issues[0]?.field).toBe("kv_namespaces");

    const d1Ids = normalizeWranglerV3(
      config({
        d1_databases: [
          { binding: "A", database_name: "app-db", database_id: "db-uuid-1" },
          { binding: "B", database_name: "other-db", database_id: "db-uuid-1" },
        ],
      }),
    );
    expect(d1Ids.ok).toBe(false);
    expect(d1Ids.issues.map((issue) => issue.field)).toContain("d1_databases");
  });

  it("refuses binding-name collisions across resource families", () => {
    const result = normalizeWranglerV3(
      config({
        r2_buckets: [{ binding: "DATA", bucket_name: BUCKET }],
        kv_namespaces: [{ binding: "DATA", id: "ns-1" }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(
      result.issues.some(
        (issue) => issue.code === "INVALID_SHAPE" && issue.detail.includes("already used"),
      ),
    ).toBe(true);
  });
});

describe("verified resource actions against live state", () => {
  it("preserves an existing R2 bucket only through its unique live identity", () => {
    const action = plannedBucketActionFor(
      { binding: "MEDIA", bucketName: BUCKET },
      [{ name: BUCKET, id: `${BUCKET}@2026-01-01T00:00:00.000Z` }],
      { createIfMissing: true },
    );
    expect(action).toEqual({
      binding: "MEDIA",
      bucketName: BUCKET,
      action: "preserve",
      id: `${BUCKET}@2026-01-01T00:00:00.000Z`,
    });
  });

  it("creates only a verified-missing R2 bucket when provisioning is approved", () => {
    expect(
      plannedBucketActionFor({ binding: "MEDIA", bucketName: BUCKET }, [], { createIfMissing: true }),
    ).toMatchObject({ action: "create" });
    expect(
      plannedBucketActionFor({ binding: "MEDIA", bucketName: BUCKET }, [], { createIfMissing: false }),
    ).toMatchObject({ action: "conflict" });
  });

  it("refuses ambiguous or identity-less live R2 matches", () => {
    const ambiguous = plannedBucketActionFor(
      { binding: "MEDIA", bucketName: BUCKET },
      [
        { name: BUCKET, id: "one" },
        { name: BUCKET, id: "two" },
      ],
      { createIfMissing: true },
    );
    expect(ambiguous).toMatchObject({ action: "conflict" });
    expect(ambiguous.action === "conflict" && ambiguous.detail).toContain("refusing to guess");

    const noId = plannedBucketActionFor(
      { binding: "MEDIA", bucketName: BUCKET },
      [{ name: BUCKET, id: "" }],
      { createIfMissing: true },
    );
    expect(noId).toMatchObject({ action: "conflict" });
  });

  it("verifies a declared D1 database_id against the live account", () => {
    const preserved = plannedDatabaseActionFor(
      { binding: "DB", databaseName: "app-db", databaseId: "db-uuid-1" },
      [{ name: "app-db", id: "db-uuid-1" }],
      { createIfMissing: true },
    );
    expect(preserved).toEqual({
      binding: "DB",
      databaseName: "app-db",
      action: "preserve",
      id: "db-uuid-1",
    });
  });

  it("never recreates a declared D1 database_id that is absent from the account", () => {
    const action = plannedDatabaseActionFor(
      { binding: "DB", databaseName: "app-db", databaseId: "db-from-old-env" },
      [],
      { createIfMissing: true },
    );
    expect(action).toMatchObject({ action: "conflict" });
    expect(action.action === "conflict" && action.detail).toContain("never recreated");
  });

  it("refuses a declared D1 id that resolves to another name or another live id", () => {
    const wrongName = plannedDatabaseActionFor(
      { binding: "DB", databaseName: "app-db", databaseId: "db-uuid-1" },
      [{ name: "someone-elses-db", id: "db-uuid-1" }],
      { createIfMissing: true },
    );
    expect(wrongName).toMatchObject({ action: "conflict" });
    expect(wrongName.action === "conflict" && wrongName.detail).toContain("refusing a silent rebind");

    const staleId = plannedDatabaseActionFor(
      { binding: "DB", databaseName: "app-db", databaseId: "db-from-old-env" },
      [{ name: "app-db", id: "db-live-2" }],
      { createIfMissing: true },
    );
    expect(staleId).toMatchObject({ action: "conflict" });
    expect(staleId.action === "conflict" && staleId.detail).toContain("different id");
  });

  it("creates a D1 database by name only when no provider id is declared", () => {
    expect(
      plannedDatabaseActionFor({ binding: "DB", databaseName: "app-db" }, [], { createIfMissing: true }),
    ).toMatchObject({ action: "create" });
    expect(
      plannedDatabaseActionFor({ binding: "DB", databaseName: "app-db" }, [], { createIfMissing: false }),
    ).toMatchObject({ action: "conflict" });
  });

  it("verifies a declared KV namespace id and never creates a replacement", () => {
    const preserved = plannedNamespaceActionFor(
      { binding: "CACHE", namespaceId: "ns-1" },
      [{ name: "cache-prod", id: "ns-1" }],
    );
    expect(preserved).toEqual({
      binding: "CACHE",
      namespaceName: "cache-prod",
      action: "preserve",
      id: "ns-1",
    });

    const missing = plannedNamespaceActionFor({ binding: "CACHE", namespaceId: "ns-old" }, []);
    expect(missing).toMatchObject({ action: "conflict" });
    expect(missing.action === "conflict" && missing.detail).toContain("never recreated from a wrangler binding");

    const empty = plannedNamespaceActionFor({ binding: "CACHE", namespaceId: "" }, []);
    expect(empty).toMatchObject({ action: "conflict" });
  });
});

describe("planWranglerResourceActions", () => {
  it("plans verified preserves and approved creates with provider binding types", () => {
    const projection = projectionFrom({
      r2_buckets: [
        { binding: "MEDIA", bucket_name: "media-bucket" },
        { binding: "ARCHIVE", bucket_name: "archive-bucket" },
      ],
      d1_databases: [{ binding: "DB", database_name: "app-db" }],
      kv_namespaces: [{ binding: "CACHE", id: "ns-live-1" }],
    });
    const snapshot = {
      r2Buckets: [{ name: "media-bucket", id: "media-bucket@2026-01-01" }],
      d1Databases: [{ name: "app-db", id: "db-live-1" }],
      kvNamespaces: [{ name: "cache-prod", id: "ns-live-1" }],
    };
    const planned = planWranglerResourceActions(projection, snapshot, "ensure");
    if (!planned.ok) {
      throw new Error(`expected ok plan: ${planned.issues.join("; ")}`);
    }
    expect(planned.plan.r2Buckets).toEqual([
      {
        binding: "MEDIA",
        providerType: "r2_bucket",
        bucketName: "media-bucket",
        action: "preserve",
        id: "media-bucket@2026-01-01",
      },
      { binding: "ARCHIVE", providerType: "r2_bucket", bucketName: "archive-bucket", action: "create" },
    ]);
    expect(planned.plan.d1Databases).toEqual([
      { binding: "DB", providerType: "d1", databaseName: "app-db", action: "preserve", id: "db-live-1" },
    ]);
    expect(planned.plan.kvNamespaces).toEqual([
      {
        binding: "CACHE",
        providerType: "kv_namespace",
        namespaceId: "ns-live-1",
        namespaceName: "cache-prod",
        action: "preserve",
      },
    ]);
  });

  it("fails the whole plan in bind-existing mode instead of creating a missing resource", () => {
    const projection = projectionFrom({
      r2_buckets: [{ binding: "MEDIA", bucket_name: "media-bucket" }],
    });
    const planned = planWranglerResourceActions(
      projection,
      { r2Buckets: [], d1Databases: [], kvNamespaces: [] },
      "bind-existing",
    );
    expect(planned.ok).toBe(false);
    if (planned.ok) {
      throw new Error("expected a fail-closed plan");
    }
    expect(planned.issues[0]).toContain("createIfMissing=false");
  });

  it("fails closed on stale D1/KV identities and never drops a binding", () => {
    const projection = projectionFrom({
      d1_databases: [{ binding: "DB", database_name: "app-db", database_id: "db-from-old-env" }],
      kv_namespaces: [{ binding: "CACHE", id: "ns-from-old-env" }],
    });
    const planned = planWranglerResourceActions(
      projection,
      { r2Buckets: [], d1Databases: [], kvNamespaces: [] },
      "ensure",
    );
    expect(planned.ok).toBe(false);
    if (planned.ok) {
      throw new Error("expected a fail-closed plan");
    }
    expect(planned.issues).toHaveLength(2);
    expect(planned.issues.join(" ")).toContain("never recreated");
    expect(planned.issues.join(" ")).toContain("never recreated from a wrangler binding");
  });
});

describe("provider denial and duplicate handling (R2 step)", () => {
  it("treats a 403 on create as a denial, never as an absent resource", async () => {
    const { calls, client } = trackedClient(() => cfError(403, "Authentication error"));
    const outcome = await createR2Buckets(r2StepContext(client, []), {});
    expect(outcome).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("reports a duplicate-name 409 as conflict and preserves the bucket on retry after a refreshed snapshot", async () => {
    const { calls, client } = trackedClient(() => cfError(409, "bucket name is taken"));
    const first = await createR2Buckets(r2StepContext(client, []), {});
    expect(first).toMatchObject({ ok: false, error: { kind: "conflict" } });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);

    const second = await createR2Buckets(
      r2StepContext(client, [{ name: BUCKET, id: `${BUCKET}@2026-10-17T00:00:00.000Z` }]),
      {},
    );
    expect(second).toMatchObject({
      ok: true,
      result: {
        buckets: [
          {
            binding: "MEDIA",
            bucketName: BUCKET,
            action: "preserve",
            id: `${BUCKET}@2026-10-17T00:00:00.000Z`,
          },
        ],
      },
    });
    // The retry never repeats the mutation.
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("fails the snapshot on a denied (403) R2 listing instead of returning an empty list", async () => {
    const fetcher: Fetcher = async (input) => {
      const url = String(input);
      return url.includes("/r2/buckets")
        ? cfError(403, "Authentication error")
        : cfError(404, "script not found");
    };
    const client = createCloudflareClient({ accessToken: "t", accountId: ACCOUNT, fetcher });
    await expect(
      snapshotTarget(client, {
        accountId: ACCOUNT,
        workerName: "demo-worker",
        needs: { r2: true, domains: false },
      }),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("fails the snapshot on a 404 R2 listing when R2 is required (no error kind is an absent list)", async () => {
    const fetcher: Fetcher = async (input) => {
      const url = String(input);
      return url.includes("/r2/buckets")
        ? cfError(404, "not found")
        : cfError(404, "script not found");
    };
    const client = createCloudflareClient({ accessToken: "t", accountId: ACCOUNT, fetcher });
    await expect(
      snapshotTarget(client, {
        accountId: ACCOUNT,
        workerName: "demo-worker",
        needs: { r2: true, domains: false },
      }),
    ).rejects.toMatchObject({ kind: "not-found" });
  });

  it("keeps an optional undeclared R2 read lenient, then fails the create closed with the real denial", async () => {
    const fetcher: Fetcher = async (input) => {
      const url = String(input);
      return url.includes("/workers/scripts")
        ? cfError(404, "script not found")
        : cfError(403, "Authentication error");
    };
    const client = createCloudflareClient({ accessToken: "t", accountId: ACCOUNT, fetcher });
    // Legacy compatibility: an *undeclared* (optional) read may be empty; the
    // declared-resource path must mark its needs required (wiring), and the
    // actual create still fails closed with the real provider denial (below).
    const snapshot = await snapshotTarget(client, {
      accountId: ACCOUNT,
      workerName: "demo-worker",
      needs: { domains: false },
    });
    expect(snapshot.r2Buckets).toEqual([]);
    const planned = planWranglerResourceActions(
      { r2Buckets: [{ binding: "MEDIA", bucketName: BUCKET }], d1Databases: [], kvNamespaces: [] },
      snapshot,
      "ensure",
    );
    if (!planned.ok) {
      throw new Error(`expected ok plan: ${planned.issues.join("; ")}`);
    }
    expect(planned.plan.r2Buckets).toEqual([
      { binding: "MEDIA", providerType: "r2_bucket", bucketName: BUCKET, action: "create" },
    ]);
    const { calls, client: stepClient } = trackedClient(() => cfError(403, "Authentication error"));
    const outcome = await createR2Buckets(r2StepContext(stepClient, snapshot.r2Buckets), {});
    expect(outcome).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(calls.some((call) => call.method === "POST")).toBe(true);
  });

  it("preserves an existing bucket from the verified create response identity", async () => {
    const created = { name: BUCKET, creation_date: "2026-10-17T01:02:03.000Z", location: "APAC", storage_class: "Standard" };
    const { calls, client } = trackedClient(() => jsonOk(created));
    const outcome = await createR2Buckets(r2StepContext(client, []), {});
    expect(outcome).toMatchObject({
      ok: true,
      result: { buckets: [{ binding: "MEDIA", action: "create", id: `${BUCKET}@2026-10-17T01:02:03.000Z` }] },
    });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
});

describe("V3 KV/D1 provider-id identity (never an id-titled create)", () => {
  const KV_ID = "n".repeat(32);
  const DB_ID = "d".repeat(32);

  function kvSpec(entries: DeploySpec["cloudflare"]["kv"]): DeploySpec {
    return {
      schemaVersion: 1,
      targetKind: "workers",
      project: { id: "demo/app", version: "1.0.0" },
      assets: [],
      inputs: {},
      cloudflare: {
        workerName: "demo-worker",
        r2: [],
        d1: [],
        kv: entries,
        queues: [],
        hyperdrive: [],
        vectorize: [],
        secretsStore: [],
        runtimeBindings: [],
        cron: [],
        secrets: {},
      },
      wrangler: { name: "demo-worker", compatibility_date: "2026-10-10", r2_buckets: [], crons: [] },
    } as unknown as DeploySpec;
  }

  function kvStepContext(
    client: CloudflareApiClient,
    kvNamespaces: Array<{ name: string; id: string }>,
    entries: DeploySpec["cloudflare"]["kv"],
  ): DeployStepContext {
    const snapshot = {
      accountId: ACCOUNT,
      workerExists: false,
      secretNames: [],
      r2Buckets: [],
      d1Databases: [],
      kvNamespaces,
      queues: [],
      hyperdriveConfigs: [],
      vectorizeIndexes: [],
      secretsStores: [],
      secretsStoreSecrets: [],
    } as unknown as TargetSnapshot;
    return {
      spec: kvSpec(entries),
      snapshot,
      workerName: "demo-worker",
      accountId: ACCOUNT,
      accessToken: "t",
      client,
    } as unknown as DeployStepContext;
  }

  it("projects the Wrangler KV id as an identity claim, never a creation handle", async () => {
    const { preparedGraphInputs } = await import("../../src/api/routes/deploy-plan.js");
    const config = {
      schemaVersion: 3,
      app: { id: "example/app", name: "App" },
      source: { allowLocalZip: true },
      capabilities: ["workers", "kv", "d1"],
      units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }],
    };
    const prepared = preparedGraphInputs(
      config as never,
      [
        {
          unitId: "main",
          wranglerPath: "wrangler.jsonc",
          wranglerSha256: "0".repeat(64),
          wranglerEffectiveHash: "1".repeat(64),
          canonicalWrangler: {
            kind: "worker",
            name: "api",
            compatibility_date: "2026-10-17",
            kvNamespaces: [{ binding: "KV", namespaceId: KV_ID }],
            d1Databases: [{ binding: "DB", databaseName: "app-db", databaseId: DB_ID }],
            crons: [],
            vars: {},
          },
          mainModule: { path: "worker/main.mjs", size: 10, sha256: "2".repeat(64) },
          modules: [{ path: "worker/main.mjs", size: 10, sha256: "2".repeat(64), mime: "application/javascript+module" }],
          assets: [],
          bundleDigest: "bundle-digest-1",
        },
      ] as never,
      "3".repeat(64),
      "4".repeat(64),
      {},
    );
    if (!prepared.ok) throw new Error(`expected ok projection: ${prepared.detail}`);
    expect(prepared.specs["main"]!.cloudflare.kv).toEqual([
      { binding: "KV", namespaceName: KV_ID, namespaceId: KV_ID, createIfMissing: false },
    ]);
    expect(prepared.specs["main"]!.cloudflare.d1).toEqual([
      { binding: "DB", databaseName: "app-db", createIfMissing: true, databaseId: DB_ID },
    ]);
  });

  it("preserves the exact live KV namespace by id and conflicts (never creates) otherwise", () => {
    const preserved = planNamespaceActions(
      kvSpec([{ binding: "KV", namespaceName: KV_ID, namespaceId: KV_ID, createIfMissing: false }]),
      { kvNamespaces: [{ name: "real-kv", id: KV_ID }] } as unknown as TargetSnapshot,
    );
    expect(preserved).toEqual([
      { binding: "KV", namespaceName: "real-kv", action: "preserve", id: KV_ID },
    ]);

    const missing = planNamespaceActions(
      kvSpec([{ binding: "KV", namespaceName: KV_ID, namespaceId: "unknown-id", createIfMissing: false }]),
      { kvNamespaces: [] } as unknown as TargetSnapshot,
    );
    expect(missing).toMatchObject([{ action: "conflict" }]);

    const legacy = planNamespaceActions(
      kvSpec([{ binding: "KV", namespaceName: "cache", createIfMissing: false }]),
      { kvNamespaces: [] } as unknown as TargetSnapshot,
    );
    expect(legacy).toMatchObject([{ action: "conflict" }]);
  });

  it("verifies a declared D1 database_id and refuses a silent rebind or recreation", () => {
    const preserved = planDatabaseActions(
      kvSpec([]) as unknown as DeploySpec,
      { d1Databases: [] } as unknown as TargetSnapshot,
    );
    expect(preserved).toEqual([]);
    const spec = kvSpec([]);
    spec.cloudflare.d1 = [{ binding: "DB", databaseName: "app-db", createIfMissing: true, databaseId: DB_ID }];
    expect(
      planDatabaseActions(spec, { d1Databases: [{ name: "app-db", id: DB_ID }] } as unknown as TargetSnapshot),
    ).toMatchObject([{ action: "preserve", id: DB_ID }]);
    expect(
      planDatabaseActions(spec, { d1Databases: [{ name: "someone-elses-db", id: DB_ID }] } as unknown as TargetSnapshot),
    ).toMatchObject([{ action: "conflict" }]);
    expect(
      planDatabaseActions(spec, { d1Databases: [] } as unknown as TargetSnapshot),
    ).toMatchObject([{ action: "conflict" }]);
  });

  it("refuses an unknown KV id at the step without any provider write", async () => {
    const { calls, client } = trackedClient(() => jsonOk({}));
    const outcome = await createKvNamespaces(
      kvStepContext(
        client,
        [],
        [{ binding: "KV", namespaceName: KV_ID, namespaceId: "unknown-id", createIfMissing: false }],
      ),
      {},
    );
    expect(outcome).toMatchObject({ ok: false, error: { kind: "conflict" } });
    expect(calls).toEqual([]);
  });

  it("preserves a verified KV namespace at the step with zero provider writes", async () => {
    const { calls, client } = trackedClient(() => jsonOk({}));
    const outcome = await createKvNamespaces(
      kvStepContext(
        client,
        [{ name: "real-kv", id: KV_ID }],
        [{ binding: "KV", namespaceName: "real-kv", namespaceId: KV_ID, createIfMissing: false }],
      ),
      {},
    );
    expect(outcome).toMatchObject({
      ok: true,
      result: { namespaces: [{ binding: "KV", namespaceName: "real-kv", action: "preserve", id: KV_ID }] },
    });
    expect(calls).toEqual([]);
  });
});

// The projection type must accept a normalized WranglerV3Config directly so the
// plan can be built without a second, duplicated resource declaration.
const _typeCheck: (cfg: WranglerV3Config) => WranglerResourceProjection = (cfg) => cfg;
void _typeCheck;

// ---------------------------------------------------------------------------
// Queue producer/consumer graph. Producers are Worker version bindings;
// consumers are trigger registrations on the queue's consumers subresource,
// decided from fresh per-queue facts (preserve our own, update our own in
// place, create when absent, refuse any foreign consumer before a write).
// ---------------------------------------------------------------------------

describe("queue producer/consumer projection and registration", () => {
  function queueSpec(entries: DeploySpec["cloudflare"]["queues"]): DeploySpec {
    return {
      schemaVersion: 1,
      targetKind: "workers",
      project: { id: "demo/app", version: "1.0.0" },
      assets: [],
      inputs: {},
      cloudflare: {
        workerName: "api",
        r2: [], d1: [], kv: [],
        queues: entries,
        hyperdrive: [], vectorize: [], secretsStore: [], runtimeBindings: [], cron: [], secrets: {},
      },
      wrangler: { name: "api", compatibility_date: "2026-10-10", r2_buckets: [], crons: [] },
    } as unknown as DeploySpec;
  }

  function queueStepContext(
    spec: DeploySpec,
    client: CloudflareApiClient,
    overrides: {
      queues?: Array<{ name: string; id: string }>;
      queueConsumers?: TargetSnapshot["queueConsumers"];
      workerExists?: boolean;
      activeDeploymentVersionIds?: string[];
    } = {},
  ): DeployStepContext {
    const snapshot = {
      accountId: ACCOUNT,
      workerExists: overrides.workerExists ?? true,
      secretNames: [],
      r2Buckets: [], d1Databases: [], kvNamespaces: [],
      queues: overrides.queues ?? [{ name: "jobs", id: "q1" }],
      queueConsumers: overrides.queueConsumers ?? {},
      hyperdriveConfigs: [], vectorizeIndexes: [], secretsStores: [], secretsStoreSecrets: [],
      activeDeploymentVersionIds: overrides.activeDeploymentVersionIds ?? ["version-1"],
    } as unknown as TargetSnapshot;
    return {
      spec,
      snapshot,
      workerName: "api",
      accountId: ACCOUNT,
      accessToken: "t",
      client,
    } as unknown as DeployStepContext;
  }

  function queueClient(responses: unknown[]): {
    calls: { method: string; url: string; body: unknown }[];
    client: CloudflareApiClient;
  } {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fetcher: Fetcher = async (input, init) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (responses.length === 0) throw new Error(`unexpected provider call: ${init?.method ?? "GET"} ${url}`);
      return jsonOk(responses.shift());
    };
    return { calls, client: createCloudflareClient({ accessToken: "t", accountId: ACCOUNT, fetcher }) };
  }

  it("normalizes wrangler producers/consumers into explicit per-queue roles", async () => {
    const { preparedGraphInputs } = await import("../../src/api/routes/deploy-plan.js");
    const config = {
      schemaVersion: 3,
      app: { id: "example/app", name: "App" },
      source: { allowLocalZip: true },
      capabilities: ["workers", "queues"],
      units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }],
    };
    const prepared = preparedGraphInputs(
      config as never,
      [
        {
          unitId: "main",
          wranglerPath: "wrangler.jsonc",
          wranglerSha256: "0".repeat(64),
          wranglerEffectiveHash: "1".repeat(64),
          canonicalWrangler: {
            kind: "worker",
            name: "api",
            compatibility_date: "2026-10-17",
            queueProducers: [{ binding: "JOBS", queue: "jobs" }, { binding: "EVENTS", queue: "events" }],
            queueConsumers: [
              { queue: "jobs", type: "worker", max_batch_size: 5, max_batch_timeout: 2, retry_delay: 10 },
              { queue: "audit", type: "worker" },
            ],
            crons: [],
            vars: {},
          },
          mainModule: { path: "worker/main.mjs", size: 10, sha256: "2".repeat(64) },
          modules: [{ path: "worker/main.mjs", size: 10, sha256: "2".repeat(64), mime: "application/javascript+module" }],
          assets: [],
          bundleDigest: "bundle-digest-1",
        },
      ] as never,
      "3".repeat(64),
      "4".repeat(64),
      {},
    );
    if (!prepared.ok) throw new Error(`expected ok projection: ${prepared.detail}`);
    // Producer entries bind (role both when also consumed); a consumer-only
    // queue is an explicit role with no binding identity at all.
    expect(prepared.specs["main"]!.cloudflare.queues).toEqual([
      {
        binding: "JOBS", queueName: "jobs", createIfMissing: true, role: "both",
        consumer: { queue: "jobs", type: "worker", max_batch_size: 5, max_batch_timeout: 2, retry_delay: 10 },
      },
      { binding: "EVENTS", queueName: "events", createIfMissing: true, role: "producer" },
      { queueName: "audit", createIfMissing: true, role: "consumer", consumer: { queue: "audit", type: "worker" } },
    ]);
    // The wrangler projection mirrors the same roles for display/verification.
    expect(prepared.specs["main"]!.wrangler.queues).toEqual([
      { binding: "JOBS", queue_name: "jobs", role: "both" },
      { binding: "EVENTS", queue_name: "events", role: "producer" },
      { queue_name: "audit", role: "consumer" },
    ]);
    // The version projection binds only producer/both entries.
    const queuesProjection = prepared.specs["main"]!.wrangler.queues ?? [];
    expect(queuesProjection.filter((entry) => entry.binding !== undefined).map((entry) => entry.binding)).toEqual(["JOBS", "EVENTS"]);
  });

  it("creates the declared queue for a consumer-only entry without inventing a binding", async () => {
    const spec = queueSpec([
      { queueName: "jobs", createIfMissing: true, role: "consumer", consumer: { queue: "jobs", type: "worker" } },
    ]);
    const { calls, client } = trackedClient(() => jsonOk({ queue_id: "q9", queue_name: "jobs" }));
    const outcome = await createQueues(queueStepContext(spec, client, { queues: [] }), {});
    expect(outcome).toMatchObject({ ok: true, result: { queues: [{ queueName: "jobs", action: "create", id: "q9" }] } });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    // A preserved consumer-only queue carries no binding field either.
    const { calls: preserveCalls, client: preserveClient } = trackedClient(() => { throw new Error("no provider call expected"); });
    const preserved = await createQueues(
      queueStepContext(spec, preserveClient, { queues: [{ name: "jobs", id: "q1" }] }),
      {},
    );
    expect(preserved).toMatchObject({ ok: true, result: { queues: [{ queueName: "jobs", action: "preserve", id: "q1" }] } });
    expect(preserveCalls).toEqual([]);
  });

  it("creates the trigger on the live queue id when the queue has no consumers", async () => {
    const spec = queueSpec([
      {
        queueName: "jobs", createIfMissing: true, role: "consumer",
        consumer: { queue: "jobs", type: "worker", max_batch_size: 5 },
      },
    ]);
    const { calls, client } = queueClient([[], { consumer_id: "c1", script: "api", type: "worker" }]);
    const outcome = await registerQueueConsumers(queueStepContext(spec, client), {});
    expect(outcome).toMatchObject({ ok: true, result: { consumers: [{ queueName: "jobs", consumerId: "c1", action: "create" }] } });
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(calls[0]!.url).toContain(`/accounts/${ACCOUNT}/queues/q1/consumers`);
    expect(calls[1]!.url).toContain(`/accounts/${ACCOUNT}/queues/q1/consumers`);
    expect(calls[1]!.body).toEqual({ script_name: "api", type: "worker", settings: { batch_size: 5 } });
  });

  it("preserves our own exactly matching consumer with zero provider writes", async () => {
    const spec = queueSpec([
      { queueName: "jobs", createIfMissing: true, role: "consumer", consumer: { queue: "jobs", type: "worker" } },
    ]);
    const { calls, client } = trackedClient(() => { throw new Error("no provider call expected"); });
    const outcome = await registerQueueConsumers(
      queueStepContext(spec, client, {
        queueConsumers: { jobs: [{ consumerId: "c1", scriptName: "api", type: "worker" }] },
      }),
      {},
    );
    expect(outcome).toMatchObject({ ok: true, result: { consumers: [{ queueName: "jobs", consumerId: "c1", action: "preserve" }] } });
    expect(calls).toEqual([]);
  });

  it("updates our own drifted consumer in place under its immutable identity", async () => {
    const spec = queueSpec([
      {
        queueName: "jobs", createIfMissing: true, role: "consumer",
        consumer: { queue: "jobs", type: "worker", max_batch_size: 5, retry_delay: 10 },
      },
    ]);
    const { calls, client } = queueClient([
      [{ consumer_id: "c1", script: "api", type: "worker", settings: { batch_size: 99, retry_delay: 10 } }],
      { consumer_id: "c1", script: "api", type: "worker", settings: { batch_size: 5, retry_delay: 10 } },
    ]);
    const outcome = await registerQueueConsumers(
      queueStepContext(spec, client, {
        queueConsumers: { jobs: [{ consumerId: "c1", scriptName: "api", type: "worker", settings: { batch_size: 99, retry_delay: 10 } }] },
      }),
      {},
    );
    expect(outcome).toMatchObject({ ok: true, result: { consumers: [{ queueName: "jobs", consumerId: "c1", action: "update" }] } });
    expect(calls.map((call) => call.method)).toEqual(["GET", "PUT"]);
    expect(calls[1]!.url).toContain(`/accounts/${ACCOUNT}/queues/q1/consumers/c1`);
    expect(calls[1]!.body).toEqual({ script_name: "api", type: "worker", settings: { batch_size: 5, retry_delay: 10 } });
  });

  it("refuses any foreign consumer and a missing queue before a write", async () => {
    const spec = queueSpec([
      { queueName: "jobs", createIfMissing: true, role: "consumer", consumer: { queue: "jobs", type: "worker" } },
    ]);
    const { calls, client } = trackedClient(() => { throw new Error("no provider call expected"); });
    const foreign = await registerQueueConsumers(
      queueStepContext(spec, client, {
        queueConsumers: { jobs: [{ consumerId: "f1", scriptName: "someone-else", type: "worker" }] },
      }),
      {},
    );
    expect(foreign).toMatchObject({ ok: false, error: { kind: "conflict" } });
    const missing = await registerQueueConsumers(queueStepContext(spec, client, { queues: [] }), {});
    expect(missing).toMatchObject({ ok: false, error: { kind: "conflict" } });
    expect(calls).toEqual([]);
  });

  it("fails closed before triggering when the Worker or its deployment is missing", async () => {
    const spec = queueSpec([
      { queueName: "jobs", createIfMissing: true, role: "consumer", consumer: { queue: "jobs", type: "worker" } },
    ]);
    const { calls, client } = trackedClient(() => { throw new Error("no provider call expected"); });
    const noWorker = await registerQueueConsumers(queueStepContext(spec, client, { workerExists: false }), {});
    expect(noWorker).toMatchObject({ ok: false, error: { kind: "worker-missing" } });
    const noDeployment = await registerQueueConsumers(
      queueStepContext(spec, client, { activeDeploymentVersionIds: [] }),
      {},
    );
    expect(noDeployment).toMatchObject({ ok: false, error: { kind: "worker-missing" } });
    expect(calls).toEqual([]);
  });
});

describe("Platform bindings — Wrangler projection (Hyperdrive, Vectorize, Secrets Store, AI, Browser)", () => {
  it("projects the five platform bindings with their official Wrangler keys", () => {
    const cfg = projectionFrom({
      hyperdrive: [{ binding: "HYPERDRIVE", id: "hd-1", localConnectionString: "postgres://localhost/dev" }],
      vectorize: [{ binding: "INDEX", index_name: "docs" }],
      secrets_store_secrets: [{ binding: "API_KEY", store_id: "store-1", secret_name: "api-key" }],
      ai: { binding: "AI" },
      browser: { binding: "BROWSER" },
    }) as WranglerV3Config;
    expect(cfg.hyperdrive).toEqual([{ binding: "HYPERDRIVE", id: "hd-1" }]);
    expect(cfg.vectorize).toEqual([{ binding: "INDEX", indexName: "docs" }]);
    expect(cfg.secretsStoreSecrets).toEqual([{ binding: "API_KEY", storeId: "store-1", secretName: "api-key" }]);
    expect(cfg.ai).toEqual({ binding: "AI" });
    expect(cfg.browser).toEqual({ binding: "BROWSER" });
  });

  it("requires every identity handle and refuses remote-dev variants", () => {
    const missing = normalizeWranglerV3(config({ hyperdrive: [{ binding: "HD" }], secrets_store_secrets: [{ binding: "S", store_id: "s" }] }));
    expect(missing.ok).toBe(false);
    expect(missing.issues.map((issue) => issue.field)).toEqual(["hyperdrive[0].id", "secrets_store_secrets[0].secret_name"]);
    const remote = normalizeWranglerV3(config({ vectorize: [{ binding: "I", index_name: "docs", remote: true }], ai: { binding: "AI", remote: true } }));
    expect(codes(remote)).toEqual(["UNSUPPORTED_WRANGLER_FEATURE", "UNSUPPORTED_WRANGLER_FEATURE"]);
  });

  it("fails duplicate targets and binding-name collisions", () => {
    const duplicate = normalizeWranglerV3(config({ vectorize: [{ binding: "A", index_name: "docs" }, { binding: "B", index_name: "docs" }] }));
    expect(duplicate.ok).toBe(false);
    const collision = normalizeWranglerV3(config({ ai: { binding: "SHARED" }, browser: { binding: "SHARED" } }));
    expect(collision.ok).toBe(false);
  });
});
