import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import { deriveSealKey, openSeal, type SealedEnvelope } from "../../src/auth/keys.js";
import { createSession, sessionCookieName } from "../../src/auth/session.js";
import { sourcePolicyUnits } from "../../src/auth/oauth-tx.js";
import { computeConfigV3Id, type ConfigV3 } from "../../src/manifest/config-v3.js";
import { graphActionId } from "../../src/core/planning/digest.js";
import { zipSync } from "fflate";
import { graphHonoFixture } from "./graph-hono-fixture.js";

afterEach(() => vi.unstubAllGlobals());

const enc = new TextEncoder();
const code = "export default { fetch() { return new Response('ok'); } };";
// A Workflow carrier must be an exported WorkflowEntrypoint subclass (live 400/10021 otherwise).
const workflowCode = "import { WorkflowEntrypoint } from \"cloudflare:workers\";\nexport class WF extends WorkflowEntrypoint { async run() {} }";
const baseConfig = (capabilities: ConfigV3["capabilities"]): ConfigV3 => ({ schemaVersion: 3, app: { id: "example/graph", name: "Graph" }, source: { allowLocalZip: true }, capabilities });

it.each(["node", "workers"] as const)("executes resource-only R2 and KV with account-only reads (%s binding)", async runtime => {
  const config: ConfigV3 = { ...baseConfig(["r2", "kv"]), units: [], resources: [{ kind: "r2", name: "media" }, { kind: "kv", name: "cache" }] };
  const f = await graphHonoFixture(config, { "README.md": enc.encode("resource release") }, runtime);
  expect(f.plannedBody.graphPlan.blocked).toBe(false);
  for (const [resource, name, phase] of [["r2", "media", "create-r2-buckets"], ["kv", "cache", "create-kv-namespaces"]]) {
    const response = await f.step("resources", resource!, "create", name!, phase!);
    expect(response.status, await response.clone().text()).toBe(200);
  }
  expect(f.writes().map(call => call.path)).toEqual([`/client/v4/accounts/${f.accountId}/r2/buckets`, `/client/v4/accounts/${f.accountId}/storage/kv/namespaces`]);
  expect(f.trace.every(call => !call.path.includes("/workers/") && !call.path.includes("/pages/"))).toBe(true);
});

it("executes a Worker bound to a newly created R2 bucket, then verifies activation", async () => {
  const f = await graphHonoFixture(baseConfig(["workers", "r2"]), {
    "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17", r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }] })),
    "worker/main.mjs": enc.encode(code),
    "worker/engine.wasm": new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 255, 128]),
  });
  expect(f.plannedBody.graphPlan.blocked, JSON.stringify(f.plannedBody)).toBe(false);
  const bucket = await f.step("main", "r2", "create", "media", "create-r2-buckets");
  expect(bucket.status, await bucket.clone().text()).toBe(200);
  const bucketReceipt = (await bucket.json() as { phaseReceipt: unknown }).phaseReceipt;
  const created = await f.step("main", "worker", "create", "api", "create-worker", { receipts: [bucketReceipt] });
  expect(created.status, await created.clone().text()).toBe(200);
  expect(f.workers.get("api")?.versions[0]?.bindings).toContainEqual({ name: "MEDIA", type: "r2_bucket", bucket_name: "media" });
  const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
  const activated = await f.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt, bucketReceipt] });
  expect(activated.status, await activated.clone().text()).toBe(200);
});

it("an upgrade that creates a new R2 bucket uploads the version after its own verified bucket receipt (no false GRAPH_TARGET_STALE)", async () => {
  const f = await graphHonoFixture(baseConfig(["workers", "r2"]), {
    "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17", r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }] })),
    "worker/main.mjs": enc.encode(code),
  });
  // Install first: bucket, Worker, activation.
  const bucket = await f.step("main", "r2", "create", "media", "create-r2-buckets");
  const bucketReceipt = (await bucket.json() as { phaseReceipt: unknown }).phaseReceipt;
  const created = await f.step("main", "worker", "create", "api", "create-worker", { receipts: [bucketReceipt] });
  const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
  expect((await f.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt, bucketReceipt] })).status).toBe(200);
  // The bucket is gone (e.g. a release that adds storage on upgrade): the
  // upgrade plan creates it and updates the existing Worker.
  f.buckets.splice(0, f.buckets.length);
  const replanned = await f.plan({ mode: "upgrade" });
  const replannedBody = await replanned.json() as typeof f.plannedBody;
  expect(replanned.status, JSON.stringify(replannedBody)).toBe(200);
  const diffs = replannedBody.graphPlan.units[0]!.diffs.map(diff => `${diff.resource}:${diff.action}`);
  expect(diffs).toContain("r2:create");
  expect(diffs).toContain("worker:update");
  const upgradeStep = f.makeStep(replannedBody);
  const newBucket = await upgradeStep("main", "r2", "create", "media", "create-r2-buckets");
  expect(newBucket.status, await newBucket.clone().text()).toBe(200);
  const newBucketReceipt = (await newBucket.json() as { phaseReceipt: unknown }).phaseReceipt;
  const version = await upgradeStep("main", "worker", "update", "api", "create-version", { receipts: [newBucketReceipt] });
  expect(version.status, await version.clone().text()).toBe(200);
});

it.each(["create-worker", "create-version"] as const)("%s readback rides out a short provider read-after-write lag on the new version", async (phase) => {
  const f = await graphHonoFixture(baseConfig(["workers"]), {
    "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17" })),
    "worker/main.mjs": enc.encode(code),
  }, "node", {}, { versionReadbackLag: 2 });
  const created = await f.step("main", "worker", "create", "api", "create-worker");
  expect(created.status, await created.clone().text()).toBe(200);
  if (phase === "create-version") {
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    expect((await f.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt] })).status).toBe(200);
    const replanned = await f.plan({ mode: "upgrade" });
    const replannedBody = await replanned.json() as typeof f.plannedBody;
    const version = await f.makeStep(replannedBody)("main", "worker", "update", "api", "create-version");
    expect(version.status, await version.clone().text()).toBe(200);
  }
});

it("a version that never becomes readable is a typed 409, not a 500", async () => {
  const f = await graphHonoFixture(baseConfig(["workers"]), {
    "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17" })),
    "worker/main.mjs": enc.encode(code),
  }, "node", {}, { versionReadbackLag: 100 });
  const created = await f.step("main", "worker", "create", "api", "create-worker");
  expect(created.status).toBeGreaterThanOrEqual(400);
  expect(created.status).toBeLessThan(500);
  expect(typeof (await created.json() as { error?: unknown }).error).toBe("string");
}, 30_000);

it("an upgrade still refuses the version upload when a planned-missing bucket appears without this run's receipt", async () => {
  const f = await graphHonoFixture(baseConfig(["workers", "r2"]), {
    "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17", r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }] })),
    "worker/main.mjs": enc.encode(code),
  });
  const bucket = await f.step("main", "r2", "create", "media", "create-r2-buckets");
  const bucketReceipt = (await bucket.json() as { phaseReceipt: unknown }).phaseReceipt;
  const created = await f.step("main", "worker", "create", "api", "create-worker", { receipts: [bucketReceipt] });
  const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
  expect((await f.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt, bucketReceipt] })).status).toBe(200);
  const removed = f.buckets.splice(0, f.buckets.length);
  const replanned = await f.plan({ mode: "upgrade" });
  const replannedBody = await replanned.json() as typeof f.plannedBody;
  // Someone else creates the bucket after planning; the old install receipt
  // belongs to another plan and cannot authenticate it.
  f.buckets.push(...removed);
  const writesBefore = f.writes().length;
  const version = await f.makeStep(replannedBody)("main", "worker", "update", "api", "create-version", { receipts: [bucketReceipt] });
  expect(version.status).toBe(409);
  expect(f.writes()).toHaveLength(writesBefore);
});

it("New never updates an existing Worker and Upgrade never creates one (TARGET_MODE_CONFLICT before any write)", async () => {
  const f = await graphHonoFixture(baseConfig(["workers"]), {
    "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17" })),
    "worker/main.mjs": enc.encode(code),
  });
  const upgradeMissing = await f.plan({ mode: "upgrade" });
  expect(upgradeMissing.status).toBe(409);
  expect(await upgradeMissing.json()).toMatchObject({ error: "TARGET_MODE_CONFLICT" });
  const created = await f.step("main", "worker", "create", "api", "create-worker");
  expect(created.status).toBe(200);
  const writes = f.writes().length;
  const installExisting = await f.plan({ mode: "install" });
  expect(installExisting.status).toBe(409);
  const body = await installExisting.json() as { error: string; detail: string };
  expect(body.error).toBe("TARGET_MODE_CONFLICT");
  expect(body.detail).toContain('"api" already exists');
  expect(f.writes()).toHaveLength(writes);
  expect((await f.plan({ mode: "upgrade" })).status).toBe(200);
});

it("enforces server-derived RPC dependency order and unit-bound receipts", async () => {
  const config: ConfigV3 = { ...baseConfig(["workers"]), units: [{ id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc" }, { id: "jobs", kind: "worker", wrangler: "units/jobs/wrangler.jsonc" }] };
  const f = await graphHonoFixture(config, {
    "units/jobs/wrangler.jsonc": enc.encode(JSON.stringify({ name: "jobs-worker", main: "main.mjs", compatibility_date: "2026-10-17" })),
    "units/jobs/main.mjs": enc.encode(code),
    "units/api/wrangler.jsonc": enc.encode(JSON.stringify({ name: "api-worker", main: "main.mjs", compatibility_date: "2026-10-17", services: [{ binding: "JOBS", service: "jobs-worker" }] })),
    "units/api/main.mjs": enc.encode(code),
  });
  expect(f.plannedBody.graphPlan.blocked, JSON.stringify(f.plannedBody)).toBe(false);
  const early = await f.step("api", "worker", "create", "api-worker", "create-worker");
  expect(early.status).toBe(409);
  expect(f.writes()).toEqual([]);
  const jobs = await f.step("jobs", "worker", "create", "jobs-worker", "create-worker");
  expect(jobs.status, await jobs.clone().text()).toBe(200);
  const jobsBody = await jobs.json() as { phaseReceipt: unknown; result: { versionId: string } };
  const active = await f.step("jobs", "deployment", "create", "jobs-worker", "activate", { versionId: jobsBody.result.versionId, receipts: [jobsBody.phaseReceipt] });
  expect(active.status, await active.clone().text()).toBe(200);
  const activeBody = await active.json() as { phaseReceipt: unknown };
  const api = await f.step("api", "worker", "create", "api-worker", "create-worker", { receipts: [jobsBody.phaseReceipt, activeBody.phaseReceipt] });
  expect(api.status, await api.clone().text()).toBe(200);
  expect(f.workers.get("api-worker")?.versions[0]?.bindings).toContainEqual({ name: "JOBS", type: "service", service: "jobs-worker" });
});

it("rejects cross-unit receipt reuse with zero additional writes", async () => {
  const config: ConfigV3 = { ...baseConfig(["workers"]), units: [{ id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc" }, { id: "jobs", kind: "worker", wrangler: "units/jobs/wrangler.jsonc" }] };
  const f = await graphHonoFixture(config, {
    "units/jobs/wrangler.jsonc": enc.encode(JSON.stringify({ name: "jobs-worker", main: "main.mjs", compatibility_date: "2026-10-17" })),
    "units/jobs/main.mjs": enc.encode(code),
    "units/api/wrangler.jsonc": enc.encode(JSON.stringify({ name: "api-worker", main: "main.mjs", compatibility_date: "2026-10-17", services: [{ binding: "JOBS", service: "jobs-worker" }] })),
    "units/api/main.mjs": enc.encode(code),
  });
  expect(f.plannedBody.graphPlan.blocked, JSON.stringify(f.plannedBody)).toBe(false);
  const jobs = await f.step("jobs", "worker", "create", "jobs-worker", "create-worker");
  expect(jobs.status, await jobs.clone().text()).toBe(200);
  const jobsBody = await jobs.json() as { phaseReceipt: unknown; result: { versionId: string } };
  const active = await f.step("jobs", "deployment", "create", "jobs-worker", "activate", { versionId: jobsBody.result.versionId, receipts: [jobsBody.phaseReceipt] });
  expect(active.status, await active.clone().text()).toBe(200);
  const activeBody = await active.json() as { phaseReceipt: unknown };
  const api = await f.step("api", "worker", "create", "api-worker", "create-worker", { receipts: [jobsBody.phaseReceipt, activeBody.phaseReceipt] });
  expect(api.status, await api.clone().text()).toBe(200);
  const apiBody = await api.json() as { phaseReceipt: unknown };
  const writesBefore = f.writes().length;
  // The api unit receipt proves api-worker state; replaying it against the jobs
  // unit must fail before any provider mutation.
  const stolen = await f.step("jobs", "worker", "create", "jobs-worker", "create-worker", { receipts: [apiBody.phaseReceipt] });
  expect(stolen.status).toBe(409);
  expect(f.writes()).toHaveLength(writesBefore);
});

it("rejects a tampered wasm module and a foreign activation cutover before any write", async () => {
  const files = {
    "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17", r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }] })),
    "worker/main.mjs": enc.encode(code),
    "worker/engine.wasm": new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 255, 128]),
  };
  const tampered = await graphHonoFixture(baseConfig(["workers", "r2"]), files);
  expect(tampered.plannedBody.graphPlan.blocked, JSON.stringify(tampered.plannedBody)).toBe(false);
  const bucket = await tampered.step("main", "r2", "create", "media", "create-r2-buckets");
  expect(bucket.status, await bucket.clone().text()).toBe(200);
  const bucketReceipt = (await bucket.json() as { phaseReceipt: unknown }).phaseReceipt;
  const badWasm = await tampered.step("main", "worker", "create", "api", "create-worker", {
    receipts: [bucketReceipt],
    additionalModules: [{ name: "worker/engine.wasm", contentB64: Buffer.from([0, 97, 115, 109, 2, 0, 0, 0]).toString("base64") }],
  });
  expect(badWasm.status).toBe(422);
  expect(tampered.writes().map(call => call.path)).toEqual([`/client/v4/accounts/${tampered.accountId}/r2/buckets`]);

  const f = await graphHonoFixture(baseConfig(["workers", "r2"]), files);
  const ownBucket = await f.step("main", "r2", "create", "media", "create-r2-buckets");
  const ownBucketReceipt = (await ownBucket.json() as { phaseReceipt: unknown }).phaseReceipt;
  const created = await f.step("main", "worker", "create", "api", "create-worker", { receipts: [ownBucketReceipt] });
  expect(created.status, await created.clone().text()).toBe(200);
  const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
  const writesBefore = f.writes().length;
  // An outside activation lands after our upload: our receipts no longer
  // describe live state, so activation is refused instead of cutting over.
  f.foreignActivateWorker("api");
  const cutover = await f.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt, ownBucketReceipt] });
  expect(cutover.status).toBe(409);
  expect(f.writes()).toHaveLength(writesBefore);
});

it("rejects underdeclared capabilities and unconfirmed paid risk before any provider write", async () => {
  const files = {
    "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17", r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }] })),
    "worker/main.mjs": enc.encode(code),
  };
  const scoped = await graphHonoFixture({ ...baseConfig(["workers"]), units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }] }, files);
  const scopedBody = scoped.plannedBody as unknown as { graphPlan?: { blocked: boolean }; error?: string };
  expect(scoped.planned.status).toBe(409);
  expect(scopedBody.error).toBe("DEVELOPER_SCOPE_UNDERDECLARED");
  expect(scoped.writes()).toEqual([]);

  const f = await graphHonoFixture(baseConfig(["workers", "r2"]), files);
  const unconfirmed = await f.plan({ paidRiskConfirmed: false });
  const unconfirmedBody = await unconfirmed.json() as { graphPlan: { blocked: boolean }; executionContext?: unknown; approval?: unknown };
  expect(unconfirmedBody.graphPlan.blocked).toBe(true);
  expect(unconfirmedBody.executionContext).toBeUndefined();
  expect(unconfirmedBody.approval).toBeUndefined();
});

it("refuses a Workflow release whose capability is not declared before any provider read", async () => {
  // the Workflow carrier path is implemented; the developer-scope gate
  // still refuses a release that declares a Workflow without granting the
  // capability, before any provider read or write.
  const config: ConfigV3 = { ...baseConfig(["workers", "r2"]), units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }] };
  const f = await graphHonoFixture(config, {
    "wrangler.jsonc": enc.encode(JSON.stringify({ name: "wf-worker", main: "worker/main.mjs", compatibility_date: "2026-10-17", workflows: [{ binding: "WF", name: "wf", class_name: "WF" }], r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }] })),
    "worker/main.mjs": enc.encode(workflowCode),
  });
  expect(f.planned.status).toBe(409);
  const body = f.plannedBody as unknown as { error?: string; undeclared?: string[] };
  expect(body.error).toBe("DEVELOPER_SCOPE_UNDERDECLARED");
  expect(body.undeclared).toContain("workflows");
  expect(f.trace).toEqual([]);
});

it("config secret inputs bind to Worker units only; a Pages unit in the same release plans without them", async () => {
  const config: ConfigV3 = {
    ...baseConfig(["workers", "pages"]),
    inputs: [{ key: "API_TOKEN", type: "secret", label: "API token" }],
    units: [{ id: "api", kind: "worker", wrangler: "api/wrangler.jsonc" }, { id: "site", kind: "pages", wrangler: "site/wrangler.jsonc" }],
  };
  const f = await graphHonoFixture(config, {
    "api/wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "main.mjs", compatibility_date: "2026-10-17" })),
    "api/main.mjs": enc.encode(code),
    "site/wrangler.jsonc": enc.encode(JSON.stringify({ name: "site", compatibility_date: "2026-10-17", pages_build_output_dir: "dist" })),
    "site/dist/index.html": enc.encode("<h1>hi</h1>"),
  });
  expect(f.planned.status, JSON.stringify(f.plannedBody)).toBe(200);
  expect(f.plannedBody.graphPlan.blocked, JSON.stringify(f.plannedBody.graphPlan)).toBe(false);
  const diffsOf = (unitId: string) => f.plannedBody.graphPlan.units.find(unit => unit.unitId === unitId)!.diffs.map(diff => `${diff.resource}:${diff.action}${diff.name ? `:${diff.name}` : ""}`);
  expect(diffsOf("api")).toContain("secret:create:API_TOKEN");
  expect(diffsOf("site").some(diff => diff.startsWith("secret:"))).toBe(false);
  expect(f.trace.filter(call => call.method !== "GET")).toEqual([]);
  // The static Pages project is created without any secret (none was asked for).
  const project = await f.step("site", "pages-project", "create", "site", "pages-create-project");
  expect(project.status, await project.clone().text()).toBe(200);
});

it("a Pages deployment that is still building at deploy time passes postcheck once it succeeds (receipts bind identity, not stage status)", async () => {
  const { toPagesAssetPath } = await import("../../src/cloudflare/pages/manifest.js");
  const config: ConfigV3 = { ...baseConfig(["pages"]), units: [{ id: "site", kind: "pages", wrangler: "wrangler.jsonc" }] };
  const f = await graphHonoFixture(config, {
    "wrangler.jsonc": enc.encode(JSON.stringify({ name: "site", compatibility_date: "2026-10-17", pages_build_output_dir: "dist" })),
    "dist/index.html": enc.encode("<h1>hi</h1>"),
  }, "node", {}, { pagesDeployReadsBeforeSuccess: 2 });
  const siteUnit = f.release.units.find(unit => (unit as { unitId?: string }).unitId === "site") as unknown as { assets: Array<{ path: string; pagesHash: string }> };
  const manifest = Object.fromEntries(siteUnit.assets.map(asset => [toPagesAssetPath(asset.path, "dist"), asset.pagesHash]));
  const project = await f.step("site", "pages-project", "create", "site", "pages-create-project");
  const projectBody = await project.json() as { phaseReceipt: unknown };
  const handoff = await f.step("site", "static-assets", "create", "site", "pages-register-assets", { receipts: [projectBody.phaseReceipt] });
  const handoffBody = await handoff.json() as { phaseReceipt: unknown };
  const deploy = await f.step("site", "deployment", "create", "site", "pages-deploy", { manifest, receipts: [projectBody.phaseReceipt, handoffBody.phaseReceipt] });
  expect(deploy.status, await deploy.clone().text()).toBe(200);
  const deployBody = await deploy.json() as { phaseReceipt: unknown; result: { deploymentId: string } };
  const post = await f.step("site", "deployment", "create", "site", "pages-postcheck", { deploymentId: deployBody.result.deploymentId, receipts: [projectBody.phaseReceipt, handoffBody.phaseReceipt, deployBody.phaseReceipt] });
  expect(post.status, await post.clone().text()).toBe(200);
  expect((await post.json() as { result: { succeeded: boolean } }).result.succeeded).toBe(true);
});

it("executes a Pages static release through project, asset handoff, deploy and postcheck", async () => {
  const { toPagesAssetPath } = await import("../../src/cloudflare/pages/manifest.js");
  const config: ConfigV3 = { ...baseConfig(["pages"]), units: [{ id: "site", kind: "pages", wrangler: "wrangler.jsonc" }] };
  const f = await graphHonoFixture(config, {
    "wrangler.jsonc": enc.encode(JSON.stringify({ name: "site", compatibility_date: "2026-10-17", pages_build_output_dir: "dist", vars: { HELLO: "world" } })),
    "dist/index.html": enc.encode("<h1>hi</h1>"),
    "dist/app.js": enc.encode("console.log(1)"),
  });
  expect(f.planned.status, JSON.stringify(f.plannedBody)).toBe(200);
  // Projection keeps Pages .js output as an asset, never a module.
  const siteUnit = f.release.units.find(unit => (unit as { unitId?: string }).unitId === "site") as unknown as { modules: unknown[]; assets: Array<{ path: string; pagesHash: string }> };
  expect(siteUnit.modules).toEqual([]);
  expect(siteUnit.assets.map(asset => asset.path).sort()).toEqual(["dist/app.js", "dist/index.html"]);
  expect(siteUnit.assets.every(asset => typeof asset.pagesHash === "string" && /^[0-9a-f]{32}$/.test(asset.pagesHash))).toBe(true);
  const diffs = f.plannedBody.graphPlan.units.find(unit => unit.unitId === "site")!.diffs;
  expect(diffs.map(diff => `${diff.resource}:${diff.action}`).sort()).toEqual(["deployment:create", "pages-project:create", "static-assets:create"]);
  expect(f.plannedBody.graphPlan.blocked).toBe(false);
  // Handoff/deploy before the project exists are refused with zero writes.
  expect((await f.step("site", "deployment", "create", "site", "pages-deploy", { manifest: {} })).status).toBe(409);
  expect((await f.step("site", "static-assets", "create", "site", "pages-register-assets")).status).toBe(409);
  expect(f.writes()).toEqual([]);
  const project = await f.step("site", "pages-project", "create", "site", "pages-create-project");
  expect(project.status, await project.clone().text()).toBe(200);
  const projectBody = await project.json() as { phaseReceipt: unknown; result: { id: string } };
  expect(projectBody.result.id).toBe("pages-site");
  // The server sends an explicit production branch (Cloudflare 8000033
  // requires one); the mock records exactly what was sent.
  expect(f.pagesProjects.get("site")).toMatchObject({ productionBranch: "main" });
  expect(f.writes().map(call => `${call.method} ${call.path}`)).toEqual([`POST /client/v4/accounts/${f.accountId}/pages/projects`]);
  const manifest = Object.fromEntries(siteUnit.assets.map(asset => [toPagesAssetPath(asset.path, "dist"), asset.pagesHash]));
  expect(Object.keys(manifest).sort()).toEqual(["/app.js", "/index.html"]);
  // A deployment without the handoff receipt is refused before any write.
  const noHandoff = await f.step("site", "deployment", "create", "site", "pages-deploy", { manifest, receipts: [projectBody.phaseReceipt] });
  expect(noHandoff.status).toBe(409);
  expect(f.writes()).toHaveLength(1);
  const handoff = await f.step("site", "static-assets", "create", "site", "pages-register-assets", { receipts: [projectBody.phaseReceipt] });
  expect(handoff.status, await handoff.clone().text()).toBe(200);
  const handoffBody = await handoff.json() as { phaseReceipt: unknown; result: { jwt: string } };
  expect(handoffBody.result.jwt).toBe("pages-jwt-for-site");
  expect(f.writes()).toHaveLength(1);
  // A tampered manifest never reaches the provider.
  const tampered = await f.step("site", "deployment", "create", "site", "pages-deploy", { manifest: { ...manifest, "/index.html": "0".repeat(32) }, receipts: [projectBody.phaseReceipt, handoffBody.phaseReceipt] });
  expect(tampered.status).toBe(400);
  expect(f.writes()).toHaveLength(1);
  const deploy = await f.step("site", "deployment", "create", "site", "pages-deploy", { manifest, receipts: [projectBody.phaseReceipt, handoffBody.phaseReceipt] });
  expect(deploy.status, await deploy.clone().text()).toBe(200);
  const deployBody = await deploy.json() as { phaseReceipt: unknown; result: { deploymentId: string; url: string } };
  expect(deployBody.result.url).toBe("https://1a2b3c4d.site.pages.dev");
  expect(f.pagesManifests).toEqual([{ project: "site", manifest }]);
  expect(f.writes().map(call => `${call.method} ${call.path}`)).toEqual([
    `POST /client/v4/accounts/${f.accountId}/pages/projects`,
    `POST /client/v4/accounts/${f.accountId}/pages/projects/site/deployments`,
  ]);
  const post = await f.step("site", "deployment", "create", "site", "pages-postcheck", { deploymentId: deployBody.result.deploymentId, receipts: [projectBody.phaseReceipt, handoffBody.phaseReceipt, deployBody.phaseReceipt] });
  expect(post.status, await post.clone().text()).toBe(200);
  // Success reports the production address, not the per-deployment one.
  expect((await post.json() as { result: { succeeded: boolean; url: string } }).result).toMatchObject({ succeeded: true, url: "https://site.pages.dev" });
  expect(f.writes()).toHaveLength(2);
  // Retrying the project with its receipt is idempotent and write-free.
  const retry = await f.step("site", "pages-project", "create", "site", "pages-create-project", { phaseReceipt: projectBody.phaseReceipt });
  expect(retry.status, await retry.clone().text()).toBe(200);
  expect((await retry.json() as { status?: string }).status).toBe("IDEMPOTENT_VERIFIED");
  expect(f.writes()).toHaveLength(2);
  // A foreign redeploy invalidates outstanding receipts instead of being adopted.
  f.tamperPagesDeployment("site");
  const stale = await f.step("site", "deployment", "create", "site", "pages-postcheck", { deploymentId: deployBody.result.deploymentId, receipts: [projectBody.phaseReceipt, handoffBody.phaseReceipt, deployBody.phaseReceipt] });
  expect(stale.status).toBe(409);
  expect(f.writes()).toHaveLength(2);
});

it("rejects a forged V3 execution context in the real Hono route before provider access", async () => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  const origin = "https://installer.example";
  const env = { RUNTIME: "node", PUBLIC_ORIGIN: origin, OAUTH_CLIENT_ID: "x", OAUTH_CLIENT_SECRET: "x" } as const;
  const key = await deriveSealKey(env.OAUTH_CLIENT_SECRET);
  const session = await createSession(key, { ttlMs: 60_000, publicOrigin: origin }, { accessToken: "token", tokenType: "Bearer", scope: [], source: "v3", accountId: "a".repeat(32), configHash: "c".repeat(64), sourcePolicy: { allowLocalZip: true, appId: "app", units: [] } });
  const app = createApp(env);
  const response = await app.request("/api/deploy/step", { method: "POST", headers: { origin, "content-type": "application/json", "x-tapdeploy-csrf": session.payload.csrf, cookie: `${sessionCookieName(origin)}=${session.cookieValue}` }, body: JSON.stringify({ executionContext: { forged: true }, unitId: "x", actionId: "x", phase: "create-r2-buckets", step: "create-r2-buckets" }) });
  expect(response.status).toBe(409); expect((await response.json()).error).toBe("GRAPH_CONTEXT_MISMATCH"); expect(fetchMock).not.toHaveBeenCalled();
});

// the Wrangler KV provider id is verified by id, never used as a title.
it.each(["node", "workers"] as const)("verifies a KV namespace id and never provisions a fake title (%s binding)", async runtime => {
  const KV_ID = "k".repeat(32);
  const files = {
    "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17", kv_namespaces: [{ binding: "KV", id: KV_ID }] })),
    "worker/main.mjs": enc.encode(code),
  };
  const f = await graphHonoFixture(baseConfig(["workers", "kv"]), files, runtime);
  // Unknown id: the plan blocks before any write and no namespace is created.
  expect(f.plannedBody.graphPlan.blocked, JSON.stringify(f.plannedBody)).toBe(true);
  expect(f.writes()).toEqual([]);
  expect(f.namespaces).toEqual([]);
  // The exact live id resolves to its real name: unblocked, preserved by id.
  f.namespaces.push({ title: "real-kv", id: KV_ID });
  const replanned = await f.plan();
  const body = await replanned.json() as typeof f.plannedBody;
  expect(replanned.status, JSON.stringify(body)).toBe(200);
  expect(body.graphPlan.blocked, JSON.stringify(body.graphPlan)).toBe(false);
  const diffs = body.graphPlan.units.find(unit => unit.unitId === "main")!.diffs;
  expect(diffs.filter(diff => diff.resource === "kv")).toMatchObject([
    { resource: "kv", action: "preserve", name: "real-kv", before: KV_ID, after: KV_ID },
  ]);
  // The Worker version binds the verified id, and no fake title was provisioned.
  const created = await f.step("main", "worker", "create", "api", "create-worker", {}, { executionContext: body.executionContext, approval: body.approval });
  expect(created.status, await created.clone().text()).toBe(200);
  expect(f.workers.get("api")?.versions[0]?.bindings).toContainEqual({ name: "KV", type: "kv_namespace", namespace_id: KV_ID });
  expect(f.namespaces).toEqual([{ title: "real-kv", id: KV_ID }]);
  expect(f.writes().some(call => call.path.endsWith("/storage/kv/namespaces") && call.method === "POST")).toBe(false);
});

// one unit-bound whole-set schedule action — applied together, read back,
// idempotent on retry, and never sliced per expression.
it.each(["node", "workers"] as const)("reconciles an exact cron set atomically with sealed readback (%s)", async runtime => {
  const CRONS = ["*/5 * * * *", "0 3 * * *"];
  const f = await graphHonoFixture(baseConfig(["workers"]), {
    "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17", triggers: { crons: CRONS } })),
    "worker/main.mjs": enc.encode(code),
  }, runtime);
  expect(f.plannedBody.graphPlan.blocked, JSON.stringify(f.plannedBody)).toBe(false);
  const diffs = f.plannedBody.graphPlan.units.find(unit => unit.unitId === "main")!.diffs;
  // One nameless whole-set action: no per-cron slice exists to address.
  expect(diffs.filter(diff => diff.resource === "schedule")).toEqual([{ resource: "schedule", action: "create" }]);
  // A forged per-cron action id is not an approved diff: zero writes.
  const forged = await f.step("main", "schedule", "create", CRONS[0]!, "reconcile-schedules");
  expect(forged.status).toBe(409);
  expect(f.writes()).toEqual([]);
  const created = await f.step("main", "worker", "create", "api", "create-worker");
  expect(created.status, await created.clone().text()).toBe(200);
  const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
  const activated = await f.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt] });
  expect(activated.status, await activated.clone().text()).toBe(200);
  const activatedBody = await activated.json() as { phaseReceipt: unknown };
  const scheduleActionId = graphActionId({ unitId: "main", resource: "schedule", action: "create" });
  const bundleDigest = (f.release.units.find(unit => unit.unitId === "main") as { bundleDigest: string }).bundleDigest;
  const scheduleStep = (receipts: unknown[]) => f.json("/api/deploy/step", {
    accountId: f.accountId, executionContext: f.plannedBody.executionContext, approval: f.plannedBody.approval,
    unitId: "main", actionId: scheduleActionId, phase: "reconcile-schedules", step: "reconcile-schedules",
    bundleDigest, args: { receipts },
  });
  const puts = () => f.writes().filter(call => call.path.endsWith("/schedules") && call.method === "PUT");
  const reconciled = await scheduleStep([createdBody.phaseReceipt, activatedBody.phaseReceipt]);
  expect(reconciled.status, await reconciled.clone().text()).toBe(200);
  const reconciledBody = await reconciled.json() as { result: { crons: string[] }; phaseReceipt: unknown };
  expect([...reconciledBody.result.crons].sort()).toEqual([...CRONS].sort());
  expect(puts()).toHaveLength(1);
  // Cron-only workers need no public URL: nothing fabricated, no fetch route.
  expect(JSON.stringify(reconciledBody)).not.toContain("pages.dev");
  expect(JSON.stringify(reconciledBody)).not.toContain("workers.dev");
  expect(f.writes().every(call => !call.path.includes("subdomain"))).toBe(true);
  // A second identical run performs zero writes and stays green.
  const writesBefore = f.writes().length;
  const retry = await scheduleStep([createdBody.phaseReceipt, activatedBody.phaseReceipt, reconciledBody.phaseReceipt]);
  expect(retry.status, await retry.clone().text()).toBe(200);
  expect(puts()).toHaveLength(1);
  expect(f.writes()).toHaveLength(writesBefore);
  // A foreign activation invalidates the deployment receipt the schedule
  // depends on: the retry refuses with zero new writes.
  f.foreignActivateWorker("api");
  const stale = await scheduleStep([createdBody.phaseReceipt, activatedBody.phaseReceipt, reconciledBody.phaseReceipt]);
  expect(stale.status).toBe(409);
  expect(puts()).toHaveLength(1);
  // A differently-shaped cron set is a different plan digest (compared last:
  // each fixture owns the global provider mock).
  const other = await graphHonoFixture(baseConfig(["workers"]), {
    "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17", triggers: { crons: ["*/5 * * * *"] } })),
    "worker/main.mjs": enc.encode(code),
  }, runtime);
  expect(other.plannedBody.graphPlan.digest).not.toBe(f.plannedBody.graphPlan.digest);
});

// workers.dev exposure is an explicit plan action verified against the
// provider (flag plus account subdomain). No Wrangler intent means no action,
// no URL, and no writes; a missing account subdomain is deployed-but-
// unpublished truth, never a fabricated URL.
describe("workers.dev exposure (graph API)", () => {
  const ACCOUNT = "a".repeat(32);
  const ORIGIN = "https://installer.example.com";
  const V3_CONFIG = {
    schemaVersion: 3,
    app: { id: "example/exposure", name: "Exposure" },
    source: { allowLocalZip: true },
    capabilities: ["workers"],
  };

  interface MockVersion { id: string; message: string; bindings: Record<string, unknown>[]; runtime: Record<string, unknown> }

  async function setupExposure(runtime: "node" | "workers", wrangler: Record<string, unknown>, seed: { accountSubdomain?: string; scriptEnabled?: boolean } = {}) {
    const env = { RUNTIME: runtime, PUBLIC_ORIGIN: ORIGIN, OAUTH_CLIENT_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } as const;
    const app = createApp(env);
    const key = await deriveSealKey(env.OAUTH_CLIENT_SECRET);
    const session = await createSession(key, { ttlMs: 120_000, publicOrigin: ORIGIN }, {
      accessToken: "offline-test-token", tokenType: "Bearer", scope: [], source: "v3", accountId: ACCOUNT,
      configHash: await computeConfigV3Id(V3_CONFIG as never),
      sourcePolicy: { allowLocalZip: true, appId: "example/exposure", units: [] },
    });
    const headers = {
      origin: ORIGIN,
      "x-tapdeploy-csrf": session.payload.csrf,
      cookie: `${sessionCookieName(ORIGIN)}=${session.cookieValue}`,
    };
    const accountSubdomain: string | undefined = "accountSubdomain" in seed ? seed.accountSubdomain : "myaccount";
    let scriptSubdomain = { enabled: seed.scriptEnabled === true, previews_enabled: true };
    const workers = new Map<string, { versions: MockVersion[]; active: string }>();
    let versionCounter = 0;
    const ok = (result: unknown) => Response.json({ success: true, result });
    const notFound = () => Response.json({ success: false, errors: [{ code: 10007, message: "not found" }] }, { status: 404 });
    const calls: Array<{ method: string; path: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.cloudflare.com");
      const method = init?.method ?? "GET";
      const path = url.pathname;
      calls.push({ method, path });
      if (path.endsWith("/workers/subdomain") && method === "GET") {
        return accountSubdomain === undefined ? notFound() : ok({ subdomain: accountSubdomain });
      }
      const subMatch = /\/workers\/scripts\/([^/]+)\/subdomain$/.exec(path);
      if (subMatch) {
        if (method === "GET") return ok({ ...scriptSubdomain });
        const body = JSON.parse(String(init?.body)) as { enabled?: unknown; previews_enabled?: unknown };
        scriptSubdomain = { enabled: body.enabled === true, previews_enabled: body.previews_enabled !== false };
        return ok({ ...scriptSubdomain });
      }
      if (path.endsWith("/workers/scripts") && method === "GET") return ok([...workers.keys()].map((id) => ({ id })));
      const match = /\/workers\/scripts\/([^/]+)(.*)$/.exec(path);
      if (match) {
        const name = decodeURIComponent(match[1]!);
        const tail = match[2]!;
        const worker = workers.get(name);
        if ((tail === "" && method === "PUT") || (tail === "/versions" && method === "POST")) {
          const form = init?.body as FormData;
          const meta = JSON.parse(await (form.get("metadata") as Blob).text()) as Record<string, unknown>;
          const id = `00000000-0000-4000-8000-${String(++versionCounter).padStart(12, "0")}`;
          const version: MockVersion = { id, message: (meta.annotations as Record<string, string>)["workers/message"]!, bindings: (meta.bindings as Record<string, unknown>[]) ?? [], runtime: { compatibility_date: meta.compatibility_date, compatibility_flags: meta.compatibility_flags ?? [] } };
          if (worker) worker.versions.unshift(version);
          else workers.set(name, { versions: [version], active: id });
          return ok({ id: tail === "" ? name : id });
        }
        if (!worker) return notFound();
        if (tail === "/versions" && method === "GET") return ok({ items: worker.versions.map(({ id, message }) => ({ id, message })) });
        if (tail.startsWith("/versions/") && method === "GET") {
          const version = worker.versions.find((v) => v.id === tail.slice("/versions/".length));
          return version ? ok({ id: version.id, message: version.message, resources: { bindings: version.bindings, script_runtime: version.runtime } }) : notFound();
        }
        if (tail === "/deployments") {
          if (method === "POST") worker.active = (JSON.parse(String(init?.body)) as { versions: Array<{ version_id: string }> }).versions[0]!.version_id;
          const deployment = { id: `deployment-${worker.active}`, versions: [{ version_id: worker.active, percentage: 100 }] };
          return ok(method === "GET" ? { deployments: [deployment] } : deployment);
        }
        if (tail === "/schedules") return ok({ schedules: [] });
        if (tail === "/settings") return ok({ bindings: worker.versions[0]?.bindings ?? [] });
        if (tail === "/secrets") return ok([]);
      }
      throw new Error(`unexpected provider operation ${method} ${path}`);
    }));
    const files = {
      "wrangler.jsonc": enc.encode(JSON.stringify(wrangler)),
      "worker/main.mjs": enc.encode(code),
    };
    const archive = zipSync(files, { level: 0 });
    const prepared = await app.request("/api/deploy/prepare", {
      method: "POST", headers: { ...headers, "content-type": "application/zip" }, body: archive as unknown as BodyInit,
    });
    const preparedBody = await prepared.json() as { releaseProof: unknown };
    expect(prepared.status, JSON.stringify(preparedBody)).toBe(200);
    const planned = await app.request("/api/deploy/plan", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ accountId: ACCOUNT, releaseProof: preparedBody.releaseProof, config: { text: JSON.stringify(V3_CONFIG) }, paidRiskConfirmed: true, mode: "install" }),
    });
    const body = await planned.json() as {
      graphPlan: { blocked: boolean; digest: string; units: Array<{ unitId: string; kind: string; diffs: Array<{ resource: string; action: string; name?: string }> }> };
      executionContext: unknown; approval: unknown; bundleDigests: Record<string, string>;
    };
    const callStep = (unitId: string, resource: string, action: string, name: string | undefined, phase: string, args: Record<string, unknown> = {}) => {
      const actionId = graphActionId({ unitId, resource, action, ...(name !== undefined ? { name } : {}) });
      return app.request("/api/deploy/step", {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          accountId: ACCOUNT, executionContext: body.executionContext, approval: body.approval,
          unitId, actionId, phase, step: phase, bundleDigest: body.bundleDigests[unitId], args,
        }),
      });
    };
    return { app, headers, calls, workers, body, step: callStep };
  }

  const baseWrangler = (extra: Record<string, unknown> = {}) => ({
    name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17", ...extra,
  });

  it.each(["node", "workers"] as const)("enables workers.dev from explicit intent and seals the verified URL (%s)", async (runtime) => {
    const t = await setupExposure(runtime, baseWrangler({ workers_dev: true }));
    expect(t.body.graphPlan.blocked, JSON.stringify(t.body.graphPlan)).toBe(false);
    const diffs = t.body.graphPlan.units.find((u) => u.unitId === "main")!.diffs;
    // Explicit intent plans exactly one enable action; nothing is disabled.
    expect(diffs.filter((d) => d.resource === "workers-dev")).toEqual([{ resource: "workers-dev", action: "create", name: "api" }]);
    const created = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64") });
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await t.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt] });
    expect(activated.status, await activated.clone().text()).toBe(200);
    const activatedBody = await activated.json() as { phaseReceipt: unknown };
    const publish = await t.step("main", "workers-dev", "create", "api", "publish-workers-dev", { publish: true, receipts: [createdBody.phaseReceipt, activatedBody.phaseReceipt] });
    expect(publish.status, await publish.clone().text()).toBe(200);
    const publishBody = await publish.json() as { result: { published: boolean; url?: string }; phaseReceipt: unknown };
    expect(publishBody.result).toEqual({ published: true, url: "https://api.myaccount.workers.dev" });
    expect(t.calls.filter((c) => c.path.endsWith("/subdomain") && c.method === "POST")).toHaveLength(1);
    expect(t.calls.some((c) => c.path.endsWith("/subdomain") && c.method === "POST" && !c.path.includes("/scripts/"))).toBe(false);
    // Repeat is idempotent: no second enable write, same verified URL.
    const again = await t.step("main", "workers-dev", "create", "api", "publish-workers-dev", { publish: true, receipts: [createdBody.phaseReceipt, activatedBody.phaseReceipt, publishBody.phaseReceipt] });
    expect(again.status, await again.clone().text()).toBe(200);
    expect((await again.json() as { result: { published: boolean; url?: string } }).result).toEqual({ published: true, url: "https://api.myaccount.workers.dev" });
    expect(t.calls.filter((c) => c.path.endsWith("/subdomain") && c.method === "POST")).toHaveLength(1);
    // The enable requires its deployment receipt: no receipt, no call.
    const writesBefore = t.calls.length;
    const missing = await t.step("main", "workers-dev", "create", "api", "publish-workers-dev", { publish: true });
    expect(missing.status).toBe(409);
    expect(t.calls).toHaveLength(writesBefore);
  });

  it.each(["node", "workers"] as const)("reports deployed-but-unpublished when the account has no subdomain (%s)", async (runtime) => {
    const t = await setupExposure(runtime, baseWrangler({ workers_dev: true }), { accountSubdomain: undefined });
    expect(t.body.graphPlan.blocked, JSON.stringify(t.body.graphPlan)).toBe(false);
    const created = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64") });
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await t.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt] });
    const activatedBody = await activated.json() as { phaseReceipt: unknown };
    const publish = await t.step("main", "workers-dev", "create", "api", "publish-workers-dev", { publish: true, receipts: [createdBody.phaseReceipt, activatedBody.phaseReceipt] });
    expect(publish.status, await publish.clone().text()).toBe(200);
    const publishBody = await publish.json() as { result: { published: boolean; reason?: string; url?: string } };
    expect(publishBody.result.published).toBe(false);
    expect(publishBody.result.reason).toBe("no-account-subdomain");
    expect(publishBody.result.url).toBeUndefined();
    // Nothing was fabricated and no script flag was touched: the only
    // subdomain touch is the account-level read that found nothing.
    expect(t.calls.some((c) => c.path.includes("/scripts/api/subdomain"))).toBe(false);
  });

  it.each(["node", "workers"] as const)("leaves an externally-managed exposed Worker untouched (%s)", async (runtime) => {
    const t = await setupExposure(runtime, baseWrangler({ workers_dev: true }), { scriptEnabled: true });
    const created = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64") });
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await t.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt] });
    const activatedBody = await activated.json() as { phaseReceipt: unknown };
    const publish = await t.step("main", "workers-dev", "create", "api", "publish-workers-dev", { publish: true, receipts: [createdBody.phaseReceipt, activatedBody.phaseReceipt] });
    expect(publish.status).toBe(200);
    expect((await publish.json() as { result: { published: boolean; url?: string } }).result).toEqual({ published: true, url: "https://api.myaccount.workers.dev" });
    expect(t.calls.filter((c) => c.path.endsWith("/subdomain") && c.method === "POST")).toHaveLength(0);
  });

  it.each([true, false] as const)("plans no workers.dev action when intent is %s (and none when absent)", async (declared) => {
    const t = await setupExposure("node", baseWrangler(declared ? { workers_dev: false } : {}));
    expect(t.body.graphPlan.blocked, JSON.stringify(t.body.graphPlan)).toBe(false);
    const diffs = t.body.graphPlan.units.find((u) => u.unitId === "main")!.diffs;
    expect(diffs.some((d) => d.resource === "workers-dev")).toBe(false);
    expect(t.calls.some((c) => c.path.includes("subdomain"))).toBe(false);
  });
});

// Worker secret input/inheritance. Declared prompt secrets are collected
// per step (never sealed, never logged); generate-once values are created
// server-side; upgrades inherit the exact active version without prompting or
// rotating. Undeclared names, collisions, and missing values refuse prewrite.
describe("worker secret input and inheritance (graph API)", () => {
  const ACCOUNT = "a".repeat(32);
  const ORIGIN = "https://installer.example.com";
  const V3_SECRET = "s3cr3t-first-install-value";
  interface MockVersion { id: string; message: string; bindings: Record<string, unknown>[]; runtime: Record<string, unknown> }

  async function setupSecrets(
    runtime: "node" | "workers",
    inputs: Array<Record<string, unknown>>,
    wranglerExtra: Record<string, unknown> = {},
    installBody: Record<string, unknown> = {},
  ) {
    const V3_CONFIG = {
      schemaVersion: 3,
      app: { id: "example/secrets", name: "Secrets" },
      source: { allowLocalZip: true },
      capabilities: ["workers"],
      inputs,
    };
    const env = { RUNTIME: runtime, PUBLIC_ORIGIN: ORIGIN, OAUTH_CLIENT_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } as const;
    const app = createApp(env);
    const key = await deriveSealKey(env.OAUTH_CLIENT_SECRET);
    const session = await createSession(key, { ttlMs: 120_000, publicOrigin: ORIGIN }, {
      accessToken: "offline-test-token", tokenType: "Bearer", scope: [], source: "v3", accountId: ACCOUNT,
      configHash: await computeConfigV3Id(V3_CONFIG as never),
      sourcePolicy: { allowLocalZip: true, appId: "example/secrets", units: [] },
    });
    const headers = {
      origin: ORIGIN,
      "x-tapdeploy-csrf": session.payload.csrf,
      cookie: `${sessionCookieName(ORIGIN)}=${session.cookieValue}`,
    };
    const workers = new Map<string, { versions: MockVersion[]; active: string }>();
    let versionCounter = 0;
    // Raw upload request bindings per version upload (proves what crossed the
    // wire: inherit directives on upgrade, never re-sent secret values).
    const uploads: Array<{ bindings: Record<string, unknown>[] }> = [];
    const ok = (result: unknown) => Response.json({ success: true, result });
    const notFound = () => Response.json({ success: false, errors: [{ code: 10007, message: "not found" }] }, { status: 404 });
    const calls: Array<{ method: string; path: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.cloudflare.com");
      const method = init?.method ?? "GET";
      const path = url.pathname;
      calls.push({ method, path });
      if (path.endsWith("/workers/scripts") && method === "GET") return ok([...workers.keys()].map((id) => ({ id })));
      // Immutable Worker resource API used for uploads that carry inherit
      // bindings (exact active-version inheritance, never a separate PUT).
      if (path === `/client/v4/accounts/${ACCOUNT}/workers/workers` && method === "GET") {
        return Response.json({ success: true, result: workers.has("api") ? [{ id: "worker-resource-api", name: "api" }] : [], result_info: { total_pages: 1 } });
      }
      const resourceMatch = /\/workers\/workers\/([^/]+)(\/versions)?$/.exec(path);
      if (resourceMatch) {
        if (resourceMatch[2] === undefined) return ok({ id: "worker-resource-api", name: "api" });
        // The immutable resource API resolves inherit directives server-side:
        // readback sees resolved secret bindings, never values, never inherit.
        const uploaded = JSON.parse(String(init?.body)) as { bindings?: Array<Record<string, unknown>>; annotations?: Record<string, string>; compatibility_date?: string; compatibility_flags?: string[] };
        uploads.push({ bindings: (uploaded.bindings as MockVersion["bindings"]) ?? [] });
        const activeBindings = workers.get("api")?.versions[0]?.bindings ?? [];
        const resolved = ((uploaded.bindings as Array<Record<string, unknown>>) ?? []).map((binding) => {
          if (binding.type !== "inherit") return binding;
          const live = activeBindings.find((b) => (b as Record<string, unknown>).name === binding.name && ((b as Record<string, unknown>).type === "secret_text" || (b as Record<string, unknown>).type === "secret_key"));
          return live ? { name: binding.name, type: (live as Record<string, unknown>).type } : binding;
        });
        const id = `00000000-0000-4000-8000-${String(++versionCounter).padStart(12, "0")}`;
        const version: MockVersion = {
          id,
          message: uploaded.annotations?.["workers/message"] ?? "",
          bindings: resolved as MockVersion["bindings"],
          runtime: { compatibility_date: uploaded.compatibility_date, compatibility_flags: uploaded.compatibility_flags ?? [] },
        };
        const worker = workers.get("api") ?? { versions: [], active: "" };
        worker.versions.unshift(version);
        workers.set("api", worker);
        return ok({ id });
      }
      const match = /\/workers\/scripts\/([^/]+)(.*)$/.exec(path);
      if (match) {
        const name = decodeURIComponent(match[1]!);
        const tail = match[2]!;
        const worker = workers.get(name);
        if ((tail === "" && method === "PUT") || (tail === "/versions" && method === "POST")) {
          const form = init?.body as FormData;
          const meta = JSON.parse(await (form.get("metadata") as Blob).text()) as Record<string, unknown>;
          const id = `00000000-0000-4000-8000-${String(++versionCounter).padStart(12, "0")}`;
          const version: MockVersion = { id, message: (meta.annotations as Record<string, string>)["workers/message"]!, bindings: (meta.bindings as Record<string, unknown>[]) ?? [], runtime: { compatibility_date: meta.compatibility_date, compatibility_flags: meta.compatibility_flags ?? [] } };
          if (worker) worker.versions.unshift(version);
          else workers.set(name, { versions: [version], active: id });
          return ok({ id: tail === "" ? name : id });
        }
        if (!worker) return notFound();
        if (tail === "/versions" && method === "GET") return ok({ items: worker.versions.map(({ id, message }) => ({ id, message })) });
        if (tail.startsWith("/versions/") && method === "GET") {
          const version = worker.versions.find((v) => v.id === tail.slice("/versions/".length));
          return version ? ok({ id: version.id, message: version.message, resources: { bindings: version.bindings, script_runtime: version.runtime } }) : notFound();
        }
        if (tail === "/deployments") {
          if (method === "POST") worker.active = (JSON.parse(String(init?.body)) as { versions: Array<{ version_id: string }> }).versions[0]!.version_id;
          const deployment = { id: `deployment-${worker.active}`, versions: [{ version_id: worker.active, percentage: 100 }] };
          return ok(method === "GET" ? { deployments: [deployment] } : deployment);
        }
        if (tail === "/schedules") return ok({ schedules: [] });
        if (tail === "/settings") return ok({ bindings: worker.versions[0]?.bindings ?? [] });
        if (tail === "/secrets") return ok([]);
      }
      throw new Error(`unexpected provider operation ${method} ${path}`);
    }));
    const files = {
      "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17", ...wranglerExtra })),
      "worker/main.mjs": enc.encode(code),
    };
    const archive = zipSync(files, { level: 0 });
    const prepared = await app.request("/api/deploy/prepare", {
      method: "POST", headers: { ...headers, "content-type": "application/zip" }, body: archive as unknown as BodyInit,
    });
    const preparedBody = await prepared.json() as { releaseProof: unknown };
    expect(prepared.status, JSON.stringify(preparedBody)).toBe(200);
    const planned = await app.request("/api/deploy/plan", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ accountId: ACCOUNT, releaseProof: preparedBody.releaseProof, config: { text: JSON.stringify(V3_CONFIG) }, paidRiskConfirmed: true, mode: "install", ...installBody }),
    });
    const body = await planned.json() as {
      graphPlan: { blocked: boolean; digest: string; units: Array<{ unitId: string; kind: string; diffs: Array<{ resource: string; action: string; name?: string }> }> };
      executionContext: unknown; approval: unknown; bundleDigests: Record<string, string>;
    };
    const planStatus: number = planned.status;
    const makeStep = (planBody: typeof body) => (unitId: string, resource: string, action: string, name: string | undefined, phase: string, args: Record<string, unknown> = {}) => {
      const actionId = graphActionId({ unitId, resource, action, ...(name !== undefined ? { name } : {}) });
      return app.request("/api/deploy/step", {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          accountId: ACCOUNT, executionContext: planBody.executionContext, approval: planBody.approval,
          unitId, actionId, phase, step: phase, bundleDigest: planBody.bundleDigests[unitId], args,
        }),
      });
    };
    const planUpgrade = (extra: Record<string, unknown> = {}) => app.request("/api/deploy/plan", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ accountId: ACCOUNT, releaseProof: preparedBody.releaseProof, config: { text: JSON.stringify(V3_CONFIG) }, paidRiskConfirmed: true, mode: "upgrade", ...extra }),
    });
    const replan = async (extra: Record<string, unknown> = {}) => (await (await planUpgrade(extra)).json()) as typeof body & { error?: string; detail?: string };
    const writes = () => calls.filter((call) => call.method !== "GET");
    return { app, headers, calls, writes, workers, uploads, body, step: makeStep(body), makeStep, replan, planUpgrade, planStatus };
  }

  const secretInput = (extra: Record<string, unknown> = {}) => ({
    key: "TOKEN", type: "secret", label: "Worker token", ...extra,
  });

  it.each(["node", "workers"] as const)("binds a fresh prompt-on-install secret to the Worker version (%s)", async (runtime) => {
    const t = await setupSecrets(runtime, [secretInput()]);
    expect(t.planStatus).toBe(200);
    expect(t.body.graphPlan.blocked, JSON.stringify(t.body.graphPlan)).toBe(false);
    const diffs = t.body.graphPlan.units.find((u) => u.unitId === "main")!.diffs;
    expect(diffs.filter((d) => d.resource === "secret")).toEqual([{ resource: "secret", action: "create", name: "TOKEN" }]);
    // A missing prompt value refuses before any write.
    const writesBefore = t.writes().length;
    const missing = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64") });
    expect(missing.status).toBe(409);
    expect(t.writes()).toHaveLength(writesBefore);
    // The declared value binds into the same version upload as the code.
    const created = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64"), secrets: { TOKEN: V3_SECRET } });
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    expect(JSON.stringify(createdBody)).not.toContain(V3_SECRET);
    expect(t.workers.get("api")?.versions[0]?.bindings).toContainEqual(expect.objectContaining({ name: "TOKEN", type: "secret_text" }));
    const activated = await t.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt] });
    expect(activated.status, await activated.clone().text()).toBe(200);
  });

  it.each(["node", "workers"] as const)("generates generate-once server-side without browser values (%s)", async (runtime) => {
    const t = await setupSecrets(runtime, [secretInput({ generate: true })]);
    expect(t.planStatus).toBe(200);
    expect(t.body.graphPlan.blocked, JSON.stringify(t.body.graphPlan)).toBe(false);
    const created = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64") });
    expect(created.status, await created.clone().text()).toBe(200);
    // The server-generated value is bound but never returned or logged.
    const createdBody = await created.json() as { result: { versionId: string } };
    expect(JSON.stringify(createdBody)).not.toContain("secret");
    const bindings = t.workers.get("api")?.versions[0]?.bindings ?? [];
    expect(bindings.filter((b) => (b as Record<string, unknown>).name === "TOKEN")).toEqual([
      expect.objectContaining({ name: "TOKEN", type: "secret_text" }),
    ]);
  });

  it.each(["node", "workers"] as const)("upgrade inherits the exact active version without prompting or rotating (%s)", async (runtime) => {
    const t = await setupSecrets(runtime, [secretInput()]);
    expect(t.planStatus).toBe(200);
    const created = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64"), secrets: { TOKEN: V3_SECRET } });
    expect(created.status).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await t.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt] });
    expect(activated.status).toBe(200);
    // A re-plan against the live secret: preserve, no prompt, no rotation.
    const upgrade = await t.replan();
    expect(upgrade.graphPlan.blocked, JSON.stringify(upgrade.graphPlan)).toBe(false);
    expect(upgrade.graphPlan.units.find((u) => u.unitId === "main")!.diffs.filter((d) => d.resource === "secret")).toEqual([
      { resource: "secret", action: "preserve", name: "TOKEN" },
    ]);
    // Upgrade path: a version upload with no supplied values inherits the
    // exact active version; nothing is created or rotated.
    const ustep = t.makeStep(upgrade);
    const upgraded = await ustep("main", "worker", "update", "api", "create-version", { scriptB64: Buffer.from(code).toString("base64") });
    expect(upgraded.status, await upgraded.clone().text()).toBe(200);
    // The second upload carries an inherit directive at the exact active
    // version — no re-sent value, no rotation, nothing prompted.
    const v2Upload = t.uploads[t.uploads.length - 1];
    expect(v2Upload?.bindings).toContainEqual({ type: "inherit", name: "TOKEN", version_id: createdBody.result.versionId });
    expect((v2Upload?.bindings ?? []).filter((b) => b.name === "TOKEN" && b.type === "secret_text")).toHaveLength(0);
    // The live version readback sees the resolved secret binding (no value).
    const v2 = t.workers.get("api")?.versions[0];
    expect(v2?.bindings).toContainEqual(expect.objectContaining({ name: "TOKEN", type: "secret_text" }));
    expect(JSON.stringify(v2?.bindings ?? []).includes(V3_SECRET)).toBe(false);
  });

  async function installAndActivate(t: Awaited<ReturnType<typeof setupSecrets>>) {
    const created = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64"), secrets: { TOKEN: V3_SECRET } });
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await t.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt] });
    expect(activated.status).toBe(200);
    return createdBody.result.versionId;
  }

  it.each(["node", "workers"] as const)("an upgrade replaces a secret the user chose to change, with the new value (%s)", async (runtime) => {
    const t = await setupSecrets(runtime, [secretInput({ required: false })]);
    await installAndActivate(t);
    const upgrade = await t.replan({ replaceSecrets: ["TOKEN"] });
    expect(upgrade.graphPlan.blocked, JSON.stringify(upgrade.graphPlan)).toBe(false);
    expect(upgrade.graphPlan.units.find((u) => u.unitId === "main")!.diffs.filter((d) => d.resource === "secret")).toEqual([{ resource: "secret", action: "update", name: "TOKEN" }]);
    const ustep = t.makeStep(upgrade);
    const missing = await ustep("main", "worker", "update", "api", "create-version", { scriptB64: Buffer.from(code).toString("base64") });
    expect(missing.status).toBe(409);
    const upgraded = await ustep("main", "worker", "update", "api", "create-version", { scriptB64: Buffer.from(code).toString("base64"), secrets: { TOKEN: "new-token-value" } });
    expect(upgraded.status, await upgraded.clone().text()).toBe(200);
    // The only secret is replaced, so nothing is inherited: the upload carries the new value itself.
    expect(t.workers.get("api")!.versions[0]!.bindings.filter((binding) => binding.name === "TOKEN")).toEqual([{ type: "secret_text", name: "TOKEN", text: "new-token-value" }]);
    expect(JSON.stringify(await upgraded.json())).not.toContain("new-token-value");
    // Not choosing it keeps the live secret: no prompt, an inherit directive.
    const kept = await t.replan();
    expect(kept.graphPlan.units.find((u) => u.unitId === "main")!.diffs.filter((d) => d.resource === "secret")).toEqual([{ resource: "secret", action: "preserve", name: "TOKEN" }]);
  });

  it("replacing one secret still inherits the others from the active version", async () => {
    const t = await setupSecrets("node", [secretInput({ required: false }), secretInput({ key: "OTHER", label: "Other", required: false })]);
    const created = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64"), secrets: { TOKEN: V3_SECRET, OTHER: "other-value" } });
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    expect((await t.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt] })).status).toBe(200);
    const upgrade = await t.replan({ replaceSecrets: ["TOKEN"] });
    expect(upgrade.graphPlan.units.find((u) => u.unitId === "main")!.diffs.filter((d) => d.resource === "secret")).toEqual([
      { resource: "secret", action: "update", name: "TOKEN" },
      { resource: "secret", action: "preserve", name: "OTHER" },
    ]);
    const upgraded = await t.makeStep(upgrade)("main", "worker", "update", "api", "create-version", { scriptB64: Buffer.from(code).toString("base64"), secrets: { TOKEN: "new-token-value" } });
    expect(upgraded.status, await upgraded.clone().text()).toBe(200);
    const upload = t.uploads[t.uploads.length - 1]!;
    expect(upload.bindings.filter((binding) => binding.name === "TOKEN")).toEqual([{ type: "secret_text", name: "TOKEN", text: "new-token-value" }]);
    expect(upload.bindings.filter((binding) => binding.name === "OTHER")).toEqual([{ type: "inherit", name: "OTHER", version_id: createdBody.result.versionId }]);
  });

  it.each([
    ["an install-only secret", [secretInput({ upgradeKeep: true })], ["TOKEN"]],
    ["a generate-once secret", [secretInput({ generate: true })], ["TOKEN"]],
    ["an undeclared name", [secretInput({ required: false })], ["OTHER"]],
  ] as const)("refuses to replace %s on upgrade, before any provider read", async (_label, inputs, replaceSecrets) => {
    const t = await setupSecrets("node", [...inputs]);
    const callsBefore = t.calls.length;
    const refused = await t.planUpgrade({ replaceSecrets });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "INVALID_INPUT" });
    expect(t.calls).toHaveLength(callsBefore);
  });

  it("refuses replaceSecrets on an install", async () => {
    const t = await setupSecrets("node", [secretInput({ required: false })], {}, { replaceSecrets: ["TOKEN"] });
    expect(t.planStatus).toBe(400);
  });

  const varInputs = [
    { key: "REGION", type: "select", label: "Region", upgradeKeep: true, options: [{ label: "Europe", value: "eu" }, "us"] },
    { key: "RETENTION_DAYS", type: "integer", label: "Retention", validation: { minimum: 1, maximum: 30 } },
    { key: "TAGS", type: "multiselect", label: "Tags", required: false, options: [{ label: "A", value: "a" }, "b"] },
    { key: "EXPIRES", type: "date", label: "Expires", required: false },
  ];

  it("non-secret inputs become plain-text Worker variables, and an upgrade changes them", async () => {
    const t = await setupSecrets("node", varInputs, {}, { inputs: { REGION: "eu", RETENTION_DAYS: "7", TAGS: "a,b", EXPIRES: "2027-02-28" } });
    expect(t.planStatus, JSON.stringify(t.body)).toBe(200);
    const created = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64") });
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    expect((await t.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt] })).status).toBe(200);
    const bindings = t.workers.get("api")!.versions[0]!.bindings;
    expect(bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "plain_text", name: "REGION", text: "eu" }),
      expect.objectContaining({ type: "plain_text", name: "RETENTION_DAYS", text: "7" }),
      expect.objectContaining({ type: "plain_text", name: "TAGS", text: "a,b" }),
      expect.objectContaining({ type: "plain_text", name: "EXPIRES", text: "2027-02-28" }),
    ]));
    // Upgrade: REGION (upgradeKeep) is kept and not asked; an empty value keeps what is deployed, a given one must still be valid.
    expect((await t.planUpgrade({ inputs: { RETENTION_DAYS: "14" } })).status).toBe(200);
    expect((await t.planUpgrade({ inputs: {} })).status).toBe(200);
    expect((await t.planUpgrade({ inputs: { RETENTION_DAYS: "99" } })).status).toBe(400);
    expect(await (await t.planUpgrade({ inputs: { REGION: "us", RETENTION_DAYS: "14" } })).json()).toMatchObject({ error: "INVALID_INPUT", detail: "inputs.REGION is not asked on upgrade" });
  });

  it.each([
    ["a missing required input", { REGION: "eu" }, "inputs.RETENTION_DAYS is required"],
    ["a number out of range", { REGION: "eu", RETENTION_DAYS: "99" }, "inputs.RETENTION_DAYS: at most 30"],
    ["a non-integer", { REGION: "eu", RETENTION_DAYS: "1.5" }, "inputs.RETENTION_DAYS: a whole number"],
    ["an option that is not listed", { REGION: "asia", RETENTION_DAYS: "7" }, "inputs.REGION: one of the listed options"],
    ["a multiselect with an unlisted choice", { REGION: "eu", RETENTION_DAYS: "7", TAGS: "a,z" }, "inputs.TAGS: only the listed options"],
    ["an impossible date", { REGION: "eu", RETENTION_DAYS: "7", EXPIRES: "2027-02-30" }, "inputs.EXPIRES: a date as YYYY-MM-DD"],
  ])("refuses %s at plan time", async (_label, inputs, detail) => {
    const t = await setupSecrets("node", varInputs, {}, { inputs });
    expect(t.planStatus).toBe(400);
    expect(t.body).toMatchObject({ error: "INVALID_INPUT", detail });
  });

  it("refuses an input that would override a variable the release sets", async () => {
    const t = await setupSecrets("node", varInputs, { vars: { REGION: "fixed" } }, { inputs: { REGION: "eu", RETENTION_DAYS: "7" } });
    expect(t.planStatus).toBe(409);
    expect(t.body).toMatchObject({ detail: 'input "REGION" collides with a variable the release already sets in unit main' });
  });

  it.each(["node", "workers"] as const)("rejects undeclared secret names before any provider write (%s)", async (runtime) => {
    const t = await setupSecrets(runtime, [secretInput()]);
    expect(t.planStatus).toBe(200);
    const writesBefore = t.writes().length;
    const injected = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64"), secrets: { TOKEN: V3_SECRET, INJECTED: "nope" } });
    // Invalid request shape: refused before any provider write.
    expect(injected.status).toBe(400);
    expect((await injected.json() as { error?: string }).error).toBe("invalid-args");
    expect(t.writes()).toHaveLength(writesBefore);
  });

  it.each(["node", "workers"] as const)("refuses a plaintext var colliding with a declared secret (%s)", async (runtime) => {
    const t = await setupSecrets(runtime, [secretInput()], { vars: { TOKEN: "plain-text" } });
    expect(t.planStatus).toBe(200);
    const writesBefore = t.writes().length;
    const collided = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64"), secrets: { TOKEN: V3_SECRET } });
    expect(collided.status).toBe(409);
    expect(t.writes()).toHaveLength(writesBefore);
  });

  it("rejects generate on non-secret inputs and invalid binding names before any provider read", async () => {    const badPolicy = await setupSecrets("node", [{ key: "PLAIN", type: "string", label: "Plain", generate: true }]);
    expect(badPolicy.planStatus).toBe(400);
    expect(badPolicy.calls).toEqual([]);
    const badName = await setupSecrets("node", [{ key: "bad-name!", type: "secret", label: "Bad" }]);
    expect(badName.planStatus).toBe(400);
    expect(badName.calls).toEqual([]);
  });
});

// rate limits are Worker version metadata bindings only — never
// account/zone rule provisioning. Six bindings arrive intact and in
// declaration order; invalid declarations refuse before any provider read,
// and a tampered readback blocks activation with zero new writes.
describe("rate-limit worker bindings (graph API)", () => {
  const SIX_LIMITS = [
    { name: "RATE_A", namespace_id: "1001", simple: { limit: 100, period: 60 } },
    { name: "RATE_B", namespace_id: "1002", simple: { limit: 10, period: 10 } },
    { name: "RATE_C", namespace_id: "1003", simple: { limit: 1000, period: 60 } },
    { name: "RATE_D", namespace_id: "1004", simple: { limit: 5, period: 10 } },
    { name: "RATE_E", namespace_id: "1005", simple: { limit: 50, period: 60 } },
    { name: "RATE_F", namespace_id: "1006", simple: { limit: 25, period: 10 } },
  ];
  const expectedBindings = SIX_LIMITS.map((r) => ({ name: r.name, type: "ratelimit", namespace_id: r.namespace_id, simple: { ...r.simple } }));

  it.each(["node", "workers"] as const)("binds six rate limits as version metadata with zero account rule writes (%s)", async (runtime) => {
    const f = await graphHonoFixture(baseConfig(["workers"]), {
      "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17", ratelimits: SIX_LIMITS })),
      "worker/main.mjs": enc.encode(code),
    }, runtime);
    expect(f.plannedBody.graphPlan.blocked, JSON.stringify(f.plannedBody)).toBe(false);
    // Rate limits are version bindings, not plan diffs and not account rules.
    expect(f.plannedBody.graphPlan.units.find((u) => u.unitId === "main")!.diffs.map((d) => d.resource).sort()).toEqual(["deployment", "worker"]);
    const created = await f.step("main", "worker", "create", "api", "create-worker");
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    expect(f.workers.get("api")?.versions[0]?.bindings).toEqual(expectedBindings);
    const activated = await f.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt] });
    expect(activated.status, await activated.clone().text()).toBe(200);
    expect(f.writes().every((call) => call.path.includes("/workers/scripts/"))).toBe(true);
    expect(f.writes().some((call) => /rule/i.test(call.path))).toBe(false);
  });

  it.each(["period 600", "non-decimal namespace"] as const)("refuses an invalid %s declaration at plan time with zero provider calls", async (kind) => {
    const bad = kind === "period 600"
      ? [{ name: "RL", namespace_id: "1001", simple: { limit: 10, period: 600 } }]
      : [{ name: "RL", namespace_id: "ns-abc", simple: { limit: 10, period: 60 } }];
    const t = await graphHonoFixture(baseConfig(["workers"]), {
      "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17", ratelimits: bad })),
      "worker/main.mjs": enc.encode(code),
    });
    expect(t.planned.status).toBe(409);
    expect(t.writes()).toEqual([]);
  });

  it("refuses duplicate names and colliding binding names before any provider read", async () => {
    const { normalizeWranglerV3 } = await import("../../src/manifest/wrangler-v3.js");
    const dupes = normalizeWranglerV3(JSON.stringify({
      name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17",
      ratelimits: [
        { name: "RL", namespace_id: "1001", simple: { limit: 10, period: 60 } },
        { name: "RL", namespace_id: "1002", simple: { limit: 10, period: 60 } },
      ],
    }));
    expect(dupes.ok).toBe(false);
    const collided = normalizeWranglerV3(JSON.stringify({
      name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17",
      vars: { RL: "plain-text" },
      ratelimits: [{ name: "RL", namespace_id: "1001", simple: { limit: 10, period: 60 } }],
    }));
    expect(collided.ok).toBe(false);
  });

  it.each(["node", "workers"] as const)("a tampered live binding invalidates receipts and blocks follow-up steps (%s)", async (runtime) => {
    const f = await graphHonoFixture(baseConfig(["workers"]), {
      "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17", ratelimits: SIX_LIMITS })),
      "worker/main.mjs": enc.encode(code),
    }, runtime);
    const created = await f.step("main", "worker", "create", "api", "create-worker");
    expect(created.status).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await f.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt] });
    expect(activated.status).toBe(200);
    const activatedBody = await activated.json() as { phaseReceipt: unknown };
    const writesBefore = f.writes().length;
    // Drop one binding from the live version: every outstanding receipt stops
    // verifying, so the follow-up step fails closed with zero new writes.
    const live = f.workers.get("api")!;
    live.versions[0] = { ...live.versions[0]!, bindings: live.versions[0]!.bindings.filter((b) => (b as Record<string, unknown>).name !== "RATE_F") };
    const post = await f.step("main", "worker", "create", "api", "postcheck", { expectedVersionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt, activatedBody.phaseReceipt] });
    expect(post.status).toBe(409);
    expect((await post.json() as { error?: string }).error).toBe("GRAPH_RECEIPT_STATE_CHANGED");
    expect(f.writes()).toHaveLength(writesBefore);
  });

  // Live-manual found this: route-level worker postcheck always failed with
  // GRAPH_READBACK_MISMATCH because the step sealed no version identity. The
  // browser's expectedVersionId is now bound to the sealed prepared version, so
  // a clean create -> activate -> postcheck seals green, while a forged claim
  // still fails closed with zero new writes.
  it.each(["node", "workers"] as const)("worker postcheck seals the live version after activate (%s)", async (runtime) => {
    const f = await graphHonoFixture(baseConfig(["workers"]), {
      "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17" })),
      "worker/main.mjs": enc.encode(code),
    }, runtime);
    const created = await f.step("main", "worker", "create", "api", "create-worker");
    expect(created.status).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await f.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt] });
    expect(activated.status).toBe(200);
    const activatedBody = await activated.json() as { phaseReceipt: unknown };
    const writesBefore = f.writes().length;
    const post = await f.step("main", "worker", "create", "api", "postcheck", { expectedVersionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt, activatedBody.phaseReceipt] });
    const postBody = await post.json() as { phaseReceipt?: unknown; result?: { deployed?: boolean }; error?: string };
    expect(post.status, JSON.stringify(postBody)).toBe(200);
    expect(postBody.result?.deployed).toBe(true);
    expect(postBody.phaseReceipt).toBeDefined();
    expect(f.writes()).toHaveLength(writesBefore);
    // A forged expectedVersionId (not the sealed prepared version) fails closed.
    const forged = await f.step("main", "worker", "create", "api", "postcheck", { expectedVersionId: "ffffffff-ffff-4fff-8fff-ffffffffffff", receipts: [createdBody.phaseReceipt, activatedBody.phaseReceipt] });
    expect(forged.status).toBe(409);
    expect((await forged.json() as { error?: string }).error).toBe("GRAPH_READBACK_MISMATCH");
    expect(f.writes()).toHaveLength(writesBefore);
  });
});

it("prepares raw ZIP bytes and creates a server-derived V3 graph plan", async () => {
  const origin = "https://installer.example";
  const accountId = "a".repeat(32);
  const config: ConfigV3 = {
    schemaVersion: 3 as const,
    app: { id: "example/api", name: "API" },
    source: { allowLocalZip: true },
    capabilities: ["workers", "r2"],
    units: [{ id: "api", kind: "worker" as const, wrangler: "wrangler.jsonc" }],
    resources: [{ kind: "r2" as const, name: "media" }],
  };
  const configText = JSON.stringify(config);
  const env = { RUNTIME: "node", PUBLIC_ORIGIN: origin, OAUTH_CLIENT_ID: "x", OAUTH_CLIENT_SECRET: "x" } as const;
  const key = await deriveSealKey(env.OAUTH_CLIENT_SECRET);
  const session = await createSession(key, { ttlMs: 60_000, publicOrigin: origin }, {
    accessToken: "token", tokenType: "Bearer", scope: [], source: "v3", accountId,
    configHash: await computeConfigV3Id(config),
    sourcePolicy: { allowLocalZip: true, appId: config.app.id, units: sourcePolicyUnits(config) },
  });
  const app = createApp(env);
  let r2Created = false;
  let workerMetadata: Record<string, unknown> | undefined;
  const versionId = "00000000-0000-4000-8000-000000000001";
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method && init.method !== "GET") writes.push(`${init.method} ${url.pathname}`);
    if (url.pathname.endsWith("/workers/scripts/api") && init?.method === "PUT") {
      const form = init.body as FormData;
      workerMetadata = JSON.parse(await (form.get("metadata") as Blob).text()) as Record<string, unknown>;
      expect(await (form.get("worker/main.mjs") as Blob).text()).toBe("export default { fetch() { return new Response('ok'); } };");
      return Response.json({ success: true, result: { id: "api" } });
    }
    if (url.pathname.endsWith("/workers/scripts/api")) {
      return Response.json({ success: false, errors: [{ code: 10007, message: "not found" }] }, { status: 404 });
    }
    const message = (workerMetadata?.annotations as Record<string, unknown> | undefined)?.["workers/message"];
    if (url.pathname.endsWith("/workers/scripts")) return Response.json({ success: true, result: workerMetadata ? [{ id: "api" }] : [] });
    if (url.pathname.endsWith("/versions")) return Response.json({ success: true, result: { items: [{ id: versionId, message }] } });
    if (url.pathname.endsWith("/deployments")) return Response.json({ success: true, result: { deployments: [{ id: "deployment-one", versions: [{ version_id: versionId, percentage: 100 }] }] } });
    if (url.pathname.includes("/versions/")) return Response.json({ success: true, result: { id: versionId, message, resources: { bindings: workerMetadata?.bindings ?? [], script_runtime: { compatibility_date: "2026-10-17", compatibility_flags: [] } } } });
    if (url.pathname.endsWith("/schedules")) return Response.json({ success: true, result: { schedules: [] } });
    if (url.pathname.endsWith("/r2/buckets")) {
      if (url.searchParams.get("per_page")) return Response.json({ success: true, result: { buckets: r2Created ? [{ name: "media", id: "bucket-media" }] : [] } });
      r2Created = true;
      return Response.json({ success: true, result: { name: "media", id: "bucket-media" } });
    }
    return Response.json({ success: true, result: [] });
  }));
  const headers = { origin, "x-tapdeploy-csrf": session.payload.csrf, cookie: `${sessionCookieName(origin)}=${session.cookieValue}` };
  const archive = zipSync({
    "wrangler.jsonc": new TextEncoder().encode('{"name":"api","main":"worker/main.mjs","compatibility_date":"2026-10-17"}'),
    "worker/main.mjs": new TextEncoder().encode("export default { fetch() { return new Response('ok'); } };"),
  });
  const prepared = await app.request("/api/deploy/prepare", { method: "POST", headers: { ...headers, "content-type": "application/zip" }, body: archive });
  const preparedBody = await prepared.json() as { releaseProof?: unknown; error?: string; detail?: string };
  expect(prepared.status, JSON.stringify(preparedBody)).toBe(200);
  const proof = preparedBody.releaseProof;
  const planned = await app.request("/api/deploy/plan", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ accountId, config: { text: configText }, releaseProof: proof, mode: "install", paidRiskConfirmed: true }) });
  const body = await planned.json() as { error?: string; detail?: string; graphPlan: { blocked: boolean; units: Array<{ unitId: string }> }; executionContext?: unknown; approval?: unknown };
  expect(planned.status, JSON.stringify(body)).toBe(200);
  expect(body.graphPlan.blocked, JSON.stringify(body.graphPlan)).toBe(false);
  expect(body.graphPlan.units.map((unit) => unit.unitId)).toEqual(["api", "resources"]);
  expect(body.executionContext).toBeDefined();
  expect(body.approval).toBeDefined();
  const stepBody = { accountId, executionContext: body.executionContext, approval: body.approval, unitId: "resources", actionId: graphActionId({ unitId: "resources", resource: "r2", action: "create", name: "media" }), phase: "create-r2-buckets", step: "create-r2-buckets" };
  const wrongPhase = await app.request("/api/deploy/step", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ ...stepBody, phase: "activate" }) });
  expect(wrongPhase.status).toBe(409);
  expect(writes).toEqual([]);
  const step = await app.request("/api/deploy/step", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(stepBody),
  });
  expect(step.status, await step.clone().text()).toBe(200);
  const resourceReceipt = (await step.json() as { phaseReceipt?: unknown }).phaseReceipt;
  expect(resourceReceipt).toBeDefined();
  expect(writes).toEqual([`POST /client/v4/accounts/${accountId}/r2/buckets`]);
  const collision = await app.request("/api/deploy/step", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(stepBody) });
  expect(collision.status).toBe(409);
  const retry = await app.request("/api/deploy/step", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ ...stepBody, args: { phaseReceipt: resourceReceipt } }) });
  expect(retry.status, await retry.clone().text()).toBe(200);
  expect(writes).toHaveLength(1);
  const release = await openSeal<{ units: Array<{ unitId: string; bundleDigest: string }> }>(key, proof as SealedEnvelope);
  const workerBody = { ...stepBody, unitId: "api", actionId: graphActionId({ unitId: "api", resource: "worker", action: "create", name: "api" }), step: "create-worker", phase: "create-worker", bundleDigest: release!.units.find(unit => unit.unitId === "api")!.bundleDigest };
  const extraVersion = await app.request("/api/deploy/step", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ ...workerBody, phase: "create-version", step: "create-version", args: { scriptB64: btoa("export default { fetch() { return new Response('ok'); } };") } }) });
  expect(extraVersion.status).toBe(409);
  expect(writes).toHaveLength(1);
  const tampered = await app.request("/api/deploy/step", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ ...workerBody, args: { scriptB64: btoa("modified-module") } }) });
  expect(tampered.status).toBe(422);
  expect(writes).toHaveLength(1);
  const workerStep = await app.request("/api/deploy/step", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ ...workerBody, args: { scriptB64: btoa("export default { fetch() { return new Response('ok'); } };") } }) });
  expect(workerStep.status, await workerStep.clone().text()).toBe(200);
  expect(writes).toEqual([`POST /client/v4/accounts/${accountId}/r2/buckets`, `PUT /client/v4/accounts/${accountId}/workers/scripts/api`]);
  const workerReceipt = (await workerStep.json() as { phaseReceipt: unknown }).phaseReceipt;
  const workerCollision = await app.request("/api/deploy/step", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(workerBody) });
  expect(workerCollision.status).toBe(409);
  const workerRetry = await app.request("/api/deploy/step", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ ...workerBody, args: { phaseReceipt: workerReceipt } }) });
  expect(workerRetry.status, await workerRetry.clone().text()).toBe(200);
  expect(writes).toHaveLength(2);
});

// guarded R2 owner bootstrap over the V3 graph API (both runtimes).// The plan validates the install profile structurally and refuses unknown// units/bindings before any provider read; each Worker version upload then// inspects live state with verified object existence (never contents),// decides Fresh/Resume/Upgrade, and for fresh/resume proves bucket privacy// immediately before the write and merges the server-generated/bootstrap// secrets into the SAME version upload. No stdout, log, or report ever// carries a secret value, an object body, or an Owner password.import { describe, expect, it, vi } from "vitest";

const ACCOUNT = "a".repeat(32);
const ORIGIN = "https://installer.example.com";
const PROFILE = {
  kind: "private-r2-owner-bootstrap/v1",
  unitId: "main",
  r2Binding: "DATA",
  rootSecret: "ROOT_SECRET",
  armSecret: "SETUP_ARMED",
  armValue: "yes",
  ownerKey: "owner.json",
  markerKey: "setup-marker.json",
  initialPasswordKey: "initial-password",
  readinessPath: "/api/auth/methods",
} as const;
const V3_CONFIG_BASE = {
  schemaVersion: 3 as const,
  app: { id: "example/owner-app", name: "Owner App" },
  source: { allowLocalZip: true },
  capabilities: ["workers", "r2"] as string[],
};

interface MockVersion { id: string; message: string; bindings: Record<string, unknown>[]; runtime: Record<string, unknown> }
interface BootstrapWorld {
  workers: Map<string, { versions: MockVersion[]; active: string }>;
  buckets: Map<string, { id: string }>;
  objects: Set<string>;
  secretsByWorker: Map<string, string[]>;
  managedEnabled: boolean;
  customDomains: Array<{ domain: string; enabled: boolean }>;
  denyObjects: boolean;
  foreignBucket: boolean;
  ownerAfterFirstRead: boolean;
  ownerReads: number;
  calls: Array<{ method: string; path: string }>;
  uploaded: Array<{ bindings: unknown }>;
}

function configWith(policy: unknown) {
  return {
    ...V3_CONFIG_BASE,
    inputs: [
      { key: "UNUSED", type: "text", label: "Unused", required: false },
    ],
    units: [{ id: "main", kind: "worker" as const, wrangler: "wrangler.jsonc" }],
    install: { policies: [policy] },
  };
}

async function setupBootstrap(
  runtime: "node" | "workers",
  policy: unknown,
  seed: Partial<{
    workerExists: boolean; secrets: string[]; bucketExists: boolean; foreignBucket: boolean;
    owner: boolean; marker: boolean; managedEnabled: boolean;
    customDomains: Array<{ domain: string; enabled: boolean }>;
    denyObjects: boolean; ownerAfterFirstRead: boolean;
  }> = {},
) {
  const env = { RUNTIME: runtime, PUBLIC_ORIGIN: ORIGIN, OAUTH_CLIENT_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } as const;
  const app = createApp(env);
  const key = await deriveSealKey(env.OAUTH_CLIENT_SECRET);
  const config = configWith(policy);
  const session = await createSession(key, { ttlMs: 120_000, publicOrigin: ORIGIN }, {
    accessToken: "offline-test-token", tokenType: "Bearer", scope: [], source: "v3", accountId: ACCOUNT,
    configHash: await computeConfigV3Id(config as never),
    sourcePolicy: { allowLocalZip: true, appId: "example/owner-app", units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }] },
  });
  const headers = {
    origin: ORIGIN,
    "x-tapdeploy-csrf": session.payload.csrf,
    cookie: `${sessionCookieName(ORIGIN)}=${session.cookieValue}`,
  };
  const world: BootstrapWorld = {
    workers: new Map(),
    buckets: new Map(),
    objects: new Set<string>(),
    secretsByWorker: new Map(),
    managedEnabled: false,
    customDomains: [],
    denyObjects: false,
    foreignBucket: false,
    ownerAfterFirstRead: false,
    ownerReads: 0,
    calls: [],
    uploaded: [],
  };
  if (seed.foreignBucket !== undefined) world.foreignBucket = seed.foreignBucket;
  if (seed.ownerAfterFirstRead !== undefined) world.ownerAfterFirstRead = seed.ownerAfterFirstRead;
  if (seed.bucketExists !== false) world.buckets.set("private-data", { id: "bucket-private-data" });
  if (seed.workerExists) {
    world.workers.set("api", { versions: [{ id: "00000000-0000-4000-8000-000000000001", message: "m", bindings: (seed.secrets ?? []).map((name) => ({ name, type: "secret_text" })), runtime: {} }], active: "00000000-0000-4000-8000-000000000001" });
  }
  if (seed.secrets) world.secretsByWorker.set("api", [...seed.secrets]);
  if (seed.owner) world.objects.add("private-data/owner.json");
  if (seed.marker) world.objects.add("private-data/setup-marker.json");
  if (seed.managedEnabled !== undefined) world.managedEnabled = seed.managedEnabled;
  if (seed.customDomains !== undefined) world.customDomains = seed.customDomains;
  if (seed.denyObjects !== undefined) world.denyObjects = seed.denyObjects;
  let versionCounter = 1;
  const recordSecretNames = (bindings: Array<Record<string, unknown>>) => {
    const names = new Set(world.secretsByWorker.get("api") ?? []);
    for (const binding of bindings) {
      if (binding.type === "secret_text" || binding.type === "secret_key") names.add(String(binding.name));
    }
    world.secretsByWorker.set("api", [...names]);
  };
  const ok = (result: unknown) => Response.json({ success: true, result });
  const notFound = () => Response.json({ success: false, errors: [{ code: 10007, message: "not found" }] }, { status: 404 });
  const noContent = () => new Response(null, { status: 204 });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.cloudflare.com");
    const method = init?.method ?? "GET";
    const path = url.pathname;
    world.calls.push({ method, path });
    // R2 object existence (HEAD only — never contents).
    const objMatch = /^\/client\/v4\/accounts\/[^/]+\/r2\/buckets\/([^/]+)\/objects\/(.+)$/.exec(path);
    if (objMatch) {
      if (world.denyObjects) return Response.json({ success: false, errors: [{ code: 10001, message: "forbidden" }] }, { status: 403 });
      const key = decodeURIComponent(objMatch[2]!).split("/").map(decodeURIComponent).join("/");
      const bucket = decodeURIComponent(objMatch[1]!);
      if (!world.buckets.has(bucket)) return notFound();
      // Race simulation: a concurrent install's Owner appears right after
      // the first existence read (between inspect and prewrite recheck).
      if (key === "owner.json" && world.ownerAfterFirstRead) {
        world.ownerReads += 1;
        return world.ownerReads > 1 ? noContent() : notFound();
      }
      return world.objects.has(`${bucket}/${key}`) ? noContent() : notFound();
    }
    if (path.endsWith("/domains/managed") && method === "GET") {
      return ok({ domain: "private-data.r2.dev", enabled: world.managedEnabled });
    }
    if (path.endsWith("/domains/custom") && method === "GET") {
      return ok({ domains: world.customDomains.map((d) => ({ domain: d.domain, enabled: d.enabled })) });
    }
    if (path.endsWith("/workers/subdomain") && method === "GET") return notFound();
    const subMatch = /\/workers\/scripts\/([^/]+)\/subdomain$/.exec(path);
    if (subMatch) return method === "GET" ? ok({ enabled: false, previews_enabled: true }) : ok({ enabled: true, previews_enabled: true });
    if (path.endsWith("/workers/scripts") && method === "GET") return ok([...world.workers.keys()].map((id) => ({ id })));
    // Immutable Worker resource API: identity list + inherit-resolving version
    // upload. The raw request is recorded to prove values are never re-sent.
    if (path === `/client/v4/accounts/${ACCOUNT}/workers/workers` && method === "GET") {
      return Response.json({ success: true, result: world.workers.has("api") ? [{ id: "worker-resource-api", name: "api" }] : [], result_info: { total_pages: 1 } });
    }
    const resMatch = /\/workers\/workers\/([^/]+)(\/versions)?$/.exec(path);
    if (resMatch) {
      if (resMatch[2] === undefined) return ok({ id: "worker-resource-api", name: "api" });
      const uploaded = JSON.parse(String(init?.body)) as {
        bindings?: Array<Record<string, unknown>>;
        annotations?: Record<string, string>;
        compatibility_date?: string;
        compatibility_flags?: string[];
      };
      world.uploaded.push({ bindings: uploaded.bindings ?? [] });
      // The provider resolves `inherit` server-side: readback sees resolved
      // secret bindings (names/types only, never values, never `inherit`).
      const activeBindings = world.workers.get("api")?.versions[0]?.bindings ?? [];
      const resolved = (uploaded.bindings ?? []).map((binding) => {
        if (binding.type !== "inherit") return binding;
        const live = activeBindings.find((b) => b.name === binding.name && (b.type === "secret_text" || b.type === "secret_key"));
        return live ? { name: binding.name, type: live.type, version_id: binding.version_id } : binding;
      });
      recordSecretNames(resolved);
      const id = `00000000-0000-4000-8000-${String(++versionCounter).padStart(12, "0")}`;
      const version: MockVersion = {
        id,
        message: uploaded.annotations?.["workers/message"] ?? "",
        bindings: resolved,
        runtime: { compatibility_date: uploaded.compatibility_date, compatibility_flags: uploaded.compatibility_flags ?? [] },
      };
      const worker = world.workers.get("api") ?? { versions: [], active: "" };
      worker.versions.unshift(version);
      world.workers.set("api", worker);
      return ok({ id });
    }
    const match = /\/workers\/scripts\/([^/]+)(.*)$/.exec(path);
    if (match) {
      const name = decodeURIComponent(match[1]!);
      const tail = match[2]!;
      const worker = world.workers.get(name);
      if ((tail === "" && method === "PUT") || (tail === "/versions" && method === "POST")) {
        const form = init?.body as FormData;
        const meta = JSON.parse(await (form.get("metadata") as Blob).text()) as Record<string, unknown>;
        const id = `00000000-0000-4000-8000-${String(++versionCounter).padStart(12, "0")}`;
        const version: MockVersion = { id, message: (meta.annotations as Record<string, string>)["workers/message"]!, bindings: (meta.bindings as Record<string, unknown>[]) ?? [], runtime: { compatibility_date: meta.compatibility_date, compatibility_flags: meta.compatibility_flags ?? [] } };
        world.uploaded.push({ bindings: version.bindings });
        recordSecretNames(version.bindings);
        if (worker) worker.versions.unshift(version);
        else world.workers.set(name, { versions: [version], active: id });
        return ok({ id: tail === "" ? name : id });
      }
      if (!worker) return notFound();
      if (tail === "/secrets" && method === "GET") return ok((world.secretsByWorker.get(name) ?? []).map((s) => ({ name: s })));
      if (tail === "/versions" && method === "GET") return ok({ items: worker.versions.map(({ id, message }) => ({ id, message })) });
      if (tail.startsWith("/versions/") && method === "GET") {
        const version = worker.versions.find((v) => v.id === tail.slice("/versions/".length));
        return version ? ok({ id: version.id, message: version.message, resources: { bindings: version.bindings, script_runtime: version.runtime } }) : notFound();
      }
      if (tail === "/deployments") {
        if (method === "POST") worker.active = (JSON.parse(String(init?.body)) as { versions: Array<{ version_id: string }> }).versions[0]!.version_id;
        const deployment = { id: `deployment-${worker.active}`, versions: [{ version_id: worker.active, percentage: 100 }] };
        return ok(method === "GET" ? { deployments: [deployment] } : deployment);
      }
      if (tail === "/schedules") return ok({ schedules: [] });
      if (tail === "/settings") return ok({ bindings: worker.versions[0]?.bindings ?? [] });
    }
    if (path.endsWith("/r2/buckets")) {
      if (method === "GET") return ok({ buckets: [...world.buckets].map(([name, b]) => ({ name, id: b.id })) });
      const { name } = JSON.parse(String(init?.body)) as { name: string };
      world.buckets.set(name, { id: `bucket-${name}` });
      return ok({ name, id: `bucket-${name}` });
    }
    const bucketMatch = /\/r2\/buckets\/([^/]+)$/.exec(path);
    if (bucketMatch && method === "GET") {
      if (world.foreignBucket) return ok({ name: "other-bucket", id: "other-id" });
      const bucket = world.buckets.get(decodeURIComponent(bucketMatch[1]!));
      return bucket ? ok({ name: decodeURIComponent(bucketMatch[1]!), id: bucket.id }) : notFound();
    }
    throw new Error(`unexpected provider operation ${method} ${path}`);
  }));
  const files = {
    "wrangler.jsonc": enc.encode(JSON.stringify(bootstrapWrangler())),
    "worker/main.mjs": enc.encode(code),
  };
  const archive = zipSync(files, { level: 0 });
  const prepared = await app.request("/api/deploy/prepare", {
    method: "POST", headers: { ...headers, "content-type": "application/zip" }, body: archive as unknown as BodyInit,
  });
  const preparedBody = await prepared.json() as { releaseProof: unknown };
  expect(prepared.status, JSON.stringify(preparedBody)).toBe(200);
  const planned = await app.request("/api/deploy/plan", {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ accountId: ACCOUNT, releaseProof: preparedBody.releaseProof, config: { text: JSON.stringify(config) }, paidRiskConfirmed: true, mode: "install" }),
  });
  const body = await planned.json() as {
    graphPlan: { blocked: boolean; digest: string; units: Array<{ unitId: string; kind: string; diffs: Array<{ resource: string; action: string; name?: string }> }> };
    executionContext: unknown; approval: unknown; bundleDigests: Record<string, string>; error?: string; detail?: string;
  };
  const makeStep = (planBody: typeof body) => (unitId: string, resource: string, action: string, name: string | undefined, phase: string, args: Record<string, unknown> = {}) => {
    const actionId = graphActionId({ unitId, resource, action, ...(name !== undefined ? { name } : {}) });
    return app.request("/api/deploy/step", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        accountId: ACCOUNT, executionContext: planBody.executionContext, approval: planBody.approval,
        unitId, actionId, phase, step: phase, bundleDigest: planBody.bundleDigests[unitId], args,
      }),
    });
  };
  const replan = async () => {
    const replanned = await app.request("/api/deploy/plan", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ accountId: ACCOUNT, releaseProof: preparedBody.releaseProof, config: { text: JSON.stringify(configWith(policy)) }, paidRiskConfirmed: true, mode: "upgrade" }),
    });
    return (await replanned.json()) as typeof body & { error?: string };
  };
  return { app, headers, calls: world.calls, world, body, step: makeStep(body), makeStep, replan, planStatus: planned.status };
}

function bootstrapWrangler(extra: Record<string, unknown> = {}) {
  return {
    name: "api",
    main: "worker/main.mjs",
    compatibility_date: "2026-10-17",
    r2_buckets: [{ binding: "DATA", bucket_name: "private-data" }],
    ...extra,
  };
}

describe("guarded R2 owner bootstrap (graph API)", () => {
  it.each(["node", "workers"] as const)("fresh install generates root and arms in one version upload (%s)", async (runtime) => {
    const t = await setupBootstrap(runtime, { ...PROFILE }, { bucketExists: false });
    expect(t.planStatus, JSON.stringify(t.body)).toBe(200);
    expect(t.body.graphPlan.blocked, JSON.stringify(t.body.graphPlan)).toBe(false);
    const r2 = await t.step("main", "r2", "create", "private-data", "create-r2-buckets");
    expect(r2.status, await r2.clone().text()).toBe(200);
    const r2Body = await r2.json() as { phaseReceipt: unknown };
    const created = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64"), receipts: [r2Body.phaseReceipt] });
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const bound = t.world.workers.get("api")!.versions[0]!.bindings as Array<Record<string, unknown>>;
    expect(bound.filter((b) => b.name === "ROOT_SECRET")).toEqual([expect.objectContaining({ name: "ROOT_SECRET", type: "secret_text" })]);
    expect(bound.filter((b) => b.name === "SETUP_ARMED")).toEqual([expect.objectContaining({ name: "SETUP_ARMED", type: "secret_text" })]);
    expect(JSON.stringify(createdBody)).not.toContain("ROOT_SECRET");
    const activated = await t.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt] });
    expect(activated.status, await activated.clone().text()).toBe(200);
    const writes = t.calls.filter((c) => c.method !== "GET");
    expect(writes.some((c) => c.method === "POST" && c.path.includes("/secrets"))).toBe(false);
    expect(writes.some((c) => c.path.includes("workers/assets"))).toBe(false);
  });

  it.each(["node", "workers"] as const)("same release rerun preserves root and reuses the arm without new secrets (%s)", async (runtime) => {
    const t = await setupBootstrap(runtime, { ...PROFILE }, { bucketExists: false });
    expect(t.planStatus).toBe(200);
    const r2 = await t.step("main", "r2", "create", "private-data", "create-r2-buckets");
    expect(r2.status).toBe(200);
    const r2Body = await r2.json() as { phaseReceipt: unknown };
    const created = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64"), receipts: [r2Body.phaseReceipt] });
    expect(created.status).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await t.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt, r2Body.phaseReceipt] });
    expect(activated.status).toBe(200);
    // The fresh install is live: root and arm exist, no Owner yet. The same
    // release re-plans as a resume (never a second fresh install): the secret
    // diff is empty and the new version must inherit, not re-create.
    const upgrade = await t.replan();
    expect(upgrade.graphPlan.blocked, JSON.stringify(upgrade)).toBe(false);
    expect(upgrade.graphPlan.units.find((u) => u.unitId === "main")!.diffs.filter((d) => d.resource === "secret")).toEqual([]);
    const ustep = t.makeStep(upgrade);
    const v2 = await ustep("main", "worker", "update", "api", "create-version", { scriptB64: Buffer.from(code).toString("base64") });
    expect(v2.status, await v2.clone().text()).toBe(200);
    const v2Body = await v2.json() as { result: { versionId: string } };
    expect(v2Body.result.versionId).not.toBe(createdBody.result.versionId);
    // The upload inherits both secrets at the exact active version: no new
    // secret value is created, rotated or re-sent.
    const v2Upload = t.world.uploaded[t.world.uploaded.length - 1]!;
    expect(v2Upload.bindings).toEqual(
      expect.arrayContaining([
        { type: "inherit", name: "ROOT_SECRET", version_id: createdBody.result.versionId },
        { type: "inherit", name: "SETUP_ARMED", version_id: createdBody.result.versionId },
      ]),
    );
    expect((v2Upload.bindings as Array<Record<string, unknown>>).filter((b) => b.type === "secret_text")).toHaveLength(0);
    // Readback resolves the inherit bindings to secret names only.
    const v2Live = t.world.workers.get("api")!.versions[0]!;
    expect(v2Live.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "secret_text", name: "ROOT_SECRET" }),
        expect.objectContaining({ type: "secret_text", name: "SETUP_ARMED" }),
      ]),
    );
  });

  it.each(["node", "workers"] as const)("upgrade with an existing Owner never re-arms and binds nothing new (%s)", async (runtime) => {
    const t = await setupBootstrap(runtime, { ...PROFILE }, { bucketExists: false });
    expect(t.planStatus).toBe(200);
    const r2 = await t.step("main", "r2", "create", "private-data", "create-r2-buckets");
    expect(r2.status).toBe(200);
    const r2Body = await r2.json() as { phaseReceipt: unknown };
    const created = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64"), receipts: [r2Body.phaseReceipt] });
    expect(created.status).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await t.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt, r2Body.phaseReceipt] });
    expect(activated.status).toBe(200);
    // The Owner appears out-of-band; the re-plan is an upgrade: never re-arm,
    // never rotate, never re-send a secret value.
    t.world.objects.add("private-data/owner.json");
    const upgrade = await t.replan();
    expect(upgrade.graphPlan.blocked, JSON.stringify(upgrade)).toBe(false);
    const ustep = t.makeStep(upgrade);
    const v2 = await ustep("main", "worker", "update", "api", "create-version", { scriptB64: Buffer.from(code).toString("base64") });
    expect(v2.status, await v2.clone().text()).toBe(200);
    const v2Upload = t.world.uploaded[t.world.uploaded.length - 1]!;
    expect((v2Upload.bindings as Array<Record<string, unknown>>).filter((b) => b.type === "secret_text")).toHaveLength(0);
    expect(v2Upload.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "inherit", name: "ROOT_SECRET" }),
        expect.objectContaining({ type: "inherit", name: "SETUP_ARMED" }),
      ]),
    );
  });

  it.each(["public r2.dev", "custom domain", "denied object read", "marker without owner", "owner without root", "foreign bucket"] as const)("refuses %s with 4xx and zero version writes", async (kind) => {
    const seed: Parameters<typeof setupBootstrap>[2] = kind === "public r2.dev"
      ? { managedEnabled: true }
      : kind === "custom domain"
        ? { customDomains: [{ domain: "files.example.com", enabled: true }] }
        : kind === "denied object read"
          ? { denyObjects: true }
          : kind === "marker without owner"
            ? { marker: true }
            : kind === "owner without root"
              ? { owner: true }
              : { foreignBucket: true };
    const t = await setupBootstrap("node", { ...PROFILE }, seed);
    expect(t.planStatus).toBe(200);
    // The guarded bucket already exists (a preserve diff): the Worker upload
    // runs the bootstrap gate directly and must refuse before any write.
    const created = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64") });
    expect(created.status).toBe(409);
    const body = await created.json() as { error?: string };
    expect(typeof body.error).toBe("string");
    expect(t.world.uploaded).toHaveLength(0);
    expect(t.calls.some((c) => c.method === "PUT" && c.path.includes("/workers/scripts/"))).toBe(false);
  });

  it("defers the version upload until the guarded bucket verifiably exists", async () => {
    const t = await setupBootstrap("node", { ...PROFILE }, { bucketExists: false });
    expect(t.planStatus).toBe(200);
    // No r2 receipt yet: the upload waits instead of bootstrapping nowhere.
    const early = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64") });
    expect(early.status).toBe(409);
    expect((await early.json() as { error?: string }).error).toBe("GRAPH_DEPENDENCY_REQUIRED");
    expect(t.world.uploaded).toHaveLength(0);
    // After the bucket is verifiably created, the same upload proceeds.
    const r2 = await t.step("main", "r2", "create", "private-data", "create-r2-buckets");
    expect(r2.status).toBe(200);
    const r2Body = await r2.json() as { phaseReceipt: unknown };
    const created = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64"), receipts: [r2Body.phaseReceipt] });
    expect(created.status).toBe(200);
  });

  it.each(["node", "workers"] as const)("resume re-arms the missing arm and inherits the existing root (%s)", async (runtime) => {
    const t = await setupBootstrap(runtime, { ...PROFILE }, { bucketExists: false });
    expect(t.planStatus).toBe(200);
    const r2 = await t.step("main", "r2", "create", "private-data", "create-r2-buckets");
    expect(r2.status).toBe(200);
    const r2Body = await r2.json() as { phaseReceipt: unknown };
    const created = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64"), receipts: [r2Body.phaseReceipt] });
    expect(created.status).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await t.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt, r2Body.phaseReceipt] });
    expect(activated.status).toBe(200);
    // An operator removed the arm out-of-band (root stays): the live state is
    // root-without-owner, i.e. a resume that must re-arm in the same upload.
    const worker = t.world.workers.get("api")!;
    worker.versions[0]!.bindings = worker.versions[0]!.bindings.filter((b) => b.name !== "SETUP_ARMED");
    t.world.secretsByWorker.set("api", ["ROOT_SECRET"]);
    const upgrade = await t.replan();
    expect(upgrade.graphPlan.blocked, JSON.stringify(upgrade)).toBe(false);
    const ustep = t.makeStep(upgrade);
    const v2 = await ustep("main", "worker", "update", "api", "create-version", { scriptB64: Buffer.from(code).toString("base64") });
    expect(v2.status, await v2.clone().text()).toBe(200);
    const v2Upload = t.world.uploaded[t.world.uploaded.length - 1]!;
    // The existing root rides the exact active-version inherit binding; the
    // arm is re-set with the fixed profile value in the SAME upload.
    expect(v2Upload.bindings).toEqual(
      expect.arrayContaining([
        { type: "inherit", name: "ROOT_SECRET", version_id: createdBody.result.versionId },
        { type: "secret_text", name: "SETUP_ARMED", text: "yes" },
      ]),
    );
    expect((v2Upload.bindings as Array<Record<string, unknown>>).some((b) => b.name === "ROOT_SECRET" && b.type === "secret_text")).toBe(false);
  });

  it("refuses a concurrent install that appears between inspection and mutation (RACE_DETECTED, zero writes)", async () => {
    const t = await setupBootstrap("node", { ...PROFILE }, { ownerAfterFirstRead: true });
    expect(t.planStatus).toBe(200);
    const created = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64") });
    expect(created.status).toBe(409);
    expect((await created.json() as { error?: string }).error).toBe("RACE_DETECTED");
    expect(t.world.uploaded).toHaveLength(0);
  });

  it("refuses a marker that appears after the plan (RECOVERY_REQUIRED, zero writes)", async () => {
    const t = await setupBootstrap("node", { ...PROFILE }, { bucketExists: false });
    expect(t.planStatus).toBe(200);
    const r2 = await t.step("main", "r2", "create", "private-data", "create-r2-buckets");
    expect(r2.status).toBe(200);
    const r2Body = await r2.json() as { phaseReceipt: unknown };
    const created = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64"), receipts: [r2Body.phaseReceipt] });
    expect(created.status).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await t.step("main", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt, r2Body.phaseReceipt] });
    expect(activated.status).toBe(200);
    const uploadsBefore = t.world.uploaded.length;
    // A parallel install left a setup marker while this deploy was starting.
    t.world.objects.add("private-data/setup-marker.json");
    const upgrade = await t.replan();
    expect(upgrade.graphPlan.blocked, JSON.stringify(upgrade)).toBe(false);
    const ustep = t.makeStep(upgrade);
    const v2 = await ustep("main", "worker", "update", "api", "create-version", { scriptB64: Buffer.from(code).toString("base64") });
    expect(v2.status).toBe(409);
    expect((await v2.json() as { error?: string }).error).toBe("RECOVERY_REQUIRED");
    expect(t.world.uploaded).toHaveLength(uploadsBefore);
  });

  it("refuses a fresh upload when the verified bucket vanishes between steps (zero writes)", async () => {
    const t = await setupBootstrap("node", { ...PROFILE }, { bucketExists: false });
    expect(t.planStatus).toBe(200);
    const r2 = await t.step("main", "r2", "create", "private-data", "create-r2-buckets");
    expect(r2.status).toBe(200);
    const r2Body = await r2.json() as { phaseReceipt: unknown };
    t.world.buckets.delete("private-data");
    const created = await t.step("main", "worker", "create", "api", "create-worker", { scriptB64: Buffer.from(code).toString("base64"), receipts: [r2Body.phaseReceipt] });
    expect(created.status).toBe(409);
    expect((await created.json() as { error?: string }).error).toBe("GRAPH_RECEIPT_STATE_CHANGED");
    expect(t.world.uploaded).toHaveLength(0);
  });

  it("rejects unknown install policies and unresolvable units or bindings at plan time with zero provider reads", async () => {
    const unknownKind = await setupBootstrap("node", { ...(PROFILE as unknown as Record<string, unknown>), kind: "unknown-kind/v9" });
    expect(unknownKind.planStatus).toBe(400);
    expect(unknownKind.calls).toHaveLength(0);
    const badUnit = await setupBootstrap("node", { ...PROFILE, unitId: "ghost" });
    expect(badUnit.planStatus).toBe(400);
    expect(badUnit.calls).toHaveLength(0);
    const badBinding = await setupBootstrap("node", { ...PROFILE, r2Binding: "ELSEWHERE" });
    expect(badBinding.planStatus).toBe(409);
    expect(badBinding.calls).toHaveLength(0);
  });
});
// ---------------------------------------------------------------------------
// queue producer/consumer graph. Producers bind in the Worker version;
// consumers register a provider trigger on the queue's consumers subresource
// after the exact approved version is active. Both are derived server-side from
// the normalized wrangler queues config; the browser addresses them by action
// id and chains receipts. A foreign consumer, a replaced queue identity, a
// forged target or an out-of-order phase refuses before any provider write.
// ---------------------------------------------------------------------------
describe("queue producer/consumer graph (graph API)", () => {
  const queueOnlyCode = "export default { queue() {} };";
  const workerFile = (code: string) => enc.encode(code);

  it.each(["node", "workers"] as const)("binds the producer and registers the consumer trigger only after cutover (%s)", async (runtime) => {
    const f = await graphHonoFixture(
      { ...baseConfig(["workers", "queues"]), units: [{ id: "api", kind: "worker", wrangler: "wrangler.jsonc" }] },
      {
        "wrangler.jsonc": enc.encode(JSON.stringify({
          name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17", workers_dev: false,
          queues: { producers: [{ binding: "JOBS", queue: "jobs" }], consumers: [{ queue: "jobs" }] },
        })),
        "worker/main.mjs": workerFile(queueOnlyCode),
      },
      runtime,
    );
    expect(f.plannedBody.graphPlan.blocked, JSON.stringify(f.plannedBody)).toBe(false);
    const apiUnit = f.plannedBody.graphPlan.units.find((unit) => unit.unitId === "api")!;
    // The queue is declared as a resource; the consumer is its own action. No
    // exposure action exists (workers_dev false, no fabricated URL).
    expect(apiUnit.diffs).toContainEqual(expect.objectContaining({ resource: "queue", action: "create", name: "jobs" }));
    expect(apiUnit.diffs).toContainEqual(expect.objectContaining({ resource: "queue-consumer", action: "create", name: "jobs" }));
    expect(apiUnit.diffs.some((diff) => diff.resource === "workers-dev")).toBe(false);

    // Out of order: the trigger refuses before the queue and the Worker exist.
    const early = await f.step("api", "queue-consumer", "create", "jobs", "register-queue-consumers");
    expect(early.status).toBe(409);
    expect((await early.json() as { error?: string }).error).toBe("GRAPH_DEPENDENCY_REQUIRED");

    const queue = await f.step("api", "queue", "create", "jobs", "create-queues");
    expect(queue.status, await queue.clone().text()).toBe(200);
    const queueBody = await queue.json() as { phaseReceipt: unknown };
    const created = await f.step("api", "worker", "create", "api", "create-worker", { receipts: [queueBody.phaseReceipt] });
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    // The producer binds; the consumer trigger is never an environment binding.
    expect(f.workers.get("api")!.versions[0]!.bindings).toEqual([{ type: "queue", name: "JOBS", queue_name: "jobs" }]);
    const activated = await f.step("api", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [queueBody.phaseReceipt, createdBody.phaseReceipt] });
    expect(activated.status, await activated.clone().text()).toBe(200);
    const activatedBody = await activated.json() as { phaseReceipt: unknown };
    const consumer = await f.step("api", "queue-consumer", "create", "jobs", "register-queue-consumers", { receipts: [queueBody.phaseReceipt, createdBody.phaseReceipt, activatedBody.phaseReceipt] });
    expect(consumer.status, await consumer.clone().text()).toBe(200);
    const consumerBody = await consumer.json() as { phaseReceipt: unknown; result: { consumers: Array<{ consumerId: string; queueName: string; action: string }> } };
    expect(consumerBody.result.consumers).toEqual([expect.objectContaining({ queueName: "jobs", action: "create" })]);
    const liveQueue = f.queues.find((entry) => entry.name === "jobs")!;
    expect(f.queueConsumers.get(liveQueue.id)).toEqual([expect.objectContaining({ consumer_id: consumerBody.result.consumers[0]!.consumerId, script: "api", type: "worker" })]);

    // Second deployment: the queue and the trigger are preserved by identity and
    // no trigger action is emitted. Replaying the exact approved action proves
    // idempotence with zero provider writes.
    const replanned = await f.plan({ mode: "upgrade" });
    const replanBody = await replanned.json() as typeof f.plannedBody;
    expect(replanBody.graphPlan.blocked, JSON.stringify(replanBody)).toBe(false);
    const replanUnit = replanBody.graphPlan.units.find((unit) => unit.unitId === "api")!;
    expect(replanUnit.diffs).toContainEqual(expect.objectContaining({ resource: "queue", action: "preserve", name: "jobs" }));
    expect(replanUnit.diffs).toContainEqual(expect.objectContaining({ resource: "queue-consumer", action: "preserve", name: "jobs" }));
    expect(replanUnit.diffs.some((diff) => diff.resource === "queue-consumer" && diff.action !== "preserve")).toBe(false);
    const writesBefore = f.writes().length;
    const replay = await f.step("api", "queue-consumer", "create", "jobs", "register-queue-consumers", { receipts: [queueBody.phaseReceipt, createdBody.phaseReceipt, activatedBody.phaseReceipt] });
    expect(replay.status, await replay.clone().text()).toBe(200);
    const replayBody = await replay.json() as { result: { consumers: Array<{ action: string; consumerId: string }> } };
    expect(replayBody.result.consumers[0]).toMatchObject({ action: "preserve", consumerId: consumerBody.result.consumers[0]!.consumerId });
    expect(f.writes()).toHaveLength(writesBefore);
    expect(f.queueConsumers.get(liveQueue.id)).toHaveLength(1);
  });

  it.each(["node", "workers"] as const)("registers a settings-carrying consumer for a queue-only Worker and never binds it (%s)", async (runtime) => {
    const f = await graphHonoFixture(
      { ...baseConfig(["workers", "queues"]), units: [{ id: "api", kind: "worker", wrangler: "wrangler.jsonc" }] },
      {
        "wrangler.jsonc": enc.encode(JSON.stringify({
          name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17", workers_dev: false,
          queues: { consumers: [{ queue: "jobs", max_batch_size: 5, max_batch_timeout: 2, retry_delay: 10 }] },
        })),
        "worker/main.mjs": workerFile(queueOnlyCode),
      },
      runtime,
    );
    expect(f.plannedBody.graphPlan.blocked, JSON.stringify(f.plannedBody)).toBe(false);
    const apiUnit = f.plannedBody.graphPlan.units.find((unit) => unit.unitId === "api")!;
    expect(apiUnit.diffs).toContainEqual(expect.objectContaining({ resource: "queue", action: "create", name: "jobs" }));
    expect(apiUnit.diffs).toContainEqual(expect.objectContaining({ resource: "queue-consumer", action: "create", name: "jobs" }));
    const queue = await f.step("api", "queue", "create", "jobs", "create-queues");
    const queueBody = await queue.json() as { phaseReceipt: unknown };
    const created = await f.step("api", "worker", "create", "api", "create-worker", { receipts: [queueBody.phaseReceipt] });
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    // A consumer-only queue carries no producer binding: the version metadata
    // must not contain a queue binding for it.
    expect(f.workers.get("api")!.versions[0]!.bindings ?? []).toEqual([]);
    const activated = await f.step("api", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [queueBody.phaseReceipt, createdBody.phaseReceipt] });
    const activatedBody = await activated.json() as { phaseReceipt: unknown };
    const consumer = await f.step("api", "queue-consumer", "create", "jobs", "register-queue-consumers", { receipts: [queueBody.phaseReceipt, createdBody.phaseReceipt, activatedBody.phaseReceipt] });
    expect(consumer.status, await consumer.clone().text()).toBe(200);
    const liveQueue = f.queues.find((entry) => entry.name === "jobs")!;
    expect(f.queueConsumers.get(liveQueue.id)).toEqual([
      expect.objectContaining({ script: "api", settings: { batch_size: 5, max_wait_time_ms: 2000, retry_delay: 10 } }),
    ]);
  });

  it("updates our own consumer settings in place under an approved diff", async () => {
    const wrangler = (maxBatchSize: number) => JSON.stringify({
      name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17", workers_dev: false,
      queues: { consumers: [{ queue: "jobs", max_batch_size: maxBatchSize, retry_delay: 10 }] },
    });
    const f = await graphHonoFixture(
      { ...baseConfig(["workers", "queues"]), units: [{ id: "api", kind: "worker", wrangler: "wrangler.jsonc" }] },
      { "wrangler.jsonc": enc.encode(wrangler(5)), "worker/main.mjs": workerFile(queueOnlyCode) },
    );
    const queue = await f.step("api", "queue", "create", "jobs", "create-queues");
    const queueBody = await queue.json() as { phaseReceipt: unknown };
    const created = await f.step("api", "worker", "create", "api", "create-worker", { receipts: [queueBody.phaseReceipt] });
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await f.step("api", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [queueBody.phaseReceipt, createdBody.phaseReceipt] });
    const activatedBody = await activated.json() as { phaseReceipt: unknown };
    const first = await f.step("api", "queue-consumer", "create", "jobs", "register-queue-consumers", { receipts: [queueBody.phaseReceipt, createdBody.phaseReceipt, activatedBody.phaseReceipt] });
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBody = await first.json() as { result: { consumers: Array<{ consumerId: string }> } };
    const consumerId = firstBody.result.consumers[0]!.consumerId;
    const liveQueue = f.queues.find((entry) => entry.name === "jobs")!;
    // The live consumer drifts from the declaration (out-of-band settings).
    f.queueConsumers.get(liveQueue.id)![0]!.settings = { batch_size: 99, retry_delay: 10 };
    // Re-declare the same settings: the fresh plan approves an in-place update
    // of our own consumer, never a second competing trigger.
    const planned = await f.plan({ mode: "upgrade" });
    const replanBody = await planned.json() as typeof f.plannedBody;
    expect(replanBody.graphPlan.blocked, JSON.stringify(replanBody)).toBe(false);
    expect(replanBody.graphPlan.units.find((unit) => unit.unitId === "api")!.diffs).toContainEqual(
      expect.objectContaining({ resource: "queue-consumer", action: "update", name: "jobs" }),
    );
    const stepUnderReplan = f.makeStep(replanBody);
    const version = await stepUnderReplan("api", "worker", "update", "api", "create-version");
    expect(version.status, await version.clone().text()).toBe(200);
    const versionBody = await version.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activateAgain = await stepUnderReplan("api", "deployment", "create", "api", "activate", { versionId: versionBody.result.versionId, receipts: [versionBody.phaseReceipt] });
    expect(activateAgain.status, await activateAgain.clone().text()).toBe(200);
    const activateBody = await activateAgain.json() as { phaseReceipt: unknown };
    const update = await stepUnderReplan("api", "queue-consumer", "update", "jobs", "register-queue-consumers", { receipts: [versionBody.phaseReceipt, activateBody.phaseReceipt] });
    expect(update.status, await update.clone().text()).toBe(200);
    // Exactly one consumer identity throughout; the update rewrites it in place.
    expect(f.queueConsumers.get(liveQueue.id)).toHaveLength(1);
    expect(f.queueConsumers.get(liveQueue.id)![0]!.consumer_id).toBe(consumerId);
    expect(f.queueConsumers.get(liveQueue.id)![0]!.settings).toEqual({ batch_size: 5, retry_delay: 10 });
    const queueWrites = f.writes().filter((call) => call.path.endsWith(`/consumers/${consumerId}`));
    expect(queueWrites).toHaveLength(1);
    expect(queueWrites[0]!.method).toBe("PUT");
  });

  it.each(["node", "workers"] as const)("refuses to overwrite or compete with a foreign consumer (%s)", async (runtime) => {
    const f = await graphHonoFixture(
      { ...baseConfig(["workers", "queues"]), units: [{ id: "api", kind: "worker", wrangler: "wrangler.jsonc" }] },
      {
        "wrangler.jsonc": enc.encode(JSON.stringify({
          name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17",
          queues: { consumers: [{ queue: "jobs" }] },
        })),
        "worker/main.mjs": workerFile(queueOnlyCode),
      },
      runtime,
      { queues: [{ name: "jobs", consumers: [{ script: "someone-else" }] }] },
    );
    expect(f.plannedBody.graphPlan.blocked).toBe(true);
    expect(f.plannedBody.graphPlan.guards).toContainEqual(
      expect.objectContaining({ code: "unit-blocked", level: "block", detail: expect.stringContaining("queue-drift") }),
    );
    // The blocked unit explains its conflict; it is not repeated as an
    // unsupported or destructive operation.
    expect(f.plannedBody.graphPlan.guards.map((guard) => guard.code)).not.toContain("unsupported-operation");
    expect(f.plannedBody.graphPlan.guards.map((guard) => guard.code)).not.toContain("destructive-operation");
    const apiUnit = f.plannedBody.graphPlan.units.find((unit) => unit.unitId === "api")!;
    expect(apiUnit.diffs).toContainEqual(expect.objectContaining({ resource: "queue-consumer", action: "conflict", name: "jobs" }));
    // A blocked plan carries no execution context or approval: the step refuses
    // and the foreign consumer is untouched.
    expect(f.plannedBody.approval).toBeUndefined();
    expect(f.plannedBody.executionContext).toBeUndefined();
    const attempt = await f.step("api", "queue-consumer", "create", "jobs", "register-queue-consumers");
    expect(attempt.status).toBeGreaterThanOrEqual(400);
    expect(f.writes()).toEqual([]);
    expect(f.queueConsumers.get(f.queues[0]!.id)).toEqual([expect.objectContaining({ script: "someone-else" })]);
  });

  it("invalidates outstanding receipts when the queue identity changes", async () => {
    const f = await graphHonoFixture(
      { ...baseConfig(["workers", "queues"]), units: [{ id: "api", kind: "worker", wrangler: "wrangler.jsonc" }] },
      {
        "wrangler.jsonc": enc.encode(JSON.stringify({
          name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17",
          queues: { consumers: [{ queue: "jobs" }] },
        })),
        "worker/main.mjs": workerFile(queueOnlyCode),
      },
    );
    const queue = await f.step("api", "queue", "create", "jobs", "create-queues");
    const queueBody = await queue.json() as { phaseReceipt: unknown };
    const created = await f.step("api", "worker", "create", "api", "create-worker", { receipts: [queueBody.phaseReceipt] });
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await f.step("api", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [queueBody.phaseReceipt, createdBody.phaseReceipt] });
    const activatedBody = await activated.json() as { phaseReceipt: unknown };
    // Out-of-band replacement: same name, different provider identity.
    const oldQueue = f.queues.find((entry) => entry.name === "jobs")!;
    f.queues.splice(f.queues.indexOf(oldQueue), 1);
    f.queueConsumers.delete(oldQueue.id);
    const rotated = { id: `${oldQueue.id}-rotated`, name: "jobs" };
    f.queues.push(rotated);
    f.queueConsumers.set(rotated.id, []);
    const writesBefore = f.writes().length;
    const replay = await f.step("api", "queue-consumer", "create", "jobs", "register-queue-consumers", { receipts: [queueBody.phaseReceipt, createdBody.phaseReceipt, activatedBody.phaseReceipt] });
    expect(replay.status).toBe(409);
    expect((await replay.json() as { error?: string }).error).toBe("GRAPH_RECEIPT_STATE_CHANGED");
    expect(f.writes()).toHaveLength(writesBefore);
    expect(f.queueConsumers.get(rotated.id)).toEqual([]);
  });

  it("rejects a forged account, a forged target and a forged phase before any write", async () => {
    const f = await graphHonoFixture(
      { ...baseConfig(["workers", "queues"]), units: [{ id: "api", kind: "worker", wrangler: "wrangler.jsonc" }] },
      {
        "wrangler.jsonc": enc.encode(JSON.stringify({
          name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17",
          queues: { consumers: [{ queue: "jobs" }] },
        })),
        "worker/main.mjs": workerFile(queueOnlyCode),
      },
    );
    const queue = await f.step("api", "queue", "create", "jobs", "create-queues");
    const queueBody = await queue.json() as { phaseReceipt: unknown };
    const created = await f.step("api", "worker", "create", "api", "create-worker", { receipts: [queueBody.phaseReceipt] });
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await f.step("api", "deployment", "create", "api", "activate", { versionId: createdBody.result.versionId, receipts: [queueBody.phaseReceipt, createdBody.phaseReceipt] });
    const activatedBody = await activated.json() as { phaseReceipt: unknown };
    const receipts = [queueBody.phaseReceipt, createdBody.phaseReceipt, activatedBody.phaseReceipt];
    const consumerWrites = () => f.writes().filter((call) => call.path.includes("/consumers"));
    expect(consumerWrites()).toEqual([]);
    const forgedAccount = await f.step("api", "queue-consumer", "create", "jobs", "register-queue-consumers", { receipts }, { accountId: "b".repeat(32) });
    expect(forgedAccount.status).toBe(409);
    expect((await forgedAccount.json() as { error?: string }).error).toBe("GRAPH_CONTEXT_MISMATCH");
    const forgedQueue = await f.step("api", "queue-consumer", "create", "another-queue", "register-queue-consumers", { receipts });
    expect(forgedQueue.status).toBe(409);
    expect((await forgedQueue.json() as { error?: string }).error).toBe("GRAPH_ACTION_MISMATCH");
    const forgedPhase = await f.step("api", "queue-consumer", "create", "jobs", "activate", { receipts });
    expect(forgedPhase.status).toBe(409);
    expect((await forgedPhase.json() as { error?: string }).error).toBe("GRAPH_PHASE_MISMATCH");
    expect(consumerWrites()).toEqual([]);
    // The exact approved action still succeeds afterwards: refusals have no side effects.
    const legitimate = await f.step("api", "queue-consumer", "create", "jobs", "register-queue-consumers", { receipts });
    expect(legitimate.status, await legitimate.clone().text()).toBe(200);
  });
});
// ---------------------------------------------------------------------------
// Workflow carrier + direct schedules graph. The declared WorkflowEntrypoint
// class must be exported by the prebuilt entry module (verified at prepare); the
// exact binding rides the approved version metadata; the definition and its
// direct schedule set are applied through the documented Workflows API only
// after that version is active, and every write is read back exactly. No fetch
// handler is required, no workers.dev URL is fabricated, a foreign definition
// or a duplicate account-unique name blocks before any provider write, and a
// schedule drift invalidates outstanding receipts and demands a new approval.
// ---------------------------------------------------------------------------
describe("workflow carrier graph (graph API)", () => {
  const wfCode = workflowCode;
  const wfWrangler = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    name: "wf-carrier", main: "worker/main.mjs", compatibility_date: "2026-10-17", workers_dev: false,
    workflows: [{ binding: "WF", name: "wf", class_name: "WF", schedules: ["*/5 * * * *", "0 0 * * *"] }],
    r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }],
    ...overrides,
  });
  const wfConfig = (capabilities: ConfigV3["capabilities"] = ["workers", "workflows", "r2"]): ConfigV3 => ({
    ...baseConfig(capabilities),
    units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }],
  });

  it.each(["node", "workers"] as const)("creates the exact carrier binding, applies the Workflow after cutover and preserves on replay (%s)", async (runtime) => {
    const f = await graphHonoFixture(wfConfig(), { "wrangler.jsonc": enc.encode(wfWrangler()), "worker/main.mjs": enc.encode(wfCode) }, runtime);
    expect(f.plannedBody.graphPlan.blocked, JSON.stringify(f.plannedBody)).toBe(false);
    const unit = f.plannedBody.graphPlan.units.find((entry) => entry.unitId === "main")!;
    expect(unit.diffs).toContainEqual(expect.objectContaining({ resource: "workflow", action: "create", name: "wf" }));
    // No HTTP fetch root is required and no workers.dev exposure is fabricated.
    expect(unit.diffs.some((diff) => diff.resource === "workers-dev")).toBe(false);
    // Out of order: the definition refuses before the carrier version is live.
    const early = await f.step("main", "workflow", "create", "wf", "apply-workflows");
    expect(early.status).toBe(409);
    expect((await early.json() as { error?: string }).error).toBe("GRAPH_DEPENDENCY_REQUIRED");
    expect(f.writes()).toEqual([]);
    const bucket = await f.step("main", "r2", "create", "media", "create-r2-buckets");
    expect(bucket.status, await bucket.clone().text()).toBe(200);
    const bucketReceipt = (await bucket.json() as { phaseReceipt: unknown }).phaseReceipt;
    const created = await f.step("main", "worker", "create", "wf-carrier", "create-worker", { receipts: [bucketReceipt] });
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    // The exact approved version metadata carries the workflow binding; the
    // definition and its schedules never ride the metadata.
    expect(f.workers.get("wf-carrier")!.versions[0]!.bindings).toContainEqual({ type: "workflow", name: "WF", workflow_name: "wf", class_name: "WF" });
    const activated = await f.step("main", "deployment", "create", "wf-carrier", "activate", { versionId: createdBody.result.versionId, receipts: [bucketReceipt, createdBody.phaseReceipt] });
    expect(activated.status, await activated.clone().text()).toBe(200);
    const activatedBody = await activated.json() as { phaseReceipt: unknown };
    const applied = await f.step("main", "workflow", "create", "wf", "apply-workflows", { receipts: [bucketReceipt, createdBody.phaseReceipt, activatedBody.phaseReceipt] });
    expect(applied.status, await applied.clone().text()).toBe(200);
    const appliedBody = await applied.json() as { result: { workflows: Array<Record<string, unknown>> } };
    expect(appliedBody.result.workflows).toEqual([
      expect.objectContaining({ binding: "WF", name: "wf", className: "WF", scriptName: "wf-carrier", schedules: ["*/5 * * * *", "0 0 * * *"], action: "create" }),
    ]);
    const live = f.workflows.find((entry) => entry.name === "wf")!;
    expect(live).toMatchObject({ className: "WF", scriptName: "wf-carrier", schedules: ["*/5 * * * *", "0 0 * * *"] });
    // Exact provider ledger: one PUT (the definition) plus one GET (the only
    // proof of the schedule set); no hidden exposure call.
    expect(f.trace.filter((call) => call.path.endsWith("/workflows/wf"))).toEqual([
      { method: "PUT", path: `/client/v4/accounts/${f.accountId}/workflows/wf` },
      { method: "GET", path: `/client/v4/accounts/${f.accountId}/workflows/wf` },
    ]);
    expect(f.trace.some((call) => call.path.includes("workers_dev") || call.path.endsWith("/subdomain"))).toBe(false);
    // Replan: the definition is preserved by identity and replaying the exact
    // approved action performs zero provider writes.
    const replanned = await f.plan({ mode: "upgrade" });
    const replanBody = await replanned.json() as typeof f.plannedBody;
    expect(replanBody.graphPlan.blocked, JSON.stringify(replanBody)).toBe(false);
    expect(replanBody.graphPlan.units.find((entry) => entry.unitId === "main")!.diffs).toContainEqual(expect.objectContaining({ resource: "workflow", action: "preserve", name: "wf" }));
    const writesBefore = f.writes().length;
    const replay = await f.step("main", "workflow", "create", "wf", "apply-workflows", { receipts: [bucketReceipt, createdBody.phaseReceipt, activatedBody.phaseReceipt] });
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect((await replay.json() as { result: { workflows: Array<{ action: string }> } }).result.workflows[0]).toMatchObject({ action: "preserve" });
    expect(f.writes()).toHaveLength(writesBefore);
    expect(f.workflows.filter((entry) => entry.name === "wf")).toHaveLength(1);
  });

  it("blocks a foreign Workflow definition and a duplicate account-unique name before any provider write", async () => {
    // Same script name but a foreign class, and the same class under a foreign
    // script: both are foreign ownership and both must block.
    const foreign = await graphHonoFixture(wfConfig(), { "wrangler.jsonc": enc.encode(wfWrangler()), "worker/main.mjs": enc.encode(wfCode) }, "node", {
      workflows: [{ name: "wf", className: "Other", scriptName: "someone-else", schedules: ["*/5 * * * *"] }],
    });
    expect(foreign.plannedBody.graphPlan.blocked).toBe(true);
    expect(foreign.plannedBody.graphPlan.guards).toContainEqual(
      expect.objectContaining({ code: "unit-blocked", level: "block", detail: expect.stringContaining("workflow-drift") }),
    );
    // The blocked unit explains its conflict; it is not repeated as an
    // unsupported or destructive operation.
    expect(foreign.plannedBody.graphPlan.guards.map((guard) => guard.code)).not.toContain("unsupported-operation");
    expect(foreign.plannedBody.graphPlan.guards.map((guard) => guard.code)).not.toContain("destructive-operation");
    expect(foreign.plannedBody.graphPlan.units.find((entry) => entry.unitId === "main")!.diffs).toContainEqual(
      expect.objectContaining({ resource: "workflow", action: "conflict", name: "wf" }),
    );
    // A blocked plan carries no execution context or approval: the step refuses
    // and the foreign definition is untouched.
    expect(foreign.plannedBody.approval).toBeUndefined();
    expect(foreign.plannedBody.executionContext).toBeUndefined();
    const attempt = await foreign.step("main", "workflow", "create", "wf", "apply-workflows");
    expect(attempt.status).toBeGreaterThanOrEqual(400);
    expect(foreign.writes()).toEqual([]);
    expect(foreign.workflows[0]).toMatchObject({ className: "Other", scriptName: "someone-else" });

    // Workflow names are account-unique: two carriers declaring one name block.
    const duplicate = await graphHonoFixture(
      { ...baseConfig(["workers", "workflows"]), units: [{ id: "a", kind: "worker", wrangler: "a/wrangler.jsonc" }, { id: "b", kind: "worker", wrangler: "b/wrangler.jsonc" }] },
      {
        "a/wrangler.jsonc": enc.encode(JSON.stringify({ name: "worker-a", main: "main.mjs", compatibility_date: "2026-10-17", workflows: [{ binding: "WF", name: "shared-wf", class_name: "WF" }] })),
        "a/main.mjs": enc.encode(wfCode),
        "b/wrangler.jsonc": enc.encode(JSON.stringify({ name: "worker-b", main: "main.mjs", compatibility_date: "2026-10-17", workflows: [{ binding: "WF2", name: "shared-wf", class_name: "WF" }] })),
        "b/main.mjs": enc.encode(wfCode),
      },
    );
    expect(duplicate.plannedBody.graphPlan.blocked).toBe(true);
    // Workflow names are account-unique: the structural graph guard names the
    // account-unique collision and no unit may be written.
    expect(duplicate.plannedBody.graphPlan.graphGuards).toContainEqual(
      expect.objectContaining({ code: "duplicate-workflow", message: expect.stringContaining("shared-wf") }),
    );
    expect(duplicate.plannedBody.graphPlan.guards).toContainEqual(expect.objectContaining({ code: "graph-blocked", level: "block" }));
    expect(duplicate.plannedBody.approval).toBeUndefined();
    expect(duplicate.writes()).toEqual([]);
  });

  it("invalidates an outstanding receipt on out-of-band schedule drift and requires a new approved update", async () => {
    const f = await graphHonoFixture(wfConfig(), {
      "wrangler.jsonc": enc.encode(wfWrangler({ workflows: [{ binding: "WF", name: "wf", class_name: "WF", schedules: ["*/5 * * * *"] }] })),
      "worker/main.mjs": enc.encode(wfCode),
    });
    const bucket = await f.step("main", "r2", "create", "media", "create-r2-buckets");
    const bucketReceipt = (await bucket.json() as { phaseReceipt: unknown }).phaseReceipt;
    const created = await f.step("main", "worker", "create", "wf-carrier", "create-worker", { receipts: [bucketReceipt] });
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await f.step("main", "deployment", "create", "wf-carrier", "activate", { versionId: createdBody.result.versionId, receipts: [bucketReceipt, createdBody.phaseReceipt] });
    const activatedBody = await activated.json() as { phaseReceipt: unknown };
    const receipts = [bucketReceipt, createdBody.phaseReceipt, activatedBody.phaseReceipt];
    const applied = await f.step("main", "workflow", "create", "wf", "apply-workflows", { receipts });
    expect(applied.status, await applied.clone().text()).toBe(200);
    const appliedBody = await applied.json() as { phaseReceipt: unknown };
    expect(f.workflows[0]!.schedules).toEqual(["*/5 * * * *"]);
    // Out-of-band drift: the direct schedule set changes outside TapDeploy.
    f.workflows[0]!.schedules = ["0 1 * * *"];
    const writesBefore = f.writes().length;
    // The old approved action can no longer be verified: its receipt sealed the
    // old schedule set, so the replay is refused rather than re-writing state.
    const replay = await f.step("main", "workflow", "create", "wf", "apply-workflows", { phaseReceipt: appliedBody.phaseReceipt, receipts });
    expect(replay.status).toBe(409);
    expect((await replay.json() as { error?: string }).error).toBe("GRAPH_RECEIPT_STATE_CHANGED");
    expect(f.writes()).toHaveLength(writesBefore);
    expect(f.workflows[0]!.schedules).toEqual(["0 1 * * *"]);
    // The fresh plan treats the drift as an explicit update under a new approval.
    const replanned = await f.plan({ mode: "upgrade" });
    const replanBody = await replanned.json() as typeof f.plannedBody;
    expect(replanBody.graphPlan.blocked, JSON.stringify(replanBody)).toBe(false);
    const replanUnit = replanBody.graphPlan.units.find((entry) => entry.unitId === "main")!;
    expect(replanUnit.diffs).toContainEqual(expect.objectContaining({ resource: "workflow", action: "update", name: "wf" }));
    const stepUnderReplan = f.makeStep(replanBody);
    const version = await stepUnderReplan("main", "worker", "update", "wf-carrier", "create-version");
    expect(version.status, await version.clone().text()).toBe(200);
    const versionBody = await version.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activateAgain = await stepUnderReplan("main", "deployment", "create", "wf-carrier", "activate", { versionId: versionBody.result.versionId, receipts: [versionBody.phaseReceipt] });
    expect(activateAgain.status, await activateAgain.clone().text()).toBe(200);
    const activateBody = await activateAgain.json() as { phaseReceipt: unknown };
    const update = await stepUnderReplan("main", "workflow", "update", "wf", "apply-workflows", { receipts: [versionBody.phaseReceipt, activateBody.phaseReceipt] });
    expect(update.status, await update.clone().text()).toBe(200);
    expect(f.workflows[0]!.schedules).toEqual(["*/5 * * * *"]);
    expect(f.writes().filter((call) => call.method === "PUT" && call.path.endsWith("/workflows/wf"))).toHaveLength(2);
  });

  it("orders a carrier Workflow behind a dependency resource unit's receipts", async () => {
    const f = await graphHonoFixture(
      { ...baseConfig(["workers", "workflows", "r2"]), units: [{ id: "api", kind: "worker", wrangler: "wrangler.jsonc" }], resources: [{ kind: "r2", name: "assets-media" }] },
      {
        "wrangler.jsonc": enc.encode(wfWrangler({ r2_buckets: [{ binding: "MEDIA", bucket_name: "assets-media" }] })),
        "worker/main.mjs": enc.encode(wfCode),
      },
    );
    expect(f.plannedBody.graphPlan.blocked, JSON.stringify(f.plannedBody)).toBe(false);
    // Out of order: both the carrier upload and the definition must wait for the
    // dependency unit's receipts.
    expect((await f.step("api", "workflow", "create", "wf", "apply-workflows")).status).toBe(409);
    expect((await f.step("api", "worker", "create", "wf-carrier", "create-worker")).status).toBe(409);
    expect(f.writes()).toEqual([]);
    const bucket = await f.step("resources", "r2", "create", "assets-media", "create-r2-buckets");
    expect(bucket.status, await bucket.clone().text()).toBe(200);
    const bucketReceipt = (await bucket.json() as { phaseReceipt: unknown }).phaseReceipt;
    const created = await f.step("api", "worker", "create", "wf-carrier", "create-worker", { receipts: [bucketReceipt] });
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await f.step("api", "deployment", "create", "wf-carrier", "activate", { versionId: createdBody.result.versionId, receipts: [bucketReceipt, createdBody.phaseReceipt] });
    expect(activated.status, await activated.clone().text()).toBe(200);
    const activatedBody = await activated.json() as { phaseReceipt: unknown };
    const applied = await f.step("api", "workflow", "create", "wf", "apply-workflows", { receipts: [bucketReceipt, createdBody.phaseReceipt, activatedBody.phaseReceipt] });
    expect(applied.status, await applied.clone().text()).toBe(200);
    // The dependency's provider write precedes the Workflow write.
    const r2Index = f.writes().findIndex((call) => call.path.endsWith("/r2/buckets"));
    const workflowIndex = f.writes().findIndex((call) => call.path.endsWith("/workflows/wf"));
    expect(r2Index).toBeGreaterThanOrEqual(0);
    expect(workflowIndex).toBeGreaterThan(r2Index);
  });

  it("rejects a forged account, a forged target and a forged phase for a Workflow action before any write", async () => {
    const f = await graphHonoFixture(wfConfig(), { "wrangler.jsonc": enc.encode(wfWrangler()), "worker/main.mjs": enc.encode(wfCode) });
    const bucket = await f.step("main", "r2", "create", "media", "create-r2-buckets");
    const bucketReceipt = (await bucket.json() as { phaseReceipt: unknown }).phaseReceipt;
    const created = await f.step("main", "worker", "create", "wf-carrier", "create-worker", { receipts: [bucketReceipt] });
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await f.step("main", "deployment", "create", "wf-carrier", "activate", { versionId: createdBody.result.versionId, receipts: [bucketReceipt, createdBody.phaseReceipt] });
    const activatedBody = await activated.json() as { phaseReceipt: unknown };
    const receipts = [bucketReceipt, createdBody.phaseReceipt, activatedBody.phaseReceipt];
    const workflowWrites = () => f.writes().filter((call) => call.path.includes("/workflows"));
    expect(workflowWrites()).toEqual([]);
    const forgedAccount = await f.step("main", "workflow", "create", "wf", "apply-workflows", { receipts }, { accountId: "b".repeat(32) });
    expect(forgedAccount.status).toBe(409);
    expect((await forgedAccount.json() as { error?: string }).error).toBe("GRAPH_CONTEXT_MISMATCH");
    const forgedTarget = await f.step("main", "workflow", "create", "other-wf", "apply-workflows", { receipts });
    expect(forgedTarget.status).toBe(409);
    expect((await forgedTarget.json() as { error?: string }).error).toBe("GRAPH_ACTION_MISMATCH");
    const forgedPhase = await f.step("main", "workflow", "create", "wf", "activate", { receipts });
    expect(forgedPhase.status).toBe(409);
    expect((await forgedPhase.json() as { error?: string }).error).toBe("GRAPH_PHASE_MISMATCH");
    expect(workflowWrites()).toEqual([]);
    // The exact approved action still succeeds afterwards: refusals have no side effects.
    const legitimate = await f.step("main", "workflow", "create", "wf", "apply-workflows", { receipts });
    expect(legitimate.status, await legitimate.clone().text()).toBe(200);
  });

  it("refuses a Workflow whose class export is missing or unverifiable at prepare", async () => {
    const config: ConfigV3 = { ...baseConfig(["workers", "workflows"]), units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }] };
    const wrangler = JSON.stringify({ name: "wf-carrier", main: "worker/main.mjs", compatibility_date: "2026-10-17", workflows: [{ binding: "WF", name: "wf", class_name: "WF" }] });
    const missing = await graphHonoFixture(config, { "wrangler.jsonc": enc.encode(wrangler), "worker/main.mjs": enc.encode("export class Other { async run() {} }") }, "node", {}, { allowPrepareFailure: true });
    const refused = await missing.prepare();
    expect(refused.status).toBe(400);
    const refusedBody = await refused.json() as { error?: string; detail?: string };
    expect(refusedBody.error).toBe("INVALID_PER_UNIT_RELEASE");
    expect(refusedBody.detail).toContain("WORKFLOW_CLASS_MISSING");
    expect(missing.trace).toEqual([]);
    // A wholesale re-export the scanner cannot resolve fails closed instead of
    // being accepted optimistically.
    const unverifiable = await graphHonoFixture(config, { "wrangler.jsonc": enc.encode(wrangler), "worker/main.mjs": enc.encode('export * from "./impl.mjs";') }, "node", {}, { allowPrepareFailure: true });
    const refusedUnverifiable = await unverifiable.prepare();
    expect(refusedUnverifiable.status).toBe(400);
    expect((await refusedUnverifiable.json() as { detail?: string }).detail).toContain("WORKFLOW_EXPORTS_UNVERIFIABLE");
    expect(unverifiable.trace).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Durable Object declaration safety. Only the strictly-bound subset plans:
// own script, exported class (prepare-time gate), pure new-class migrations
// with exact binding cover and unique tags. The binding and the validated
// migrations ride the atomic version upload verbatim (no separate account API
// exists for them); the step claims only the created version, never an applied
// migration. Renames/deletes/transfers, foreign scripts, environments, empty
// entries, duplicate tags, uncovered classes and unbound migrations all fail
// closed before any provider write.
// ---------------------------------------------------------------------------
describe("durable object declaration safety (graph API)", () => {
  // The extra classes exist so plan-time vetoes (not the prepare gate) decide
  // the unbound/unmigrated cases: prepare must pass for the plan refusal to
  // be the assertion under test.
  const doCode = "import { DurableObject } from \"cloudflare:workers\";\nexport class Counter extends DurableObject {}\nexport class Other {}\nexport class Orphan {}\nexport class Gone {}\n";
  const doWrangler = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    name: "do-carrier", main: "worker/main.mjs", compatibility_date: "2026-10-17", workers_dev: false,
    durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
    migrations: [{ tag: "v1", new_classes: ["Counter"] }],
    ...overrides,
  });
  const doConfig = (): ConfigV3 => ({
    ...baseConfig(["workers", "durable-objects"]),
    units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }],
  });

  it.each(["node", "workers"] as const)("binds the class and forwards the pure migration with the atomic version upload (%s)", async (runtime) => {
    const f = await graphHonoFixture(doConfig(), { "wrangler.jsonc": enc.encode(doWrangler()), "worker/main.mjs": enc.encode(doCode) }, runtime);
    expect(f.plannedBody.graphPlan.blocked, JSON.stringify(f.plannedBody)).toBe(false);
    // The declaration is metadata-only: no plan diff, no account API call, no
    // synthetic namespace — the worker version carries everything.
    expect(f.plannedBody.graphPlan.units.find((entry) => entry.unitId === "main")!.diffs.map((diff) => diff.resource).sort()).toEqual(["deployment", "worker"]);
    const created = await f.step("main", "worker", "create", "do-carrier", "create-worker");
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const version = f.workers.get("do-carrier")!.versions[0]!;
    expect(version.bindings).toContainEqual({ type: "durable_object_namespace", name: "COUNTER", class_name: "Counter" });
    expect(version.migrations).toEqual({ new_tag: "v1", new_classes: ["Counter"] });
    // No Durable Object account operation exists in the trace: the upload is
    // the only provider write and it carries the exact declaration.
    expect(f.trace.every((call) => !call.path.includes("durable"))).toBe(true);
    const activated = await f.step("main", "deployment", "create", "do-carrier", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt] });
    expect(activated.status, await activated.clone().text()).toBe(200);
    // A replan re-uploads the identical static declaration (provider treats
    // the re-applied tag as a no-op); the metadata stays exact.
    const replanned = await f.plan({ mode: "upgrade" });
    const replanBody = await replanned.json() as typeof f.plannedBody;
    expect(replanBody.graphPlan.blocked, JSON.stringify(replanBody)).toBe(false);
    const stepUnderReplan = f.makeStep(replanBody);
    const versionAgain = await stepUnderReplan("main", "worker", "update", "do-carrier", "create-version");
    expect(versionAgain.status, await versionAgain.clone().text()).toBe(200);
    const latest = f.workers.get("do-carrier")!.versions[0]!;
    expect(latest.bindings).toContainEqual({ type: "durable_object_namespace", name: "COUNTER", class_name: "Counter" });
    expect(latest.migrations).toEqual({ new_tag: "v1", new_classes: ["Counter"] });
  });

  it.each([
    ["renamed class", { migrations: [{ tag: "v1", new_classes: ["Counter"], renamed_classes: [{ from: "Old", to: "Counter" }] }] }, "DO_MIGRATION_DESTRUCTIVE"],
    ["deleted class", { migrations: [{ tag: "v1", new_classes: ["Counter"], deleted_classes: ["Gone"] }] }, "DO_MIGRATION_DESTRUCTIVE"],
    ["foreign script", { durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter", script_name: "someone-else" }] } }, "UNSUPPORTED_EXTERNAL_DO"],
    ["environment", { durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter", environment: "preview" }] } }, "UNSUPPORTED_DO_ENVIRONMENT"],
    ["tag-only entry", { migrations: [{ tag: "v1" }] }, "DO_MIGRATION_EMPTY"],
    ["duplicate tag", { migrations: [{ tag: "v1", new_classes: ["Counter"] }, { tag: "v1", new_classes: ["Counter"] }] }, "DO_MIGRATION_TAG_CONFLICT"],
    ["bound class without migration", { migrations: [{ tag: "v1", new_classes: ["Other"] }] }, "DO_CLASS_UNMIGRATED"],
    ["migrated class without binding", { migrations: [{ tag: "v1", new_classes: ["Counter", "Orphan"] }] }, "DO_CLASS_UNBOUND"],
  ])("vetoes %s at plan time with zero provider reads or writes", async (_label, overrides, code) => {
    const f = await graphHonoFixture(doConfig(), { "wrangler.jsonc": enc.encode(doWrangler(overrides)), "worker/main.mjs": enc.encode(doCode) });
    expect(f.planned.status).toBe(409);
    const body = f.plannedBody as unknown as { error?: string; detail?: string };
    expect(body.error).toBe("INVALID_RELEASE_PROOF");
    expect(body.detail).toContain(code);
    expect(f.trace).toEqual([]);
  });

  it("refuses a missing class export, a Pages carrier and transferred classes at prepare", async () => {
    const config: ConfigV3 = { ...baseConfig(["workers", "durable-objects"]), units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }] };
    const wrangler = doWrangler();
    const missing = await graphHonoFixture(config, { "wrangler.jsonc": enc.encode(wrangler), "worker/main.mjs": enc.encode("export class Other {}") }, "node", {}, { allowPrepareFailure: true });
    const refused = await missing.prepare();
    expect(refused.status).toBe(400);
    const refusedBody = await refused.json() as { error?: string; detail?: string };
    expect(refusedBody.error).toBe("INVALID_PER_UNIT_RELEASE");
    expect(refusedBody.detail).toContain("DO_CLASS_MISSING");
    expect(missing.trace).toEqual([]);
    // A transfer between scripts can never be verified locally: the parser
    // refuses it before the release exists.
    const transferred = await graphHonoFixture(config, {
      "wrangler.jsonc": enc.encode(doWrangler({ migrations: [{ tag: "v1", new_classes: ["Counter"], transferred_classes: [{ from: "old-script", to: "Counter" }] }] })),
      "worker/main.mjs": enc.encode(doCode),
    }, "node", {}, { allowPrepareFailure: true });
    const refusedTransfer = await transferred.prepare();
    expect(refusedTransfer.status).toBe(400);
    expect((await refusedTransfer.json() as { detail?: string }).detail).toContain("INVALID_WRANGLER");
    expect(transferred.trace).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pages static vs Functions honesty. A `_worker.js` or `functions/`
// source tree anywhere structural (unit root, output root, or a functions
// tree) is refused at prepare with PAGES_FUNCTIONS_UNSUPPORTED — the V3
// sealed release never carries a worker bundle, so sealing one would deploy
// static-only and silently drop the Functions behavior. Nested dist `.js`
// (even named `_worker.js`) stays a static asset with a publisher hash.
// ---------------------------------------------------------------------------
describe("pages static vs functions honesty (graph API)", () => {
  const pagesWrangler = JSON.stringify({ name: "site", compatibility_date: "2026-10-17", pages_build_output_dir: "dist" });
  const pagesConfig = (): ConfigV3 => ({ ...baseConfig(["pages"]), units: [{ id: "site", kind: "pages", wrangler: "wrangler.jsonc" }] });

  it.each([
    ["unit-root _worker.js", { "wrangler.jsonc": pagesWrangler, "_worker.js": "export default {};", "dist/index.html": "<h1>hi</h1>" }],
    ["dist-root _worker.js", { "wrangler.jsonc": pagesWrangler, "dist/index.html": "<h1>hi</h1>", "dist/_worker.js": "export default {};" }],
    ["functions/ source tree", { "wrangler.jsonc": pagesWrangler, "dist/index.html": "<h1>hi</h1>", "functions/api.js": "export function onRequest() {}" }],
  ])("refuses %s at prepare before any provider read or write", async (_label, rawFiles) => {
    const files = Object.fromEntries(Object.entries(rawFiles).map(([path, text]) => [path, enc.encode(text as string)]));
    const f = await graphHonoFixture(pagesConfig(), files, "node", {}, { allowPrepareFailure: true });
    const refused = await f.prepare();
    expect(refused.status).toBe(400);
    const body = await refused.json() as { error?: string; detail?: string };
    expect(body.error).toBe("INVALID_PER_UNIT_RELEASE");
    expect(body.detail).toContain("PAGES_FUNCTIONS_UNSUPPORTED");
    expect(f.trace).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// zone-scoped route add via the original Wrangler declaration. Patterns
// convert to explicit workers-route domain entries (add-only; an existing
// pattern is preserved, never rewritten). The step verifies the live route
// (zone, pattern, provider id, delivering script) and seals it into the
// receipt; the readback requires the pattern bound to this Worker. Anything
// else (custom domains, missing zones, unmanaged mutations) fails closed
// before any provider write.
// ---------------------------------------------------------------------------
describe("zone-scoped route add (graph API)", () => {
  const ZONE_ID = "9".repeat(32); // 32-hex: the client validates zone id shape
  const routeWrangler = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    name: "web", main: "worker/main.mjs", compatibility_date: "2026-10-17", workers_dev: false,
    routes: [{ pattern: "example.com/*", zone_name: "example.com" }],
    ...overrides,
  });
  const routeConfig = (capabilities: ConfigV3["capabilities"] = ["workers", "routes", "zone"]): ConfigV3 => ({
    ...baseConfig(capabilities),
    units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }],
  });
  const code = "export default { fetch() { return new Response('ok'); } };";
  const zoneSeed = { zones: [{ id: ZONE_ID, name: "example.com" }] };

  it.each(["node", "workers"] as const)("adds the zone-scoped route after activation with exact provider readback (%s)", async (runtime) => {
    const f = await graphHonoFixture(routeConfig(), { "wrangler.jsonc": enc.encode(routeWrangler()), "worker/main.mjs": enc.encode(code) }, runtime, zoneSeed);
    expect(f.plannedBody.graphPlan.blocked, JSON.stringify(f.plannedBody)).toBe(false);
    const unit = f.plannedBody.graphPlan.units.find((entry) => entry.unitId === "main")!;
    expect(unit.diffs).toContainEqual(expect.objectContaining({ resource: "worker-route", action: "create", name: "example.com/*" }));
    // Out of order: the route refuses before the carrier version is live.
    const early = await f.step("main", "worker-route", "create", "example.com/*", "reconcile-domains");
    expect(early.status).toBe(409);
    expect((await early.json() as { error?: string }).error).toBe("GRAPH_DEPENDENCY_REQUIRED");
    expect(f.writes()).toEqual([]);
    const created = await f.step("main", "worker", "create", "web", "create-worker");
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await f.step("main", "deployment", "create", "web", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt] });
    expect(activated.status, await activated.clone().text()).toBe(200);
    const activatedBody = await activated.json() as { phaseReceipt: unknown };
    const applied = await f.step("main", "worker-route", "create", "example.com/*", "reconcile-domains", { receipts: [createdBody.phaseReceipt, activatedBody.phaseReceipt] });
    expect(applied.status, await applied.clone().text()).toBe(200);
    const appliedBody = await applied.json() as { result: { applied: Array<{ kind: string; hostname: string; action: string }> } };
    expect(appliedBody.result.applied).toEqual([{ kind: "workers-route", hostname: "example.com/*", action: "create" }]);
    // The live route table shows the exact pattern bound to this Worker.
    expect(f.workerRoutes).toEqual([{ zoneId: ZONE_ID, id: expect.any(String), pattern: "example.com/*", script: "web" }]);
    // Exact provider ledger: zone discovery, route readback, one POST. No
    // PUT/DELETE, no DNS calls, no workers.dev exposure.
    const paths = f.trace.map((call) => `${call.method} ${call.path}`);
    expect(paths).toContain(`GET /client/v4/zones`);
    expect(paths).toContain(`GET /client/v4/zones/${ZONE_ID}/workers/routes`);
    expect(paths).toContain(`POST /client/v4/zones/${ZONE_ID}/workers/routes`);
    expect(paths.some((path) => path.includes("/workers/routes/") && (path.startsWith("PUT") || path.startsWith("DELETE")))).toBe(false);
    expect(paths.some((path) => path.includes("dns") || path.includes("subdomain") || path.includes("workers.dev"))).toBe(false);
    // Replan preserves the route; replaying the exact approved action
    // re-verifies and preserves with zero provider writes.
    const replanned = await f.plan({ mode: "upgrade" });
    const replanBody = await replanned.json() as typeof f.plannedBody;
    expect(replanBody.graphPlan.blocked, JSON.stringify(replanBody)).toBe(false);
    expect(replanBody.graphPlan.units.find((entry) => entry.unitId === "main")!.diffs).toContainEqual(
      expect.objectContaining({ resource: "worker-route", action: "preserve", name: "example.com/*" }),
    );
    const writesBefore = f.writes().length;
    const replay = await f.step("main", "worker-route", "create", "example.com/*", "reconcile-domains", { receipts: [createdBody.phaseReceipt, activatedBody.phaseReceipt] });
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect((await replay.json() as { result: { applied: Array<{ action: string }> } }).result.applied).toEqual([
      expect.objectContaining({ action: "preserve" }),
    ]);
    expect(f.writes()).toHaveLength(writesBefore);
  });

  it.each([
    ["custom domain", { routes: [{ pattern: "example.com/*", zone_name: "example.com", custom_domain: true }] }, "custom-domain route"],
    ["missing zone", { routes: [{ pattern: "example.com/*" }] }, "declares no zone"],
    ["zone_id only", { routes: [{ pattern: "example.com/*", zone_id: "8".repeat(32) }] }, "declares no zone"],
    ["duplicate pattern", { routes: [{ pattern: "example.com/*", zone_name: "example.com" }, { pattern: "example.com/*", zone_name: "example.com" }] }, "declared more than once"],
  ])("vetoes %s at plan time before any provider read or write", async (_label, wrangler, detail) => {
    const f = await graphHonoFixture(routeConfig(), { "wrangler.jsonc": enc.encode(routeWrangler(wrangler)), "worker/main.mjs": enc.encode(code) }, "node", zoneSeed);
    expect(f.planned.status).toBe(409);
    const body = f.plannedBody as unknown as { error?: string; detail?: string };
    expect(body.error).toBe("INVALID_RELEASE_PROOF");
    expect(body.detail).toContain(detail);
    expect(f.trace).toEqual([]);
  });

  it("refuses an underdeclared routes/zone capability before any provider read", async () => {
    const f = await graphHonoFixture(routeConfig(["workers"]), { "wrangler.jsonc": enc.encode(routeWrangler()), "worker/main.mjs": enc.encode(code) }, "node", zoneSeed);
    expect(f.planned.status).toBe(409);
    const body = f.plannedBody as unknown as { error?: string; undeclared?: string[] };
    expect(body.error).toBe("DEVELOPER_SCOPE_UNDERDECLARED");
    // `zone` is implied by the HTTP unit (custom domains); `routes` is not.
    expect(body.undeclared).toEqual(["routes"]);
    expect(f.trace).toEqual([]);
  });

  it("blocks an unresolvable zone at plan time and rejects a foreign route at step time, both with zero writes", async () => {
    // No such zone: the plan blocks on domain-drift, never approving a write.
    const missing = await graphHonoFixture(routeConfig(), {
      "wrangler.jsonc": enc.encode(routeWrangler({ routes: [{ pattern: "other.com/*", zone_name: "other.com" }] })),
      "worker/main.mjs": enc.encode(code),
    }, "node", zoneSeed);
    expect(missing.plannedBody.graphPlan.blocked).toBe(true);
    // The per-unit domain-drift block surfaces globally as unit-blocked; the
    // conflict diff additionally trips the unsupported + destructive gates.
    expect(missing.plannedBody.graphPlan.guards).toContainEqual(
      expect.objectContaining({ code: "unit-blocked", level: "block", detail: expect.stringContaining("domain-drift") }),
    );
    expect(missing.plannedBody.approval).toBeUndefined();
    expect(missing.writes()).toEqual([]);
    // Existing foreign route: the plan approves preserve, but the step refuses
    // the unverifiable target before any provider write.
    const f = await graphHonoFixture(routeConfig(), { "wrangler.jsonc": enc.encode(routeWrangler()), "worker/main.mjs": enc.encode(code) }, "node", zoneSeed);
    f.workerRoutes.push({ zoneId: ZONE_ID, id: "route-foreign", pattern: "example.com/*", script: "someone-else" });
    expect(f.plannedBody.graphPlan.blocked, JSON.stringify(f.plannedBody)).toBe(false);
    const created = await f.step("main", "worker", "create", "web", "create-worker");
    expect(created.status).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await f.step("main", "deployment", "create", "web", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt] });
    expect(activated.status).toBe(200);
    const activatedBody = await activated.json() as { phaseReceipt: unknown };
    const writesBefore = f.writes().length;
    const refused = await f.step("main", "worker-route", "create", "example.com/*", "reconcile-domains", { receipts: [createdBody.phaseReceipt, activatedBody.phaseReceipt] });
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error?: string }).error).toBe("domain_error");
    expect(f.writes()).toHaveLength(writesBefore);
    expect(f.workerRoutes).toEqual([{ zoneId: ZONE_ID, id: "route-foreign", pattern: "example.com/*", script: "someone-else" }]);
    // A forged account is rejected before any provider write.
    const forged = await f.step("main", "worker-route", "create", "example.com/*", "reconcile-domains", { receipts: [createdBody.phaseReceipt, activatedBody.phaseReceipt] }, { accountId: "b".repeat(32) });
    expect(forged.status).toBe(409);
    expect((await forged.json() as { error?: string }).error).toBe("GRAPH_CONTEXT_MISMATCH");
    expect(f.writes()).toHaveLength(writesBefore);
  });
});

// ---------------------------------------------------------------------------
// Red reproducers (no live Cloudflare), turned green by and . Each
// asserts the CORRECT behavior. : Pages preserve; : multi-tag DO history.
// ---------------------------------------------------------------------------
describe("Pages preserve of an existing project", () => {
  // Install once (project create only), then re-plan against the now-existing
  // project so the plan carries `pages-project:preserve`.
  async function existingPagesProject() {
    const { toPagesAssetPath } = await import("../../src/cloudflare/pages/manifest.js");
    const config: ConfigV3 = { ...baseConfig(["pages"]), units: [{ id: "site", kind: "pages", wrangler: "wrangler.jsonc" }] };
    const f = await graphHonoFixture(config, {
      "wrangler.jsonc": enc.encode(JSON.stringify({ name: "site", compatibility_date: "2026-10-17", pages_build_output_dir: "dist" })),
      "dist/index.html": enc.encode("<h1>hi</h1>"),
    });
    const project = await f.step("site", "pages-project", "create", "site", "pages-create-project");
    expect(project.status, await project.clone().text()).toBe(200);
    const replanned = await f.plan();
    const replanBody = await replanned.json() as typeof f.plannedBody;
    expect(replanned.status, JSON.stringify(replanBody.graphPlan?.guards)).toBe(200);
    expect(replanBody.graphPlan.blocked, JSON.stringify(replanBody.graphPlan.guards)).toBe(false);
    expect(replanBody.graphPlan.units.find(unit => unit.unitId === "site")!.diffs.map(diff => `${diff.resource}:${diff.action}`)).toContain("pages-project:preserve");
    const siteUnit = f.release.units.find(unit => (unit as { unitId?: string }).unitId === "site") as unknown as { assets: Array<{ path: string; pagesHash: string }> };
    const manifest = Object.fromEntries(siteUnit.assets.map(asset => [toPagesAssetPath(asset.path, "dist"), asset.pagesHash]));
    return { f, replanBody, manifest, step: f.makeStep(replanBody) };
  }
  const registerAssets = (ctx: Awaited<ReturnType<typeof existingPagesProject>>, overrides: Record<string, unknown> = {}) =>
    ctx.step("site", "static-assets", "update", "site", "pages-register-assets", {}, overrides);

  it("redeploys through handoff, deploy and postcheck with zero project re-creation", async () => {
    const { graphActionsForPlan } = await import("../../src/web/graph-deploy-runner.js");
    const ctx = await existingPagesProject();
    const { f, replanBody, manifest, step } = ctx;
    const writesBefore = f.writes().length;
    const receipts: unknown[] = [];
    let pending = graphActionsForPlan(replanBody.graphPlan);
    expect(pending.map(action => `${action.resource}:${action.action}`).sort()).toEqual(["deployment:create", "static-assets:update"]);
    const outcomes: string[] = [];
    while (pending.length > 0) {
      const next: typeof pending = [];
      for (const action of pending) {
        const args = action.phase === "pages-deploy" ? { manifest, receipts } : { receipts };
        const response = await step(action.unitId, action.resource, action.action, action.name ?? "site", action.phase, args);
        const text = await response.clone().text();
        outcomes.push(`${action.resource}:${action.action}@${action.phase} -> ${response.status} ${response.status === 200 ? "" : text}`);
        if (response.status === 200) receipts.push((JSON.parse(text) as { phaseReceipt: unknown }).phaseReceipt);
        else next.push(action);
      }
      if (next.length === pending.length) break;
      pending = next;
    }
    expect(pending.map(action => `${action.resource}:${action.action}`), outcomes.join("\n")).toEqual([]);
    expect(f.writes().slice(writesBefore).map(call => `${call.method} ${call.path}`)).toEqual([`POST /client/v4/accounts/${f.accountId}/pages/projects/site/deployments`]);
    expect(f.pagesManifests).toEqual([{ project: "site", manifest }]);
    const deployed = f.pagesProjects.get("site")!.deployment!;
    const post = await step("site", "deployment", "create", "site", "pages-postcheck", { deploymentId: deployed.id, receipts });
    expect(post.status, await post.clone().text()).toBe(200);
    expect((await post.json() as { result: { succeeded: boolean } }).result.succeeded).toBe(true);
    expect(f.writes()).toHaveLength(writesBefore + 1);
  });

  it("a redeploy of a live site is verified against the new deployment while production still serves the old one", async () => {
    const { toPagesAssetPath } = await import("../../src/cloudflare/pages/manifest.js");
    const config: ConfigV3 = { ...baseConfig(["pages"]), units: [{ id: "site", kind: "pages", wrangler: "wrangler.jsonc" }] };
    const f = await graphHonoFixture(config, {
      "wrangler.jsonc": enc.encode(JSON.stringify({ name: "site", compatibility_date: "2026-10-17", pages_build_output_dir: "dist" })),
      "dist/index.html": enc.encode("<h1>hi</h1>"),
    }, "node", {}, { pagesDeployReadsBeforeSuccess: 2 });
    const siteUnit = f.release.units.find(unit => (unit as { unitId?: string }).unitId === "site") as unknown as { assets: Array<{ path: string; pagesHash: string }> };
    const manifest = Object.fromEntries(siteUnit.assets.map(asset => [toPagesAssetPath(asset.path, "dist"), asset.pagesHash]));
    const run = async (step: typeof f.step, projectAction: "create" | "preserve") => {
      const receipts: unknown[] = [];
      if (projectAction === "create") receipts.push((await (await step("site", "pages-project", "create", "site", "pages-create-project")).json() as { phaseReceipt: unknown }).phaseReceipt);
      const handoff = await step("site", "static-assets", projectAction === "create" ? "create" : "update", "site", "pages-register-assets", { receipts });
      expect(handoff.status, await handoff.clone().text()).toBe(200);
      receipts.push((await handoff.json() as { phaseReceipt: unknown }).phaseReceipt);
      const deploy = await step("site", "deployment", "create", "site", "pages-deploy", { manifest, receipts });
      expect(deploy.status, await deploy.clone().text()).toBe(200);
      const deployBody = await deploy.json() as { phaseReceipt: unknown; result: { deploymentId: string } };
      receipts.push(deployBody.phaseReceipt);
      const post = await step("site", "deployment", "create", "site", "pages-postcheck", { deploymentId: deployBody.result.deploymentId, receipts });
      expect(post.status, await post.clone().text()).toBe(200);
      return { deploymentId: deployBody.result.deploymentId, result: (await post.json() as { result: { succeeded: boolean } }).result };
    };
    const first = await run(f.step, "create");
    expect(first.result.succeeded).toBe(true);
    const replanned = await f.plan();
    const replanBody = await replanned.json() as typeof f.plannedBody;
    expect(replanBody.graphPlan.units[0]!.diffs.map(diff => `${diff.resource}:${diff.action}`)).toContain("pages-project:preserve");
    const second = await run(f.makeStep(replanBody), "preserve");
    expect(second.deploymentId).not.toBe(first.deploymentId);
    expect(second.result.succeeded).toBe(true);
  });

  it("refuses a changed baseline deployment before any write", async () => {
    const ctx = await existingPagesProject();
    const writes = ctx.f.writes().length;
    ctx.f.tamperPagesDeployment("site");
    const response = await registerAssets(ctx);
    expect(response.status).toBe(409);
    expect((await response.json() as { error?: string }).error).toBe("GRAPH_TARGET_STALE");
    const deploy = await ctx.step("site", "deployment", "create", "site", "pages-deploy", { manifest: ctx.manifest });
    expect(deploy.status).toBe(409);
    expect(ctx.f.writes()).toHaveLength(writes);
  });

  it.each([
    ["replaced immutable project id", (project: { id: string }) => { project.id = "pages-replaced"; }],
    ["lost ownership marker", (project: { configs?: Record<string, unknown> }) => { project.configs = {}; }],
  ])("refuses a %s after planning, with zero writes", async (_label, mutate) => {
    const ctx = await existingPagesProject();
    const writes = ctx.f.writes().length;
    mutate(ctx.f.pagesProjects.get("site")! as never);
    const response = await registerAssets(ctx);
    expect(response.status).toBe(409);
    expect((await response.json() as { error?: string }).error).toBe("GRAPH_PROJECT_CONFLICT");
    const deploy = await ctx.step("site", "deployment", "create", "site", "pages-deploy", { manifest: ctx.manifest });
    expect(deploy.status).toBe(409);
    expect(ctx.f.writes()).toHaveLength(writes);
  });

  it("refuses a forged account and the non-dispatchable preserve action itself, with zero writes", async () => {
    const ctx = await existingPagesProject();
    const writes = ctx.f.writes().length;
    const forged = await registerAssets(ctx, { accountId: "b".repeat(32) });
    expect(forged.status).toBe(409);
    expect((await forged.json() as { error?: string }).error).toBe("GRAPH_CONTEXT_MISMATCH");
    const direct = await ctx.step("site", "pages-project", "preserve", "site", "pages-create-project");
    expect(direct.status).toBe(409);
    expect((await direct.json() as { error?: string }).error).toBe("GRAPH_ACTION_UNSAFE");
    expect(ctx.f.writes()).toHaveLength(writes);
  });

  it("keeps the fresh-install receipt requirement: handoff without the project receipt is refused", async () => {
    const config: ConfigV3 = { ...baseConfig(["pages"]), units: [{ id: "site", kind: "pages", wrangler: "wrangler.jsonc" }] };
    const f = await graphHonoFixture(config, {
      "wrangler.jsonc": enc.encode(JSON.stringify({ name: "site", compatibility_date: "2026-10-17", pages_build_output_dir: "dist" })),
      "dist/index.html": enc.encode("<h1>hi</h1>"),
    });
    expect(f.plannedBody.graphPlan.units.find(unit => unit.unitId === "site")!.diffs.map(diff => `${diff.resource}:${diff.action}`)).toContain("pages-project:create");
    const refused = await f.step("site", "static-assets", "create", "site", "pages-register-assets");
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error?: string }).error).toBe("GRAPH_DEPENDENCY_REQUIRED");
    expect(f.writes()).toEqual([]);
  });
});

describe("multi-tag Durable Object history refused before any provider mutation (M01/M02)", () => {
  const doCode = "import { DurableObject } from \"cloudflare:workers\";\nexport class Counter extends DurableObject {}\nexport class Other extends DurableObject {}\n";
  const wrangler = JSON.stringify({
    name: "do-carrier", main: "worker/main.mjs", compatibility_date: "2026-10-17", workers_dev: false,
    r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }],
    durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }, { name: "OTHER", class_name: "Other" }] },
    migrations: [{ tag: "v1", new_classes: ["Counter"] }, { tag: "v2", new_classes: ["Other"] }],
  });

  it("vetoes the ordered multi-tag history at plan time, before the R2 bucket or any other write", async () => {
    const config: ConfigV3 = { ...baseConfig(["workers", "durable-objects", "r2"]), units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }] };
    const f = await graphHonoFixture(config, { "wrangler.jsonc": enc.encode(wrangler), "worker/main.mjs": enc.encode(doCode) });
    expect(f.planned.status, `plan accepted a multi-tag DO history (diffs=${JSON.stringify(f.plannedBody.graphPlan?.units?.[0]?.diffs)})`).toBe(409);
    const body = f.plannedBody as unknown as { error?: string; detail?: string };
    expect(body.error).toBe("INVALID_RELEASE_PROOF");
    expect(body.detail).toContain("UNSUPPORTED_MIGRATION_HISTORY");
    expect(body.detail).not.toMatch(/squash/i);
    // No bucket, no worker, not even a provider read happened.
    expect(f.trace).toEqual([]);
    expect(f.writes()).toEqual([]);
  });
});

// the provider mock rejects the exact shapes the live API rejected, so a
// green route test can no longer hide them (Pages 8000033, migrations array
// 10021, bare Workflow class 10021).
describe("provider fixture parity", () => {
  const bareWorkflowClass = "export class WF { async run() {} }";
  const upload = async (accountId: string, metadata: Record<string, unknown>, source: string) => {
    const form = new FormData();
    form.set("metadata", new Blob([JSON.stringify({ main_module: "worker/main.mjs", annotations: { "workers/message": "m" }, ...metadata })], { type: "application/json" }));
    form.set("worker/main.mjs", new Blob([source], { type: "application/javascript+module" }), "worker/main.mjs");
    return fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/probe`, { method: "PUT", body: form });
  };
  const errorCode = async (response: Response) => ((await response.json()) as { errors: Array<{ code: number }> }).errors[0]!.code;

  it("refuses a Pages project without a production branch, an array migrations upload and a bare Workflow class", async () => {
    const f = await graphHonoFixture(baseConfig(["workers"]), {
      "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17" })),
      "worker/main.mjs": enc.encode(bareWorkflowClass),
    });
    const branchless = await fetch(`https://api.cloudflare.com/client/v4/accounts/${f.accountId}/pages/projects`, { method: "POST", body: JSON.stringify({ name: "site" }) });
    expect(branchless.status).toBe(400);
    expect(await errorCode(branchless)).toBe(8000033);
    expect(f.pagesProjects.size).toBe(0);

    const arrayMigrations = await upload(f.accountId, { migrations: [{ tag: "v1", new_classes: ["Counter"] }] }, bareWorkflowClass);
    expect(arrayMigrations.status).toBe(400);
    expect(await errorCode(arrayMigrations)).toBe(10021);

    const bare = await upload(f.accountId, { bindings: [{ type: "workflow", name: "WF", workflow_name: "wf", class_name: "WF" }] }, bareWorkflowClass);
    expect(bare.status).toBe(400);
    expect(await errorCode(bare)).toBe(10021);
    expect(f.workers.has("probe")).toBe(false);
    // An inheriting class is accepted by the Workflow route tests above.
  });
});

// Operator-chosen custom domains through the real Hono plan/step routes: the
// plan request's choice becomes a sealed diff, the reconcile-domains step binds
// it only after the carrier is live, and the receipt binds the live binding.
describe("custom domains (graph API)", () => {
  const ZONE_ID = "7".repeat(32);
  const zoneSeed = { zones: [{ id: ZONE_ID, name: "example.com" }] };
  const code = "export default { fetch() { return new Response('ok'); } };";
  const workerFiles = { "wrangler.jsonc": enc.encode(JSON.stringify({ name: "web", main: "worker/main.mjs", compatibility_date: "2026-10-17", workers_dev: false })), "worker/main.mjs": enc.encode(code) };
  const workerConfig: ConfigV3 = { ...baseConfig(["workers"]), units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }] };
  const bind = (hostname: string, replaceExisting?: boolean) => ({ main: { bind: [{ hostname, zone: "example.com", ...(replaceExisting ? { replaceExisting } : {}) }] } });

  async function liveWorker(f: Awaited<ReturnType<typeof graphHonoFixture>>, step: typeof f.step) {
    const created = await step("main", "worker", "create", "web", "create-worker");
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await step("main", "deployment", "create", "web", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt] });
    expect(activated.status, await activated.clone().text()).toBe(200);
    return [createdBody.phaseReceipt, (await activated.json() as { phaseReceipt: unknown }).phaseReceipt];
  }

  it.each(["node", "workers"] as const)("binds a free hostname to the new Worker after activation (%s)", async (runtime) => {
    const f = await graphHonoFixture(workerConfig, workerFiles, runtime, zoneSeed);
    const planned = await f.plan({ domains: bind("app.example.com") });
    const body = await planned.json() as typeof f.plannedBody;
    expect(body.graphPlan.blocked, JSON.stringify(body)).toBe(false);
    expect(body.graphPlan.units[0]!.diffs).toContainEqual(expect.objectContaining({ resource: "worker-custom-domain", action: "attach", name: "app.example.com" }));
    const step = f.makeStep(body);
    const early = await step("main", "worker-custom-domain", "attach", "app.example.com", "reconcile-domains");
    expect(early.status).toBe(409);
    expect((await early.json() as { error?: string }).error).toBe("GRAPH_DEPENDENCY_REQUIRED");
    const receipts = await liveWorker(f, step);
    const applied = await step("main", "worker-custom-domain", "attach", "app.example.com", "reconcile-domains", { receipts });
    expect(applied.status, await applied.clone().text()).toBe(200);
    expect((await applied.json() as { result: { applied: unknown[] } }).result.applied).toEqual([{ kind: "workers-custom-domain", hostname: "app.example.com", action: "attach" }]);
    expect(f.workerDomains).toEqual([{ id: expect.any(String), hostname: "app.example.com", service: "web", zone_id: ZONE_ID }]);
    expect(f.trace.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("refuses an occupied hostname without consent and replaces its record only with consent", async () => {
    const seed = { ...zoneSeed, dnsRecords: [{ zoneId: ZONE_ID, id: "e".repeat(32), name: "app.example.com", type: "A", content: "192.0.2.1" }] };
    const f = await graphHonoFixture(workerConfig, workerFiles, "node", seed);
    const refused = await (await f.plan({ domains: bind("app.example.com") })).json() as typeof f.plannedBody;
    expect(refused.graphPlan.blocked).toBe(true);
    expect(refused.approval).toBeUndefined();
    const consented = await (await f.plan({ domains: bind("app.example.com", true) })).json() as typeof f.plannedBody;
    expect(consented.graphPlan.blocked, JSON.stringify(consented)).toBe(false);
    const step = f.makeStep(consented);
    const receipts = await liveWorker(f, step);
    const withoutFlag = await step("main", "worker-custom-domain", "attach", "app.example.com", "reconcile-domains", { receipts });
    expect(withoutFlag.status).toBe(400);
    expect(f.dnsRecords).toHaveLength(1);
    const applied = await step("main", "worker-custom-domain", "attach", "app.example.com", "reconcile-domains", { receipts, confirmDomainChanges: true });
    expect(applied.status, await applied.clone().text()).toBe(200);
    expect(f.dnsRecords).toEqual([]);
    expect(f.workerDomains.map((domain) => [domain.hostname, domain.service])).toEqual([["app.example.com", "web"]]);
  });

  it("lists the bound domain on upgrade and unbinds it only on the operator's removal", async () => {
    const f = await graphHonoFixture(workerConfig, workerFiles, "node", zoneSeed);
    const installed = await (await f.plan({ domains: bind("app.example.com") })).json() as typeof f.plannedBody;
    const installStep = f.makeStep(installed);
    const receipts = await liveWorker(f, installStep);
    expect((await installStep("main", "worker-custom-domain", "attach", "app.example.com", "reconcile-domains", { receipts })).status).toBe(200);
    // An upgrade that does not mention the domain keeps it untouched.
    const keep = await (await f.plan({ mode: "upgrade" })).json() as typeof f.plannedBody;
    expect(keep.graphPlan.units[0]!.diffs.some((diff) => diff.resource === "worker-custom-domain")).toBe(false);
    const upgrade = await (await f.plan({ mode: "upgrade", domains: { main: { remove: [{ hostname: "app.example.com", zone: "example.com" }] } } })).json() as typeof f.plannedBody;
    expect(upgrade.graphPlan.blocked, JSON.stringify(upgrade)).toBe(false);
    expect(upgrade.graphPlan.units[0]!.diffs).toContainEqual(expect.objectContaining({ resource: "worker-custom-domain", action: "detach", name: "app.example.com" }));
    const step = f.makeStep(upgrade);
    const created = await step("main", "worker", "update", "web", "create-version");
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    const activated = await step("main", "deployment", "create", "web", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt] });
    expect(activated.status, await activated.clone().text()).toBe(200);
    const activatedBody = await activated.json() as { phaseReceipt: unknown };
    const removed = await step("main", "worker-custom-domain", "detach", "app.example.com", "reconcile-domains", { receipts: [createdBody.phaseReceipt, activatedBody.phaseReceipt] });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(f.workerDomains).toEqual([]);
  });

  it("refuses a domain choice for a hostname outside its zone before any provider read", async () => {
    const f = await graphHonoFixture(workerConfig, workerFiles, "node", zoneSeed);
    const before = f.trace.length;
    const refused = await f.plan({ domains: { main: { bind: [{ hostname: "app.other.com", zone: "example.com" }] } } });
    expect(refused.status).toBe(400);
    expect((await refused.json() as { error?: string }).error).toBe("INVALID_DOMAIN_CHOICE");
    expect(f.trace.length).toBe(before);
  });
});

it("binds a Pages custom domain after the deployment: project domain plus proxied CNAME, verified by receipt", async () => {
  const { toPagesAssetPath } = await import("../../src/cloudflare/pages/manifest.js");
  const ZONE_ID = "6".repeat(32);
  const config: ConfigV3 = { ...baseConfig(["pages"]), units: [{ id: "site", kind: "pages", wrangler: "wrangler.jsonc" }] };
  const f = await graphHonoFixture(config, {
    "wrangler.jsonc": enc.encode(JSON.stringify({ name: "site", compatibility_date: "2026-10-17", pages_build_output_dir: "dist" })),
    "dist/index.html": enc.encode("<h1>hi</h1>"),
  }, "node", { zones: [{ id: ZONE_ID, name: "example.com" }] });
  const planned = await (await f.plan({ domains: { site: { bind: [{ hostname: "docs.example.com", zone: "example.com" }] } } })).json() as typeof f.plannedBody;
  expect(planned.graphPlan.blocked, JSON.stringify(planned)).toBe(false);
  expect(planned.graphPlan.units[0]!.diffs).toContainEqual(expect.objectContaining({ resource: "pages-custom-domain", action: "attach", name: "docs.example.com" }));
  const step = f.makeStep(planned);
  const early = await step("site", "pages-custom-domain", "attach", "docs.example.com", "reconcile-domains");
  expect(early.status).toBe(409);
  const project = await (await step("site", "pages-project", "create", "site", "pages-create-project")).json() as { phaseReceipt: unknown };
  const siteUnit = f.release.units.find(unit => (unit as { unitId?: string }).unitId === "site") as unknown as { assets: Array<{ path: string; pagesHash: string }> };
  const manifest = Object.fromEntries(siteUnit.assets.map(asset => [toPagesAssetPath(asset.path, "dist"), asset.pagesHash]));
  const handoff = await (await step("site", "static-assets", "create", "site", "pages-register-assets", { receipts: [project.phaseReceipt] })).json() as { phaseReceipt: unknown };
  const deploy = await step("site", "deployment", "create", "site", "pages-deploy", { manifest, receipts: [project.phaseReceipt, handoff.phaseReceipt] });
  expect(deploy.status, await deploy.clone().text()).toBe(200);
  const deployBody = await deploy.json() as { phaseReceipt: unknown };
  const bound = await step("site", "pages-custom-domain", "attach", "docs.example.com", "reconcile-domains", { receipts: [project.phaseReceipt, handoff.phaseReceipt, deployBody.phaseReceipt] });
  expect(bound.status, await bound.clone().text()).toBe(200);
  expect(f.pagesProjects.get("site")?.domains).toEqual(["docs.example.com"]);
  expect(f.dnsRecords).toEqual([{ zoneId: ZONE_ID, id: expect.any(String), name: "docs.example.com", type: "CNAME", content: "site.pages.dev", proxied: true }]);
});
it("moves a hostname from another Worker to a Pages site only with the operator's confirmation", async () => {
  const { toPagesAssetPath } = await import("../../src/cloudflare/pages/manifest.js");
  const ZONE_ID = "6".repeat(32);
  const config: ConfigV3 = { ...baseConfig(["pages"]), units: [{ id: "site", kind: "pages", wrangler: "wrangler.jsonc" }] };
  const f = await graphHonoFixture(config, {
    "wrangler.jsonc": enc.encode(JSON.stringify({ name: "site", compatibility_date: "2026-10-17", pages_build_output_dir: "dist" })),
    "dist/index.html": enc.encode("<h1>hi</h1>"),
  }, "node", { zones: [{ id: ZONE_ID, name: "example.com" }], workerDomains: [{ id: "a".repeat(32), hostname: "docs.example.com", service: "other", zone_id: ZONE_ID }] });
  const unconfirmed = await (await f.plan({ domains: { site: { bind: [{ hostname: "docs.example.com", zone: "example.com" }] } } })).json() as typeof f.plannedBody;
  expect(unconfirmed.graphPlan.blocked).toBe(true);
  expect(unconfirmed.graphPlan.guards).toContainEqual(expect.objectContaining({ code: "unit-blocked", detail: expect.stringContaining("currently serves the Worker \"other\"") }));
  const planned = await (await f.plan({ domains: { site: { bind: [{ hostname: "docs.example.com", zone: "example.com", replaceExisting: true }] } } })).json() as typeof f.plannedBody;
  expect(planned.graphPlan.blocked, JSON.stringify(planned)).toBe(false);
  expect(planned.graphPlan.units[0]!.diffs).toContainEqual(expect.objectContaining({ resource: "pages-custom-domain", action: "attach", name: "docs.example.com" }));
  const step = f.makeStep(planned);
  const early = await step("site", "pages-custom-domain", "attach", "docs.example.com", "reconcile-domains");
  expect(early.status).toBe(409);
  const project = await (await step("site", "pages-project", "create", "site", "pages-create-project")).json() as { phaseReceipt: unknown };
  const siteUnit = f.release.units.find(unit => (unit as { unitId?: string }).unitId === "site") as unknown as { assets: Array<{ path: string; pagesHash: string }> };
  const manifest = Object.fromEntries(siteUnit.assets.map(asset => [toPagesAssetPath(asset.path, "dist"), asset.pagesHash]));
  const handoff = await (await step("site", "static-assets", "create", "site", "pages-register-assets", { receipts: [project.phaseReceipt] })).json() as { phaseReceipt: unknown };
  const deploy = await step("site", "deployment", "create", "site", "pages-deploy", { manifest, receipts: [project.phaseReceipt, handoff.phaseReceipt] });
  expect(deploy.status, await deploy.clone().text()).toBe(200);
  const deployBody = await deploy.json() as { phaseReceipt: unknown };
  const bound = await step("site", "pages-custom-domain", "attach", "docs.example.com", "reconcile-domains", { receipts: [project.phaseReceipt, handoff.phaseReceipt, deployBody.phaseReceipt], confirmDomainChanges: true });
  expect(bound.status, await bound.clone().text()).toBe(200);
  expect(f.workerDomains).toEqual([]);
  expect(f.pagesProjects.get("site")?.domains).toEqual(["docs.example.com"]);
  expect(f.dnsRecords).toEqual([{ zoneId: ZONE_ID, id: expect.any(String), name: "docs.example.com", type: "CNAME", content: "site.pages.dev", proxied: true }]);
});

// Workers AI, Browser Rendering, Vectorize, Hyperdrive and Secrets Store
// bindings through the real Hono plan/step routes (official binding shapes).
describe("platform bindings (graph API)", () => {
  const code = "export default { fetch() { return new Response('ok'); } };";
  const wrangler = (overrides: Record<string, unknown> = {}) => enc.encode(JSON.stringify({
    name: "web", main: "worker/main.mjs", compatibility_date: "2026-10-17", workers_dev: false,
    ai: { binding: "AI" },
    browser: { binding: "BROWSER" },
    vectorize: [{ binding: "VECTORS", index_name: "docs" }],
    hyperdrive: [{ binding: "DB", id: "publisher-config-id" }],
    secrets_store_secrets: [{ binding: "API_KEY", store_id: "publisher-store-id", secret_name: "api-key" }],
    ...overrides,
  }));
  const config: ConfigV3 = { ...baseConfig(["workers", "workers-ai", "browser-rendering", "vectorize", "hyperdrive", "secrets-store"]), units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }] };
  const seed = {
    hyperdriveConfigs: [{ id: "hd-own-1", name: "my-postgres" }],
    vectorizeIndexes: [{ name: "docs", dimensions: 768, metric: "cosine" }],
    secretsStores: [{ id: "store-own-1", name: "default_secrets_store", secrets: ["api-key"] }],
  };
  const bindingChoice = { main: { hyperdrive: { DB: "my-postgres" } } };

  it.each(["node", "workers"] as const)("binds all five to the account's own resources in the uploaded version (%s)", async (runtime) => {
    const f = await graphHonoFixture(config, { "wrangler.jsonc": wrangler(), "worker/main.mjs": enc.encode(code) }, runtime, seed);
    // Prepare tells the browser which Hyperdrive bindings need a choice.
    const prepared = await (await f.prepare()).json() as { releaseSummary: { units: Array<{ hyperdrive?: string[] }> } };
    expect(prepared.releaseSummary.units[0]!.hyperdrive).toEqual(["DB"]);
    const planned = await (await f.plan({ bindings: bindingChoice })).json() as typeof f.plannedBody;
    expect(planned.graphPlan.blocked, JSON.stringify(planned)).toBe(false);
    const diffs = planned.graphPlan.units[0]!.diffs;
    expect(diffs).toContainEqual(expect.objectContaining({ resource: "hyperdrive", action: "preserve", name: "my-postgres" }));
    expect(diffs).toContainEqual(expect.objectContaining({ resource: "vectorize", action: "preserve", name: "docs" }));
    expect(diffs).toContainEqual(expect.objectContaining({ resource: "secrets-store", action: "preserve", name: "default_secrets_store/api-key" }));
    const step = f.makeStep(planned);
    const created = await step("main", "worker", "create", "web", "create-worker");
    expect(created.status, await created.clone().text()).toBe(200);
    const bindings = f.workers.get("web")!.versions[0]!.bindings;
    expect(bindings).toEqual(expect.arrayContaining([
      { type: "ai", name: "AI" },
      { type: "browser", name: "BROWSER" },
      { type: "vectorize", name: "VECTORS", index_name: "docs" },
      { type: "hyperdrive", name: "DB", id: "hd-own-1" },
      { type: "secrets_store_secret", name: "API_KEY", store_id: "store-own-1", secret_name: "api-key" },
    ]));
    expect(JSON.stringify(bindings)).not.toContain("publisher-");
    // Nothing was created in the account for these bindings.
    expect(f.writes().map((call) => call.path).some((path) => /hyperdrive|vectorize|secrets_store/.test(path))).toBe(false);
  });

  it("upgrades a Worker that keeps its Secrets Store binding (the secret is not a store identity)", async () => {
    const f = await graphHonoFixture(config, { "wrangler.jsonc": wrangler(), "worker/main.mjs": enc.encode(code) }, "node", seed);
    const planned = await (await f.plan({ bindings: bindingChoice })).json() as typeof f.plannedBody;
    const created = await f.makeStep(planned)("main", "worker", "create", "web", "create-worker");
    const createdBody = await created.json() as { phaseReceipt: unknown; result: { versionId: string } };
    expect((await f.makeStep(planned)("main", "deployment", "create", "web", "activate", { versionId: createdBody.result.versionId, receipts: [createdBody.phaseReceipt] })).status).toBe(200);
    const replanned = await (await f.plan({ mode: "upgrade", bindings: bindingChoice })).json() as typeof f.plannedBody;
    expect(replanned.graphPlan.blocked, JSON.stringify(replanned.graphPlan)).toBe(false);
    const version = await f.makeStep(replanned)("main", "worker", "update", "web", "create-version");
    expect(version.status, await version.clone().text()).toBe(200);
    expect(f.workers.get("web")!.versions.at(-1)!.bindings).toContainEqual({ type: "secrets_store_secret", name: "API_KEY", store_id: "store-own-1", secret_name: "api-key" });
  });

  it("blocks the plan when a binding's resource is missing in the installing account", async () => {
    const blockedWith = async (overrides: Record<string, unknown>, planSeed: Record<string, unknown>, choice: unknown, code: string) => {
      const f = await graphHonoFixture(config, { "wrangler.jsonc": wrangler(overrides), "worker/main.mjs": enc.encode(code === "x" ? "" : "export default {};") }, "node", planSeed);
      const planned = await (await f.plan(choice ? { bindings: choice } : {})).json() as typeof f.plannedBody;
      expect(planned.graphPlan.blocked, code).toBe(true);
      expect(planned.graphPlan.units[0]!.guards.map((guard) => guard.code), code).toContain(code);
      expect(planned.approval).toBeUndefined();
    };
    // No choice and the publisher's id is not in this account.
    await blockedWith({}, seed, undefined, "hyperdrive-drift");
    // The secret is not in the account's store.
    await blockedWith({}, { ...seed, secretsStores: [{ id: "store-own-1", name: "default_secrets_store", secrets: [] }] }, bindingChoice, "secrets-store-drift");
    // The index does not exist and no resources unit declares it.
    await blockedWith({}, { ...seed, vectorizeIndexes: [] }, bindingChoice, "vectorize-drift");
  });

  it("creates a Vectorize index declared by a resources unit with its dimensions and metric, then binds it", async () => {
    const withIndex: ConfigV3 = {
      ...baseConfig(["workers", "vectorize"]),
      units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }],
      resources: [{ kind: "vectorize", name: "docs", dimensions: 384, metric: "dot-product" }],
    };
    const f = await graphHonoFixture(withIndex, { "wrangler.jsonc": wrangler({ ai: undefined, browser: undefined, hyperdrive: undefined, secrets_store_secrets: undefined }), "worker/main.mjs": enc.encode(code) }, "node");
    expect(f.plannedBody.graphPlan.blocked, JSON.stringify(f.plannedBody)).toBe(false);
    expect(f.plannedBody.graphPlan.units.find((unit) => unit.unitId === "resources")!.diffs).toContainEqual(expect.objectContaining({ resource: "vectorize", action: "create", name: "docs" }));
    const index = await f.step("resources", "vectorize", "create", "docs", "create-vectorize-indexes");
    expect(index.status, await index.clone().text()).toBe(200);
    expect(f.vectorizeIndexes).toEqual([{ name: "docs", created_on: expect.any(String), config: { dimensions: 384, metric: "dot-product" } }]);
  });
});

// A Worker request may make at most 50 subrequests on the Workers Free plan.
// The browser sends every receipt it holds with every step; a step verifies
// only the receipts of its own unit and its dependencies, one snapshot per unit.
it("every step of a multi-unit install stays within the Workers subrequest budget, ignoring unrelated receipts", async () => {
  const { toPagesAssetPath } = await import("../../src/cloudflare/pages/manifest.js");
  const config: ConfigV3 = { ...baseConfig(["workers", "pages", "r2", "queues", "vectorize"]), units: [
    { id: "main", kind: "worker", wrangler: "main/wrangler.jsonc" },
    { id: "site", kind: "pages", wrangler: "site/wrangler.jsonc" },
  ], resources: [{ kind: "vectorize", name: "docs", dimensions: 32, metric: "cosine" }] };
  const f = await graphHonoFixture(config, {
    "main/wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker.mjs", compatibility_date: "2026-10-17", workers_dev: false,
      vectorize: [{ binding: "VECTORS", index_name: "docs" }], r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }], queues: { producers: [{ binding: "JOBS", queue: "jobs" }] } })),
    "main/worker.mjs": enc.encode("export default { fetch() { return new Response('ok'); } };"),
    "site/wrangler.jsonc": enc.encode(JSON.stringify({ name: "site", compatibility_date: "2026-10-17", pages_build_output_dir: "dist" })),
    "site/dist/index.html": enc.encode("<h1>hi</h1>"),
  }, "node", { zones: [{ id: "7".repeat(32), name: "example.com" }] });
  const planned = await (await f.plan({ domains: { site: { bind: [{ hostname: "docs.example.com", zone: "example.com" }] } } })).json() as typeof f.plannedBody;
  expect(planned.graphPlan.blocked, JSON.stringify(planned.graphPlan)).toBe(false);
  const step = f.makeStep(planned);
  const receipts: unknown[] = [];
  const calls: Record<string, number> = {};
  const run = async (unit: string, resource: string, action: string, name: string, phase: string, args: Record<string, unknown> = {}) => {
    const before = f.trace.length;
    const res = await step(unit, resource, action, name, phase, { receipts: [...receipts], ...args });
    expect(res.status, `${unit} ${phase}: ${await res.clone().text()}`).toBe(200);
    calls[`${unit}:${phase}`] = f.trace.length - before;
    const body = await res.json() as { phaseReceipt?: unknown; result?: Record<string, unknown> };
    if (body.phaseReceipt !== undefined) receipts.push(body.phaseReceipt);
    return body;
  };
  await run("resources", "vectorize", "create", "docs", "create-vectorize-indexes");
  await run("main", "r2", "create", "media", "create-r2-buckets");
  await run("main", "queue", "create", "jobs", "create-queues");
  const created = await run("main", "worker", "create", "api", "create-worker");
  await run("main", "deployment", "create", "api", "activate", { versionId: created.result?.versionId });
  await run("site", "pages-project", "create", "site", "pages-create-project");
  const siteUnit = f.release.units.find(unit => (unit as { unitId?: string }).unitId === "site") as unknown as { assets: Array<{ path: string; pagesHash: string }> };
  const manifest = Object.fromEntries(siteUnit.assets.map(asset => [toPagesAssetPath(asset.path, "site/dist"), asset.pagesHash]));
  await run("site", "static-assets", "create", "site", "pages-register-assets");
  await run("site", "deployment", "create", "site", "pages-deploy", { manifest });
  const before = f.trace.length;
  await run("site", "pages-custom-domain", "attach", "docs.example.com", "reconcile-domains");
  // The Pages step carried the Worker and data receipts but never read their state.
  expect(f.trace.slice(before).some(call => call.path.includes("/workers/scripts/") || call.path.includes("/vectorize/"))).toBe(false);
  for (const [stepName, count] of Object.entries(calls)) expect(count, stepName).toBeLessThan(50);
});

// Operator-chosen names: install renames the release's suggestions everywhere
// (including a resource created by one unit and bound by another); the live
// Worker reports what it binds; an upgrade must keep those names.
it("installs under operator-chosen names, reads them back from the Worker, and keeps them on upgrade", async () => {
  const config: ConfigV3 = { ...baseConfig(["workers", "r2", "vectorize"]), units: [{ id: "main", kind: "worker", wrangler: "main/wrangler.jsonc" }], resources: [{ kind: "vectorize", name: "docs", dimensions: 32, metric: "cosine" }] };
  const f = await graphHonoFixture(config, {
    "main/wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker.mjs", compatibility_date: "2026-10-17", workers_dev: false,
      vectorize: [{ binding: "VECTORS", index_name: "docs" }], r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }] })),
    "main/worker.mjs": enc.encode("export default { fetch() { return new Response('ok'); } };"),
  }, "node");
  const summary = await (await f.prepare()).json() as { releaseSummary: { resources: Array<{ key: string; bindings: unknown[] }> } };
  expect(summary.releaseSummary.resources.map((item) => item.key)).toEqual(["vectorize:docs", "r2:media"]);

  const names = { "vectorize:docs": "my-docs", "r2:media": "my-media" };
  expect((await f.plan({ names: { "r2:media": "Bad Name" } })).status).toBe(400);
  const planned = await (await f.plan({ names })).json() as typeof f.plannedBody;
  expect(planned.graphPlan.blocked, JSON.stringify(planned.graphPlan.guards)).toBe(false);
  const diffs = planned.graphPlan.units.flatMap((unit) => unit.diffs.map((diff) => `${unit.unitId}:${diff.resource}:${diff.action}:${diff.name}`));
  expect(diffs).toEqual(expect.arrayContaining(["resources:vectorize:create:my-docs", "main:r2:create:my-media", "main:vectorize:skip:my-docs"]));
  const step = f.makeStep(planned);
  const receipts: unknown[] = [];
  const run = async (unit: string, resource: string, action: string, name: string, phase: string, args: Record<string, unknown> = {}) => {
    const res = await step(unit, resource, action, name, phase, { receipts: [...receipts], ...args });
    expect(res.status, `${unit} ${phase}: ${await res.clone().text()}`).toBe(200);
    const body = await res.json() as { phaseReceipt?: unknown; result?: Record<string, unknown> };
    if (body.phaseReceipt !== undefined) receipts.push(body.phaseReceipt);
    return body;
  };
  await run("resources", "vectorize", "create", "my-docs", "create-vectorize-indexes");
  await run("main", "r2", "create", "my-media", "create-r2-buckets");
  const created = await run("main", "worker", "create", "api", "create-worker");
  await run("main", "deployment", "create", "api", "activate", { versionId: created.result?.versionId });
  expect(f.vectorizeIndexes.map((index) => index.name)).toEqual(["my-docs"]);
  expect(f.buckets.map((bucket) => bucket.name)).toEqual(["my-media"]);

  const inventory = await (await f.json("/api/cloudflare/inventory", { accountId: f.accountId, kinds: ["r2", "vectorize"], worker: "api" })).json() as { names: Record<string, string[]>; bindings: unknown[] };
  expect(inventory.bindings).toEqual(expect.arrayContaining([{ binding: "MEDIA", kind: "r2", name: "my-media" }, { binding: "VECTORS", kind: "vectorize", name: "my-docs" }]));

  // Upgrading with the release's names would rebind the Worker: refused.
  const stale = await (await f.plan({ mode: "upgrade" })).json() as typeof f.plannedBody;
  expect(stale.graphPlan.blocked).toBe(true);
  const kept = await (await f.plan({ mode: "upgrade", names })).json() as typeof f.plannedBody;
  expect(kept.graphPlan.blocked, JSON.stringify(kept.graphPlan.guards)).toBe(false);
  expect(kept.graphPlan.units.flatMap((unit) => unit.diffs.filter((diff) => diff.resource === "r2" || diff.resource === "vectorize").map((diff) => `${diff.action}:${diff.name}`))).toEqual(expect.arrayContaining(["preserve:my-media", "preserve:my-docs"]));
});

// `upgradeKeep: false` on a resource entry: the config lets the user bind
// another bucket on upgrade, while a resource that keeps the default stays bound.
it("lets an upgrade rebind only the resources whose config entry says upgradeKeep false", async () => {
  const files = {
    "main/wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker.mjs", compatibility_date: "2026-10-17", workers_dev: false,
      vectorize: [{ binding: "VECTORS", index_name: "docs" }], r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }] })),
    "main/worker.mjs": enc.encode("export default { fetch() { return new Response('ok'); } };"),
  };
  const config: ConfigV3 = { ...baseConfig(["workers", "r2", "vectorize"]), units: [{ id: "main", kind: "worker", wrangler: "main/wrangler.jsonc" }], resources: [
    { kind: "vectorize", name: "docs", dimensions: 32, metric: "cosine" },
    { kind: "r2", name: "media", upgradeKeep: false },
  ] };
  const f = await graphHonoFixture(config, files, "node");
  const summary = await (await f.prepare()).json() as { releaseSummary: { resources: Array<{ key: string; changeOnUpgrade?: true }> } };
  expect(summary.releaseSummary.resources).toEqual([
    expect.objectContaining({ key: "vectorize:docs" }),
    expect.objectContaining({ key: "r2:media", changeOnUpgrade: true }),
  ]);
  expect(summary.releaseSummary.resources[0]).not.toHaveProperty("changeOnUpgrade");
  const planned = await (await f.plan({})).json() as typeof f.plannedBody;
  const step = f.makeStep(planned);
  const receipts: unknown[] = [];
  const run = async (unit: string, resource: string, action: string, name: string, phase: string, args: Record<string, unknown> = {}) => {
    const res = await step(unit, resource, action, name, phase, { receipts: [...receipts], ...args });
    expect(res.status, `${unit} ${phase}: ${await res.clone().text()}`).toBe(200);
    const body = await res.json() as { phaseReceipt?: unknown; result?: Record<string, unknown> };
    if (body.phaseReceipt !== undefined) receipts.push(body.phaseReceipt);
    return body;
  };
  await run("resources", "vectorize", "create", "docs", "create-vectorize-indexes");
  await run("resources", "r2", "create", "media", "create-r2-buckets");
  const created = await run("main", "worker", "create", "api", "create-worker");
  await run("main", "deployment", "create", "api", "activate", { versionId: created.result?.versionId });

  // The bucket may change; the Worker moves to a new one.
  const swapped = await (await f.plan({ mode: "upgrade", names: { "r2:media": "new-media" } })).json() as typeof f.plannedBody;
  expect(swapped.graphPlan.blocked, JSON.stringify(swapped.graphPlan.guards)).toBe(false);
  const upgradeStep = f.makeStep(swapped);
  const newBucket = await upgradeStep("resources", "r2", "create", "new-media", "create-r2-buckets");
  expect(newBucket.status, await newBucket.clone().text()).toBe(200);
  const version = await upgradeStep("main", "worker", "update", "api", "create-version", { receipts: [(await newBucket.json() as { phaseReceipt: unknown }).phaseReceipt] });
  expect(version.status, await version.clone().text()).toBe(200);
  expect(f.buckets.map((bucket) => bucket.name)).toEqual(["media", "new-media"]);
  // The index keeps the default (upgradeKeep true): changing it is still refused.
  const rebound = await (await f.plan({ mode: "upgrade", names: { "vectorize:docs": "other-docs" } })).json() as typeof f.plannedBody;
  expect(rebound.graphPlan.blocked).toBe(true);
});
