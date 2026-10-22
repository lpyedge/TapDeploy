import { describe, expect, it } from "vitest";

import { executeDeployStep, DEPLOY_STEP_NAMES, isDeployStepForTarget } from "../../src/core/deploy/steps.js";

type Calls = string[];

function fakeCtx(opts: { accountSubdomain?: string | "missing"; enabled: boolean; previews?: boolean; stuckDisabled?: boolean; workerName?: string }) {
  const calls: Calls = [];
  let enabled = opts.enabled;
  const client = {
    getAccountSubdomain: async () => {
      calls.push("getAccountSubdomain");
      if (opts.accountSubdomain === "missing") throw Object.assign(new Error("none"), { kind: "not-found" });
      return opts.accountSubdomain ?? "acme";
    },
    getScriptSubdomain: async () => {
      calls.push("getScriptSubdomain");
      return { enabled, previews_enabled: opts.previews ?? false };
    },
    setScriptSubdomain: async (_name: string, state: { enabled: boolean; previews_enabled: boolean }) => {
      calls.push(`set:${JSON.stringify(state)}`);
      if (!opts.stuckDisabled) enabled = state.enabled;
      return state;
    },
  };
  const ctx = {
    client,
    accountId: "a".repeat(32),
    workerName: opts.workerName ?? "my-worker",
    spec: { targetKind: "workers", assets: [], cloudflare: { r2: [], d1: [], kv: [], queues: [], hyperdrive: [], vectorize: [], secretsStore: [], runtimeBindings: [], cron: [], secrets: {} } },
    snapshot: {},
    accessToken: "t",
    beforeMutation: async () => void calls.push("guard"),
  };
  return { ctx: ctx as never, calls };
}

describe("publish-workers-dev step", () => {
  it("is a Workers-only step", () => {
    expect(DEPLOY_STEP_NAMES).toContain("publish-workers-dev");
    expect(isDeployStepForTarget("workers", "publish-workers-dev")).toBe(true);
    expect(isDeployStepForTarget("pages", "publish-workers-dev")).toBe(false);
  });

  it("does nothing unless the operator asked for it", async () => {
    const { ctx, calls } = fakeCtx({ enabled: false });
    expect(await executeDeployStep("publish-workers-dev", ctx, {})).toEqual({ ok: true, result: { published: false, skipped: true } });
    expect(calls).toEqual([]);
  });

  it("enables workers.dev, keeps the preview flag and reports the address built from provider values", async () => {
    const { ctx, calls } = fakeCtx({ enabled: false, previews: true });
    const outcome = await executeDeployStep("publish-workers-dev", ctx, { publish: true });
    expect(outcome).toEqual({ ok: true, result: { published: true, url: "https://my-worker.acme.workers.dev" } });
    expect(calls).toEqual(["getAccountSubdomain", "getScriptSubdomain", "guard", 'set:{"enabled":true,"previews_enabled":true}', "getScriptSubdomain"]);
  });

  it("does not write when the Worker is already published", async () => {
    const { ctx, calls } = fakeCtx({ enabled: true });
    const outcome = await executeDeployStep("publish-workers-dev", ctx, { publish: true });
    expect(outcome).toMatchObject({ ok: true, result: { published: true } });
    expect(calls.some((c) => c.startsWith("set:"))).toBe(false);
  });

  it("explains an account without a workers.dev subdomain instead of guessing an address", async () => {
    const { ctx, calls } = fakeCtx({ accountSubdomain: "missing", enabled: false });
    expect(await executeDeployStep("publish-workers-dev", ctx, { publish: true })).toEqual({ ok: true, result: { published: false, reason: "no-account-subdomain" } });
    expect(calls).toEqual(["getAccountSubdomain"]);
  });

  it("fails when the flag does not read back as enabled, and omits the address for a non-DNS worker name", async () => {
    const stuck = fakeCtx({ enabled: false, stuckDisabled: true });
    expect(await executeDeployStep("publish-workers-dev", stuck.ctx, { publish: true })).toMatchObject({ ok: false });
    const odd = fakeCtx({ enabled: true, workerName: "my_worker.v2" });
    expect(await executeDeployStep("publish-workers-dev", odd.ctx, { publish: true })).toEqual({ ok: true, result: { published: true } });
  });
});
