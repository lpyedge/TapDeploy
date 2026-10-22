// deploy-graph oracle.
//
// Covers the task's oracle list with literal structural inputs (the sibling
// regression file tests/unit/deployment-units.test.ts is import-blocked by the
// pre-existing user-deleted manifest schema, same module chain as +):
//   - a plain single Worker graph needs no units[] config
//   - pure R2/KV without any Worker/Pages carrier
//   - multi-worker / service / R2 / D1 workflow in deterministic topological
//     order with a trackable partial progress table
//   - cycles and conflicts block before any provider write
// No provider calls exist in the module; inputs are pure JSON literals.

import { describe, expect, it } from "vitest";

import type { DeploySpec } from "../../src/core/deploy-spec.js";
import {
  buildDeployGraph,
  type DeployGraphInput,
} from "../../src/core/planning/deploy-graph.js";

// ---------------------------------------------------------------------------
// Literal spec fixtures (the resolver only reads the fields set here)
// ---------------------------------------------------------------------------

interface SpecOverrides {
  r2?: DeploySpec["cloudflare"]["r2"];
  d1?: DeploySpec["cloudflare"]["d1"];
  kv?: DeploySpec["cloudflare"]["kv"];
  queues?: DeploySpec["cloudflare"]["queues"];
  runtimeBindings?: DeploySpec["cloudflare"]["runtimeBindings"];
  secrets?: DeploySpec["cloudflare"]["secrets"];
  cron?: string[];
  domains?: DeploySpec["cloudflare"]["domains"];
  hasWorkerBundle?: boolean;
  pagesProject?: string;
  assets?: number;
}

function file(path: string) {
  return { path, size: 16, sha256: "0".repeat(64) };
}

function spec(
  targetKind: "workers" | "pages",
  name: string,
  overrides: SpecOverrides = {},
): DeploySpec {
  const pages = targetKind === "pages";
  return {
    schemaVersion: 1,
    project: { id: `test/${name}`, version: "1.0.0" },
    ...(pages ? {} : { worker: file("index.js") }),
    ...(pages && overrides.hasWorkerBundle ? { workerBundle: file("_worker.js") } : {}),
    assets: Array.from({ length: overrides.assets ?? 0 }, (_, i) => file(`asset-${i}.txt`)),
    inputs: {},
    cloudflare: {
      workerName: name,
      r2: overrides.r2 ?? [],
      d1: overrides.d1 ?? [],
      kv: overrides.kv ?? [],
      queues: overrides.queues ?? [],
      hyperdrive: [],
      vectorize: [],
      secretsStore: [],
      runtimeBindings: overrides.runtimeBindings ?? [],
      cron: overrides.cron ?? [],
      secrets: overrides.secrets ?? {},
      ...(overrides.domains !== undefined ? { domains: overrides.domains } : {}),
      ...(pages ? { pages: { projectName: overrides.pagesProject ?? name } } : {}),
    },
    wrangler: {
      name,
      compatibility_date: "2026-01-01",
      r2_buckets: [],
      crons: overrides.cron ?? [],
    },
    targetKind,
  };
}

function input(partial: Partial<DeployGraphInput> & { specs: DeployGraphInput["specs"] }): DeployGraphInput {
  return { accountId: "acct-1", ...partial };
}

const guardCodes = (graph: ReturnType<typeof buildDeployGraph>): string[] =>
  graph.guards.map((g) => g.code);

// ---------------------------------------------------------------------------
// PASS oracle: single Worker default, resource-only, topo + partial progress
// ---------------------------------------------------------------------------

describe("deploy-graph — implicit single unit (no units[] config)", () => {
  it("builds a single Worker graph without any units[] declaration", () => {
    const graph = buildDeployGraph(
      input({ specs: { main: spec("workers", "api") }, bundleDigest: "d1" }),
    );
    expect(graph.ok).toBe(true);
    expect(graph.guards).toEqual([]);
    expect(graph.units).toHaveLength(1);
    const unit = graph.units[0]!;
    expect(unit.id).toBe("main");
    expect(unit.implicit).toBe(true);
    expect(unit.kind).toBe("worker");
    expect(unit.identity).toBe("worker-script");
    expect(unit.name).toBe("api");
    expect(unit.requiresHttpRoot).toBe(false);
    expect(unit.requiresBundle).toBe(true);
    expect(unit.buildRoute?.route).toBe("workers-direct-upload");
    expect(graph.dependencies).toEqual([]);
    expect(graph.topoOrder).toEqual(["main"]);
    expect(graph.progress).toEqual([{ unitId: "main", state: "pending", receiptDigest: null }]);
    expect(graph.bundleDigest).toBe("d1");
    expect(graph.requiresBundle).toBe(true);
  });

  it("classifies implicit Pages units (static and prebuilt functions)", () => {
    const staticGraph = buildDeployGraph(input({ specs: { main: spec("pages", "site") } }));
    expect(staticGraph.units[0]!.kind).toBe("pages-static");
    expect(staticGraph.units[0]!.identity).toBe("pages-project");
    expect(staticGraph.units[0]!.buildRoute?.route).toBe("pages-direct-upload");

    const functionsGraph = buildDeployGraph(
      input({ specs: { main: spec("pages", "site", { hasWorkerBundle: true }) } }),
    );
    expect(functionsGraph.units[0]!.kind).toBe("pages-functions");
    expect(functionsGraph.units[0]!.buildRoute?.route).toBe("pages-direct-upload-functions");
  });

  it("refuses an implicit layout with zero or multiple unit specs", () => {
    const empty = buildDeployGraph(input({ specs: {} }));
    expect(empty.ok).toBe(false);
    expect(guardCodes(empty)).toContain("missing-unit-spec");
    expect(empty.units).toEqual([]);

    const multi = buildDeployGraph(
      input({ specs: { a: spec("workers", "a"), b: spec("workers", "b") } }),
    );
    expect(multi.ok).toBe(false);
    expect(guardCodes(multi)).toContain("unexpected-unit-spec");
    expect(multi.units).toEqual([]);
  });

  it("requires a bundle digest whenever any unit needs a bundle", () => {
    const graph = buildDeployGraph(input({ specs: { main: spec("workers", "api") } }));
    expect(graph.ok).toBe(false);
    expect(guardCodes(graph)).toContain("missing-bundle-digest");
    expect(graph.bundleDigest).toBeNull();
  });

  it("surfaces cron triggers unit-bound so snapshots and readback stay exact", () => {
    const graph = buildDeployGraph(
      input({ specs: { main: spec("workers", "api", { cron: ["*/5 * * * *", "0 3 * * *"] }) }, bundleDigest: "d1" }),
    );
    expect(graph.ok).toBe(true);
    expect(graph.triggers).toEqual([
      { id: "main/cron:*/5 * * * *", kind: "cron", unitId: "main", cron: "*/5 * * * *" },
      { id: "main/cron:0 3 * * *", kind: "cron", unitId: "main", cron: "0 3 * * *" },
    ]);
  });
});

describe("deploy-graph — multi-unit DAG, service and resource edges", () => {
  it("carries declared cross-unit ordering and a deterministic topological order", () => {
    const base: DeployGraphInput = input({
      units: [
        { id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc", dependsOn: ["jobs"] },
        { id: "jobs", kind: "worker", wrangler: "units/jobs/wrangler.jsonc" },
      ],
      specs: { api: spec("workers", "api"), jobs: spec("workers", "jobs") },
      bundleDigest: "d1",
    });
    const graph = buildDeployGraph(base);
    expect(graph.ok).toBe(true);
    expect(graph.dependencies).toEqual([
      { dependent: "api", dependency: "jobs", kind: "declared", detail: 'config dependsOn "jobs"' },
    ]);
    expect(graph.topoOrder).toEqual(["jobs", "api"]);
    expect(graph.progress.map((p) => p.unitId)).toEqual(["jobs", "api"]);
    expect(graph.progress.every((p) => p.state === "pending" && p.receiptDigest === null)).toBe(
      true,
    );
    expect(graph.units.map((u) => u.id)).toEqual(["api", "jobs"]);

    // Permuted config input yields a byte-identical graph (deterministic).
    const permuted = buildDeployGraph(
      input({
        units: [
          { id: "jobs", kind: "worker", wrangler: "units/jobs/wrangler.jsonc" },
          { id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc", dependsOn: ["jobs"] },
        ],
        specs: { jobs: spec("workers", "jobs"), api: spec("workers", "api") },
        bundleDigest: "d1",
      }),
    );
    expect(JSON.stringify(permuted)).toBe(JSON.stringify(graph));
  });

  it("derives service-binding edges and resolves self targets without an edge", () => {
    const graph = buildDeployGraph(
      input({
        units: [
          { id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc", services: [{ binding: "JOBS", service: "jobs" }, { binding: "SELF", service: "api" }] },
          { id: "jobs", kind: "worker", wrangler: "units/jobs/wrangler.jsonc" },
        ],
        specs: { api: spec("workers", "api"), jobs: spec("workers", "jobs") },
        bundleDigest: "d1",
      }),
    );
    expect(graph.ok).toBe(true);
    expect(graph.dependencies).toEqual([
      {
        dependent: "api",
        dependency: "jobs",
        kind: "service-binding",
        detail: 'service binding "JOBS" targets unit "jobs"',
      },
    ]);
    expect(graph.topoOrder).toEqual(["jobs", "api"]);
  });

  it("fails closed for external and ambiguous service targets", () => {
    const external = buildDeployGraph(
      input({
        units: [
          { id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc", services: [{ binding: "EXT", service: "other-worker" }] },
        ],
        specs: { api: spec("workers", "api") },
        bundleDigest: "d1",
      }),
    );
    expect(external.ok).toBe(false);
    expect(guardCodes(external)).toContain("unresolved-service-target");

    const ambiguous = buildDeployGraph(
      input({
        units: [
          { id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc", services: [{ binding: "DUP", service: "dup" }] },
          { id: "a", kind: "worker", wrangler: "units/a/wrangler.jsonc" },
          { id: "b", kind: "worker", wrangler: "units/b/wrangler.jsonc" },
        ],
        specs: {
          api: spec("workers", "api"),
          a: spec("workers", "dup"),
          b: spec("workers", "dup"),
        },
        bundleDigest: "d1",
      }),
    );
    expect(ambiguous.ok).toBe(false);
    expect(guardCodes(ambiguous)).toContain("duplicate-name");
    expect(guardCodes(ambiguous)).toContain("ambiguous-service-target");
  });

  it("orders resource sharing creator-first and derives queue-consumer edges", () => {
    const graph = buildDeployGraph(
      input({
        units: [
          { id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc" },
          {
            id: "infra",
            kind: "resources",
            resources: [
              { kind: "queue", name: "jobs-q", mode: "ensure" },
              { kind: "r2", name: "media", mode: "ensure" },
            ],
          },
        ],
        specs: {
          api: spec("workers", "api", {
            r2: [{ binding: "MEDIA", bucketName: "media", createIfMissing: false }],
            queues: [{ binding: "Q", queueName: "jobs-q", createIfMissing: false, role: "consumer" }],
          }),
        },
        bundleDigest: "d1",
      }),
    );
    expect(graph.ok).toBe(true);
    expect(graph.topoOrder).toEqual(["infra", "api"]);
    const queue = graph.resources.find((r) => r.id === "queue:jobs-q");
    expect(queue?.creators).toEqual(["infra"]);
    expect(queue?.refs).toEqual([
      { unitId: "api", binding: "Q", disposition: "bind-existing", role: "consumer" },
      { unitId: "infra", disposition: "create-if-missing" },
    ]);
    expect(graph.dependencies).toEqual([
      {
        dependent: "api",
        dependency: "infra",
        kind: "queue-consumer",
        detail: 'binding "Q" to "queue:jobs-q" waits for creator "infra"',
      },
      {
        dependent: "api",
        dependency: "infra",
        kind: "resource-order",
        detail: 'binding "MEDIA" to "r2:media" waits for creator "infra"',
      },
    ]);
    expect(graph.bindings).toContainEqual({
      unitId: "infra",
      resourceId: "queue:jobs-q",
      kind: "provision-intent",
    });
    expect(graph.bindings).toContainEqual({
      unitId: "api",
      resourceId: "queue:jobs-q",
      binding: "Q",
      kind: "env-binding",
    });
  });

  it("blocks two units contending for the same resource creation", () => {
    const graph = buildDeployGraph(
      input({
        units: [
          { id: "a", kind: "worker", wrangler: "units/a/wrangler.jsonc" },
          { id: "b", kind: "worker", wrangler: "units/b/wrangler.jsonc" },
        ],
        specs: {
          a: spec("workers", "a", { r2: [{ binding: "MEDIA", bucketName: "media", createIfMissing: true }] }),
          b: spec("workers", "b", { r2: [{ binding: "MEDIA", bucketName: "media", createIfMissing: true }] }),
        },
        bundleDigest: "d1",
      }),
    );
    expect(graph.ok).toBe(false);
    expect(guardCodes(graph)).toContain("resource-contention");
    const contention = graph.guards.find((g) => g.code === "resource-contention");
    expect(contention?.message).toContain('"a"');
    expect(contention?.message).toContain('"b"');
  });

  it("scopes unit-local nodes (runtime, secret) by unit id and shares account resources", () => {
    const graph = buildDeployGraph(
      input({
        units: [
          { id: "a", kind: "worker", wrangler: "units/a/wrangler.jsonc" },
          { id: "b", kind: "worker", wrangler: "units/b/wrangler.jsonc" },
        ],
        specs: {
          a: spec("workers", "a", {
            runtimeBindings: [{ binding: "AI", type: "ai" }],
            secrets: { TOKEN: "generate-once" },
            r2: [{ binding: "MEDIA", bucketName: "media", createIfMissing: false }],
          }),
          b: spec("workers", "b", {
            runtimeBindings: [{ binding: "AI", type: "ai" }],
            secrets: { TOKEN: "generate-once" },
            r2: [{ binding: "MEDIA", bucketName: "media", createIfMissing: false }],
          }),
        },
        bundleDigest: "d1",
      }),
    );
    expect(graph.ok).toBe(true);
    const resourceIds = graph.resources.map((r) => r.id);
    expect(resourceIds).toEqual([
      "a/runtime:ai:AI",
      "a/secret:TOKEN",
      "b/runtime:ai:AI",
      "b/secret:TOKEN",
      "r2:media",
    ]);
    const shared = graph.resources.find((r) => r.id === "r2:media");
    expect(shared?.refs.map((ref) => ref.unitId)).toEqual(["a", "b"]);
    expect(shared?.creators).toEqual([]);
    expect(graph.topoOrder).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// FAIL oracle: cycles and conflicts block before any provider write
// ---------------------------------------------------------------------------

describe("deploy-graph — fail-closed guards", () => {
  it("blocks dependency cycles and derives no execution order", () => {
    const graph = buildDeployGraph(
      input({
        units: [
          { id: "a", kind: "worker", wrangler: "units/a/wrangler.jsonc", dependsOn: ["b"] },
          { id: "b", kind: "worker", wrangler: "units/b/wrangler.jsonc", dependsOn: ["a"] },
        ],
        specs: { a: spec("workers", "a"), b: spec("workers", "b") },
        bundleDigest: "d1",
      }),
    );
    expect(graph.ok).toBe(false);
    expect(guardCodes(graph)).toContain("dependency-cycle");
    expect(graph.topoOrder).toEqual([]);
    expect(graph.progress.map((p) => p.unitId)).toEqual(["a", "b"]);
  });

  it("blocks a self dependency as a cycle", () => {
    const graph = buildDeployGraph(
      input({
        units: [
          { id: "solo", kind: "worker", wrangler: "units/solo/wrangler.jsonc", dependsOn: ["solo"] },
        ],
        specs: { solo: spec("workers", "solo") },
        bundleDigest: "d1",
      }),
    );
    expect(graph.ok).toBe(false);
    expect(guardCodes(graph)).toContain("dependency-cycle");
    expect(graph.topoOrder).toEqual([]);
  });

  it("blocks unknown dependencies without inventing edges", () => {
    const graph = buildDeployGraph(
      input({
        units: [
          { id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc", dependsOn: ["ghost"] },
        ],
        specs: { api: spec("workers", "api") },
        bundleDigest: "d1",
      }),
    );
    expect(graph.ok).toBe(false);
    expect(guardCodes(graph)).toContain("unknown-dependency");
    expect(graph.dependencies).toEqual([]);
    expect(graph.topoOrder).toEqual(["api"]);
  });

  it("blocks duplicate unit ids, duplicate wrangler paths and duplicate identities", () => {
    const duplicateIds = buildDeployGraph(
      input({
        units: [
          { id: "api", kind: "worker", wrangler: "units/api-a/wrangler.jsonc" },
          { id: "api", kind: "worker", wrangler: "units/api-b/wrangler.jsonc" },
        ],
        specs: { api: spec("workers", "api") },
        bundleDigest: "d1",
      }),
    );
    expect(duplicateIds.ok).toBe(false);
    expect(guardCodes(duplicateIds)).toContain("duplicate-unit-id");
    expect(duplicateIds.units.map((u) => u.id)).toEqual(["api"]);

    const duplicatePaths = buildDeployGraph(
      input({
        units: [
          { id: "a", kind: "worker", wrangler: "units/same/wrangler.jsonc" },
          { id: "b", kind: "worker", wrangler: "units/same/wrangler.jsonc" },
        ],
        specs: { a: spec("workers", "a"), b: spec("workers", "b") },
        bundleDigest: "d1",
      }),
    );
    expect(duplicatePaths.ok).toBe(false);
    expect(guardCodes(duplicatePaths)).toContain("duplicate-wrangler-path");

    const duplicateNames = buildDeployGraph(
      input({
        units: [
          { id: "a", kind: "worker", wrangler: "units/a/wrangler.jsonc" },
          { id: "b", kind: "worker", wrangler: "units/b/wrangler.jsonc" },
        ],
        specs: { a: spec("workers", "same-name"), b: spec("workers", "same-name") },
        bundleDigest: "d1",
      }),
    );
    expect(duplicateNames.ok).toBe(false);
    expect(guardCodes(duplicateNames)).toContain("duplicate-name");
  });

  it("blocks cross-account claims but accepts the authorized account", () => {
    const foreign = buildDeployGraph(
      input({
        units: [
          { id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc", accountId: "acct-2" },
        ],
        specs: { api: spec("workers", "api") },
        bundleDigest: "d1",
      }),
    );
    expect(foreign.ok).toBe(false);
    expect(guardCodes(foreign)).toContain("cross-account-reference");

    const authorized = buildDeployGraph(
      input({
        units: [
          { id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc", accountId: "acct-1" },
        ],
        specs: { api: spec("workers", "api") },
        bundleDigest: "d1",
      }),
    );
    expect(authorized.ok).toBe(true);
  });

  it("blocks units whose declared kind contradicts their spec target kind", () => {
    const graph = buildDeployGraph(
      input({
        units: [{ id: "web", kind: "pages", wrangler: "units/web/wrangler.jsonc" }],
        specs: { web: spec("workers", "web") },
        bundleDigest: "d1",
      }),
    );
    expect(graph.ok).toBe(false);
    expect(guardCodes(graph)).toContain("target-kind-mismatch");
  });

  it("blocks missing and unexpected unit specs in explicit layouts", () => {
    const missing = buildDeployGraph(
      input({
        units: [{ id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc" }],
        specs: {},
        bundleDigest: "d1",
      }),
    );
    expect(missing.ok).toBe(false);
    expect(guardCodes(missing)).toContain("missing-unit-spec");
    expect(missing.units.map((u) => u.id)).toEqual(["api"]);

    const orphan = buildDeployGraph(
      input({
        units: [{ id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc" }],
        specs: { api: spec("workers", "api"), ghost: spec("workers", "ghost") },
        bundleDigest: "d1",
      }),
    );
    expect(orphan.ok).toBe(false);
    expect(guardCodes(orphan)).toContain("unexpected-unit-spec");

    const resourceSpec = buildDeployGraph(
      input({
        units: [
          { id: "infra", kind: "resources", resources: [{ kind: "kv", name: "cache", mode: "ensure" }] },
        ],
        specs: { infra: spec("workers", "infra") },
      }),
    );
    expect(resourceSpec.ok).toBe(false);
    expect(guardCodes(resourceSpec)).toContain("unexpected-unit-spec");
  });

  it("blocks missing wrangler paths and wrangler on resource-only units", () => {
    const missing = buildDeployGraph(
      input({
        units: [{ id: "api", kind: "worker" }],
        specs: { api: spec("workers", "api") },
        bundleDigest: "d1",
      }),
    );
    expect(missing.ok).toBe(false);
    expect(guardCodes(missing)).toContain("missing-wrangler-path");

    const resourceWrangler = buildDeployGraph(
      input({
        units: [
          {
            id: "infra",
            kind: "resources",
            wrangler: "units/infra/wrangler.jsonc",
            resources: [{ kind: "kv", name: "cache", mode: "ensure" }],
          },
        ],
        specs: {},
      }),
    );
    expect(resourceWrangler.ok).toBe(false);
    expect(guardCodes(resourceWrangler)).toContain("resource-unit-with-wrangler");
  });

  it("blocks two consumers of the same queue and two owners of one hostname", () => {
    const consumers = buildDeployGraph(
      input({
        units: [
          { id: "a", kind: "worker", wrangler: "units/a/wrangler.jsonc" },
          { id: "b", kind: "worker", wrangler: "units/b/wrangler.jsonc" },
        ],
        specs: {
          a: spec("workers", "a", {
            queues: [{ binding: "Q", queueName: "shared-q", createIfMissing: false, role: "consumer" }],
          }),
          b: spec("workers", "b", {
            queues: [{ binding: "Q", queueName: "shared-q", createIfMissing: false, role: "consumer" }],
          }),
        },
        bundleDigest: "d1",
      }),
    );
    expect(consumers.ok).toBe(false);
    expect(guardCodes(consumers)).toContain("duplicate-queue-consumer");

    const exposures = buildDeployGraph(
      input({
        units: [
          { id: "a", kind: "worker", wrangler: "units/a/wrangler.jsonc" },
          { id: "b", kind: "worker", wrangler: "units/b/wrangler.jsonc" },
        ],
        specs: {
          a: spec("workers", "a", {
            domains: [{ kind: "workers-custom-domain", hostname: "app.example.com" }],
          }),
          b: spec("workers", "b", {
            domains: [{ kind: "workers-custom-domain", hostname: "app.example.com" }],
          }),
        },
        bundleDigest: "d1",
      }),
    );
    expect(exposures.ok).toBe(false);
    expect(guardCodes(exposures)).toContain("ambiguous-exposure");
  });

  it("deduplicates identical exposure and binding tuples within one unit", () => {
    const graph = buildDeployGraph(
      input({
        specs: {
          main: spec("workers", "api", {
            domains: [
              { kind: "workers-custom-domain", hostname: "app.example.com" },
              { kind: "workers-custom-domain", hostname: "app.example.com" },
            ],
          }),
        },
        bundleDigest: "d1",
      }),
    );
    expect(graph.ok).toBe(true);
    expect(graph.exposures).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Resource-only releases
// ---------------------------------------------------------------------------

describe("deploy-graph — resource-only releases", () => {
  it("forms a plan for pure R2/KV units with no Worker/Pages carrier and no bundle", () => {
    const graph = buildDeployGraph(
      input({
        units: [
          {
            id: "infra",
            kind: "resources",
            resources: [
              { kind: "r2", name: "media", mode: "ensure" },
              { kind: "kv", name: "cache", mode: "ensure" },
            ],
          },
        ],
        specs: {},
      }),
    );
    expect(graph.ok).toBe(true);
    expect(graph.guards).toEqual([]);
    expect(graph.requiresBundle).toBe(false);
    expect(graph.bundleDigest).toBeNull();
    expect(graph.units).toEqual([
      {
        id: "infra",
        implicit: false,
        kind: "resource-only",
        identity: "none",
        name: "",
        assetCount: 0,
        requiresHttpRoot: false,
        requiresBundle: false,
      },
    ]);
    expect(graph.units[0]!.buildRoute).toBeUndefined();
    expect(graph.resources.map((r) => r.id)).toEqual(["kv:cache", "r2:media"]);
    expect(graph.resources.every((r) => r.creators.length === 1)).toBe(true);
    expect(graph.topoOrder).toEqual(["infra"]);
    expect(graph.progress).toEqual([{ unitId: "infra", state: "pending", receiptDigest: null }]);
    expect(graph.notes.some((n) => n.includes("all units are resource-only"))).toBe(true);
    expect(graph.notes.some((n) => n.includes("no third mode"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Purity / determinism (no provider writes)
// ---------------------------------------------------------------------------

describe("deploy-graph — purity and determinism", () => {
  it("produces JSON-round-trippable graphs and no order for blocked graphs", () => {
    const graph = buildDeployGraph(
      input({
        units: [
          { id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc", dependsOn: ["jobs"] },
          { id: "jobs", kind: "worker", wrangler: "units/jobs/wrangler.jsonc" },
        ],
        specs: { api: spec("workers", "api"), jobs: spec("workers", "jobs") },
        bundleDigest: "d1",
      }),
    );
    const roundTripped = JSON.parse(JSON.stringify(graph)) as typeof graph;
    expect(roundTripped).toEqual(graph);
    expect(roundTripped.ok).toBe(true);

    const cyclic = buildDeployGraph(
      input({
        units: [
          { id: "a", kind: "worker", wrangler: "units/a/wrangler.jsonc", dependsOn: ["b"] },
          { id: "b", kind: "worker", wrangler: "units/b/wrangler.jsonc", dependsOn: ["a"] },
        ],
        specs: { a: spec("workers", "a"), b: spec("workers", "b") },
        bundleDigest: "d1",
      }),
    );
    expect(cyclic.ok).toBe(false);
    expect(cyclic.topoOrder).toEqual([]);
    expect(cyclic.dependencies.every((edge) => edge.kind === "declared")).toBe(true);
  });

  it("is stable across repeated builds of the same input (no hidden state)", () => {
    const build = () =>
      buildDeployGraph(
        input({
          units: [
            { id: "infra", kind: "resources", resources: [{ kind: "d1", name: "db", mode: "ensure" }] },
            { id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc" },
          ],
          specs: {
            api: spec("workers", "api", {
              d1: [{ binding: "DB", databaseName: "db", createIfMissing: false }],
            }),
          },
          bundleDigest: "d1",
        }),
      );
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });
});
