// The plan response carries non-secret `schedulerHints` (the unit edges the server
// already sealed). The browser driver uses them only to order its requests. These
// scenarios run the production driver against the real Hono server (real seals,
// receipts and dependency checks; only the provider HTTP seam is mocked) with and
// without the hints: the final provider state and receipts must be identical, and
// avoidable dependency refusals must disappear. The server stays the authority.

import { afterEach, describe, expect, it, vi } from "vitest";
import { openSeal } from "../../src/auth/keys.js";
import type { ConfigV3 } from "../../src/manifest/config-v3.js";
import { graphActionsForPlan, runGraphDeploy } from "../../src/web/graph-deploy-runner.js";
import { retainedSource } from "../unit/retained-source.js";
import { graphHonoFixture } from "./graph-hono-fixture.js";

afterEach(() => vi.unstubAllGlobals());

const enc = new TextEncoder();
const code = "export default { fetch() { return new Response('ok'); } };";
const baseConfig = (): ConfigV3 => ({ schemaVersion: 3, app: { id: "example/graph", name: "Graph" }, source: { allowLocalZip: true }, capabilities: ["workers", "r2"] });

interface UnitSpec { id: string; services?: string[]; r2?: boolean; declare?: string[] }
function scenario(name: string, specs: UnitSpec[], legacy409: number) {
  const files: Record<string, Uint8Array> = {};
  const config = { ...baseConfig(), units: specs.map((s) => ({ id: s.id, kind: "worker", wrangler: `units/${s.id}/wrangler.jsonc`, ...(s.declare ? { dependsOn: s.declare } : {}) })) } as ConfigV3;
  for (const s of specs) {
    files[`units/${s.id}/wrangler.jsonc`] = enc.encode(JSON.stringify({
      name: `${s.id}-worker`, main: "main.mjs", compatibility_date: "2026-10-17",
      ...(s.services?.length ? { services: s.services.map((dependency, i) => ({ binding: `S${i}`, service: `${dependency}-worker` })) } : {}),
      ...(s.r2 ? { r2_buckets: [{ binding: "B", bucket_name: `bucket-${s.id}` }] } : {}),
    }));
    files[`units/${s.id}/main.mjs`] = enc.encode(code);
  }
  return { name, config, files, legacy409 };
}
const chain = (ids: string[]): UnitSpec[] => ids.map((id, i) => ({ id, services: i === 0 ? [] : [ids[i - 1]!] }));
// legacy409: dependency refusals the newest-first sweep produces today (BF05 measurement, reproduced here).
const scenarios = [
  scenario("1-worker", [{ id: "a" }], 0),
  scenario("2 workers, dependency sorts first", chain(["a", "b"]), 2),
  scenario("2 workers, dependency sorts last", [{ id: "a", services: ["b"] }, { id: "b" }], 1),
  scenario("4-chain, dependencies sort first", chain(["a", "b", "c", "d"]), 12),
  scenario("4-chain, dependencies sort last", [{ id: "a", services: ["b"] }, { id: "b", services: ["c"] }, { id: "c", services: ["d"] }, { id: "d" }], 6),
  scenario("diamond", [{ id: "a", services: ["b", "c"] }, { id: "b", services: ["d"] }, { id: "c", services: ["d"] }, { id: "d" }], 4),
  scenario("fan-out (1 library, 3 dependents)", [{ id: "a", services: ["z"] }, { id: "b", services: ["z"] }, { id: "c", services: ["z"] }, { id: "z" }], 3),
  scenario("2 workers each with a new R2 bucket", [{ id: "a", services: ["b"], r2: true }, { id: "b", r2: true }], 2),
  scenario("declared dependsOn only", [{ id: "a", declare: ["b"] }, { id: "b" }], 1),
];

type Sc = ReturnType<typeof scenario>;
type HintsMode = "none" | "server" | ((hints: unknown) => unknown);

async function run(sc: Sc, mode: HintsMode) {
  const f = await graphHonoFixture(sc.config, sc.files);
  expect(f.plannedBody.graphPlan.blocked, JSON.stringify(f.plannedBody.graphPlan.guards)).toBe(false);
  const envelope = f.plannedBody as unknown as { schedulerHints?: unknown; executionContext: never; approval: unknown; bundleDigests?: Record<string, string> };
  const providerFetch = globalThis.fetch;
  const steps: Array<{ status: number; phase: string }> = [];
  const browserRequests: string[] = [];
  const browserVisible: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string" && input.startsWith("/api/")) {
      browserRequests.push(input);
      const response = await f.app.request(input, { ...init, headers: { ...f.headers, ...Object.fromEntries(new Headers(init?.headers)) } });
      browserVisible.push(await response.clone().text());
      if (input === "/api/deploy/step") steps.push({ status: response.status, phase: JSON.parse(String(init?.body)).phase });
      return response;
    }
    // The Pages asset endpoints are authenticated by a JWT and are not part of the fixture's account mock.
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (target.includes("/pages/assets/")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { hashes?: string[] } : {};
      return Response.json({ success: true, errors: [], result: target.endsWith("/check-missing") ? (body.hashes ?? []) : {} });
    }
    return providerFetch(input, init);
  }));
  const hints = mode === "none" ? undefined : mode === "server" ? envelope.schedulerHints : mode(envelope.schedulerHints);
  const result = await runGraphDeploy({
    csrf: f.session.payload.csrf, accountId: f.accountId, source: await retainedSource(f.archive, "scheduler"),
    configText: JSON.stringify(sc.config), releaseProof: undefined, graphPlan: f.plannedBody.graphPlan as never,
    executionContext: envelope.executionContext, approval: envelope.approval,
    ...(envelope.bundleDigests ? { bundleDigests: envelope.bundleDigests } : {}),
    ...(hints !== undefined ? { schedulerHints: hints } : {}),
  });
  vi.stubGlobal("fetch", providerFetch);
  const state = {
    workers: Object.fromEntries([...f.workers.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, w]) => [name, { versions: w.versions.length, active: w.active === w.versions[0]?.id, bindings: w.versions[0]?.bindings }])),
    buckets: f.buckets.map((bucket) => bucket.name).sort(),
    pages: [...f.pagesProjects.keys()].sort(),
  };
  return { f, result, state, browserRequests, browserVisible, providerCalls: f.trace.length, planned: f.plannedBody.graphPlan, calls: steps.length, refused: steps.filter((s) => s.status === 409).length, otherErrors: steps.filter((s) => s.status >= 400 && s.status !== 409).length, writes: f.writes().length, hints: envelope.schedulerHints };
}

describe("plan response schedulerHints", () => {
  it("are non-secret, mirror the sealed edges, and are not part of the sealed context or approval", async () => {
    const sc = scenarios[4]!;
    const f = await graphHonoFixture(sc.config, sc.files);
    const body = f.plannedBody as unknown as { schedulerHints: { version: number; topoOrder: string[]; dependencies: unknown[] }; executionContext: never };
    const sealed = (await openSeal<Record<string, unknown>>(f.key, body.executionContext))!;
    expect(body.schedulerHints).toEqual({ version: 1, topoOrder: sealed.topoOrder, dependencies: sealed.dependencies });
    expect(body.schedulerHints.dependencies.length).toBeGreaterThan(0);
    expect(JSON.stringify(sealed)).not.toContain("schedulerHints");
    expect(JSON.stringify(body.schedulerHints)).not.toMatch(/token|secret|jwt|cookie/i);
  });
});

describe.each(scenarios)("$name", (sc) => {
  it("legacy order and hinted order end in the same provider state; hints remove every avoidable refusal", async () => {
    const legacy = await run(sc, "none");
    const hinted = await run(sc, "server");
    expect(legacy.result.ok, legacy.result.error).toBe(true);
    expect(hinted.result.ok, hinted.result.error).toBe(true);
    expect(legacy.refused).toBe(sc.legacy409);
    expect(hinted.refused).toBe(0);
    expect(hinted.otherErrors).toBe(0);
    expect(hinted.state).toEqual(legacy.state);
    expect(hinted.result.receipts.length).toBe(legacy.result.receipts.length);
    expect(hinted.writes).toBe(legacy.writes);
    expect(hinted.calls).toBeLessThanOrEqual(legacy.calls);
    expect(hinted.calls - hinted.refused).toBe(legacy.calls - legacy.refused);
  }, 60_000);
});

describe("a Pages unit (the order seen on a real account: the plan lists the deployment before its assets)", () => {
  const files = {
    "wrangler.jsonc": enc.encode(JSON.stringify({ name: "site", compatibility_date: "2026-10-17", pages_build_output_dir: "dist" })),
    "dist/index.html": enc.encode("<h1>hi</h1>"), "dist/app.js": enc.encode("console.log(1)"),
  };
  const sc = { name: "pages", config: { ...baseConfig(), capabilities: ["pages"], units: [{ id: "site", kind: "pages", wrangler: "wrangler.jsonc" }] } as ConfigV3, files, legacy409: 1 };
  it("legacy order asks for the deployment too early; hinted order never does, with the same end state", async () => {
    const legacy = await run(sc, "none");
    const hinted = await run(sc, "server");
    expect(legacy.result.ok, legacy.result.error).toBe(true);
    expect(hinted.result.ok, hinted.result.error).toBe(true);
    expect(legacy.refused).toBeGreaterThan(0);
    expect(hinted.refused).toBe(0);
    expect(hinted.state).toEqual(legacy.state);
    expect(hinted.state.pages).toEqual(["site"]);
    expect(hinted.writes).toBe(legacy.writes);
  }, 60_000);
});

describe("the bridge stays typed and aggregated", () => {
  it.each(scenarios.map((sc) => [sc.name, sc] as const))("%s: one /step per approved action plus one postcheck per Worker, nothing generic, no OAuth token in the browser", async (_name, sc) => {
    const out = await run(sc, "server");
    expect(out.result.ok, out.result.error).toBe(true);
    const actions = graphActionsForPlan(out.planned as never);
    const workers = (out.planned as { units: Array<{ kind: string }> }).units.filter((unit) => unit.kind === "worker").length;
    // Every approved action is one aggregated /step; the many provider calls behind
    // it stay on the server instead of becoming one browser round trip each.
    expect(out.calls).toBe(actions.length + workers);
    expect(out.providerCalls).toBeGreaterThan(out.calls * 5);
    // The browser only ever calls the fixed deploy route(s).
    expect(new Set(out.browserRequests)).toEqual(new Set(["/api/deploy/step"]));
    // Nothing the browser can read carries the OAuth access token.
    expect(out.browserVisible.join("\n")).not.toContain("offline-test-token");
  }, 60_000);
});

describe("hints are advice, never authority", () => {
  const sc = scenarios[4]!;
  const reference = async () => run(sc, "none");

  it.each<[string, (hints: unknown) => unknown]>([
    ["reversed edges", (h) => { const x = h as { topoOrder: string[]; dependencies: Array<{ dependent: string; dependency: string }> }; return { version: 1, topoOrder: [...x.topoOrder].reverse(), dependencies: x.dependencies.map((e) => ({ dependent: e.dependency, dependency: e.dependent })) }; }],
    ["an unknown unit", (h) => ({ ...(h as object), topoOrder: [...(h as { topoOrder: string[] }).topoOrder, "evil"] })],
    ["a cycle", () => ({ version: 1, topoOrder: ["a", "b"], dependencies: [{ dependent: "a", dependency: "b" }, { dependent: "b", dependency: "a" }] })],
    ["garbage", () => "not hints"],
    ["an empty edge set", () => ({ version: 1, topoOrder: [], dependencies: [] })],
  ])("%s still end in the approved provider state with no extra writes (the server decides)", async (_name, tamper) => {
    const expected = await reference();
    const tampered = await run(sc, tamper);
    expect(tampered.result.ok, tampered.result.error).toBe(true);
    expect(tampered.state).toEqual(expected.state);
    expect(tampered.writes).toBe(expected.writes);
    expect(tampered.result.receipts.length).toBe(expected.result.receipts.length);
  }, 60_000);

  it("a hint cannot make the driver skip a prerequisite: the step route refuses a dependent whose receipts are missing", async () => {
    const f = await graphHonoFixture(sc.config, sc.files);
    const writesBefore = f.writes().length;
    // "a" depends on "b" -> "c" -> "d"; ask for the dependent first with no receipts.
    const response = await f.step("a", "worker", "create", "a-worker", "create-worker");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "GRAPH_DEPENDENCY_REQUIRED" });
    expect(f.writes()).toHaveLength(writesBefore);
  });
});
