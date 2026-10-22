// contract oracle for the graph-step server boundary. These tests use the
// real sealed approval/receipt code and the route's shared authorization helper;
// no provider call is possible until that boundary accepts an exact, approved
// unit/action. This keeps cross-unit replay, partial progress and first-version
// ownership safety testable in both Node and Workers runtimes.

import { describe, expect, it } from "vitest";

import {
  authorizeGraphStep,
} from "../../src/api/routes/deploy-step.js";
import {
  graphActionId,
  computeGraphStepStateHash,
} from "../../src/core/planning/digest.js";
import {
  sealGraphPlanApproval,
  sealGraphStepReceipt,
  verifyGraphStepReceipt,
} from "../../src/core/planning/plan-approval.js";
import { deriveSealKey } from "../../src/auth/keys.js";
import type { GraphDeployPlan } from "../../src/core/planning/plan.js";
import type { ExpectedTarget } from "../../src/core/planning/types.js";

const ACCOUNT = "a".repeat(32);
const OTHER_ACCOUNT = "b".repeat(32);
const NONCE = "session-nonce";
const CONFIG_HASH = "config-hash";
const DIGEST = "graph-digest";
const EXPIRES = Date.now() + 60_000;
const REFS: Record<string, ExpectedTarget> = {
  resources: { accountId: ACCOUNT, workerName: "" },
  worker: { accountId: ACCOUNT, workerName: "app" },
};

function actionId(unitId: string, resource: string, action: string, name?: string): string {
  return graphActionId({ unitId, resource, action, ...(name ? { name } : {}) });
}

function plan(overrides: Partial<GraphDeployPlan> = {}): GraphDeployPlan {
  return {
    ok: true,
    blocked: false,
    accountId: ACCOUNT,
    configHash: CONFIG_HASH,
    requiresBundle: true,
    bundleDigest: "bundle-proof",
    units: [
      {
        unitId: "resources",
        kind: "resource-only",
        identity: "none",
        name: "resources",
        requiresBundle: false,
        plan: null,
        diffs: [{ resource: "r2", action: "create", name: "media" }],
        guards: [],
        resourceIdentities: [],
        targets: [],
        activeSecretProof: [],
      },
      {
        unitId: "worker",
        kind: "worker",
        identity: "worker-script",
        name: "app",
        requiresBundle: true,
        plan: null,
        diffs: [{ resource: "worker", action: "create", name: "app" }],
        guards: [],
        resourceIdentities: [],
        targets: [],
        activeSecretProof: [],
      },
    ],
    guards: [],
    graphGuards: [],
    cost: { operations: [], requiresConfirmation: false, confirmed: false, blockedUnknownCost: false },
    scopeCoverage: { ok: true, undeclared: [] },
    digest: DIGEST,
    targets: [],
    activeSecretProof: [],
    resourceIdentities: [],
    ...overrides,
  };
}

async function approval(key: CryptoKey, graph = plan(), refs = REFS) {
  return sealGraphPlanApproval(key, {
    nonce: NONCE,
    configHash: CONFIG_HASH,
    accountId: ACCOUNT,
    digest: graph.digest,
    references: refs,
    expiresAt: EXPIRES,
  });
}

describe("graph step execution boundary", () => {
  it("allows only the exact sealed resource-only action, with no bundle", async () => {
    const key = await deriveSealKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const graph = plan();
    const result = await authorizeGraphStep({
      key,
      approval: await approval(key, graph),
      nonce: NONCE,
      configHash: CONFIG_HASH,
      accountId: ACCOUNT,
      graphPlan: graph,
      references: REFS,
      unitId: "resources",
      actionId: actionId("resources", "r2", "create", "media"),
      step: "create-r2-buckets",
    });
    expect(result).toMatchObject({ ok: true, action: { resource: "r2", action: "create", name: "media" } });
  });

  it("rejects cross-unit replay, forged action ids, and invalid resource-only steps", async () => {
    const key = await deriveSealKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const graph = plan();
    const sealed = await approval(key, graph);
    const base = {
      key, approval: sealed, nonce: NONCE, configHash: CONFIG_HASH, accountId: ACCOUNT,
      graphPlan: graph, references: REFS, unitId: "resources",
    };
    const cross = await authorizeGraphStep({
      ...base,
      actionId: actionId("worker", "worker", "create", "app"),
      step: "create-r2-buckets",
    });
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.detail).toContain("exact approved unit diff");

    const wrongStep = await authorizeGraphStep({
      ...base,
      actionId: actionId("resources", "r2", "create", "media"),
      step: "create-worker",
    });
    expect(wrongStep.ok).toBe(false);
    if (!wrongStep.ok) expect(wrongStep.detail).toContain("not valid");
  });

  it("requires the exact bundle proof for a Worker first PUT already serving", async () => {
    const key = await deriveSealKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const graph = plan();
    const base = {
      key, approval: await approval(key, graph), nonce: NONCE, configHash: CONFIG_HASH,
      accountId: ACCOUNT, graphPlan: graph, references: REFS, unitId: "worker",
      actionId: actionId("worker", "worker", "create", "app"), step: "create-worker" as const,
    };
    const missing = await authorizeGraphStep(base);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.detail).toContain("exact approved bundle");
    expect((await authorizeGraphStep({ ...base, bundleDigest: "other" })).ok).toBe(false);
    expect((await authorizeGraphStep({ ...base, bundleDigest: "bundle-proof" })).ok).toBe(true);
  });

  it("rejects a foreign account, changed reference, expired approval, and blocked graph", async () => {
    const key = await deriveSealKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const graph = plan();
    const valid = await approval(key, graph);
    const base = {
      key, approval: valid, nonce: NONCE, configHash: CONFIG_HASH, accountId: ACCOUNT,
      graphPlan: graph, references: REFS, unitId: "resources",
      actionId: actionId("resources", "r2", "create", "media"), step: "create-r2-buckets" as const,
    };
    expect((await authorizeGraphStep({ ...base, accountId: OTHER_ACCOUNT })).ok).toBe(false);
    expect((await authorizeGraphStep({ ...base, references: { ...REFS, resources: { ...REFS.resources!, workerName: "forged" } } })).ok).toBe(false);
    const expired = await sealGraphPlanApproval(key, {
      nonce: NONCE, configHash: CONFIG_HASH, accountId: ACCOUNT, digest: DIGEST,
      references: REFS, expiresAt: 0,
    });
    expect((await authorizeGraphStep({ ...base, approval: expired })).ok).toBe(false);
    expect((await authorizeGraphStep({ ...base, graphPlan: plan({ blocked: true }) })).ok).toBe(false);
  });

  it("authorizes the exact whole-set schedule action with its reconcile phase", async () => {
    const key = await deriveSealKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const graph = plan({
      units: [{ ...plan().units[1]!, diffs: [{ resource: "schedule", action: "create" }] }],
    });
    const valid = await authorizeGraphStep({
      key, approval: await approval(key, graph), nonce: NONCE,
      configHash: CONFIG_HASH, accountId: ACCOUNT, graphPlan: graph,
      references: REFS, unitId: "worker",
      actionId: actionId("worker", "schedule", "create"), step: "reconcile-schedules",
      bundleDigest: "bundle-proof",
    });
    expect(valid).toMatchObject({ ok: true, action: { resource: "schedule", action: "create" } });
    // A per-cron slice is not an approved diff, and a mismatched step is not
    // valid for the approved schedule action.
    const base = {
      key, approval: await approval(key, graph), nonce: NONCE,
      configHash: CONFIG_HASH, accountId: ACCOUNT, graphPlan: graph,
      references: REFS, unitId: "worker", bundleDigest: "bundle-proof",
    };
    const sliced = await authorizeGraphStep({
      ...base, actionId: actionId("worker", "schedule", "create", "*/5 * * * *"), step: "reconcile-schedules",
    });
    expect(sliced.ok).toBe(false);
    // A cross-target step is never valid for the approved schedule action
    // (the route's exact-phase check additionally pins the single phase).
    const wrongStep = await authorizeGraphStep({
      ...base, actionId: actionId("worker", "schedule", "create"), step: "pages-deploy",
    });
    expect(wrongStep.ok).toBe(false);
  });

  it("authorizes the workers-dev enable action only with its publish phase", async () => {
    const key = await deriveSealKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const graph = plan({
      units: [{ ...plan().units[1]!, diffs: [{ resource: "workers-dev", action: "create", name: "app" }] }],
    });
    const base = {
      key, approval: await approval(key, graph), nonce: NONCE,
      configHash: CONFIG_HASH, accountId: ACCOUNT, graphPlan: graph,
      references: REFS, unitId: "worker", bundleDigest: "bundle-proof",
    };
    const valid = await authorizeGraphStep({
      ...base, actionId: actionId("worker", "workers-dev", "create", "app"), step: "publish-workers-dev",
    });
    expect(valid).toMatchObject({ ok: true, action: { resource: "workers-dev", action: "create", name: "app" } });
    // A cross-target step is never valid for the approved enable action
    // (the route's exact-phase check additionally pins the single phase).
    const wrongStep = await authorizeGraphStep({
      ...base, actionId: actionId("worker", "workers-dev", "create", "app"), step: "pages-deploy",
    });
    expect(wrongStep.ok).toBe(false);
  });

  it("authorizes the queue-consumer trigger action only with its register phase", async () => {
    const key = await deriveSealKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const graph = plan({
      units: [{ ...plan().units[1]!, diffs: [{ resource: "queue-consumer", action: "create", name: "jobs" }] }],
    });
    const base = {
      key, approval: await approval(key, graph), nonce: NONCE,
      configHash: CONFIG_HASH, accountId: ACCOUNT, graphPlan: graph,
      references: REFS, unitId: "worker", bundleDigest: "bundle-proof",
    };
    const valid = await authorizeGraphStep({
      ...base, actionId: actionId("worker", "queue-consumer", "create", "jobs"), step: "register-queue-consumers",
    });
    expect(valid).toMatchObject({ ok: true, action: { resource: "queue-consumer", action: "create", name: "jobs" } });
    // A cross-target step is never valid for the approved trigger action. The
    // route additionally pins the one exact phase (register-queue-consumers);
    // the graph API e2e covers the forged-activate refusal.
    const wrongStep = await authorizeGraphStep({
      ...base, actionId: actionId("worker", "queue-consumer", "create", "jobs"), step: "pages-deploy",
    });
    expect(wrongStep.ok).toBe(false);
    // A queue-less trigger action is not a sealed approved diff.
    const unnamed = await authorizeGraphStep({
      ...base, actionId: actionId("worker", "queue-consumer", "create"), step: "register-queue-consumers",
    });
    expect(unnamed.ok).toBe(false);
  });

  it("never dispatches preserve/conflict/detach diffs even when sealed", async () => {
    const key = await deriveSealKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    for (const action of ["preserve", "conflict", "detach"] as const) {
      const graph = plan({
        units: [{ ...plan().units[0]!, diffs: [{ resource: "r2", action, name: "media" }] }],
        requiresBundle: false,
        bundleDigest: null,
      });
      const result = await authorizeGraphStep({
        key, approval: await approval(key, graph, { resources: REFS.resources! }), nonce: NONCE,
        configHash: CONFIG_HASH, accountId: ACCOUNT, graphPlan: graph,
        references: { resources: REFS.resources! }, unitId: "resources",
        actionId: actionId("resources", "r2", action, "media"), step: "create-r2-buckets",
      });
      expect(result.ok).toBe(false);
      // preserve/conflict are never dispatchable; detach exists only for an
      // operator-removed custom domain, so an R2 detach is not a valid step.
      if (!result.ok) expect(result.detail).toMatch(action === "detach" ? /not valid for this approved unit action/ : /not a dispatchable safe mutation/);
    }
  });
});

describe("graph progress receipts", () => {
  it("binds partial-create progress to exact unit/action/state identities", async () => {
    const key = await deriveSealKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const action = actionId("resources", "r2", "create", "media");
    const stateHash = await computeGraphStepStateHash({
      accountId: ACCOUNT, planDigest: DIGEST, unitId: "resources", actionId: action,
      state: "succeeded", resourceIdentities: { media: "bucket-id" },
    });
    const receipt = await sealGraphStepReceipt(key, {
      nonce: NONCE, configHash: CONFIG_HASH, accountId: ACCOUNT, planDigest: DIGEST,
      unitId: "resources", actionId: action, stateHash, expiresAt: EXPIRES,
    });
    const expected = { nonce: NONCE, configHash: CONFIG_HASH, accountId: ACCOUNT, planDigest: DIGEST, unitId: "resources", actionId: action, stateHash };
    expect(await verifyGraphStepReceipt(key, receipt, expected)).toBe(true);
    expect(await verifyGraphStepReceipt(key, receipt, { ...expected, unitId: "worker" })).toBe(false);
    expect(await verifyGraphStepReceipt(key, receipt, { ...expected, actionId: actionId("resources", "r2", "create", "other") })).toBe(false);
    expect(await verifyGraphStepReceipt(key, receipt, { ...expected, stateHash: "foreign" })).toBe(false);
  });

  it("rejects expiry and tampering rather than claiming partial graph success", async () => {
    const key = await deriveSealKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    const action = actionId("resources", "r2", "create", "media");
    const stateHash = await computeGraphStepStateHash({
      accountId: ACCOUNT, planDigest: DIGEST, unitId: "resources", actionId: action,
      state: "failed", resourceIdentities: {},
    });
    const expired = await sealGraphStepReceipt(key, {
      nonce: NONCE, configHash: CONFIG_HASH, accountId: ACCOUNT, planDigest: DIGEST,
      unitId: "resources", actionId: action, stateHash, expiresAt: 0,
    });
    const expected = { nonce: NONCE, configHash: CONFIG_HASH, accountId: ACCOUNT, planDigest: DIGEST, unitId: "resources", actionId: action, stateHash };
    expect(await verifyGraphStepReceipt(key, expired, expected)).toBe(false);
    const valid = await sealGraphStepReceipt(key, { ...expected, expiresAt: EXPIRES });
    expect(await verifyGraphStepReceipt(key, { ...valid, ciphertext: "forged" }, expected)).toBe(false);
  });
});
