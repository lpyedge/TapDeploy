import { describe, expect, it } from "vitest";
import { verifyDeployedBindings } from "../../src/core/deploy/postcheck-bindings.js";
import type { DeploySpec } from "../../src/core/deploy-spec.js";
import type { TargetSnapshot } from "../../src/core/planning/types.js";

function spec(cloudflare: Partial<DeploySpec["cloudflare"]>): DeploySpec {
  return {
    assets: [], wrangler: { vars: {} },
    cloudflare: {
      workerName: "w",
      r2: [],
      d1: [],
      kv: [],
      queues: [],
      hyperdrive: [],
      vectorize: [],
      secretsStore: [],
      runtimeBindings: [],
      cron: [],
      secrets: {},
      ...cloudflare,
    },
  } as unknown as DeploySpec;
}

function snapshot(overrides: Partial<TargetSnapshot>): TargetSnapshot {
  return {
    d1Databases: [{ name: "db", id: "db-id" }],
    kvNamespaces: [{ name: "ns", id: "ns-id" }],
    hyperdriveConfigs: [{ name: "pg", id: "pg-id" }],
    secretsStores: [{ name: "store", id: "store-id" }],
    deployedBindings: {},
    ...overrides,
  } as unknown as TargetSnapshot;
}

const FULL_SPEC = spec({
  r2: [{ binding: "BUCKET", bucketName: "b", createIfMissing: true }],
  d1: [{ binding: "DB", databaseName: "db", createIfMissing: true }],
  kv: [{ binding: "CACHE", namespaceName: "ns", createIfMissing: true }],
  queues: [
    { binding: "JOBS", queueName: "q", createIfMissing: true, role: "producer" },
    { binding: "WORKER_CONSUMER", queueName: "q", createIfMissing: true, role: "consumer" },
  ],
  hyperdrive: [{ binding: "PG", configName: "pg" }],
  vectorize: [{ binding: "IDX", indexName: "idx", createIfMissing: true }],
  secretsStore: [{ binding: "SS", storeName: "store", secretName: "api" }],
  runtimeBindings: [
    { binding: "AI", type: "ai" },
    { binding: "BROWSER", type: "browser-rendering" },
  ],
});

const MATCHING = snapshot({
  deployedBindings: {
    r2: { BUCKET: "b" },
    d1: { DB: "db-id" },
    kv: { CACHE: "ns-id" },
    queue: { JOBS: "q" },
    hyperdrive: { PG: "pg-id" },
    vectorize: { IDX: "idx" },
    secretsStore: { SS: { storeId: "store-id", secretName: "api" } },
    runtime: { AI: "ai", BROWSER: "browser-rendering" },
  },
});

describe("verifyDeployedBindings", () => {
  it("passes when every declared binding resolves to the desired stable identity", () => {
    expect(verifyDeployedBindings(FULL_SPEC, MATCHING)).toEqual({ ok: true, mismatches: [] });
  });

  it("reports a binding that is missing from the deployed Worker", () => {
    const result = verifyDeployedBindings(FULL_SPEC, snapshot({ ...MATCHING, deployedBindings: { ...MATCHING.deployedBindings, r2: {} } }));
    expect(result.ok).toBe(false);
    expect(result.mismatches).toContain('r2 binding "BUCKET" is missing from the deployed Worker');
  });

  it("reports a binding that points at a different resource", () => {
    const result = verifyDeployedBindings(
      FULL_SPEC,
      snapshot({ ...MATCHING, deployedBindings: { ...MATCHING.deployedBindings, d1: { DB: "other-id" }, vectorize: { IDX: "other" } } }),
    );
    expect(result.mismatches).toEqual([
      'd1 binding "DB" resolves to other-id, expected db-id',
      'vectorize binding "IDX" resolves to other, expected idx',
    ]);
  });

  it("reports a missing runtime binding and ignores a consumer registration", () => {
    const result = verifyDeployedBindings(FULL_SPEC, snapshot({ ...MATCHING, deployedBindings: { ...MATCHING.deployedBindings, runtime: { AI: "ai" } } }));
    expect(result.mismatches).toEqual(['runtime binding "BROWSER" (browser-rendering) is missing from the deployed Worker']);
  });

  it("reports a resource that does not exist in the account so no id can be expected", () => {
    const result = verifyDeployedBindings(FULL_SPEC, snapshot({ ...MATCHING, kvNamespaces: [] }));
    expect(result.mismatches).toEqual(['kv binding "CACHE": namespace "ns" does not exist in the account']);
  });

  it("requires declared rate-limit bindings on the exact active Worker", () => {
    const rlSpec = {
      ...spec({}),
      wrangler: {
        vars: {},
        ratelimits: [
          { name: "RATE_A", namespace_id: "1001", limit: 100, period: 60 },
          { name: "RATE_B", namespace_id: "1002", limit: 10, period: 10 },
        ],
      },
    } as unknown as DeploySpec;
    const present = snapshot({
      activeBindings: [
        { name: "RATE_A", type: "ratelimit" },
        { name: "RATE_B", type: "ratelimit" },
      ],
    });
    expect(verifyDeployedBindings(rlSpec, present)).toEqual({ ok: true, mismatches: [] });
    const missing = verifyDeployedBindings(
      rlSpec,
      snapshot({ activeBindings: [{ name: "RATE_A", type: "ratelimit" }] }),
    );
    expect(missing.ok).toBe(false);
    expect(missing.mismatches).toEqual(['rate-limit binding "RATE_B" is missing from the deployed Worker']);
  });
});
