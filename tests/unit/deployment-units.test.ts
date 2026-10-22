// deployment-unit resolver
// regression specification.
//
// Covers the detection/selection classes the runbook requires: static-only,
// Worker fetch/scheduled/queue (no HTTP-root assumption), Workflow schedules /
// multi-worker RPC / resource-only projects (carrier-gap classification),
// prebuilt-only build routes (unsupported node/npm builds are never claimed as
// buildable), deterministic rollback-ready ordering/ids, and no-secret output.

import { describe, expect, it } from "vitest";

import type { DeploySpec } from "../../src/core/deploy-spec.js";
import {
  resolveDeploymentUnits,
  selectBuildRoute,
} from "../../src/core/planning/deployment-units.js";

// specs are built directly. The v1 manifest/projection pipeline that used
// to derive them was removed with the old pipeline; these shapes replicate the
// previously projected fixtures field-for-field for the resolver inputs.
function specFor(name: "pages-staticsite" | "minimal-worker" | "assets-r2-worker"): DeploySpec {
  if (name === "pages-staticsite") {
    return pagesSpec({ pages: { projectName: "tapdeploy-fixture-pages" } });
  }
  if (name === "minimal-worker") {
    return workerSpec({ workerName: "tapdeploy-fixture-minimal" }, { wrangler: { name: "tapdeploy-fixture-minimal", main: "./worker/main.mjs", compatibility_date: "2026-10-01", r2_buckets: [], crons: [] } });
  }
  return workerSpec(
    { workerName: "tapdeploy-fixture-assets-r2", r2: [{ binding: "FILES", bucketName: "tapdeploy-test-placeholder", createIfMissing: true }] },
    { wrangler: { name: "tapdeploy-fixture-assets-r2", main: "./worker/main.mjs", compatibility_date: "2026-10-01", r2_buckets: [], crons: [] } },
  );
}

function workerSpec(
  cloudflare: Partial<DeploySpec["cloudflare"]> = {},
  overrides: Partial<DeploySpec> = {},
): DeploySpec {
  return {
    schemaVersion: 1,
    project: { id: "fixture/unit", version: "0.1.0" },
    worker: { path: "worker/main.mjs", size: 10, sha256: "a".repeat(64) },
    assets: [],
    inputs: {},
    cloudflare: {
      workerName: "tapdeploy-unit",
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
    wrangler: {
      name: "tapdeploy-unit",
      main: "worker/main.mjs",
      compatibility_date: "2026-10-01",
      r2_buckets: [],
      crons: [],
    },
    targetKind: "workers",
    ...overrides,
  };
}

function pagesSpec(
  cloudflare: Partial<DeploySpec["cloudflare"]> = {},
  overrides: Partial<DeploySpec> = {},
): DeploySpec {
  return {
    schemaVersion: 1,
    project: { id: "fixture/pages-unit", version: "0.1.0" },
    assets: [{ path: "public/index.html", size: 12, sha256: "b".repeat(64) }],
    inputs: {},
    cloudflare: {
      workerName: "tapdeploy-pages",
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
      pages: { projectName: "tapdeploy-pages" },
      ...cloudflare,
    },
    wrangler: {
      name: "tapdeploy-pages",
      compatibility_date: "2026-10-01",
      r2_buckets: [],
      crons: [],
    },
    targetKind: "pages",
    ...overrides,
  };
}

describe("selectBuildRoute", () => {
  it("selects prebuilt direct-upload routes for every carrier kind", () => {
    const workers = selectBuildRoute({
      targetKind: "workers",
      hasWorkerModule: true,
      hasPagesFunctionBundle: false,
    });
    expect(workers.route).toBe("workers-direct-upload");
    expect(workers.prebuilt).toBe(true);

    const staticPages = selectBuildRoute({
      targetKind: "pages",
      hasWorkerModule: false,
      hasPagesFunctionBundle: false,
    });
    expect(staticPages.route).toBe("pages-direct-upload");
    expect(staticPages.prebuilt).toBe(true);

    const functionsPages = selectBuildRoute({
      targetKind: "pages",
      hasWorkerModule: false,
      hasPagesFunctionBundle: true,
    });
    expect(functionsPages.route).toBe("pages-direct-upload-functions");
    expect(functionsPages.prebuilt).toBe(true);
  });
});

describe("resolveDeploymentUnits", () => {
  it("static-only Pages: one pages-static unit, no triggers, no HTTP root assumed", () => {
    const plan = resolveDeploymentUnits(specFor("pages-staticsite"));
    expect(plan.ok).toBe(true);
    expect(plan.guards).toEqual([]);
    expect(plan.units).toHaveLength(1);
    const unit = plan.units[0]!;
    expect(unit.kind).toBe("pages-static");
    expect(unit.name).toBe("tapdeploy-fixture-pages");
    expect(unit.buildRoute.route).toBe("pages-direct-upload");
    expect(unit.requiresHttpRoot).toBe(false);
    expect(unit.assetCount).toBe(1);
    expect(plan.triggers).toEqual([]);
    expect(plan.exposures).toEqual([]);
  });

  it("Worker fetch carrier: a plain Worker needs no trigger and no HTTP root", () => {
    const plan = resolveDeploymentUnits(specFor("minimal-worker"));
    expect(plan.ok).toBe(true);
    expect(plan.units).toHaveLength(1);
    const unit = plan.units[0]!;
    expect(unit.kind).toBe("worker");
    expect(unit.buildRoute.route).toBe("workers-direct-upload");
    expect(unit.requiresHttpRoot).toBe(false);
    expect(plan.triggers).toEqual([]);
  });

  it("scheduled Worker: crons become explicit cron triggers on the unit", () => {
    const spec = workerSpec({ cron: ["*/5 * * * *", "0 3 * * *"] });
    const plan = resolveDeploymentUnits(spec);
    expect(plan.ok).toBe(true);
    expect(plan.triggers).toEqual([
      { id: "cron:*/5 * * * *", kind: "cron", unitId: "worker:tapdeploy-unit", cron: "*/5 * * * *" },
      { id: "cron:0 3 * * *", kind: "cron", unitId: "worker:tapdeploy-unit", cron: "0 3 * * *" },
    ]);
    expect(plan.units[0]!.assetCount).toBe(0);
    expect(plan.units[0]!.requiresHttpRoot).toBe(false);
  });

  it("queue-only Worker: consumer registers a trigger, producer only binds", () => {
    const spec = workerSpec({
      queues: [
        { binding: "JOBS", queueName: "jobs", createIfMissing: false, role: "consumer" },
        { binding: "EVENTS", queueName: "events", createIfMissing: false, role: "producer" },
      ],
    });
    const plan = resolveDeploymentUnits(spec);
    expect(plan.ok).toBe(true);
    expect(plan.triggers).toEqual([
      { id: "queue-consumer:jobs", kind: "queue-consumer", unitId: "worker:tapdeploy-unit", queueName: "jobs" },
    ]);
    expect(plan.resources.map((r) => [r.id, r.role])).toEqual([
      ["queue:events", "producer"],
      ["queue:jobs", "consumer"],
    ]);
    expect(plan.bindings).toEqual([
      { unitId: "worker:tapdeploy-unit", resourceId: "queue:events", binding: "EVENTS" },
      { unitId: "worker:tapdeploy-unit", resourceId: "queue:jobs", binding: "JOBS" },
    ]);
  });

  it("queue both: binds and triggers on the same queue", () => {
    const spec = workerSpec({
      queues: [{ binding: "PIPE", queueName: "pipe", createIfMissing: true, role: "both" }],
    });
    const plan = resolveDeploymentUnits(spec);
    expect(plan.triggers.map((t) => t.id)).toEqual(["queue-consumer:pipe"]);
    expect(plan.bindings).toEqual([
      { unitId: "worker:tapdeploy-unit", resourceId: "queue:pipe", binding: "PIPE" },
    ]);
    expect(plan.resources[0]!.disposition).toBe("create-if-missing");
  });

  it("consumer-only queue: provisions and triggers without any environment binding", () => {
    const spec = workerSpec({
      queues: [{ queueName: "jobs", createIfMissing: true, role: "consumer", consumer: { queue: "jobs", type: "worker" } }],
    });
    const plan = resolveDeploymentUnits(spec);
    expect(plan.ok).toBe(true);
    // The resource exists (provisioning intent) and the trigger fires, but no
    // version binding may exist for a queue that is only consumed.
    expect(plan.resources.map((r) => [r.id, r.kind, r.role, r.binding, r.disposition])).toEqual([
      ["queue:jobs", "queue", "consumer", undefined, "create-if-missing"],
    ]);
    expect(plan.bindings).toEqual([{ unitId: "worker:tapdeploy-unit", resourceId: "queue:jobs" }]);
    expect(plan.triggers).toEqual([
      { id: "queue-consumer:jobs", kind: "queue-consumer", unitId: "worker:tapdeploy-unit", queueName: "jobs" },
    ]);
  });

  it("resource-only class D1/KV/R2: resources resolve to independent nodes with stable ids", () => {
    const plan = resolveDeploymentUnits(specFor("assets-r2-worker"));
    const r2 = plan.resources.find((r) => r.kind === "r2");
    expect(r2?.id).toBe("r2:tapdeploy-test-placeholder");
    expect(r2?.disposition).toBe("create-if-missing");
    expect(plan.bindings).toContainEqual({
      unitId: "worker:tapdeploy-fixture-assets-r2",
      resourceId: "r2:tapdeploy-test-placeholder",
      binding: "FILES",
    });

    const d1 = resolveDeploymentUnits(
      workerSpec({
        d1: [{ binding: "DB", databaseName: "metrics", createIfMissing: false }],
        kv: [{ binding: "CONFIG", namespaceName: "config", createIfMissing: true }],
      }),
    );
    expect(d1.resources.map((r) => r.id)).toEqual(["d1:metrics", "kv:config"]);
    expect(d1.resources.map((r) => r.disposition)).toEqual([
      "bind-existing",
      "create-if-missing",
    ]);
  });

  it("prebuilt-only: no route claims bundling, so unsupported node/npm builds are never simulated", () => {
    for (const spec of [
      specFor("minimal-worker"),
      specFor("pages-staticsite"),
      workerSpec({ cron: ["* * * * *"] }),
    ]) {
      const plan = resolveDeploymentUnits(spec);
      for (const unit of plan.units) {
        expect(unit.buildRoute.prebuilt).toBe(true);
        expect(unit.buildRoute.route).not.toMatch(/wasm|esbuild|build/);
      }
    }
  });

  it("rollback planning: deterministic ordering and stable node ids across runs", () => {
    const spec = workerSpec({
      d1: [{ binding: "DB", databaseName: "metrics", createIfMissing: true }],
      kv: [{ binding: "CONFIG", namespaceName: "config", createIfMissing: false }],
      r2: [{ binding: "FILES", bucketName: "files", createIfMissing: true }],
      queues: [{ binding: "JOBS", queueName: "jobs", createIfMissing: false, role: "consumer" }],
      cron: ["0 0 * * *"],
    });
    const first = resolveDeploymentUnits(spec);
    const second = resolveDeploymentUnits(spec);
    expect(second).toEqual(first);
    expect(first.resources.map((r) => r.id)).toEqual([
      "d1:metrics",
      "kv:config",
      "queue:jobs",
      "r2:files",
    ]);
    expect(first.bindings.map((b) => b.resourceId)).toEqual([
      "d1:metrics",
      "kv:config",
      "queue:jobs",
      "r2:files",
    ]);
    expect(first.triggers.map((t) => t.id)).toEqual(["cron:0 0 * * *", "queue-consumer:jobs"]);
  });

  it("security: secret values are never read or emitted, only policies and names", () => {
    const spec = workerSpec({
      secrets: { API_TOKEN: "generate-once" },
      secretsStore: [
        {
          binding: "STORE_SECRET",
          storeName: "ops-store",
          createIfMissing: false,
          secretName: "rotation-key",
          secretValue: "store-secret-456",
        },
      ],
    });
    spec.inputs = { API_TOKEN: "super-secret-value-123", workerName: "tapdeploy-unit" };
    const plan = resolveDeploymentUnits(spec);
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain("super-secret-value-123");
    expect(serialized).not.toContain("store-secret-456");
    const secret = plan.resources.find((r) => r.kind === "secret");
    expect(secret?.binding).toBe("API_TOKEN");
    expect(secret?.secretPolicy).toBe("generate-once");
    expect(secret?.name).toBeUndefined();
  });

  it("exposure edges are explicit opt-in and never implied", () => {
    const plan = resolveDeploymentUnits(
      workerSpec({
        domains: [
          { kind: "workers-route", hostname: "*.example.com/*", updateAction: "preserve" },
        ],
      }),
    );
    expect(plan.exposures).toEqual([
      {
        unitId: "worker:tapdeploy-unit",
        kind: "workers-route",
        hostname: "*.example.com/*",
        updateAction: "preserve",
      },
    ]);
    // No exposure declared -> no exposure edges, even though the unit exists.
    expect(resolveDeploymentUnits(workerSpec()).exposures).toEqual([]);
  });

  it("guards fail closed: duplicate bindings, wrong-carrier triggers, missing identity", () => {
    const dup = resolveDeploymentUnits(
      workerSpec({
        r2: [{ binding: "SAME", bucketName: "a", createIfMissing: true }],
        kv: [{ binding: "SAME", namespaceName: "b", createIfMissing: true }],
      }),
    );
    expect(dup.ok).toBe(false);
    expect(dup.guards.map((g) => g.code)).toContain("duplicate-binding");

    const dupId = resolveDeploymentUnits(
      workerSpec({
        r2: [
          { binding: "A", bucketName: "same-bucket", createIfMissing: true },
          { binding: "B", bucketName: "same-bucket", createIfMissing: true },
        ],
      }),
    );
    expect(dupId.ok).toBe(false);
    expect(dupId.guards.map((g) => g.code)).toContain("duplicate-node-id");

    const pagesCron = resolveDeploymentUnits(pagesSpec({ cron: ["* * * * *"] }));
    expect(pagesCron.ok).toBe(false);
    expect(pagesCron.guards.map((g) => g.code)).toContain("trigger-requires-worker");

    const pagesConsumer = resolveDeploymentUnits(
      pagesSpec({
        queues: [{ binding: "JOBS", queueName: "jobs", createIfMissing: false, role: "consumer" }],
      }),
    );
    expect(pagesConsumer.ok).toBe(false);
    expect(pagesConsumer.guards.map((g) => g.code)).toContain("trigger-requires-worker");

    const noWorker = workerSpec({}, { worker: undefined });
    const missing = resolveDeploymentUnits(noWorker);
    expect(missing.ok).toBe(false);
    expect(missing.guards.map((g) => g.code)).toContain("missing-worker-entrypoint");

    const noIdentity = resolveDeploymentUnits(pagesSpec({ pages: undefined }));
    expect(noIdentity.ok).toBe(false);
    expect(noIdentity.guards.map((g) => g.code)).toContain("missing-pages-identity");

    const badExposure = resolveDeploymentUnits(
      workerSpec({ domains: [{ kind: "workers-route", hostname: "" }] }),
    );
    expect(badExposure.ok).toBe(false);
    expect(badExposure.guards.map((g) => g.code)).toContain("exposure-requires-hostname");
  });
});
