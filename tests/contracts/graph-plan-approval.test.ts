// multi-unit graph plan approval +
// SERVER-side capability recheck contract.
//
// Covers the task's oracle list with literal structural inputs (the module chain
// has no provider calls and no v2 schema dependency, so it always loads):
//   - tampered source / module bytes change the plan digest
//   - scope underdeclaration (capability or install policy not covered) is
//     refused as a developer error BEFORE any write, with no second OAuth
//   - a unit snapshot from a different account blocks
//   - unknown price (block-unknown-cost) blocks a metered create
//   - drift: a changed live identity between plan and write blocks
//   - a resource-only multi-unit plan needs no bundle and binds every unit
//   - synthetic (planned) targets are kept distinct from active secret proof
//   - the sealed graph approval authenticates session/config/account/digest and
//     every per-unit reference

import { expect, it } from "vitest";

import type { DeploySpec } from "../../src/core/deploy-spec.js";
import { deriveSealKey } from "../../src/auth/keys.js";
import {
  buildDeployGraph,
  type DeployGraphInput,
} from "../../src/core/planning/deploy-graph.js";
import {
  buildGraphDeployPlan,
  graphPlanReferences,
  type GraphDeployPlan,
  type GraphDeployPlanInput,
} from "../../src/core/planning/plan.js";
import {
  authorizeGraphIntent,
  resolvedCapabilitiesForGraph,
} from "../../src/core/config-envelope.js";
import {
  sealGraphPlanApproval,
  verifyGraphPlanApproval,
  type GraphApprovalContext,
} from "../../src/core/planning/plan-approval.js";
import type { TargetSnapshot } from "../../src/core/planning/types.js";
import type { DeployBundle } from "../../src/release/deploy-bundle.js";

const ACCOUNT = "a".repeat(32);
const OTHER_ACCOUNT = "b".repeat(32);
const SALT = "csrf-mock-token";
const CONFIG_HASH = "c".repeat(64);

// ---------------------------------------------------------------------------
// Literal fixtures (the resolver/planner only read the fields set here)
// ---------------------------------------------------------------------------

interface SpecOverrides {
  r2?: DeploySpec["cloudflare"]["r2"];
  kv?: DeploySpec["cloudflare"]["kv"];
  queues?: DeploySpec["cloudflare"]["queues"];
  runtimeBindings?: DeploySpec["cloudflare"]["runtimeBindings"];
  secrets?: DeploySpec["cloudflare"]["secrets"];
  domains?: DeploySpec["cloudflare"]["domains"];
  cron?: string[];
}

function file(path: string) {
  return { path, size: 16, sha256: "0".repeat(64) };
}

function spec(targetKind: "workers" | "pages", name: string, overrides: SpecOverrides = {}): DeploySpec {
  const pages = targetKind === "pages";
  return {
    schemaVersion: 1,
    project: { id: `test/${name}`, version: "1.0.0" },
    ...(pages ? {} : { worker: file("index.js") }),
    assets: [],
    inputs: {},
    cloudflare: {
      workerName: name,
      r2: overrides.r2 ?? [],
      d1: [],
      kv: overrides.kv ?? [],
      queues: overrides.queues ?? [],
      hyperdrive: [],
      vectorize: [],
      secretsStore: [],
      runtimeBindings: overrides.runtimeBindings ?? [],
      cron: overrides.cron ?? [],
      secrets: overrides.secrets ?? {},
      ...(overrides.domains !== undefined ? { domains: overrides.domains } : {}),
      ...(pages ? { pages: { projectName: name } } : {}),
    },
    wrangler: { name, compatibility_date: "2026-01-01", r2_buckets: [], crons: overrides.cron ?? [] },
    targetKind,
  };
}

function snapshot(overrides: Partial<TargetSnapshot> = {}): TargetSnapshot {
  return {
    accountId: ACCOUNT,
    workerName: "api",
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
    ...overrides,
  };
}

function bundle(overrides: Partial<DeployBundle> = {}): DeployBundle {
  return {
    schemaVersion: 1,
    appName: "api",
    targetKind: "workers",
    mainModule: "worker/index.js",
    modules: [
      { name: "worker/index.js", kind: "esm", mime: "application/javascript+module", size: 10, sha256: "1".repeat(64) },
    ],
    assets: [],
    config: { path: "wrangler.jsonc", size: 20, sha256: "2".repeat(64) },
    source: { archiveBytes: 100, archiveSha256: "3".repeat(64), manifestDigest: "4".repeat(64) },
    wranglerEffectiveHash: "5".repeat(64),
    bundleDigest: "bundle-digest-1",
    ...overrides,
  };
}

function input(partial: Partial<DeployGraphInput> & { specs: DeployGraphInput["specs"] }): DeployGraphInput {
  return { accountId: ACCOUNT, ...partial };
}

const guardCodes = (plan: GraphDeployPlan): string[] => plan.guards.map((guard) => guard.code);

// ---------------------------------------------------------------------------
// Tampered source / module bytes change the plan digest
// ---------------------------------------------------------------------------

it("a tampered module or source-archive byte changes the graph plan digest", async () => {
  const workerSpec = spec("workers", "api");
  const graph = buildDeployGraph(
    input({ specs: { main: workerSpec }, bundleDigest: "bundle-digest-1" }),
  );
  expect(graph.ok).toBe(true);

  const base: GraphDeployPlanInput = {
    graph,
    accountId: ACCOUNT,
    configHash: CONFIG_HASH,
    snapshots: { main: snapshot() },
    specs: { main: workerSpec },
    bundle: bundle(),
    declaredCapabilities: ["workers"],
    resolvedCapabilities: ["workers"],
  };

  const approved = await buildGraphDeployPlan(base, { salt: SALT });
  expect(approved.blocked).toBe(false);
  expect(approved.digest).toMatch(/^[0-9a-f]{64}$/);

  // Same inputs => same digest (deterministic).
  const repeat = await buildGraphDeployPlan(base, { salt: SALT });
  expect(repeat.digest).toBe(approved.digest);

  // A swapped module byte is a different approved identity.
  const tamperedModule = await buildGraphDeployPlan(
    { ...base, bundle: bundle({ modules: [{ ...bundle().modules[0]!, sha256: "9".repeat(64) }] }) },
    { salt: SALT },
  );
  expect(tamperedModule.digest).not.toBe(approved.digest);

  // A different ZIP archive hash (source) is a different approved identity.
  const tamperedSource = await buildGraphDeployPlan(
    {
      ...base,
      bundle: bundle({ source: { archiveBytes: 100, archiveSha256: "8".repeat(64), manifestDigest: "4".repeat(64) } }),
    },
    { salt: SALT },
  );
  expect(tamperedSource.digest).not.toBe(approved.digest);

  // The salt and the session account are also bound.
  expect((await buildGraphDeployPlan(base, { salt: "another-salt" })).digest).not.toBe(approved.digest);
  expect(
    (await buildGraphDeployPlan({ ...base, accountId: OTHER_ACCOUNT }, { salt: SALT })).digest,
  ).not.toBe(approved.digest);
});

// ---------------------------------------------------------------------------
// Scope underdeclaration: developer error, refused before any write
// ---------------------------------------------------------------------------

it("refuses a release whose resolved capabilities exceed the declared envelope", () => {
  const check = authorizeGraphIntent({
    declaredCapabilities: ["workers"],
    resolvedCapabilities: ["r2", "workers"],
  });
  expect(check.ok).toBe(false);
  expect(check.error).toBe("DEVELOPER_SCOPE_UNDERDECLARED");
  expect(check.undeclared).toEqual(["r2"]);
  expect(check.detail).toContain("no additional permission was requested");
});

it("fails closed on an unknown capability or install-policy kind", () => {
  const unknownCapability = authorizeGraphIntent({
    declaredCapabilities: ["workers"],
    resolvedCapabilities: ["workers", "mystery"],
  });
  expect(unknownCapability.ok).toBe(false);
  expect(unknownCapability.error).toBe("UNKNOWN_CAPABILITY");
  expect(unknownCapability.undeclared).toEqual(["mystery"]);

  const unknownPolicy = authorizeGraphIntent({
    declaredCapabilities: ["workers"],
    resolvedCapabilities: ["workers"],
    installPolicies: ["not-a-real-policy/v9"],
  });
  expect(unknownPolicy.ok).toBe(false);
  expect(unknownPolicy.error).toBe("UNKNOWN_CAPABILITY");
});

it("requires the install policy's capability to be declared too", () => {
  // The private R2 owner bootstrap manages R2 objects, so it needs `r2`.
  const undeclaredPolicy = authorizeGraphIntent({
    declaredCapabilities: ["workers"],
    resolvedCapabilities: ["workers"],
    installPolicies: ["private-r2-owner-bootstrap/v1"],
  });
  expect(undeclaredPolicy.ok).toBe(false);
  expect(undeclaredPolicy.error).toBe("DEVELOPER_SCOPE_UNDERDECLARED");
  expect(undeclaredPolicy.undeclared).toContain("r2");

  const covered = authorizeGraphIntent({
    declaredCapabilities: ["workers", "r2"],
    resolvedCapabilities: ["workers"],
    installPolicies: ["private-r2-owner-bootstrap/v1"],
  });
  expect(covered.ok).toBe(true);
});

it("blocks the graph plan before any write when the scope is underdeclared", async () => {
  const workerSpec = spec("workers", "api", {
    r2: [{ binding: "FILES", bucketName: "media", createIfMissing: true }],
  });
  const graph = buildDeployGraph(
    input({ specs: { main: workerSpec }, bundleDigest: "bundle-digest-1" }),
  );
  const plan = await buildGraphDeployPlan(
    {
      graph,
      accountId: ACCOUNT,
      configHash: CONFIG_HASH,
      snapshots: { main: snapshot() },
      specs: { main: workerSpec },
      bundle: bundle(),
      // The ZIP actually needs r2, but the config only declared workers.
      declaredCapabilities: ["workers"],
      resolvedCapabilities: resolvedCapabilitiesForGraph(graph),
    },
    { salt: SALT },
  );
  expect(plan.blocked).toBe(true);
  expect(guardCodes(plan)).toContain("scope-underdeclared");
  expect(plan.scopeCoverage.ok).toBe(false);
  expect(plan.scopeCoverage.undeclared).toEqual(["r2"]);
});

it("derives the resolved capability set from the actual graph, not the caller", () => {
  const graph = buildDeployGraph(
    input({
      specs: {
        main: spec("workers", "api", {
          r2: [{ binding: "FILES", bucketName: "media", createIfMissing: true }],
          runtimeBindings: [{ binding: "AI", type: "ai" }],
          domains: [{ kind: "dns-record", hostname: "app.example.com", zoneName: "example.com" }],
        }),
      },
      bundleDigest: "bundle-digest-1",
    }),
  );
  const capabilities = resolvedCapabilitiesForGraph(graph);
  expect(capabilities).toEqual(["dns", "r2", "workers", "workers-ai", "zone"]);
});

// ---------------------------------------------------------------------------
// Different account blocks
// ---------------------------------------------------------------------------

it("blocks a unit whose live snapshot belongs to a different account", async () => {
  const workerSpec = spec("workers", "api");
  const graph = buildDeployGraph(
    input({ specs: { main: workerSpec }, bundleDigest: "bundle-digest-1" }),
  );
  const plan = await buildGraphDeployPlan(
    {
      graph,
      accountId: ACCOUNT,
      configHash: CONFIG_HASH,
      snapshots: { main: snapshot({ accountId: OTHER_ACCOUNT }) },
      specs: { main: workerSpec },
      bundle: bundle(),
      declaredCapabilities: ["workers"],
      resolvedCapabilities: ["workers"],
    },
    { salt: SALT },
  );
  expect(plan.blocked).toBe(true);
  expect(guardCodes(plan)).toContain("wrong-account");
});

// ---------------------------------------------------------------------------
// Unknown price blocks
// ---------------------------------------------------------------------------

it("blocks a metered create under a block-unknown-cost policy", async () => {
  const workerSpec = spec("workers", "api", {
    r2: [{ binding: "FILES", bucketName: "media", createIfMissing: true }],
  });
  const graph = buildDeployGraph(
    input({ specs: { main: workerSpec }, bundleDigest: "bundle-digest-1" }),
  );
  const plan = await buildGraphDeployPlan(
    {
      graph,
      accountId: ACCOUNT,
      configHash: CONFIG_HASH,
      snapshots: { main: snapshot() },
      specs: { main: workerSpec },
      bundle: bundle(),
      declaredCapabilities: ["r2", "workers"],
      resolvedCapabilities: ["r2", "workers"],
      costPolicy: { mode: "block-unknown-cost" },
      // Even an explicit confirmation must not override a strict free-only policy.
      paidRiskConfirmed: true,
    },
    { salt: SALT },
  );
  expect(plan.cost.blockedUnknownCost).toBe(true);
  expect(plan.cost.operations.some((operation) => operation.resource === "r2" && operation.action === "create")).toBe(true);
  expect(plan.blocked).toBe(true);
  expect(guardCodes(plan)).toContain("unknown-cost");
});

it("requires an explicit confirmation for a metered create", async () => {
  const workerSpec = spec("workers", "api", {
    kv: [{ binding: "KV", namespaceName: "cache", createIfMissing: true }],
  });
  const graph = buildDeployGraph(
    input({ specs: { main: workerSpec }, bundleDigest: "bundle-digest-1" }),
  );
  const base: GraphDeployPlanInput = {
    graph,
    accountId: ACCOUNT,
    configHash: CONFIG_HASH,
    snapshots: { main: snapshot() },
    specs: { main: workerSpec },
    bundle: bundle(),
    declaredCapabilities: ["kv", "workers"],
    resolvedCapabilities: ["kv", "workers"],
  };
  const unconfirmed = await buildGraphDeployPlan(base, { salt: SALT });
  expect(unconfirmed.cost.requiresConfirmation).toBe(true);
  expect(guardCodes(unconfirmed)).toContain("paid-risk-unconfirmed");

  const confirmed = await buildGraphDeployPlan({ ...base, paidRiskConfirmed: true }, { salt: SALT });
  expect(confirmed.blocked).toBe(false);
});

// ---------------------------------------------------------------------------
// Drift: a changed live identity between plan and write blocks
// ---------------------------------------------------------------------------

it("blocks the write when a preserved resource identity changed since the plan", async () => {
  const workerSpec = spec("workers", "api", {
    r2: [{ binding: "FILES", bucketName: "media", createIfMissing: true }],
  });
  const graph = buildDeployGraph(
    input({ specs: { main: workerSpec }, bundleDigest: "bundle-digest-1" }),
  );
  const baseInput: GraphDeployPlanInput = {
    graph,
    accountId: ACCOUNT,
    configHash: CONFIG_HASH,
    snapshots: { main: snapshot({ r2Buckets: [{ name: "media", id: "bucket-1" }] }) },
    specs: { main: workerSpec },
    bundle: bundle(),
    declaredCapabilities: ["r2", "workers"],
    resolvedCapabilities: ["r2", "workers"],
  };
  const approved = await buildGraphDeployPlan(baseInput, { salt: SALT });
  expect(approved.blocked).toBe(false);
  const references = graphPlanReferences(approved);
  expect(references.main?.r2BucketIds).toEqual({ media: "bucket-1" });

  // An outside actor replaces the bucket identity between plan and write.
  const driftedSnapshot = snapshot({ r2Buckets: [{ name: "media", id: "bucket-2" }] });
  const replanned = await buildGraphDeployPlan(
    { ...baseInput, snapshots: { main: driftedSnapshot }, expected: references },
    { salt: SALT },
  );
  expect(replanned.blocked).toBe(true);
  expect(guardCodes(replanned)).toContain("unit-blocked");
  expect(replanned.units[0]!.guards.map((guard) => guard.code)).toContain("r2-drift");
});

// ---------------------------------------------------------------------------
// Resource-only multi-unit plan (requiresBundle=false)
// ---------------------------------------------------------------------------

it("plans a resource-only multi-unit release without any bundle", async () => {
  const graph = buildDeployGraph(
    input({
      units: [
        { id: "storage", kind: "resources", resources: [{ kind: "r2", name: "media", mode: "ensure" }] },
        { id: "cache", kind: "resources", resources: [{ kind: "kv", name: "cache", mode: "ensure" }] },
      ],
      specs: {},
    }),
  );
  expect(graph.ok).toBe(true);
  expect(graph.requiresBundle).toBe(false);

  const resolved = resolvedCapabilitiesForGraph(graph);
  expect(resolved).toEqual(["kv", "r2"]);

  const base: GraphDeployPlanInput = {
    graph,
    accountId: ACCOUNT,
    configHash: CONFIG_HASH,
    snapshots: { storage: snapshot(), cache: snapshot() },
    specs: {},
    declaredCapabilities: ["kv", "r2"],
    resolvedCapabilities: resolved,
    paidRiskConfirmed: true,
  };
  const plan = await buildGraphDeployPlan(base, { salt: SALT });
  expect(plan.blocked).toBe(false);
  expect(plan.requiresBundle).toBe(false);
  expect(plan.bundleDigest).toBeNull();
  expect(plan.units.map((unit) => unit.unitId)).toEqual(["cache", "storage"]);
  expect(plan.units.every((unit) => unit.plan === null)).toBe(true);
  // Resource-only units carry no synthetic provider target.
  expect(plan.targets).toEqual([]);
  expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(
    plan.units.flatMap((unit) => unit.diffs).some((diff) => diff.action === "create"),
  ).toBe(true);

  // Every unit's action is bound: a changed action changes the digest.
  const storagePresent = await buildGraphDeployPlan(
    {
      ...base,
      snapshots: { storage: snapshot({ r2Buckets: [{ name: "media", id: "bucket-1" }] }), cache: snapshot() },
    },
    { salt: SALT },
  );
  expect(storagePresent.digest).not.toBe(plan.digest);
});

// ---------------------------------------------------------------------------
// Synthetic targets vs active secret proof
// ---------------------------------------------------------------------------

it("keeps synthetic planned targets distinct from active secret proof", async () => {
  const workerSpec = spec("workers", "api", { secrets: { TOKEN: "preserve-only" } });
  const graph = buildDeployGraph(
    input({ specs: { main: workerSpec }, bundleDigest: "bundle-digest-1" }),
  );
  const base: GraphDeployPlanInput = {
    graph,
    accountId: ACCOUNT,
    configHash: CONFIG_HASH,
    snapshots: { main: snapshot({ workerExists: true, secretNames: ["TOKEN"] }) },
    specs: { main: workerSpec },
    bundle: bundle(),
    declaredCapabilities: ["workers"],
    resolvedCapabilities: ["workers"],
  };
  const plan = await buildGraphDeployPlan(base, { salt: SALT });

  // The provider target is planned/synthetic...
  expect(plan.targets).toContainEqual({
    unitId: "main",
    identity: "worker-script",
    name: "api",
    synthetic: true,
  });
  // ...and the secret is separate, live-proven identity (never a value).
  expect(plan.activeSecretProof).toContainEqual({ unitId: "main", name: "TOKEN", provenActive: true });
  expect(plan.targets.some((target) => target.name === "TOKEN")).toBe(false);

  // A fresh install has no active proof: the secret is only a planned create.
  const fresh = await buildGraphDeployPlan(
    { ...base, snapshots: { main: snapshot() } },
    { salt: SALT },
  );
  expect(fresh.activeSecretProof).toEqual([]);
  expect(fresh.digest).not.toBe(plan.digest);
});

// ---------------------------------------------------------------------------
// Sealed graph approval
// ---------------------------------------------------------------------------

const KEY_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function approvalContext(): GraphApprovalContext {
  return {
    nonce: "fake-session",
    configHash: CONFIG_HASH,
    accountId: ACCOUNT,
    digest: "d".repeat(64),
    references: {
      main: {
        accountId: ACCOUNT,
        workerName: "api",
        r2BucketIds: { media: "bucket-1" },
        secretNames: ["TOKEN"],
      },
    },
    expiresAt: Date.now() + 60_000,
  };
}

it("authenticates every field of a sealed graph approval", async () => {
  const key = await deriveSealKey(KEY_B64);
  const context = approvalContext();
  const approval = await sealGraphPlanApproval(key, context);
  expect(await verifyGraphPlanApproval(key, approval, context)).toBe(true);

  for (const field of ["nonce", "configHash", "accountId", "digest"] as const) {
    expect(await verifyGraphPlanApproval(key, approval, { ...context, [field]: "forged" })).toBe(false);
  }
  for (const references of [
    { ...context.references, main: { ...context.references.main!, workerName: "other" } },
    { ...context.references, main: { ...context.references.main!, r2BucketIds: {} } },
    { ...context.references, extra: { accountId: ACCOUNT, workerName: "extra" } },
  ]) {
    expect(await verifyGraphPlanApproval(key, approval, { ...context, references })).toBe(false);
  }
});

it("rejects missing, tampered and expired graph approvals", async () => {
  const key = await deriveSealKey(KEY_B64);
  const context = approvalContext();
  const approval = await sealGraphPlanApproval(key, context);

  expect(await verifyGraphPlanApproval(key, undefined, context)).toBe(false);
  expect(await verifyGraphPlanApproval(key, { ...approval, ciphertext: "tampered" }, context)).toBe(false);

  const expired = await sealGraphPlanApproval(key, { ...context, expiresAt: 0 });
  expect(await verifyGraphPlanApproval(key, expired, context)).toBe(false);

});
