import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DeploySpec } from "../../src/core/deploy-spec.js";
import { buildDeployPlan } from "../../src/core/planning/plan.js";
import {
  canonicalJson,
  computePlanDigest,
  currentVersion,
  TAPDEPLOY_MANAGED_MARKER,
  isManagedWorker,
  isManagedWorkerForProject,
  managedWorkerProjectId,
  resolveActiveOwnership,
  versionOwnerProjectId,
} from "../../src/core/planning/digest.js";
import { detectDrift, planReference } from "../../src/core/planning/drift.js";
import type { ExpectedTarget, TargetSnapshot } from "../../src/core/planning/types.js";

// Pre-projected DeploySpec fixtures (the shape the V3 prepare/plan bridge
// produces), so these planner tests do not depend on any projection code.
const dir = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(dir, "../fixtures/specs");
const ACCOUNT = "a".repeat(32);
const SALT = "csrf-mock-token";

function specFor(name: string): DeploySpec {
  return JSON.parse(readFileSync(path.join(fixtures, `${name}.json`), "utf8")) as DeploySpec;
}

function snapshot(overrides: Partial<TargetSnapshot> = {}): TargetSnapshot {
  return {
    accountId: ACCOUNT,
    workerName: "tapdeploy-fixture-minimal",
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
    ...overrides,
  };
}

function managedVersions(projectId = "fixture/minimal-worker"): TargetSnapshot["versions"] {
  return [
    {
      id: "version-1",
      number: 1,
      message: `${projectId} v0.1.0 ${TAPDEPLOY_MANAGED_MARKER}`,
    },
  ];
}

describe("buildDeployPlan", () => {
  it("binds resource, domain, project and runtime settings to the approved digest", async () => {
    const spec = specFor("minimal-worker");
    const original = await buildDeployPlan({ spec }, snapshot(), { salt: SALT });
    const variants: DeploySpec[] = [
      { ...spec, project: { ...spec.project, id: "another/project" } },
      { ...spec, cloudflare: { ...spec.cloudflare, cron: ["* * * * *"] } },
      { ...spec, cloudflare: { ...spec.cloudflare, domains: [{ kind: "dns-record", hostname: "app.example.com", zoneName: "example.com", recordType: "A", recordContent: "192.0.2.1" }] } },
      { ...spec, cloudflare: { ...spec.cloudflare, kv: [{ binding: "DATA", namespaceName: "new-data", createIfMissing: true }] } },
      { ...spec, wrangler: { ...spec.wrangler, compatibility_date: "2026-01-01" } },
    ];
    for (const changed of variants) {
      const plan = await buildDeployPlan({ spec: changed }, snapshot(), { salt: SALT });
      expect(plan.digest).not.toBe(original.digest);
    }
  });
  it("produces an install plan for a fresh worker without guards", async () => {
    const spec = specFor("minimal-worker");
    const plan = await buildDeployPlan({ spec }, snapshot(), { salt: SALT });
    expect(plan.kind).toBe("install");
    expect(plan.blocked).toBe(false);
    expect(plan.accountId).toBe(ACCOUNT);
    expect(plan.workerName).toBe("tapdeploy-fixture-minimal");
    expect(plan.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: "worker", action: "create" }),
        expect.objectContaining({ resource: "deployment", action: "create" }),
      ]),
    );
    expect(plan.guards).toEqual([]);
    expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces an upgrade plan on an installer-managed worker", async () => {
    const spec = specFor("minimal-worker");
    const plan = await buildDeployPlan(
      { spec },
      snapshot({
        workerExists: true,
        versions: managedVersions(),
        latestVersionId: "version-1",
        activeDeploymentId: "deployment-1",
        activeDeploymentVersionIds: ["version-1"],
      }),
      { salt: SALT },
    );
    expect(plan.kind).toBe("upgrade");
    expect(plan.blocked).toBe(false);
    expect(plan.activeDeploymentId).toBe("deployment-1");
    expect(plan.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: "deployment",
          action: "create",
          before: "deployment-1",
        }),
      ]),
    );
  });

  it("blocks adoption of an unmanaged pre-existing worker", async () => {
    const spec = specFor("minimal-worker");
    const plan = await buildDeployPlan(
      { spec },
      snapshot({
        workerExists: true,
        versions: [{ id: "v-1", number: 1, message: "deployed by hand" }],
        latestVersionId: "v-1",
        activeDeploymentId: "dep-1",
      }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("unrelated-worker");
  });

  it("blocks when the expected account differs from the snapshot account", async () => {
    const spec = specFor("minimal-worker");
    const expected: ExpectedTarget = {
      accountId: "b".repeat(32),
      workerName: "tapdeploy-fixture-minimal",
    };
    const plan = await buildDeployPlan({ spec }, snapshot(), {
      salt: SALT,
      expected,
    });
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("wrong-account");
  });

  it("blocks when no account is bound", async () => {
    const spec = specFor("minimal-worker");
    const plan = await buildDeployPlan(
      { spec },
      snapshot({ accountId: "" }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("missing-account");
  });

  it("blocks on a stale deployed version", async () => {
    const spec = specFor("minimal-worker");
    const plan = await buildDeployPlan(
      { spec },
      snapshot({
        workerExists: true,
        versions: managedVersions(),
        latestVersionId: "version-2",
        activeDeploymentId: "dep-1",
      }),
      {
        salt: SALT,
        expected: {
          accountId: ACCOUNT,
          workerName: "tapdeploy-fixture-minimal",
          latestVersionId: "version-1",
          activeDeploymentId: "dep-1",
        },
      },
    );
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("stale-deployed-version");
  });

  it("blocks on remote active-deployment drift", async () => {
    const spec = specFor("minimal-worker");
    const plan = await buildDeployPlan(
      { spec },
      snapshot({
        workerExists: true,
        versions: managedVersions(),
        latestVersionId: "version-1",
        activeDeploymentId: "dep-2",
      }),
      {
        salt: SALT,
        expected: {
          accountId: ACCOUNT,
          workerName: "tapdeploy-fixture-minimal",
          activeDeploymentId: "dep-1",
        },
      },
    );
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("remote-drift");
  });

  it("conflicts on a declared R2 bucket that is missing and not createable", async () => {
    const spec = specFor("conflicting-r2-not-createable");
    const plan = await buildDeployPlan(
      { spec },
      snapshot({ r2Buckets: [] }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("r2-drift");
    expect(plan.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: "r2", action: "conflict" }),
      ]),
    );
  });

  it("plans to create a missing R2 bucket when createIfMissing is set", async () => {
    const spec = specFor("assets-r2-worker");
    const plan = await buildDeployPlan(
      { spec },
      snapshot({ r2Buckets: [], workerName: "tapdeploy-fixture-assets-r2" }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(false);
    expect(plan.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: "r2",
          action: "create",
          name: "tapdeploy-test-placeholder",
        }),
      ]),
    );
  });

  it("preserves an existing R2 bucket by identity and binds it in the reference", async () => {
    const spec = specFor("assets-r2-worker");
    const plan = await buildDeployPlan(
      { spec },
      snapshot({
        workerName: "tapdeploy-fixture-assets-r2",
        r2Buckets: [{ name: "tapdeploy-test-placeholder", id: "bucket-9" }],
      }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(false);
    expect(plan.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: "r2",
          action: "preserve",
          before: "bucket-9",
        }),
      ]),
    );
    expect(planReference(plan).r2BucketIds).toEqual({
      "tapdeploy-test-placeholder": "bucket-9",
    });
  });

  it("blocks when an expected R2 bucket identity changed remotely", async () => {
    const spec = specFor("assets-r2-worker");
    const plan = await buildDeployPlan(
      { spec },
      snapshot({
        workerName: "tapdeploy-fixture-assets-r2",
        r2Buckets: [{ name: "tapdeploy-test-placeholder", id: "bucket-new" }],
      }),
      {
        salt: SALT,
        expected: {
          accountId: ACCOUNT,
          workerName: "tapdeploy-fixture-assets-r2",
          r2BucketIds: { "tapdeploy-test-placeholder": "bucket-old" },
        },
      },
    );
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("r2-drift");
  });

  it("plans to create a missing D1 database when createIfMissing is set", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.d1 = [{ binding: "DB", databaseName: "my-db", createIfMissing: true }];
    base.wrangler.d1_databases = [{ binding: "DB", database_name: "my-db" }];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({ d1Databases: [] }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(false);
    expect(plan.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: "d1", action: "create", name: "my-db" }),
      ]),
    );
  });

  it("preserves an existing D1 database by identity and binds it in the reference", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.d1 = [{ binding: "DB", databaseName: "my-db", createIfMissing: true }];
    base.wrangler.d1_databases = [{ binding: "DB", database_name: "my-db" }];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({ d1Databases: [{ name: "my-db", id: "db-1" }] }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(false);
    const reference = planReference(plan);
    expect(reference.d1DatabaseIds).toEqual({ "my-db": "db-1" });
  });

  it("blocks when a declared D1 database is missing and createIfMissing is false", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.d1 = [{ binding: "DB", databaseName: "my-db", createIfMissing: false }];
    base.wrangler.d1_databases = [{ binding: "DB", database_name: "my-db" }];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({ d1Databases: [] }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("d1-drift");
  });

  it("plans to create a missing KV namespace when createIfMissing is set", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.kv = [{ binding: "KV", namespaceName: "my-ns", createIfMissing: true }];
    base.wrangler.kv_namespaces = [{ binding: "KV", id: "" }];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({ kvNamespaces: [] }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(false);
    expect(plan.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: "kv", action: "create", name: "my-ns" }),
      ]),
    );
  });

  it("preserves an existing KV namespace by identity and binds it in the reference", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.kv = [{ binding: "KV", namespaceName: "my-ns", createIfMissing: true }];
    base.wrangler.kv_namespaces = [{ binding: "KV", id: "" }];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({ kvNamespaces: [{ name: "my-ns", id: "ns-1" }] }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(false);
    const reference = planReference(plan);
    expect(reference.kvNamespaceIds).toEqual({ "my-ns": "ns-1" });
  });

  it("blocks when a declared KV namespace is missing and createIfMissing is false", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.kv = [{ binding: "KV", namespaceName: "my-ns", createIfMissing: false }];
    base.wrangler.kv_namespaces = [{ binding: "KV", id: "" }];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({ kvNamespaces: [] }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("kv-drift");
  });

  it("plans to create a missing Queue when createIfMissing is set", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.queues = [{ binding: "Q", queueName: "my-queue", createIfMissing: true, role: "producer" }];
    base.wrangler.queues = [{ binding: "Q", queue_name: "my-queue", role: "producer" }];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({ queues: [] }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(false);
    expect(plan.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: "queue", action: "create", name: "my-queue" }),
      ]),
    );
  });

  it("preserves an existing Queue by identity and binds it in the reference", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.queues = [{ binding: "Q", queueName: "my-queue", createIfMissing: true, role: "producer" }];
    base.wrangler.queues = [{ binding: "Q", queue_name: "my-queue", role: "producer" }];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({ queues: [{ name: "my-queue", id: "queue-1" }] }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(false);
    const reference = planReference(plan);
    expect(reference.queueIds).toEqual({ "my-queue": "queue-1" });
  });

  it("blocks when a declared Queue is missing and createIfMissing is false", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.queues = [{ binding: "Q", queueName: "my-queue", createIfMissing: false, role: "producer" }];
    base.wrangler.queues = [{ binding: "Q", queue_name: "my-queue", role: "producer" }];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({ queues: [] }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("queue-drift");
  });

  it("plans to create a missing Hyperdrive config when createIfMissing is set", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.hyperdrive = [{ binding: "HD", configName: "my-hd", createIfMissing: true, origin: { database: "app", host: "db.example.com", user: "app", password: "fake", port: 5432, scheme: "postgresql" } }];
    base.wrangler.hyperdrive = [{ binding: "HD", id: "" }];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({ hyperdriveConfigs: [] }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(false);
    expect(plan.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: "hyperdrive", action: "create", name: "my-hd" }),
      ]),
    );
  });

  it("preserves an existing Hyperdrive config by identity and binds it in the reference", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.hyperdrive = [{ binding: "HD", configName: "my-hd", createIfMissing: true }];
    base.wrangler.hyperdrive = [{ binding: "HD", id: "" }];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({ hyperdriveConfigs: [{ name: "my-hd", id: "hd-1" }] }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(false);
    const reference = planReference(plan);
    expect(reference.hyperdriveConfigIds).toEqual({ "my-hd": "hd-1" });
  });

  it("blocks when a declared Hyperdrive config is missing and createIfMissing is false", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.hyperdrive = [{ binding: "HD", configName: "my-hd", createIfMissing: false }];
    base.wrangler.hyperdrive = [{ binding: "HD", id: "" }];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({ hyperdriveConfigs: [] }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("hyperdrive-drift");
  });

  it("plans to create a missing Vectorize index when createIfMissing is set", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.vectorize = [{ binding: "VZ", indexName: "my-index", createIfMissing: true }];
    base.wrangler.vectorize = [{ binding: "VZ", index_name: "my-index" }];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({ vectorizeIndexes: [] }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(false);
    expect(plan.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: "vectorize", action: "create", name: "my-index" }),
      ]),
    );
  });

  it("preserves an existing Vectorize index by identity and binds it in the reference", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.vectorize = [{ binding: "VZ", indexName: "my-index", createIfMissing: true }];
    base.wrangler.vectorize = [{ binding: "VZ", index_name: "my-index" }];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({ vectorizeIndexes: [{ name: "my-index", id: "vz-1" }] }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(false);
    const reference = planReference(plan);
    expect(reference.vectorizeIndexIds).toEqual({ "my-index": "vz-1" });
  });

  it("blocks when a declared Vectorize index is missing and createIfMissing is false", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.vectorize = [{ binding: "VZ", indexName: "my-index", createIfMissing: false }];
    base.wrangler.vectorize = [{ binding: "VZ", index_name: "my-index" }];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({ vectorizeIndexes: [] }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("vectorize-drift");
  });

  it("plans to create a missing Secrets Store store when createIfMissing is set", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.secretsStore = [{ binding: "SS", storeName: "my-store", createIfMissing: true, secretName: "token", secretCreateIfMissing: true }];
    base.wrangler.secrets_store_secrets = [];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({ secretsStores: [] }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(false);
    expect(plan.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: "secrets-store", action: "create", name: "my-store" }),
      ]),
    );
  });

  it("preserves an existing Secrets Store store by identity and binds it in the reference", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.secretsStore = [{ binding: "SS", storeName: "my-store", createIfMissing: true, secretName: "token", secretCreateIfMissing: true }];
    base.wrangler.secrets_store_secrets = [];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({ secretsStores: [{ name: "my-store", id: "store-1" }] }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(false);
    const reference = planReference(plan);
    expect(reference.secretsStoreIds).toEqual({ "my-store": "store-1" });
  });

  it("blocks when a declared Secrets Store store is missing and createIfMissing is false", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.secretsStore = [{ binding: "SS", storeName: "my-store", createIfMissing: false }];
    base.wrangler.secrets_store_secrets = [];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({ secretsStores: [] }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("secrets-store-drift");
  });

  it("plans to create a missing Secrets Store secret inside a present store and preserves an existing one", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.secretsStore = [
      {
        binding: "SS",
        storeName: "my-store",
        createIfMissing: true,
        secretName: "api-token",
        secretCreateIfMissing: true,
      },
    ];
    base.wrangler.secrets_store_secrets = [
      { binding: "SS", store_id: "", secret_name: "api-token" },
    ];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({
        secretsStores: [{ name: "my-store", id: "store-1" }],
        secretsStoreSecrets: [],
      }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(false);
    expect(plan.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: "secrets-store",
          action: "create",
          name: "my-store/api-token",
        }),
      ]),
    );
  });

  it("preserves a declared Secrets Store secret by identity and never leaks its value", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.secretsStore = [
      {
        binding: "SS",
        storeName: "my-store",
        createIfMissing: true,
        secretName: "api-token",
        secretCreateIfMissing: true,
        secretValue: "s3cr3t",
      },
    ];
    base.wrangler.secrets_store_secrets = [
      { binding: "SS", store_id: "", secret_name: "api-token" },
    ];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({
        secretsStores: [{ name: "my-store", id: "store-1" }],
        secretsStoreSecrets: [
          { secretName: "api-token", id: "secret-1", store_id: "store-1" },
        ],
      }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(false);
    const reference = planReference(plan);
    // The preserved secret identity is bound into the reference.
    expect(Object.keys(reference.secretsStoreIds ?? {})).toContain("my-store");
  });

  it("preserves an existing secret and plans a create for a missing one", async () => {
    const spec = specFor("minimal-worker-secret-policies");
    const plan = await buildDeployPlan(
      { spec },
      snapshot({
        workerExists: true,
        versions: managedVersions(),
        secretNames: ["API_KEY"],
      }),
      { salt: SALT },
    );
    expect(plan.secretSummary).toEqual([
      { name: "API_KEY", policy: "preserve-only", exists: true },
      { name: "TOKEN", policy: "generate-once", exists: false },
    ]);
    expect(plan.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: "secret", action: "preserve", name: "API_KEY" }),
        expect.objectContaining({ resource: "secret", action: "create", name: "TOKEN" }),
      ]),
    );
  });

  it("blocks when a previously tracked secret disappeared", async () => {
    const spec = specFor("minimal-worker");
    const plan = await buildDeployPlan(
      { spec },
      snapshot({ secretNames: [] }),
      {
        salt: SALT,
        expected: {
          accountId: ACCOUNT,
          workerName: "tapdeploy-fixture-minimal",
          secretNames: ["API_KEY"],
        },
      },
    );
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("secret-drift");
  });

  it("preserves equal schedules and plans an update for changed crons", async () => {
    const spec = specFor("minimal-worker-daily-cron");
    const same = await buildDeployPlan(
      { spec },
      snapshot({
        workerExists: true,
        versions: managedVersions(),
        scheduleCrons: ["0 0 * * *"],
      }),
      { salt: SALT },
    );
    expect(same.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: "schedule", action: "preserve" }),
      ]),
    );

    const changed = await buildDeployPlan(
      { spec },
      snapshot({
        workerExists: true,
        versions: managedVersions(),
        scheduleCrons: ["0 0 * * *"],
        activeDeploymentId: "dep-1",
        activeDeploymentVersionIds: ["version-1"],
        latestVersionId: "version-1",
      }),
      { salt: SALT, expected: undefined },
    );
    // Flip the cron set on a copy of the spec to force an update diff.
    const flipped = structuredClone(spec);
    flipped.cloudflare.cron = ["5 4 * * *"];
    flipped.wrangler.crons = ["5 4 * * *"];
    expect(changed.kind).toBe("upgrade");
    expect(changed.blocked).toBe(false);
    const upd = await buildDeployPlan(
      { spec: flipped },
      snapshot({
        workerExists: true,
        versions: managedVersions(),
        scheduleCrons: ["0 0 * * *"],
        activeDeploymentVersionIds: ["version-1"],
      }),
      { salt: SALT },
    );
    expect(upd.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: "schedule", action: "update" }),
      ]),
    );
  });

  it("never plans changes to an existing rate-limit set", async () => {
    const spec = specFor("minimal-worker");
    const plan = await buildDeployPlan(
      { spec },
      snapshot({ rateLimitCount: 2 }),
      { salt: SALT },
    );
    expect(plan.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: "rate-limit", action: "preserve" }),
      ]),
    );
    expect(plan.diffs.filter((d) => d.resource === "rate-limit")).toHaveLength(1);
  });

  it("returns a blocked plan on contradictory manifest projection", async () => {
    const plan = await buildDeployPlan(
      {
        projectionIssues: [
          { kind: "conflicting-r2", field: "r2_buckets.FILES", detail: "duplicate" },
        ],
      },
      snapshot(),
      { salt: SALT },
    );
    expect(plan.kind).toBe("blocked");
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("contradictory-manifest");
    expect(plan.digest).toBe(`blocked:${SALT}`);
  });

  it("binds the digest to salt, inputs, and artifact hashes", async () => {
    const spec = specFor("minimal-worker");
    const snap = snapshot({ workerExists: true, versions: managedVersions() });
    const a = await buildDeployPlan({ spec }, snap, { salt: "salt-a" });
    const a2 = await buildDeployPlan({ spec }, snap, { salt: "salt-a" });
    const b = await buildDeployPlan({ spec }, snap, { salt: "salt-b" });
    expect(a.digest).toBe(a2.digest);
    expect(a.digest).not.toBe(b.digest);

    const mutated = specFor("minimal-worker-renamed");
    const c = await buildDeployPlan({ spec: mutated }, snap, { salt: "salt-a" });
    expect(c.digest).not.toBe(a.digest);
  });
});

describe("digest helpers", () => {
  it("canonicalJson sorts keys regardless of insertion order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(`{"a":2,"b":1}`);
    expect(canonicalJson({ a: 2, b: 1 })).toBe(`{"a":2,"b":1}`);
    expect(canonicalJson([3, { y: 1, x: 0 }])).toBe(`[3,{"x":0,"y":1}]`);
    expect(canonicalJson({ drop: undefined })).toBe(`{}`);
  });

  it("isManagedWorker detects the installer marker in any version message", () => {
    expect(isManagedWorker([{ id: "1", message: TAPDEPLOY_MANAGED_MARKER }])).toBe(true);
    expect(isManagedWorker([{ id: "1", message: "plain" }])).toBe(false);
    expect(isManagedWorker([])).toBe(false);
  });

  it("managedWorkerProjectId extracts the project id from the version message", () => {
    expect(managedWorkerProjectId([{ id: "1", message: `fixture/minimal-worker v0.1.0 ${TAPDEPLOY_MANAGED_MARKER}` }])).toBe("fixture/minimal-worker");
    expect(managedWorkerProjectId([{ id: "1", message: TAPDEPLOY_MANAGED_MARKER }])).toBeUndefined();
    expect(managedWorkerProjectId([])).toBeUndefined();
  });

  it("isManagedWorkerForProject requires the marker AND a matching project id", () => {
    const same = [{ id: "1", message: `fixture/minimal-worker v0.1.0 ${TAPDEPLOY_MANAGED_MARKER}` }];
    const other = [{ id: "1", message: `fixture/other v0.1.0 ${TAPDEPLOY_MANAGED_MARKER}` }];
    expect(isManagedWorkerForProject(same, "fixture/minimal-worker")).toBe(true);
    expect(isManagedWorkerForProject(same, "fixture/other")).toBe(false);
    expect(isManagedWorkerForProject(other, "fixture/minimal-worker")).toBe(false);
    // Unknown project id falls back to the generic marker check (any managed worker).
    expect(isManagedWorkerForProject(same, undefined)).toBe(true);
    expect(isManagedWorkerForProject([{ id: "1", message: "plain" }], "fixture/minimal-worker")).toBe(false);
  });

  it("versionOwnerProjectId + currentVersion read ownership from a single/current version", () => {
    expect(versionOwnerProjectId({ id: "1", message: `app/A v1 ${TAPDEPLOY_MANAGED_MARKER}` })).toBe("app/A");
    expect(versionOwnerProjectId({ id: "1", message: TAPDEPLOY_MANAGED_MARKER })).toBeUndefined();
    expect(versionOwnerProjectId({ id: "1", message: "plain" })).toBeUndefined();
    const history = [
      { id: "new", number: 2, message: `app/B v2 ${TAPDEPLOY_MANAGED_MARKER}` },
      { id: "old", number: 1, message: `app/A v1 ${TAPDEPLOY_MANAGED_MARKER}` },
    ];
    expect(currentVersion(history)?.id).toBe("new");
    expect(managedWorkerProjectId(history)).toBe("app/B");
  });

  it("a HISTORICAL owner marker must not authorize an upgrade", () => {
    const history = [
      { id: "new", number: 2, message: `app/B v2 ${TAPDEPLOY_MANAGED_MARKER}` },
      { id: "old", number: 1, message: `app/A v1 ${TAPDEPLOY_MANAGED_MARKER}` },
    ];
    // The old app/A marker is historical; the current deployment is app/B.
    expect(isManagedWorkerForProject(history, "app/A")).toBe(false);
    expect(isManagedWorkerForProject(history, "app/B")).toBe(true);
  });

  it("resolveActiveOwnership uses only the active deployment version(s)", () => {
    const history = [
      { id: "new", number: 2, message: `app/B v2 ${TAPDEPLOY_MANAGED_MARKER}` },
      { id: "old", number: 1, message: `app/A v1 ${TAPDEPLOY_MANAGED_MARKER}` },
    ];
    // Active deployment is the old app/A version -> adopting app/A is allowed
    // (it IS the current owner), and adopting app/B is refused.
    expect(resolveActiveOwnership(history, ["old"], "app/A")).toMatchObject({ owned: true });
    expect(resolveActiveOwnership(history, ["old"], "app/B")).toMatchObject({ owned: false, managedOther: true });
    // Active deployment is app/B -> the historical app/A marker cannot authorize.
    expect(resolveActiveOwnership(history, ["new"], "app/A")).toMatchObject({ owned: false, managedOther: true });
    expect(resolveActiveOwnership(history, ["new"], "app/B")).toMatchObject({ owned: true });
  });

  it("resolveActiveOwnership fails closed on missing or unresolvable active data", () => {
    const history = [{ id: "new", number: 2, message: `app/B v2 ${TAPDEPLOY_MANAGED_MARKER}` }];
    expect(resolveActiveOwnership(history, [], "app/B")).toMatchObject({ owned: false, unresolved: true });
    expect(resolveActiveOwnership(history, ["ghost"], "app/B")).toMatchObject({ owned: false, unresolved: true });
    expect(resolveActiveOwnership(history, [], "app/B").detail).toMatch(/no active deployment version/i);
  });

  it("resolveActiveOwnership fails closed on an inconsistent traffic split", () => {
    const history = [
      { id: "new", number: 2, message: `app/B v2 ${TAPDEPLOY_MANAGED_MARKER}` },
      { id: "old", number: 1, message: `app/A v1 ${TAPDEPLOY_MANAGED_MARKER}` },
    ];
    const split = resolveActiveOwnership(history, ["new", "old"], "app/B");
    expect(split).toMatchObject({ owned: false, ambiguous: true });
    expect(split.detail).toMatch(/split/i);
    // A split between an unnamed bare marker and a named project is also ambiguous.
    const bareSplit = resolveActiveOwnership(
      [
        { id: "n", number: 2, message: `app/B v2 ${TAPDEPLOY_MANAGED_MARKER}` },
        { id: "b", number: 1, message: TAPDEPLOY_MANAGED_MARKER },
      ],
      ["n", "b"],
      "app/B",
    );
    expect(bareSplit).toMatchObject({ owned: false, ambiguous: true });
  });

  it("computePlanDigest binds artifact hashes one-way", async () => {
    const digest = await computePlanDigest(
      {
        spec: {
          worker: { path: "worker/main.mjs", size: 1, sha256: "a".repeat(64) },
          assets: [{ path: "assets/index.html", size: 2, sha256: "b".repeat(64) }],
        } as never,
        accountId: ACCOUNT,
        workerName: "w",
        activeDeploymentId: "dep-1",
        diffSummary: [{ resource: "worker", action: "create" }],
        inputs: { secretInput: "super-secret-value" },
      },
      SALT,
    );
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain("super-secret-value");
  });
});

describe("pre-write drift detection", () => {
  it("reports no drift when the reference matches the current snapshot", () => {
    const ref: ExpectedTarget = {
      accountId: ACCOUNT,
      workerName: "w",
      activeDeploymentId: "dep-1",
      r2BucketIds: { b: "bucket-1" },
      secretNames: ["API_KEY"],
    };
    const current = snapshot({
      workerName: "w",
      activeDeploymentId: "dep-1",
      r2Buckets: [{ name: "b", id: "bucket-1" }],
      secretNames: ["API_KEY"],
    });
    expect(detectDrift(ref, current).drifted).toBe(false);
  });

  it("flags every identity change in the current snapshot", () => {
    const ref: ExpectedTarget = {
      accountId: ACCOUNT,
      workerName: "w",
      activeDeploymentId: "dep-1",
      r2BucketIds: { b: "bucket-1" },
      secretNames: ["API_KEY"],
    };
    const current = snapshot({
      workerName: "w",
      activeDeploymentId: "dep-9",
      r2Buckets: [{ name: "b", id: "bucket-2" }],
      secretNames: [],
    });
    const result = detectDrift(ref, current);
    expect(result.drifted).toBe(true);
    expect(result.reasons.join("\n")).toMatch(/active deployment id changed/);
    expect(result.reasons.join("\n")).toMatch(/identity changed/);
    expect(result.reasons.join("\n")).toMatch(/no longer present/);
  });

  it("flags account and worker name changes", () => {
    const ref: ExpectedTarget = { accountId: ACCOUNT, workerName: "w" };
    const current = snapshot({ workerName: "renamed" });
    current.accountId = "b".repeat(32);
    const result = detectDrift(ref, current);
    expect(result.drifted).toBe(true);
    expect(result.reasons.join("\n")).toMatch(/account changed/);
    expect(result.reasons.join("\n")).toMatch(/worker name changed/);
  });

  it("flags Queue + Hyperdrive identity changes in the current snapshot", () => {
    const ref: ExpectedTarget = {
      accountId: ACCOUNT,
      workerName: "w",
      queueIds: { "my-queue": "queue-1" },
      hyperdriveConfigIds: { "my-hd": "hd-1" },
    };
    const current = snapshot({
      queues: [{ name: "my-queue", id: "queue-2" }],
      hyperdriveConfigs: [{ name: "my-hd", id: "hd-2" }],
    });
    const result = detectDrift(ref, current);
    expect(result.drifted).toBe(true);
    expect(result.reasons.join("\n")).toMatch(/Queue "my-queue" identity changed/);
    expect(result.reasons.join("\n")).toMatch(/Hyperdrive config "my-hd" identity changed/);
  });
});

// a binding that was bound at plan time and later DISAPPEARED must be a
// blocking drift, not a silent no-op (the old `now !== undefined && ...` guard
// let an outsider delete an approved binding). Every resource family is covered.
describe("binding disappearance is blocking drift", () => {
  interface DriftCase {
    label: string;
    ref: ExpectedTarget;
    missing: TargetSnapshot;
    changed: TargetSnapshot;
    same: TargetSnapshot;
    reason: RegExp;
  }

  const cases: DriftCase[] = [
    {
      label: "workerR2Bindings",
      ref: { accountId: ACCOUNT, workerName: "w", workerR2Bindings: { BUCKET: "bucket-a" } },
      missing: snapshot({ workerName: "w", workerR2Bindings: {} }),
      changed: snapshot({ workerName: "w", workerR2Bindings: { BUCKET: "bucket-b" } }),
      same: snapshot({ workerName: "w", workerR2Bindings: { BUCKET: "bucket-a" } }),
      reason: /R2 binding "BUCKET" identity changed \(bucket-a -> missing\)/,
    },
    {
      label: "deployedBindings.r2",
      ref: { accountId: ACCOUNT, workerName: "w", deployedBindings: { r2: { BUCKET: "bucket-a" } } },
      missing: snapshot({ workerName: "w", deployedBindings: { r2: {} } }),
      changed: snapshot({ workerName: "w", deployedBindings: { r2: { BUCKET: "bucket-b" } } }),
      same: snapshot({ workerName: "w", deployedBindings: { r2: { BUCKET: "bucket-a" } } }),
      reason: /R2 binding "BUCKET" rebind \(bucket-a -> missing\)/,
    },
    {
      label: "deployedBindings.d1",
      ref: { accountId: ACCOUNT, workerName: "w", deployedBindings: { d1: { DB: "db-1" } } },
      missing: snapshot({ workerName: "w", deployedBindings: { d1: {} } }),
      changed: snapshot({ workerName: "w", deployedBindings: { d1: { DB: "db-2" } } }),
      same: snapshot({ workerName: "w", deployedBindings: { d1: { DB: "db-1" } } }),
      reason: /D1 binding "DB" rebind \(db-1 -> missing\)/,
    },
    {
      label: "deployedBindings.kv",
      ref: { accountId: ACCOUNT, workerName: "w", deployedBindings: { kv: { KV: "ns-1" } } },
      missing: snapshot({ workerName: "w", deployedBindings: { kv: {} } }),
      changed: snapshot({ workerName: "w", deployedBindings: { kv: { KV: "ns-2" } } }),
      same: snapshot({ workerName: "w", deployedBindings: { kv: { KV: "ns-1" } } }),
      reason: /KV binding "KV" rebind \(ns-1 -> missing\)/,
    },
    {
      label: "deployedBindings.queue",
      ref: { accountId: ACCOUNT, workerName: "w", deployedBindings: { queue: { Q: "q-1" } } },
      missing: snapshot({ workerName: "w", deployedBindings: { queue: {} } }),
      changed: snapshot({ workerName: "w", deployedBindings: { queue: { Q: "q-2" } } }),
      same: snapshot({ workerName: "w", deployedBindings: { queue: { Q: "q-1" } } }),
      reason: /Queue binding "Q" rebind \(q-1 -> missing\)/,
    },
    {
      label: "deployedBindings.hyperdrive",
      ref: { accountId: ACCOUNT, workerName: "w", deployedBindings: { hyperdrive: { HD: "hd-1" } } },
      missing: snapshot({ workerName: "w", deployedBindings: { hyperdrive: {} } }),
      changed: snapshot({ workerName: "w", deployedBindings: { hyperdrive: { HD: "hd-2" } } }),
      same: snapshot({ workerName: "w", deployedBindings: { hyperdrive: { HD: "hd-1" } } }),
      reason: /Hyperdrive binding "HD" rebind \(hd-1 -> missing\)/,
    },
    {
      label: "deployedBindings.vectorize",
      ref: { accountId: ACCOUNT, workerName: "w", deployedBindings: { vectorize: { VZ: "idx-1" } } },
      missing: snapshot({ workerName: "w", deployedBindings: { vectorize: {} } }),
      changed: snapshot({ workerName: "w", deployedBindings: { vectorize: { VZ: "idx-2" } } }),
      same: snapshot({ workerName: "w", deployedBindings: { vectorize: { VZ: "idx-1" } } }),
      reason: /Vectorize binding "VZ" rebind \(idx-1 -> missing\)/,
    },
    {
      label: "deployedBindings.secretsStore",
      ref: {
        accountId: ACCOUNT,
        workerName: "w",
        deployedBindings: { secretsStore: { SEC: { storeId: "store-1", secretName: "secret-1" } } },
      },
      missing: snapshot({ workerName: "w", deployedBindings: { secretsStore: {} } }),
      changed: snapshot({ workerName: "w", deployedBindings: { secretsStore: { SEC: { storeId: "store-2", secretName: "secret-1" } } } }),
      same: snapshot({ workerName: "w", deployedBindings: { secretsStore: { SEC: { storeId: "store-1", secretName: "secret-1" } } } }),
      reason: /Secrets Store binding "SEC" rebind \(store-1\/secret-1 -> missing\)/,
    },
  ];

  for (const c of cases) {
    it(`${c.label}: present -> missing is drift`, () => {
      const result = detectDrift(c.ref, c.missing);
      expect(result.drifted).toBe(true);
      expect(result.reasons.join("\n")).toMatch(c.reason);
    });

    it(`${c.label}: present -> different is still drift`, () => {
      expect(detectDrift(c.ref, c.changed).drifted).toBe(true);
    });

    it(`${c.label}: unchanged binding is not drift`, () => {
      expect(detectDrift(c.ref, c.same).drifted).toBe(false);
    });
  }
});

describe("plan-level blocking: a missing approved binding blocks before write", () => {
  const planCases: { label: string; code: string; expected: Partial<ExpectedTarget> }[] = [
    { label: "r2 via workerR2Bindings", code: "r2-drift", expected: { workerR2Bindings: { BUCKET: "bucket-a" } } },
    { label: "r2 via deployedBindings", code: "r2-drift", expected: { deployedBindings: { r2: { BUCKET: "bucket-a" } } } },
    { label: "d1", code: "d1-drift", expected: { deployedBindings: { d1: { DB: "db-1" } } } },
    { label: "kv", code: "kv-drift", expected: { deployedBindings: { kv: { KV: "ns-1" } } } },
    { label: "queue", code: "queue-drift", expected: { deployedBindings: { queue: { Q: "q-1" } } } },
    { label: "hyperdrive", code: "hyperdrive-drift", expected: { deployedBindings: { hyperdrive: { HD: "hd-1" } } } },
    { label: "vectorize", code: "vectorize-drift", expected: { deployedBindings: { vectorize: { VZ: "idx-1" } } } },
    {
      label: "secrets-store",
      code: "secrets-store-drift",
      expected: { deployedBindings: { secretsStore: { SEC: { storeId: "store-1", secretName: "secret-1" } } } },
    },
  ];

  const upgradeSnapshot = (overrides: Partial<TargetSnapshot> = {}) =>
    snapshot({
      workerExists: true,
      versions: managedVersions(),
      latestVersionId: "version-1",
      activeDeploymentId: "dep-1",
      activeDeploymentVersionIds: ["version-1"],
      ...overrides,
    });

  for (const c of planCases) {
    it(`${c.label}: blocks as external drift when the binding is gone`, async () => {
      const spec = specFor("minimal-worker");
      const plan = await buildDeployPlan(
        { spec },
        upgradeSnapshot(),
        {
          salt: SALT,
          expected: { accountId: ACCOUNT, workerName: "tapdeploy-fixture-minimal", activeDeploymentId: "dep-1", ...c.expected },
        },
      );
      expect(plan.blocked).toBe(true);
      expect(plan.guards.map((g) => g.code)).toContain(c.code);
    });

    it(`${c.label}: unchanged binding still plans clean`, async () => {
      const spec = specFor("minimal-worker");
      const live: Partial<TargetSnapshot> = {};
      if (c.expected.workerR2Bindings) live.workerR2Bindings = c.expected.workerR2Bindings;
      if (c.expected.deployedBindings) live.deployedBindings = c.expected.deployedBindings;
      const plan = await buildDeployPlan(
        { spec },
        upgradeSnapshot(live),
        {
          salt: SALT,
          expected: { accountId: ACCOUNT, workerName: "tapdeploy-fixture-minimal", activeDeploymentId: "dep-1", ...c.expected },
        },
      );
      expect(plan.blocked).toBe(false);
    });
  }
});

describe("deploy state machine: immutable digest across own writes", () => {
  it("keeps the digest stable across an own R2 create (preserve vs create)", async () => {
    const spec = specFor("assets-r2-worker");
    const before = await buildDeployPlan(
      { spec },
      snapshot({ workerName: "tapdeploy-fixture-assets-r2", r2Buckets: [] }),
      { salt: SALT },
    );
    const after = await buildDeployPlan(
      { spec },
      snapshot({
        workerName: "tapdeploy-fixture-assets-r2",
        r2Buckets: [{ name: "tapdeploy-test-placeholder", id: "bucket-1" }],
      }),
      { salt: SALT },
    );
    expect(after.digest).toBe(before.digest);
  });

  it("keeps the digest stable across an own activate (active deployment change)", async () => {
    const spec = specFor("minimal-worker");
    const dep1 = await buildDeployPlan(
      { spec },
      snapshot({
        workerExists: true,
        versions: managedVersions(),
        latestVersionId: "version-1",
        activeDeploymentId: "dep-1",
        activeDeploymentVersionIds: ["version-1"],
      }),
      { salt: SALT },
    );
    const dep2 = await buildDeployPlan(
      { spec },
      snapshot({
        workerExists: true,
        versions: managedVersions(),
        latestVersionId: "version-1",
        activeDeploymentId: "dep-2",
        activeDeploymentVersionIds: ["version-1"],
      }),
      { salt: SALT },
    );
    expect(dep2.digest).toBe(dep1.digest);
  });

  it("an upgrade plan that only carries the operator's target-kind intent is not drift", async () => {
    // The browser sends the operator's target kind with the first plan; that is
    // intent, not a frozen baseline, so it must not read as "the remote active
    // deployment changed since the plan was created".
    const plan = await buildDeployPlan(
      { spec: specFor("minimal-worker") },
      snapshot({
        workerExists: true,
        versions: managedVersions(),
        latestVersionId: "version-1",
        activeDeploymentId: "dep-1",
        activeDeploymentVersionIds: ["version-1"],
      }),
      { salt: SALT, intent: { targetKind: "workers" } },
    );
    expect(plan.guards.map((g) => g.code)).not.toContain("remote-drift");
    expect(plan.blocked).toBe(false);
    expect(plan.kind).toBe("upgrade");
  });

  it("still blocks an outside active-deployment drift via expected guards", async () => {
    const spec = specFor("minimal-worker");
    const base = await buildDeployPlan(
      { spec },
      snapshot({
        workerExists: true,
        versions: managedVersions(),
        latestVersionId: "version-1",
        activeDeploymentId: "dep-1",
        activeDeploymentVersionIds: ["version-1"],
      }),
      { salt: SALT },
    );
    const reference = planReference(base);
    const drifted = await buildDeployPlan(
      { spec },
      snapshot({
        workerExists: true,
        versions: managedVersions(),
        latestVersionId: "version-1",
        activeDeploymentId: "dep-9",
        activeDeploymentVersionIds: ["version-1"],
      }),
      { salt: SALT, expected: reference },
    );
    expect(drifted.blocked).toBe(true);
    expect(drifted.guards.map((g) => g.code)).toContain("remote-drift");
  });
});

describe("secrets/bindings upgrade", () => {
  it("keeps binding identity unchanged on standard upgrade (same bucket)", async () => {
    const spec = specFor("assets-r2-worker");
    const plan = await buildDeployPlan(
      { spec },
      snapshot({
        workerName: "tapdeploy-fixture-assets-r2",
        workerExists: true,
        versions: managedVersions("fixture/assets-r2-worker"),
        latestVersionId: "version-1",
        activeDeploymentId: "dep-1",
        activeDeploymentVersionIds: ["version-1"],
        r2Buckets: [{ name: "tapdeploy-test-placeholder", id: "bucket-1" }],
        workerR2Bindings: { FILES: "tapdeploy-test-placeholder" },
      }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(false);
  });

  it("refuses an unapproved R2 binding remap on upgrade", async () => {
    // Same binding FILES but a different bucket than the deployed map.
    const spec = specFor("assets-r2-worker-evil-bucket");
    const plan = await buildDeployPlan(
      { spec },
      snapshot({
        workerName: "tapdeploy-fixture-assets-r2",
        workerExists: true,
        versions: managedVersions("fixture/assets-r2-worker"),
        latestVersionId: "version-1",
        activeDeploymentId: "dep-1",
        activeDeploymentVersionIds: ["version-1"],
        r2Buckets: [
          { name: "tapdeploy-test-placeholder", id: "bucket-1" },
          { name: "evil-bucket", id: "bucket-evil" },
        ],
        workerR2Bindings: { FILES: "tapdeploy-test-placeholder" },
      }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("r2-drift");
    expect(plan.guards.map((g) => g.detail).join("\n")).toMatch(/FILES.*tapdeploy-test-placeholder.*evil-bucket/);
  });

  it("blocks an outside binding rebind via expected workerR2Bindings", async () => {
    const spec = specFor("assets-r2-worker");
    const baseSnap = snapshot({
      workerName: "tapdeploy-fixture-assets-r2",
      workerExists: true,
      versions: managedVersions("fixture/assets-r2-worker"),
      latestVersionId: "version-1",
      activeDeploymentId: "dep-1",
      activeDeploymentVersionIds: ["version-1"],
      r2Buckets: [{ name: "tapdeploy-test-placeholder", id: "bucket-1" }],
      workerR2Bindings: { FILES: "tapdeploy-test-placeholder" },
    });
    const base = await buildDeployPlan({ spec }, baseSnap, { salt: SALT });
    expect(base.blocked).toBe(false);
    const reference = planReference(base, baseSnap);
    expect(reference.workerR2Bindings).toEqual({ FILES: "tapdeploy-test-placeholder" });
    // Outside actor rebinds FILES to another bucket behind our back.
    const drifted = await buildDeployPlan(
      { spec },
      snapshot({
        workerName: "tapdeploy-fixture-assets-r2",
        workerExists: true,
        versions: managedVersions("fixture/assets-r2-worker"),
        latestVersionId: "version-1",
        activeDeploymentId: "dep-1",
        activeDeploymentVersionIds: ["version-1"],
        r2Buckets: [
          { name: "tapdeploy-test-placeholder", id: "bucket-1" },
          { name: "evil-bucket", id: "bucket-evil" },
        ],
        workerR2Bindings: { FILES: "evil-bucket" },
      }),
      { salt: SALT, expected: reference },
    );
    expect(drifted.blocked).toBe(true);
    expect(drifted.guards.map((g) => g.code)).toContain("r2-drift");
  });
});
describe("upgrade guards: project ownership and no silent rebind", () => {
  it("blocks a worker that is managed by a DIFFERENT installer project", async () => {
    const spec = specFor("minimal-worker"); // project id fixture/minimal-worker
    const plan = await buildDeployPlan(
      { spec },
      snapshot({
        workerExists: true,
        versions: [{ id: "version-1", number: 1, message: `fixture/other-project v0.1.0 ${TAPDEPLOY_MANAGED_MARKER}` }],
        latestVersionId: "version-1",
        activeDeploymentId: "dep-1",
        activeDeploymentVersionIds: ["version-1"],
      }),
      { salt: SALT },
    );
    expect(plan.kind).toBe("upgrade");
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("unrelated-worker");
    expect(plan.guards.find((g) => g.code === "unrelated-worker")!.detail).toMatch(/different installer project/);
  });

  it("accepts a worker that is managed by the SAME project identity", async () => {
    const spec = specFor("minimal-worker");
    const plan = await buildDeployPlan(
      { spec },
      snapshot({
        workerExists: true,
        versions: managedVersions("fixture/minimal-worker"),
        latestVersionId: "version-1",
        activeDeploymentId: "dep-1",
        activeDeploymentVersionIds: ["version-1"],
      }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(false);
  });

  it("a historical app/A marker cannot authorize an upgrade of the active app/B worker", async () => {
    const spec = specFor("minimal-worker");
    spec.project.id = "app/A";
    const plan = await buildDeployPlan(
      { spec },
      snapshot({
        workerExists: true,
        versions: [
          { id: "new", number: 2, message: `app/B v2 ${TAPDEPLOY_MANAGED_MARKER}` },
          { id: "old", number: 1, message: `app/A v1 ${TAPDEPLOY_MANAGED_MARKER}` },
        ],
        latestVersionId: "new",
        activeDeploymentId: "dep-1",
        activeDeploymentVersionIds: ["new"],
      }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("unrelated-worker");
    expect(plan.guards.find((g) => g.code === "unrelated-worker")!.detail).toMatch(/different installer project/);
  });

  it("an active traffic split across projects fails closed", async () => {
    const spec = specFor("minimal-worker");
    const plan = await buildDeployPlan(
      { spec },
      snapshot({
        workerExists: true,
        versions: [
          { id: "new", number: 2, message: `fixture/minimal-worker v0.2.0 ${TAPDEPLOY_MANAGED_MARKER}` },
          { id: "old", number: 1, message: `fixture/other v0.1.0 ${TAPDEPLOY_MANAGED_MARKER}` },
        ],
        latestVersionId: "new",
        activeDeploymentId: "dep-1",
        activeDeploymentVersionIds: ["new", "old"],
      }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("unrelated-worker");
    expect(plan.guards.find((g) => g.code === "unrelated-worker")!.detail).toMatch(/split/i);
  });

  it("an existing worker with no active deployment fails closed", async () => {
    const spec = specFor("minimal-worker");
    const plan = await buildDeployPlan(
      { spec },
      snapshot({
        workerExists: true,
        versions: managedVersions(),
        latestVersionId: "version-1",
        // No active deployment is resolvable.
      }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("unrelated-worker");
    expect(plan.guards.find((g) => g.code === "unrelated-worker")!.detail).toMatch(/no active deployment version/i);
  });

  it("the current active version being the same project still upgrades", async () => {
    const spec = specFor("minimal-worker");
    const plan = await buildDeployPlan(
      { spec },
      snapshot({
        workerExists: true,
        versions: managedVersions("fixture/minimal-worker"),
        latestVersionId: "version-1",
        activeDeploymentId: "dep-1",
        activeDeploymentVersionIds: ["version-1"],
      }),
      { salt: SALT },
    );
    expect(plan.kind).toBe("upgrade");
    expect(plan.blocked).toBe(false);
  });

  it("blocks a silent D1 rebind on upgrade (binding points at a different database)", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.d1 = [{ binding: "DB", databaseName: "desired-db", createIfMissing: true }];
    base.wrangler.d1_databases = [{ binding: "DB", database_name: "desired-db" }];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({
        workerExists: true,
        versions: managedVersions(),
        latestVersionId: "version-1",
        activeDeploymentId: "dep-1",
        activeDeploymentVersionIds: ["version-1"],
        d1Databases: [{ name: "desired-db", id: "db-desired" }],
        deployedBindings: { d1: { DB: "db-deployed-other" } },
      }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("d1-drift");
    expect(plan.guards.find((g) => g.code === "d1-drift")!.detail).toMatch(/binding "DB"/i);
  });

  it("allows a KV binding that already points at the declared namespace (no false rebind)", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.kv = [{ binding: "KV", namespaceName: "my-ns", createIfMissing: true }];
    base.wrangler.kv_namespaces = [{ binding: "KV", id: "ns-current" }];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({
        workerExists: true,
        versions: managedVersions(),
        latestVersionId: "version-1",
        activeDeploymentId: "dep-1",
        activeDeploymentVersionIds: ["version-1"],
        kvNamespaces: [{ name: "my-ns", id: "ns-current" }],
        deployedBindings: { kv: { KV: "ns-current" } },
      }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(false);
  });

  it("blocks a silent Vectorize rebind on upgrade (binding points at a different index)", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.vectorize = [{ binding: "VZ", indexName: "desired-index", createIfMissing: true }];
    base.wrangler.vectorize = [{ binding: "VZ", index_name: "desired-index" }];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({
        workerExists: true,
        versions: managedVersions(),
        latestVersionId: "version-1",
        activeDeploymentId: "dep-1",
        activeDeploymentVersionIds: ["version-1"],
        vectorizeIndexes: [{ name: "desired-index", id: "vz-desired" }],
        deployedBindings: { vectorize: { VZ: "deployed-other-index" } },
      }),
      { salt: SALT },
    );
    expect(plan.blocked).toBe(true);
    expect(plan.guards.map((g) => g.code)).toContain("vectorize-drift");
  });

  it("populates before/after on a preserved binding so the UI can show the current target", async () => {
    const base = specFor("minimal-worker");
    base.cloudflare.r2 = [{ binding: "FILES", bucketName: "tapdeploy-test-placeholder", createIfMissing: true }];
    base.wrangler.r2_buckets = [{ binding: "FILES", bucket_name: "tapdeploy-test-placeholder" }];
    const plan = await buildDeployPlan(
      { spec: base },
      snapshot({
        workerExists: true,
        versions: managedVersions(),
        latestVersionId: "version-1",
        activeDeploymentId: "dep-1",
        activeDeploymentVersionIds: ["version-1"],
        r2Buckets: [{ name: "tapdeploy-test-placeholder", id: "bucket-1" }],
        deployedBindings: { r2: { FILES: "tapdeploy-test-placeholder" } },
      }),
      { salt: SALT },
    );
    const r2Diff = plan.diffs.find((d) => d.resource === "r2" && d.action === "preserve")!;
    expect(r2Diff.before).toBe("bucket-1");
    expect(r2Diff.after).toBe("bucket-1");
  });

  it("detectDrift flags an outside deployed-binding rebind for D1", () => {
    const ref: ExpectedTarget = {
      accountId: ACCOUNT,
      workerName: "w",
      deployedBindings: { d1: { DB: "db-deployed" } },
    };
    const cur = snapshot({
      workerExists: true,
      versions: managedVersions(),
      deployedBindings: { d1: { DB: "db-evil" } },
    });
    const result = detectDrift(ref, cur);
    expect(result.drifted).toBe(true);
    expect(result.reasons.join("\n")).toMatch(/D1 binding "DB" rebind/);
  });
});
