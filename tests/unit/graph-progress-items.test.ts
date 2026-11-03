// Deploy progress shows one row per deployed item (each Worker / Pages site,
// each created resource, each domain), built only from the approved plan.

import { describe, expect, it } from "vitest";
import { graphProgressItems } from "../../src/web/DeployProgress.js";
import type { GraphPlan } from "../../src/web/api.js";

function plan(): GraphPlan {
  return {
    ok: true,
    blocked: false,
    digest: "d",
    units: [
      { unitId: "data", kind: "resource-only", name: "", requiresBundle: false, diffs: [{ resource: "kv", action: "create", name: "cache" }] },
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
          { resource: "worker-custom-domain", action: "attach", name: "app.example.com" },
        ],
      },
      {
        unitId: "site",
        kind: "pages-static",
        name: "site",
        requiresBundle: true,
        diffs: [
          { resource: "pages-project", action: "create", name: "site" },
          { resource: "static-assets", action: "create", name: "site" },
          { resource: "deployment", action: "create", name: "site" },
        ],
      },
    ],
    guards: [],
    cost: { operations: [], requiresConfirmation: false, confirmed: true, blockedUnknownCost: false },
    takeover: { workers: [], confirmed: false },
  };
}

describe("graphProgressItems", () => {
  it("shows one row per deployed item, in plan order", () => {
    const items = graphProgressItems(plan(), []);
    expect(items.map((item) => [item.key, item.label, item.name])).toEqual([
      ["data-kv-cache", "KV namespace", "cache"],
      ["main-r2-media", "R2 bucket", "media"],
      ["main", "Worker", "api"],
      ["main-domain-app.example.com", "Custom domain", "app.example.com"],
      ["site", "Pages site", "site"],
    ]);
    expect(items.every((item) => item.state === "pending" && !item.verified)).toBe(true);
  });

  it("summarizes the steps behind an item and names the current one", () => {
    const items = graphProgressItems(plan(), [
      { unitId: "main", resource: "worker", action: "create", name: "api", phase: "create-worker", state: "done", receipt: true },
      { unitId: "main", resource: "deployment", action: "create", name: "api", phase: "activate", state: "waiting", detail: "waiting for dependency receipts" },
      { unitId: "site", resource: "pages-project", action: "create", name: "site", phase: "pages-create-project", state: "done", receipt: true },
      { unitId: "site", resource: "deployment", action: "create", name: "site", phase: "pages-deploy", state: "error", detail: "Cloudflare answered with an error" },
    ]);
    expect(items.find((item) => item.key === "main")).toMatchObject({ state: "waiting", detail: "Activate the new version" });
    expect(items.find((item) => item.key === "site")).toMatchObject({ state: "error", detail: "Create Pages deployment: Cloudflare answered with an error" });
  });

  it("is done and verified only when every step behind it is, postcheck included", () => {
    const steps = [
      { unitId: "main", resource: "worker", action: "create", name: "api", phase: "create-worker", state: "done" as const, receipt: true },
      { unitId: "main", resource: "deployment", action: "create", name: "api", phase: "activate", state: "done" as const, receipt: true },
    ];
    expect(graphProgressItems(plan(), steps, [{ unitId: "main", resource: "worker", action: "create", phase: "postcheck", state: "running" }]).find((item) => item.key === "main")).toMatchObject({ state: "running", detail: "Verify the live Worker" });
    expect(graphProgressItems(plan(), steps, [{ unitId: "main", resource: "worker", action: "create", phase: "postcheck", state: "done" }]).find((item) => item.key === "main")).toMatchObject({ state: "done", verified: true });
  });

  it("never reads done before its verification, so an item does not step back from done to verifying", () => {
    const actions = [
      { unitId: "main", resource: "worker", action: "create", name: "api", phase: "create-worker", state: "done" as const, receipt: true },
      { unitId: "main", resource: "deployment", action: "create", name: "api", phase: "activate", state: "done" as const, receipt: true },
      { unitId: "site", resource: "pages-project", action: "create", name: "site", phase: "pages-create-project", state: "done" as const, receipt: true },
      { unitId: "site", resource: "static-assets", action: "create", name: "site", phase: "pages-register-assets", state: "done" as const, receipt: true },
      { unitId: "site", resource: "deployment", action: "create", name: "site", phase: "pages-deploy", state: "done" as const, receipt: true },
    ];
    const timeline = [
      [],
      [{ unitId: "main", resource: "worker", action: "create", phase: "postcheck", state: "running" as const }],
      [{ unitId: "main", resource: "worker", action: "create", phase: "postcheck", state: "done" as const }, { unitId: "site", resource: "deployment", action: "create", phase: "pages-postcheck", state: "running" as const }],
      [{ unitId: "main", resource: "worker", action: "create", phase: "postcheck", state: "done" as const }, { unitId: "site", resource: "deployment", action: "create", phase: "pages-postcheck", state: "done" as const }],
    ];
    const states = timeline.map((checks) => {
      const items = graphProgressItems(plan(), actions, checks);
      return ["main", "site"].map((key) => items.find((item) => item.key === key)!.state);
    });
    expect(states).toEqual([["running", "running"], ["running", "running"], ["done", "running"], ["done", "done"]]);
  });

  it("statuses for unapproved phases never add a row", () => {
    const items = graphProgressItems(plan(), [
      { unitId: "main", resource: "worker", action: "create", name: "api", phase: "register-assets", state: "done", receipt: true },
    ]);
    expect(items).toHaveLength(5);
  });
});
