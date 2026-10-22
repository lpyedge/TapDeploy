// Red reproducer: live-source graph action defects (no live Cloudflare).
// Each test asserts the CORRECT behavior; all three FAIL on current source,
// proving the confirmed defects before any fix (own the fixes).
import { describe, expect, it } from "vitest";
import type { DeploySpec } from "../../src/core/deploy-spec.js";
import { exactGraphDispatchSpec } from "../../src/core/deploy/graph-dispatch.js";
import { plannedNamespaceActionFor } from "../../src/cloudflare/resources/kv.js";
import { graphPhaseForDiff } from "../../src/web/graph-deploy-runner.js";

function file(path: string) {
  return { path, size: 16, sha256: "0".repeat(64) };
}

function workerSpec(overrides: { assets?: number; cron?: string[] } = {}): DeploySpec {
  return {
    schemaVersion: 1,
    project: { id: "test/app", version: "1.0.0" },
    worker: file("index.js"),
    assets: Array.from({ length: overrides.assets ?? 0 }, (_, i) => file(`asset-${i}.txt`)),
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
      cron: overrides.cron ?? [],
      secrets: {},
    },
    wrangler: {
      name: "app",
      compatibility_date: "2026-01-01",
      r2_buckets: [],
      crons: overrides.cron ?? [],
    },
    targetKind: "workers",
  } as DeploySpec;
}

describe("red repro: Worker+Assets graph addressing (DEFECT WORKER_ASSETS_GRAPH_GAP)", () => {
  it("maps a Worker static-assets create to a worker asset phase instead of throwing", () => {
    // plan.ts emits {resource:'static-assets',action:'create'} for Worker+assets;
    // graphPhaseForDiff must address it (currently throws: pages-only mapping).
    const phase = graphPhaseForDiff("worker", "static-assets", "create");
    expect(typeof phase).toBe("string");
    expect(phase.length).toBeGreaterThan(0);
  });
});

describe("red repro: schedule identity (DEFECT SCHEDULE_NO_IDENTITY)", () => {
  it("dispatches the nameless schedule diff emitted by plan.ts (no name field)", () => {
    // plan.ts ~530-538 emits {resource:'schedule',action:'create'} with NO name.
    // exactGraphDispatchSpec requires action.name and returns null -> FAIL.
    const spec = workerSpec({ cron: ["*/5 * * * *", "0 * * * *"] });
    const dispatched = exactGraphDispatchSpec(spec, { resource: "schedule", action: "create" });
    expect(dispatched).not.toBeNull();
  });
});

describe("regression: KV wrangler id is a provider identity, never a creation title", () => {
  it("verifies by namespace id and preserves the live namespace instead of creating a fake one", () => {
    // 's original repro asserted the OLD name-based shape (which would have
    // created "abc123-id"). fixed the defect: the wrangler projection now
    // carries `namespaceId` and the planner resolves it by IDENTITY. This
    // regression pins the fixed behavior at the same seam.
    const known = [{ id: "abc123-id", name: "real-kv-name" }];
    const action = plannedNamespaceActionFor(
      { binding: "KV", namespaceId: "abc123-id" },
      known,
    );
    // The live namespace is preserved by id; no namespace named by the id is created.
    expect(action).toEqual({ binding: "KV", namespaceName: "real-kv-name", action: "preserve", id: "abc123-id" });
    expect(action.action).not.toBe("create");

    // An id that is not present live is a conflict — a KV namespace is never
    // recreated from a wrangler binding, and the id is never used as a title.
    const missing = plannedNamespaceActionFor(
      { binding: "KV", namespaceId: "deadbeef-id" },
      known,
    );
    expect(missing.action).toBe("conflict");
    if (missing.action === "conflict") expect(missing.detail).toContain("never recreated");

    // A binding with no id cannot be verified and refuses rather than creating.
    const unverifiable = plannedNamespaceActionFor(
      { binding: "KV", namespaceId: "" },
      known,
    );
    expect(unverifiable.action).toBe("conflict");
  });
});
