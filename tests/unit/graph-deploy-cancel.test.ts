import { describe, expect, it } from "vitest";
import { runGraphDeploy } from "../../src/web/graph-deploy-runner.js";
import { buildValidZip } from "./zip-builder.js";
import { retainedSource } from "./retained-source.js";

const units = ["w1", "w2", "p1", "p2"];
const phases = ["w1:create-worker", "w2:create-worker", "p1:pages-deploy", "p2:pages-deploy", "w1:postcheck", "w2:postcheck", "p1:pages-postcheck", "p2:pages-postcheck"];

describe("Stop at action/postcheck boundaries", () => {
  for (const stopAt of ["before", ...phases, "none"]) {
    it(`preserves completed receipts and starts no further step after ${stopAt}`, async () => {
      const files: Record<string, string> = {};
      for (const id of units) {
        files[`${id}/wrangler.jsonc`] = JSON.stringify(id.startsWith("w")
          ? { name: id, main: "main.mjs", compatibility_date: "2026-10-17" }
          : { name: id, pages_build_output_dir: "public" });
        files[`${id}/${id.startsWith("w") ? "main.mjs" : "public/index.html"}`] = id.startsWith("w") ? "export default { fetch() { return new Response('ok'); } };" : "hello";
      }
      const source = await retainedSource(buildValidZip(files), "release.zip");
      const controller = new AbortController();
      const seen: string[] = [];
      let reached!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => { reached = resolve; });
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const original = globalThis.fetch;
      globalThis.fetch = (async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { unitId: string; phase: string };
        const key = `${body.unitId}:${body.phase}`;
        seen.push(key);
        if (key === stopAt) { reached(); await barrier; }
        return Response.json({ ok: true, phaseReceipt: key, result: body.phase === "create-worker" ? { versionId: body.unitId }
          : body.phase === "pages-deploy" ? { deploymentId: body.unitId }
          : { deployed: true, succeeded: true, bindingsVerified: true } });
      }) as typeof fetch;
      try {
        if (stopAt === "before") controller.abort();
        const running = runGraphDeploy({
          csrf: "synthetic", accountId: "a".repeat(32), source,
          configText: JSON.stringify({ units: units.map((id) => ({ id, wrangler: `${id}/wrangler.jsonc` })) }),
          releaseProof: "proof", executionContext: "context", approval: "approval",
          graphPlan: { ok: true, blocked: false, digest: "graph", guards: [],
            cost: { operations: [], requiresConfirmation: false, confirmed: true, blockedUnknownCost: false },
            units: units.map((id) => ({ unitId: id, kind: id.startsWith("w") ? "worker" : "pages-static", name: id, requiresBundle: id.startsWith("w"),
              diffs: [{ resource: id.startsWith("w") ? "worker" : "deployment", action: "create", name: id }] })),
          },
          schedulerHints: { version: 1, topoOrder: units, dependencies: [] }, signal: controller.signal,
        });
        if (stopAt !== "before" && stopAt !== "none") {
          await entered;
          controller.abort();
          release();
        }
        const result = await running;
        const expected = stopAt === "none" ? phases : stopAt === "before" ? [] : phases.slice(0, phases.indexOf(stopAt) + 1);
        expect(seen).toEqual(expected);
        expect(result.receipts).toEqual(expected);
        expect(result.ok).toBe(stopAt === "none");
        if (stopAt !== "none") expect(result.error).toBe("deploy aborted");
      } finally { globalThis.fetch = original; source.access.dispose(); }
    });
  }
});
