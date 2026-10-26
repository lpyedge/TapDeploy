import { afterEach, expect, it, vi } from "vitest";
import { graphHonoFixture } from "./graph-hono-fixture.js";
import { openSeal, type SealedEnvelope } from "../../src/auth/keys.js";
import { graphExecutionContextDigest, sealGraphExecutionContext, sealVerifiedReleaseContext } from "../../src/core/planning/graph-execution-context.js";
import type { GraphExecutionContext } from "../../src/core/planning/graph-execution-context.js";
import { sealGraphPlanApproval } from "../../src/core/planning/plan-approval.js";
import type { DeploySpec } from "../../src/core/deploy-spec.js";
import type { ExpectedTarget } from "../../src/core/planning/types.js";

afterEach(() => vi.unstubAllGlobals());

it.each(["node", "workers"] as const)("rejects previously sealed Worker asset proofs and execution contexts (%s)", async (runtime) => {
  const enc = new TextEncoder();
  const f = await graphHonoFixture({ schemaVersion: 3, app: { id: "test/assets", name: "Assets" }, source: { allowLocalZip: true }, capabilities: ["workers"] }, {
    "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "main.mjs", compatibility_date: "2026-10-17" })),
    "main.mjs": enc.encode("export default { fetch() { return new Response('ok'); } };"),
  }, runtime);
  // Simulate authentic pre-disable artifacts, using only this fixture's server key.
  const release = structuredClone(f.release);
  (release.units[0]!.canonicalWrangler as Record<string, unknown>).assets = { directoryPath: "public" };
  const planned = await f.plan({ releaseProof: await sealVerifiedReleaseContext(f.key, release) });
  expect(planned.status).toBe(409);
  expect(await planned.json()).toMatchObject({ error: "WORKER_ASSETS_UNSUPPORTED" });

  const context = await openSeal<GraphExecutionContext>(f.key, f.plannedBody.executionContext as SealedEnvelope);
  const spec = context!.perUnitCanonicalSpecs.main as DeploySpec;
  spec.assets = [{ path: "public/index.html", size: 1, sha256: "a".repeat(64) }];
  const base = Object.fromEntries(Object.entries(context!).filter(([key]) => key !== "executionContextDigest")) as Omit<GraphExecutionContext, "executionContextDigest">;
  const digest = await graphExecutionContextDigest(base);
  const executionContext = await sealGraphExecutionContext(f.key, { ...base, executionContextDigest: digest });
  const approval = await sealGraphPlanApproval(f.key, { nonce: base.nonce, configHash: base.configHash, accountId: base.accountId, digest: base.graphPlanDigest,
    references: base.expectedPerUnitReferences as Record<string, ExpectedTarget>, executionContextDigest: digest, expiresAt: base.expiresAt });
  const traceBefore = f.trace.length;
  const response = await f.makeStep({ ...f.plannedBody, executionContext, approval })("main", "worker", "create", "api", "create-worker");
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "WORKER_ASSETS_UNSUPPORTED" });
  expect(f.trace).toHaveLength(traceBefore);
  expect(f.writes()).toHaveLength(0);
});
