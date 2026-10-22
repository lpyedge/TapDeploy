// graph progress lists ONLY server-approved actions. No static step
// spam, no unapproved work, no invented URLs; states come from live statuses.

import { describe, expect, it } from "vitest";
import { graphStepRows } from "../../src/web/DeployProgress.js";
import type { GraphPlan } from "../../src/web/api.js";

function plan(): GraphPlan {
  return {
    ok: true,
    blocked: false,
    digest: "d",
    units: [
      {
        unitId: "main",
        kind: "worker",
        name: "api",
        requiresBundle: true,
        diffs: [
          { resource: "r2", action: "create", name: "media" },
          { resource: "worker", action: "preserve", name: "api" },
          { resource: "worker", action: "create", name: "api" },
          { resource: "deployment", action: "create", name: "api" },
        ],
      },
      {
        unitId: "resources",
        kind: "resource-only",
        name: "",
        requiresBundle: false,
        diffs: [{ resource: "kv", action: "create", name: "cache" }],
      },
    ],
    guards: [],
    cost: { operations: [], requiresConfirmation: false, confirmed: true, blockedUnknownCost: false },
  };
}

describe("graphStepRows", () => {
  it("lists exactly the approved dispatchable actions in plan order", () => {
    const rows = graphStepRows(plan(), []);
    expect(rows.map((row) => `${row.unitId}:${row.phase}`)).toEqual([
      "main:create-r2-buckets",
      "main:create-worker",
      "main:activate",
      "resources:create-kv-namespaces",
    ]);
    expect(rows.every((row) => row.state === "pending" && row.receipt === false)).toBe(true);
  });

  it("never invents deployment addresses; resource-only rows carry none", () => {
    const rows = graphStepRows(plan(), []);
    for (const row of rows) {
      expect(row).not.toHaveProperty("url");
    }
    expect(rows.filter((row) => row.unitId === "resources")).toHaveLength(1);
  });

  it("maps live statuses onto rows and marks verified receipts", () => {
    const rows = graphStepRows(plan(), [
      { unitId: "main", resource: "r2", action: "create", name: "media", phase: "create-r2-buckets", state: "done", receipt: true },
      { unitId: "main", resource: "worker", action: "create", name: "api", phase: "create-worker", state: "running" },
      { unitId: "main", resource: "deployment", action: "create", name: "api", phase: "activate", state: "waiting", detail: "waiting for dependency receipts" },
    ]);
    expect(rows[0]).toMatchObject({ phase: "create-r2-buckets", state: "done", receipt: true });
    expect(rows[1]).toMatchObject({ phase: "create-worker", state: "running", receipt: false });
    expect(rows[2]).toMatchObject({ phase: "activate", state: "waiting", detail: "waiting for dependency receipts" });
    expect(rows[3]).toMatchObject({ phase: "create-kv-namespaces", state: "pending" });
  });

  it("statuses for unapproved phases never appear", () => {
    const rows = graphStepRows(plan(), [
      { unitId: "main", resource: "worker", action: "create", name: "api", phase: "register-assets", state: "done", receipt: true },
    ]);
    expect(rows).toHaveLength(4);
    expect(rows.some((row) => row.phase === "register-assets")).toBe(false);
  });
});
