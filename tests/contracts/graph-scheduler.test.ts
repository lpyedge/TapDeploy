// The plan response carries non-secret `schedulerHints` (the unit edges the server
// already sealed). The browser driver uses them only to order its requests. These
// scenarios run the production driver against the real Hono server (real seals,
// receipts and dependency checks; only the provider HTTP seam is mocked) with the current plan response: avoidable dependency refusals must disappear.
// Missing or invalid scheduler advice is refused before dispatch. The server stays the authority.

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
function scenario(name: string, specs: UnitSpec[]) {
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
  return { name, config, files };
}
const chain = (ids: string[]): UnitSpec[] => ids.map((id, i) => ({ id, services: i === 0 ? [] : [ids[i - 1]!] }));
const scenarios = [
  scenario("1-worker", [{ id: "a" }]),
  scenario("2 workers, dependency sorts first", chain(["a", "b"])),
  scenario("2 workers, dependency sorts last", [{ id: "a", services: ["b"] }, { id: "b" }]),
  scenario("4-chain, dependencies sort first", chain(["a", "b", "c", "d"])),
  scenario("4-chain, dependencies sort last", [{ id: "a", services: ["b"] }, { id: "b", services: ["c"] }, { id: "c", services: ["d"] }, { id: "d" }]),
  scenario("diamond", [{ id: "a", services: ["b", "c"] }, { id: "b", services: ["d"] }, { id: "c", services: ["d"] }, { id: "d" }]),
  scenario("fan-out (1 library, 3 dependents)", [{ id: "a", services: ["z"] }, { id: "b", services: ["z"] }, { id: "c", services: ["z"] }, { id: "z" }]),
  scenario("2 workers each with a new R2 bucket", [{ id: "a", services: ["b"], r2: true }, { id: "b", r2: true }]),
  scenario("declared dependsOn only", [{ id: "a", declare: ["b"] }, { id: "b" }]),
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
  it("deploys the approved graph without avoidable dependency refusals", async () => {
    const hinted = await run(sc, "server");
    expect(hinted.result.ok, hinted.result.error).toBe(true);
    expect(hinted.refused).toBe(0);
    expect(hinted.otherErrors).toBe(0);
    expect(Object.keys(hinted.state.workers)).toHaveLength(sc.config.units!.length);
    expect(Object.values(hinted.state.workers).every((worker) => worker.active)).toBe(true);
    expect(hinted.result.receipts.length).toBeGreaterThan(0);
  }, 60_000);
});

describe("a Pages unit (the order seen on a real account: the plan lists the deployment before its assets)", () => {
  const files = {
    "wrangler.jsonc": enc.encode(JSON.stringify({ name: "site", compatibility_date: "2026-10-17", pages_build_output_dir: "dist" })),
    "dist/index.html": enc.encode("<h1>hi</h1>"), "dist/app.js": enc.encode("console.log(1)"),
  };
  const sc = { name: "pages", config: { ...baseConfig(), capabilities: ["pages"], units: [{ id: "site", kind: "pages", wrangler: "wrangler.jsonc" }] } as ConfigV3, files };
  it("uploads assets before deployment and verifies the resulting Pages site", async () => {
    const hinted = await run(sc, "server");
    expect(hinted.result.ok, hinted.result.error).toBe(true);
    expect(hinted.refused).toBe(0);
    expect(hinted.state.pages).toEqual(["site"]);
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
  it.each<[string, HintsMode]>([
    ["missing", "none"],
    ["an unknown unit", (h) => ({ ...(h as object), topoOrder: [...(h as { topoOrder: string[] }).topoOrder, "evil"] })],
    ["a cycle", () => ({ version: 1, topoOrder: ["a", "b"], dependencies: [{ dependent: "a", dependency: "b" }, { dependent: "b", dependency: "a" }] })],
    ["garbage", () => "not hints"],
    ["missing units", () => ({ version: 1, topoOrder: [], dependencies: [] })],
  ])("%s refuses before any step or write", async (_name, mode) => {
    const out = await run(sc, mode);
    expect(out.result.ok).toBe(false);
    expect(out.result.error).toContain("scheduler hints");
    expect(out.calls).toBe(0);
    expect(out.writes).toBe(0);
    expect(out.result.receipts).toEqual([]);
  });

  it("contradictory advice stops instead of switching to a legacy dispatch path", async () => {
    const out = await run(sc, (h) => {
      const x = h as { topoOrder: string[]; dependencies: Array<{ dependent: string; dependency: string }> };
      return { version: 1, topoOrder: [...x.topoOrder].reverse(), dependencies: x.dependencies.map((e) => ({ dependent: e.dependency, dependency: e.dependent })) };
    });
    expect(out.result.ok).toBe(false);
    expect(out.result.error).toContain("dependencies cannot be satisfied");
    expect(out.writes).toBe(0);
  });

  it("omitted dependency edges cannot bypass the server receipt checks", async () => {
    const out = await run(sc, (h) => ({ ...(h as object), dependencies: [] }));
    expect(out.result.ok, out.result.error).toBe(true);
    expect(out.refused).toBeGreaterThan(0);
    expect(Object.values(out.state.workers).every((worker) => worker.active)).toBe(true);
  });

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
