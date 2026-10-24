// Oracles for server-side graph authority: the browser can neither supply graph
// authority at plan time nor satisfy approval/bundle binding at step time. Every
// refusal must happen before any provider write.
import { describe, expect, it } from "vitest";
import type { ConfigV3 } from "../../src/manifest/config-v3.js";
import { graphHonoFixture } from "./graph-hono-fixture.js";

const enc = new TextEncoder();
const config: ConfigV3 = { schemaVersion: 3, app: { id: "example/negatives", name: "Negatives" }, source: { allowLocalZip: true }, capabilities: ["workers"] };
const files = {
  "wrangler.jsonc": enc.encode(JSON.stringify({ name: "neg-worker", main: "main.mjs", compatibility_date: "2026-10-17" })),
  "main.mjs": enc.encode("export default { fetch() { return new Response('ok'); } };"),
};

describe("graph authority negatives", () => {
  it.each(["bundle", "bundleDigest", "expectedUnits"] as const)("BROWSER_GRAPH_AUTHORITY_REJECTED: plan refuses browser-supplied %s", async (field) => {
    const f = await graphHonoFixture(config, files);
    const response = await f.plan({ [field]: field === "expectedUnits" ? [] : "browser-claim" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "BROWSER_GRAPH_AUTHORITY_REJECTED" });
    expect(f.writes()).toHaveLength(0);
  });

  it("GRAPH_APPROVAL_MISMATCH: step refuses a missing or tampered approval", async () => {
    const f = await graphHonoFixture(config, files);
    expect(f.plannedBody.graphPlan.blocked).toBe(false);
    const approval = f.plannedBody.approval as Record<string, unknown>;
    for (const forged of [undefined, { ...approval, ciphertext: "tampered" }]) {
      const response = await f.step("main", "worker", "create", "neg-worker", "create-worker", {}, { approval: forged });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "GRAPH_APPROVAL_MISMATCH" });
    }
    expect(f.writes()).toHaveLength(0);
  });

  it("GRAPH_BUNDLE_MISMATCH: step refuses a bundle digest that is not the sealed one", async () => {
    const f = await graphHonoFixture(config, files);
    expect(f.plannedBody.graphPlan.blocked).toBe(false);
    const response = await f.step("main", "worker", "create", "neg-worker", "create-worker", {}, { bundleDigest: "0".repeat(64) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "GRAPH_BUNDLE_MISMATCH" });
    expect(f.writes()).toHaveLength(0);
  });
});
