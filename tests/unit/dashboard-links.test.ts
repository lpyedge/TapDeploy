// Result-card dashboard links come from the server-approved plan's effective
// target names (any action), never from a guessed suffix or the release name.
import { describe, expect, it } from "vitest";
import type { GraphPlan } from "../../src/web/api.js";
import { dashboardTargetUrl, dashboardUrlForGraphPlan } from "../../src/web/DeployProgress.js";

const ACCOUNT = "a".repeat(32);
const plan = (units: Array<{ kind: string; diffs: Array<{ resource: string; action: string; name?: string }> }>): GraphPlan => ({
  ok: true, blocked: false, digest: "d", guards: [],
  cost: { operations: [], requiresConfirmation: false, confirmed: false, blockedUnknownCost: false },
  units: units.map((unit, index) => ({ unitId: `u${index}`, name: "n", requiresBundle: false, ...unit })),
});

describe("dashboardTargetUrl", () => {
  it("links the Worker overview without a guessed /production suffix and encodes names", () => {
    expect(dashboardTargetUrl(ACCOUNT, "workers", "my-api")).toBe(`https://dash.cloudflare.com/${ACCOUNT}/workers/services/view/my-api`);
    expect(dashboardTargetUrl(ACCOUNT, "pages", "site")).toBe(`https://dash.cloudflare.com/${ACCOUNT}/pages/view/site`);
    expect(dashboardTargetUrl(ACCOUNT, "workers", "a/b")).toContain("/view/a%2Fb");
  });
});

describe("dashboardUrlForGraphPlan", () => {
  const account = `https://dash.cloudflare.com/${ACCOUNT}`;

  it("uses the effective Worker name for a fresh install", () => {
    const url = dashboardUrlForGraphPlan(ACCOUNT, plan([{ kind: "worker", diffs: [{ resource: "worker", action: "create", name: "renamed-api" }, { resource: "deployment", action: "create", name: "renamed-api" }] }]));
    expect(url).toBe(`${account}/workers/services/view/renamed-api`);
  });

  it("still links the upgraded Worker (update) instead of falling back to the account home", () => {
    const url = dashboardUrlForGraphPlan(ACCOUNT, plan([{ kind: "worker", diffs: [{ resource: "worker", action: "update", name: "existing-api" }] }]));
    expect(url).toBe(`${account}/workers/services/view/existing-api`);
  });

  it("links a Pages project for create and for preserve of an existing project", () => {
    for (const action of ["create", "preserve"]) {
      const url = dashboardUrlForGraphPlan(ACCOUNT, plan([{ kind: "pages-static", diffs: [{ resource: "pages-project", action, name: "site" }, { resource: "deployment", action: "create", name: "site" }] }]));
      expect(url, action).toBe(`${account}/pages/view/site`);
    }
  });

  it("prefers the Worker for a Worker + Pages release", () => {
    const url = dashboardUrlForGraphPlan(ACCOUNT, plan([
      { kind: "pages-static", diffs: [{ resource: "pages-project", action: "create", name: "site" }] },
      { kind: "worker", diffs: [{ resource: "worker", action: "create", name: "api" }] },
    ]));
    expect(url).toBe(`${account}/workers/services/view/api`);
  });

  it("never invents a target: resource-only, nameless or missing plans link the account home", () => {
    expect(dashboardUrlForGraphPlan(ACCOUNT, plan([{ kind: "resource-only", diffs: [{ resource: "r2", action: "create", name: "media" }] }]))).toBe(account);
    expect(dashboardUrlForGraphPlan(ACCOUNT, plan([{ kind: "worker", diffs: [{ resource: "worker", action: "create" }] }]))).toBe(account);
    expect(dashboardUrlForGraphPlan(ACCOUNT, null)).toBe(account);
  });
});
