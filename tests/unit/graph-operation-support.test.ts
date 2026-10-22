// operation coverage gate contract. The shared catalog is the single
// authority: every emitted graph diff is either addressable with exact
// phase(s) or refused with UNSUPPORTED_GRAPH_OPERATION before any write.
import { describe, expect, it } from "vitest";

import {
  exactGraphPhase,
  graphResourceCreatePhase,
  isDispatchableGraphAction,
  resolveGraphOperation,
  unsupportedGraphDiffs,
} from "../../src/core/planning/graph-operation-support.js";
import { DEPLOY_STEP_NAMES, graphStepForResourceAction, isGraphActionStepAllowed } from "../../src/core/deploy/steps.js";
import { exactGraphDispatchSpec } from "../../src/core/deploy/graph-dispatch.js";
import {
  graphActionsForPlan,
  graphPhaseForDiff,
} from "../../src/web/graph-deploy-runner.js";
import type { DeploySpec } from "../../src/core/deploy-spec.js";

function file(path: string) {
  return { path, size: 16, sha256: "0".repeat(64) };
}

function workerSpec(cron: string[] = []): DeploySpec {
  return {
    schemaVersion: 1,
    project: { id: "test/app", version: "1.0.0" },
    worker: file("index.js"),
    assets: [],
    inputs: {},
    cloudflare: {
      workerName: "app",
      r2: [],
      d1: [],
      kv: [],
      queues: [],
      hyperdrive: [],
      vectorize: [],
      secretsStore: [],
      runtimeBindings: [],
      cron,
      secrets: {},
    },
    wrangler: { name: "app", compatibility_date: "2026-01-01", r2_buckets: [], crons: cron },
    targetKind: "workers",
  } as DeploySpec;
}

describe("catalog: supported operations resolve to exact phases", () => {
  it("addresses the baseline Worker+R2, Pages static and resource-only diffs", () => {
    expect(
      resolveGraphOperation({ unitId: "u", unitKind: "worker", resource: "worker", action: "create" }),
    ).toMatchObject({ supported: true, phases: ["create-worker"] });
    expect(
      resolveGraphOperation({ unitId: "u", unitKind: "worker", resource: "worker", action: "update" }),
    ).toMatchObject({ supported: true, phases: ["create-version"] });
    expect(
      resolveGraphOperation({ unitId: "u", unitKind: "worker", resource: "deployment", action: "create" }),
    ).toMatchObject({ supported: true, phases: ["activate"] });
    expect(
      resolveGraphOperation({ unitId: "u", unitKind: "worker", resource: "r2", action: "create" }),
    ).toMatchObject({ supported: true, phases: ["create-r2-buckets"] });
    expect(
      resolveGraphOperation({ unitId: "u", unitKind: "pages-static", resource: "static-assets", action: "create" }),
    ).toMatchObject({ supported: true, phases: ["pages-register-assets"] });
    expect(
      resolveGraphOperation({ unitId: "u", unitKind: "resource-only", resource: "kv", action: "create" }),
    ).toMatchObject({ supported: true, phases: ["create-kv-namespaces"] });
  });

  it("treats preserve/skip as no-ops with no phases", () => {
    expect(
      resolveGraphOperation({ unitId: "u", unitKind: "worker", resource: "r2", action: "preserve" }),
    ).toMatchObject({ supported: true, phases: [] });
    expect(unsupportedGraphDiffs([{ unitId: "u", kind: "worker", diffs: [{ resource: "r2", action: "preserve" }] }])).toEqual([]);
  });

  it("addresses the nameless schedule diff as a whole-set reconcile", () => {
    expect(
      resolveGraphOperation({ unitId: "u", unitKind: "worker", resource: "schedule", action: "create" }),
    ).toMatchObject({ supported: true, phases: ["reconcile-schedules"] });
    expect(
      resolveGraphOperation({ unitId: "u", unitKind: "worker", resource: "schedule", action: "update" }),
    ).toMatchObject({ supported: true, phases: ["reconcile-schedules"] });
  });
});

describe("catalog: unimplemented operations refuse with UNSUPPORTED_GRAPH_OPERATION", () => {
  it("addresses Worker static-assets as the sealed register+complete pair", () => {
    const resolution = resolveGraphOperation({ unitId: "api", unitKind: "worker", resource: "static-assets", action: "create" });
    expect(resolution.supported).toBe(true);
    if (resolution.supported) {
      expect(resolution.phases).toEqual(["register-assets", "complete-assets"]);
      expect(resolution.readback).toContain("completion JWT");
    }
    const bad = unsupportedGraphDiffs([
      { unitId: "api", kind: "worker", diffs: [{ resource: "static-assets", action: "attach", name: "app" }] },
    ]);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.detail).toContain("UNSUPPORTED_GRAPH_OPERATION(api,static-assets,attach)");
  });

  it("addresses Worker secrets as version-bound no-ops, still refusing unsafe actions", () => {
    for (const action of ["create", "update"] as const) {
      const resolution = resolveGraphOperation({ unitId: "api", unitKind: "worker", resource: "secret", action });
      expect(resolution.supported).toBe(true);
      if (resolution.supported) expect(resolution.phases).toEqual([]);
    }
    for (const action of ["conflict", "detach", "attach"] as const) {
      const resolution = resolveGraphOperation({ unitId: "api", unitKind: "worker", resource: "secret", action });
      expect(resolution.supported).toBe(false);
      if (!resolution.supported) expect(resolution.detail).toContain("UNSUPPORTED_GRAPH_OPERATION(api,");
    }
    const bad = unsupportedGraphDiffs([
      { unitId: "api", kind: "worker", diffs: [{ resource: "secret", action: "conflict", name: "TOKEN" }] },
    ]);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.detail).toContain("UNSUPPORTED_GRAPH_OPERATION(api,secret,conflict)");
  });

  it("refuses conflict/detach/unknown resources before any write", () => {
    expect(
      resolveGraphOperation({ unitId: "u", unitKind: "worker", resource: "r2", action: "conflict" }).supported,
    ).toBe(false);
    expect(
      resolveGraphOperation({ unitId: "u", unitKind: "worker", resource: "workflows", action: "create" }).supported,
    ).toBe(false);
    expect(
      resolveGraphOperation({ unitId: "u", unitKind: "nope", resource: "r2", action: "create" }).supported,
    ).toBe(false);
  });
});

describe("browser parity: same catalog, zero browser-only fallback", () => {
  it("maps supported diffs to the catalog phase and skips no-ops", () => {
    expect(graphPhaseForDiff("worker", "r2", "create")).toBe("create-r2-buckets");
    expect(graphPhaseForDiff("worker", "schedule", "create")).toBe("reconcile-schedules");
    expect(graphPhaseForDiff("pages-static", "static-assets", "create")).toBe("pages-register-assets");
    const actions = graphActionsForPlan({
      units: [
        {
          unitId: "main",
          kind: "worker",
          diffs: [
            { resource: "worker", action: "create", name: "app" },
            { resource: "r2", action: "preserve", name: "media" },
            // secret creates ride the worker version upload; no dispatch.
            { resource: "secret", action: "create", name: "TOKEN" },
          ],
        },
      ],
    } as never);
    expect(actions.map((a) => a.phase)).toEqual(["create-worker"]);
  });

  it("maps the Worker asset pair to register-assets and executes both phases under one action", () => {
    expect(graphPhaseForDiff("worker", "static-assets", "create")).toBe("register-assets");
    const actions = graphActionsForPlan({
      units: [{ unitId: "main", kind: "worker", diffs: [{ resource: "static-assets", action: "create", name: "app" }] }],
    } as never);
    expect(actions.map((a) => a.phase)).toEqual(["register-assets"]);
    expect(actions[0]).toMatchObject({ unitId: "main", resource: "static-assets", action: "create" });
  });
});

describe("dispatch: nameless schedule carries the whole approved set", () => {
  it("dispatches the plan-emitted nameless schedule diff with the full cron set", () => {
    const spec = workerSpec(["*/5 * * * *", "0 * * * *"]);
    const dispatched = exactGraphDispatchSpec(spec, { resource: "schedule", action: "create" });
    expect(dispatched).not.toBeNull();
    expect(dispatched!.cloudflare.cron).toEqual(["*/5 * * * *", "0 * * * *"]);
  });

  it("dispatches the Worker static-asset action with the whole sealed spec", () => {
    const spec: DeploySpec = {
      ...workerSpec(),
      assets: [{ path: "index.html", size: 1, sha256: "0".repeat(64), workersHash: "1".repeat(32) }],
    };
    const dispatched = exactGraphDispatchSpec(spec, { resource: "static-assets", action: "create", name: "app" });
    expect(dispatched).not.toBeNull();
    expect(dispatched!.cloudflare.workerName).toBe("app");
    expect(exactGraphDispatchSpec(spec, { resource: "static-assets", action: "create", name: "other" })).toBeNull();
  });
});

describe("plan preflight: unsupported diffs block before any approval", () => {
  const ACCOUNT = "a".repeat(32);

  function snapshot(): Record<string, unknown> {
    return {
      accountId: ACCOUNT,
      workerName: "app",
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
  }

  function bundle(): Record<string, unknown> {
    return {
      schemaVersion: 1,
      appName: "app",
      targetKind: "workers",
      mainModule: "worker/index.js",
      modules: [{ name: "worker/index.js", kind: "esm", mime: "application/javascript+module", size: 10, sha256: "1".repeat(64) }],
      assets: [],
      config: { path: "wrangler.jsonc", size: 20, sha256: "2".repeat(64) },
      source: { archiveBytes: 100, archiveSha256: "3".repeat(64), manifestDigest: "4".repeat(64) },
      wranglerEffectiveHash: "5".repeat(64),
      bundleDigest: "bundle-digest-1",
    };
  }

  async function planFor(overrides: { assets?: DeploySpec["assets"]; cron?: string[] }) {
    const { buildDeployGraph } = await import("../../src/core/planning/deploy-graph.js");
    const { buildGraphDeployPlan } = await import("../../src/core/planning/plan.js");
    const spec: DeploySpec = {
      ...workerSpec(overrides.cron ?? []),
      assets: overrides.assets ?? [],
    };
    const graph = buildDeployGraph({ accountId: ACCOUNT, specs: { main: spec }, bundleDigest: "bundle-digest-1" });
    expect(graph.ok).toBe(true);
    return buildGraphDeployPlan(
      {
        graph,
        accountId: ACCOUNT,
        configHash: "c".repeat(64),
        snapshots: { main: snapshot() },
        specs: { main: spec },
        bundle: bundle(),
        declaredCapabilities: ["workers"],
        resolvedCapabilities: ["workers"],
      } as never,
      { salt: "n01-salt" },
    );
  }

  it("leaves a Worker+assets graph addressable once the pair is wired", async () => {
    const plan = await planFor({ assets: [{ path: "a.txt", size: 1, sha256: "0".repeat(64), workersHash: "1".repeat(32) }] });
    expect(plan.guards.map((g) => g.code)).not.toContain("unsupported-operation");
    expect(plan.units[0]!.diffs.some((d) => d.resource === "static-assets" && d.action === "create")).toBe(true);
  });

  it("leaves a cron-only Worker graph addressable", async () => {
    const plan = await planFor({ cron: ["*/5 * * * *", "0 * * * *"] });
    expect(plan.guards.map((g) => g.code)).not.toContain("unsupported-operation");
    expect(plan.units[0]!.diffs.some((d) => d.resource === "schedule" && d.action === "create")).toBe(true);
  });
});

// the server derives the one accepted phase of an approved action from the
// same catalog the plan preflight used; there is no second phase table.
describe("catalog is the only phase table", () => {
  const kinds = ["worker", "pages-static", "pages-functions", "resource-only"] as const;
  const resources = ["worker", "deployment", "static-assets", "pages-project", "r2", "d1", "kv", "queue", "hyperdrive", "vectorize", "secrets-store", "schedule", "workers-dev", "queue-consumer", "workflow", "worker-route", "secret", "worker-custom-domain", "pages-custom-domain"];
  const actions = ["create", "update", "attach", "preserve", "skip", "conflict", "detach", "delete"];

  it("only create/update/attach/detach dispatch; preserve, skip, conflict and unknown actions never do", () => {
    expect(actions.filter(isDispatchableGraphAction)).toEqual(["create", "update", "attach", "detach"]);
    for (const kind of kinds) for (const resource of resources) {
      for (const action of ["preserve", "skip", "conflict", "delete"]) {
        expect(exactGraphPhase({ unitId: "u", unitKind: kind, resource, action }), `${kind}:${resource}:${action}`).toBeUndefined();
      }
    }
  });

  it("detach has a phase only for an operator-chosen custom domain of the matching unit kind", () => {
    for (const kind of kinds) for (const resource of resources) {
      const phase = exactGraphPhase({ unitId: "u", unitKind: kind, resource, action: "detach" });
      const allowed = (kind === "worker" && resource === "worker-custom-domain") || ((kind === "pages-static" || kind === "pages-functions") && resource === "pages-custom-domain");
      expect(phase, `${kind}:${resource}`).toBe(allowed ? "reconcile-domains" : undefined);
    }
  });

  it("the accepted phase is the first catalog phase, and the step allowlist agrees with the catalog", () => {
    for (const kind of kinds) for (const resource of resources) for (const action of actions) {
      const resolution = resolveGraphOperation({ unitId: "u", unitKind: kind, resource, action });
      const phase = exactGraphPhase({ unitId: "u", unitKind: kind, resource, action });
      if (!isDispatchableGraphAction(action) || !resolution.supported || resolution.phases.length === 0) {
        expect(phase, `${kind}:${resource}:${action}`).toBeUndefined();
        continue;
      }
      expect(phase).toBe(resolution.phases[0]);
      expect(DEPLOY_STEP_NAMES as readonly string[], `${kind}:${resource}:${action}`).toContain(phase);
      // Every phase of a supported pair is also a step the unit kind may run.
      for (const each of resolution.phases) {
        expect(isGraphActionStepAllowed({ unitKind: kind, step: each as never, resource, action }), `${kind}:${resource}:${action}:${each}`).toBe(true);
      }
    }
  });

  it("pins the accepted phase per approved action (golden)", () => {
    const golden: Array<[string, string, string, string]> = [
      ["pages-static", "pages-project", "create", "pages-create-project"],
      ["pages-static", "static-assets", "update", "pages-register-assets"],
      ["pages-static", "deployment", "create", "pages-deploy"],
      ["worker", "worker", "create", "create-worker"],
      ["worker", "worker", "update", "create-version"],
      ["worker", "deployment", "create", "activate"],
      ["worker", "static-assets", "create", "register-assets"],
      ["worker", "schedule", "update", "reconcile-schedules"],
      ["worker", "workers-dev", "create", "publish-workers-dev"],
      ["worker", "queue-consumer", "create", "register-queue-consumers"],
      ["worker", "workflow", "update", "apply-workflows"],
      ["worker", "worker-route", "create", "reconcile-domains"],
      ["worker", "r2", "create", "create-r2-buckets"],
      ["resource-only", "kv", "create", "create-kv-namespaces"],
    ];
    for (const [unitKind, resource, action, phase] of golden) expect(exactGraphPhase({ unitId: "u", unitKind, resource, action }), `${unitKind}:${resource}:${action}`).toBe(phase);
  });

  it("a Worker secret diff is covered by the version upload and has no phase of its own", () => {
    expect(exactGraphPhase({ unitId: "u", unitKind: "worker", resource: "secret", action: "create" })).toBeUndefined();
  });

  it("resource kinds are looked up by own key only (no prototype names)", () => {
    for (const resource of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(graphResourceCreatePhase(resource), resource).toBeUndefined();
      expect(graphStepForResourceAction(resource, "create"), resource).toBeUndefined();
      expect(resolveGraphOperation({ unitId: "u", unitKind: "worker", resource, action: "create" }).supported, resource).toBe(false);
      expect(resolveGraphOperation({ unitId: "u", unitKind: "resource-only", resource, action: "create" }).supported, resource).toBe(false);
    }
    expect(graphResourceCreatePhase("r2")).toBe("create-r2-buckets");
    expect(graphStepForResourceAction("r2", "update")).toBeUndefined();
  });
});
