// Publisher contract: ordinary build+zip output round-trips through the
// V3 prebuilt path with reproducible identity and safety lint. No TapDeploy build,
// no npm, no toolchain execution happens here — inputs are plain fflate bytes,
// exactly what any author toolchain (tsc/esbuild, Vite, TinyGo, rustc,
// dotnet) would emit. Wasm fixtures assert FORMAT acceptance and byte
// integrity only; nothing here executes them (RUNTIME_UNVERIFIED by design).

import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { extractPrebuiltZip } from "../../src/release/prebuilt-zip.js";
import { buildPerUnitBundles } from "../../src/release/per-unit-bundles.js";

const enc = new TextEncoder();
// Minimal valid Wasm module (magic + version, empty body): format-real,
// executes nothing. Stands in for any toolchain's compiled `.wasm` output.
const WASM_BYTES = new Uint8Array([0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const CODE = "export default { fetch() { return new Response('ok'); } };";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function prebuilt(files: Record<string, Uint8Array>) {
  const zip = zipSync(files, { level: 0 });
  const res = await extractPrebuiltZip(zip, {});
  expect(res.ok, JSON.stringify(res.errors)).toBe(true);
  if (!res.ok || !res.files || !res.manifest) throw new Error("prebuilt extract failed");
  return res;
}

describe("publisher prebuilt roundtrip", () => {
  it("worker+R2+wasm: binary modules keep raw-byte identity, never text-decoded", async () => {
    const wasm = new Uint8Array([...WASM_BYTES, 0x01, 0x02, 0x03]);
    const zip = await prebuilt({
      "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17", r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }] })),
      "worker/main.mjs": enc.encode(CODE),
      "worker/engine.wasm": wasm,
    });
    const units = await buildPerUnitBundles(zip);
    expect(units.ok).toBe(true);
    const main = units.units!.find((u) => u.unitId === "api") ?? units.units!.find((u) => u.unitId === "main")!;
    expect(main).toBeDefined();
    const engine = main.modules.find((m) => m.path === "worker/engine.wasm")!;
    expect(engine).toBeDefined();
    expect(engine.mime).toBe("application/wasm");
    // SHA-256 over the exact raw bytes (a text round-trip would change them).
    expect(engine.sha256).toBe(await sha256Hex(wasm));
    expect(engine.size).toBe(wasm.length);
    const wrangler = main.canonicalWrangler as Record<string, unknown>;
    expect((wrangler.r2Buckets as Array<Record<string, string>>)).toContainEqual({ binding: "MEDIA", bucketName: "media" });
  });

  it("multi-unit RPC: session-bound unit ids, no cross-unit paths", async () => {
    const zip = await prebuilt({
      "units/jobs/wrangler.jsonc": enc.encode(JSON.stringify({ name: "jobs-worker", main: "main.mjs", compatibility_date: "2026-10-17" })),
      "units/jobs/main.mjs": enc.encode(CODE),
      "units/api/wrangler.jsonc": enc.encode(JSON.stringify({ name: "api-worker", main: "main.mjs", compatibility_date: "2026-10-17", services: [{ binding: "JOBS", service: "jobs-worker" }] })),
      "units/api/main.mjs": enc.encode(CODE),
    });
    const units = await buildPerUnitBundles(zip, {
      unitDeclarations: [
        { id: "jobs", kind: "worker", wrangler: "units/jobs/wrangler.jsonc" },
        { id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc" },
      ],
    });
    expect(units.ok).toBe(true);
    expect(units.units!.map((u) => u.unitId).sort()).toEqual(["api", "jobs"]);
    for (const unit of units.units!) {
      expect(unit.wranglerPath).toContain(unit.unitId === "api" ? "units/api/" : "units/jobs/");
    }
  });

  it("resource-only: no wrangler, strict exception identities", async () => {
    const zip = zipSync({ "README.md": enc.encode("resource release") }, { level: 0 });
    // The resource-only exception is policy-gated (mirrors the prepare route,
    // which passes it from the authorized session, never the browser).
    const res = await extractPrebuiltZip(zip, { allowResourceOnly: true });
    expect(res.ok, JSON.stringify(res.errors)).toBe(true);
    if (!res.ok || !res.files || !res.manifest) throw new Error("prebuilt extract failed");
    const units = await buildPerUnitBundles({ ok: true, files: res.files, manifest: res.manifest, errors: [] }, { resourceOnlyUnitIds: ["resources"] });
    expect(units.ok).toBe(true);
    expect(units.units).toHaveLength(1);
    expect(units.units![0]!.modules).toEqual([]);
  });

  it("pages static: output .js stays an asset with a publisher hash", async () => {
    const zip = await prebuilt({
      "wrangler.jsonc": enc.encode(JSON.stringify({ name: "site", compatibility_date: "2026-10-17", pages_build_output_dir: "dist" })),
      "dist/index.html": enc.encode("<h1>hi</h1>"),
      "dist/app.js": enc.encode("console.log(1)"),
    });
    const units = await buildPerUnitBundles(zip);
    expect(units.ok).toBe(true);
    const site = units.units![0]!;
    expect(site.modules).toEqual([]);
    const paths = site.assets.map((a) => a.path).sort();
    expect(paths).toEqual(["dist/app.js", "dist/index.html"]);
    for (const asset of site.assets) {
      expect(asset.pagesHash).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("reproducible identity: identical inputs yield identical bundle digests", async () => {
    const files = {
      "wrangler.jsonc": enc.encode(JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17" })),
      "worker/main.mjs": enc.encode(CODE),
    };
    const first = await buildPerUnitBundles(await prebuilt({ ...files }));
    const second = await buildPerUnitBundles(await prebuilt({ ...files }));
    expect(first.ok && second.ok).toBe(true);
    expect(first.units!.map((u) => [u.unitId, u.bundleDigest])).toEqual(second.units!.map((u) => [u.unitId, u.bundleDigest]));
    expect(first.combinedUnitRootDigest).toBe(second.combinedUnitRootDigest);
  });

  it("safety lint: secret files are refused", async () => {
    const secret = await extractPrebuiltZip(zipSync({ "wrangler.jsonc": enc.encode("{}"), ".env": enc.encode("SECRET=1") }, { level: 0 }), {});
    expect(secret.ok).toBe(false);
    expect(secret.errors.some((e) => e.includes("SECRET_FILE"))).toBe(true);
  });

  it("pages functions: _worker.js anywhere structural is refused, never silently dropped", async () => {
    const pagesWrangler = JSON.stringify({ name: "site", compatibility_date: "2026-10-17", pages_build_output_dir: "dist" });
    const cases: Array<[string, Record<string, Uint8Array>]> = [
      ["unit-root _worker.js", { "wrangler.jsonc": enc.encode(pagesWrangler), "_worker.js": enc.encode("export default {};"), "dist/index.html": enc.encode("<h1>hi</h1>") }],
      ["dist-root _worker.js", { "wrangler.jsonc": enc.encode(pagesWrangler), "dist/index.html": enc.encode("<h1>hi</h1>"), "dist/_worker.js": enc.encode("export default {};") }],
      ["unit-root functions/ tree", { "wrangler.jsonc": enc.encode(pagesWrangler), "dist/index.html": enc.encode("<h1>hi</h1>"), "functions/api.js": enc.encode("export function onRequest() {}") }],
      ["dist functions/ tree", { "wrangler.jsonc": enc.encode(pagesWrangler), "dist/index.html": enc.encode("<h1>hi</h1>"), "dist/functions/api.js": enc.encode("export function onRequest() {}") }],
    ];
    for (const [label, files] of cases) {
      const units = await buildPerUnitBundles(await prebuilt(files));
      expect(units.ok, label).toBe(false);
      expect(units.errors, label).toEqual([expect.stringMatching(/^PAGES_FUNCTIONS_UNSUPPORTED:wrangler\.jsonc:/)]);
    }
  });

  it("pages static: nested .js (even named _worker.js) stays a static asset", async () => {
    const zip = await prebuilt({
      "wrangler.jsonc": enc.encode(JSON.stringify({ name: "site", compatibility_date: "2026-10-17", pages_build_output_dir: "dist" })),
      "dist/index.html": enc.encode("<h1>hi</h1>"),
      "dist/app.js": enc.encode("console.log(1)"),
      "dist/assets/_worker.js": enc.encode("console.log('nested static')"),
    });
    const units = await buildPerUnitBundles(zip);
    expect(units.ok, JSON.stringify(units.errors)).toBe(true);
    const site = units.units![0]!;
    expect(site.modules).toEqual([]);
    expect(site.assets.map((a) => a.path).sort()).toEqual(["dist/app.js", "dist/assets/_worker.js", "dist/index.html"]);
  });
});

// ---------------------------------------------------------------------------
// every documented supported publisher shape has exactly one positive
// prepare fixture (with the exact effective values carried) plus a negative
// trust test. Values are fixture-only; no real secret is ever used.
// ---------------------------------------------------------------------------
describe("publisher fixture shapes", () => {
  it("worker + assets + r2 + cron + ratelimits carries the exact effective values", async () => {
    const zip = await prebuilt({
      "wrangler.jsonc": enc.encode(JSON.stringify({
        name: "full-worker", main: "worker/main.mjs", compatibility_date: "2026-10-17",
        workers_dev: false,
        assets: { directory: "public", binding: "ASSETS", html_handling: "auto-trailing-slash" },
        r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }],
        triggers: { crons: ["*/5 * * * *", "0 * * * *"] },
        ratelimits: [{ name: "LIMITER", namespace_id: "1001", simple: { limit: 10, period: 60 } }],
      })),
      "worker/main.mjs": enc.encode(CODE),
      "public/index.html": enc.encode("<h1>hi</h1>"),
    });
    const units = await buildPerUnitBundles(zip);
    expect(units.ok, JSON.stringify(units.errors)).toBe(true);
    const main = units.units![0]!;
    const wrangler = main.canonicalWrangler as Record<string, unknown>;
    expect(wrangler.kind).toBe("worker");
    expect(wrangler.crons).toEqual(["*/5 * * * *", "0 * * * *"]);
    expect(wrangler.ratelimits).toEqual([{ name: "LIMITER", namespace_id: "1001", limit: 10, period: 60 }]);
    expect((wrangler.r2Buckets as Array<Record<string, string>>)).toContainEqual({ binding: "MEDIA", bucketName: "media" });
    expect(main.assets.map((a) => a.path)).toEqual(["public/index.html"]);
    expect(main.modules.map((m) => m.path)).toEqual(["worker/main.mjs"]);
  });

  it("queue-only worker (no fetch handler) round-trips", async () => {
    const zip = await prebuilt({
      "wrangler.jsonc": enc.encode(JSON.stringify({
        name: "queue-only", main: "worker/main.mjs", compatibility_date: "2026-10-17", workers_dev: false,
        queues: { producers: [{ binding: "JOBS", queue: "jobs" }], consumers: [{ queue: "jobs", max_batch_size: 5 }] },
      })),
      "worker/main.mjs": enc.encode("export default { async queue(batch) { for (const m of batch.messages) m.ack(); } };"),
    });
    const units = await buildPerUnitBundles(zip);
    expect(units.ok, JSON.stringify(units.errors)).toBe(true);
    expect(units.units![0]!.modules.map((m) => m.path)).toEqual(["worker/main.mjs"]);
  });

  it("workflow + r2: the exported carrier class is proved and the schedules are carried verbatim", async () => {
    const zip = await prebuilt({
      "wrangler.jsonc": enc.encode(JSON.stringify({
        name: "wf-carrier", main: "worker/main.mjs", compatibility_date: "2026-10-17", workers_dev: false,
        workflows: [{ binding: "WF", name: "wf", class_name: "WF", schedules: ["*/5 * * * *"] }],
        r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }],
      })),
      "worker/main.mjs": enc.encode("export class WF { async run() {} }\nexport default { fetch() { return new Response('ok'); } };"),
    });
    const units = await buildPerUnitBundles(zip);
    expect(units.ok, JSON.stringify(units.errors)).toBe(true);
    const wrangler = units.units![0]!.canonicalWrangler as Record<string, unknown>;
    expect(wrangler.workflows).toEqual([{ name: "wf", binding: "WF", class_name: "WF", schedules: ["*/5 * * * *"] }]);
  });

  it("durable object: an exported class with a pure new-class migration round-trips", async () => {
    const zip = await prebuilt({
      "wrangler.jsonc": enc.encode(JSON.stringify({
        name: "do-carrier", main: "worker/main.mjs", compatibility_date: "2026-10-17", workers_dev: false,
        durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
        migrations: [{ tag: "v1", new_classes: ["Counter"] }],
      })),
      "worker/main.mjs": enc.encode("export class Counter {}\nexport default { fetch() { return new Response('ok'); } };"),
    });
    const units = await buildPerUnitBundles(zip);
    expect(units.ok, JSON.stringify(units.errors)).toBe(true);
    const wrangler = units.units![0]!.canonicalWrangler as Record<string, unknown>;
    expect(wrangler.durableObjects).toEqual([{ name: "COUNTER", class_name: "Counter" }]);
    expect(wrangler.migrations).toEqual([{ tag: "v1", new_classes: ["Counter"] }]);
  });

  it("negative: a workflow class that is not exported is refused at prepare", async () => {
    const zip = await prebuilt({
      "wrangler.jsonc": enc.encode(JSON.stringify({ name: "wf", main: "worker/main.mjs", compatibility_date: "2026-10-17", workflows: [{ binding: "WF", name: "wf", class_name: "WF" }] })),
      "worker/main.mjs": enc.encode("export default { fetch() { return new Response('ok'); } };"),
    });
    const units = await buildPerUnitBundles(zip);
    expect(units.ok).toBe(false);
    expect(units.errors[0]).toContain("WORKFLOW_CLASS_MISSING");
  });

  it("negative: a durable object class that is not exported is refused at prepare", async () => {
    const zip = await prebuilt({
      "wrangler.jsonc": enc.encode(JSON.stringify({ name: "do", main: "worker/main.mjs", compatibility_date: "2026-10-17", durable_objects: { bindings: [{ name: "C", class_name: "Missing" }] }, migrations: [{ tag: "v1", new_classes: ["Missing"] }] })),
      "worker/main.mjs": enc.encode("export default { fetch() { return new Response('ok'); } };"),
    });
    const units = await buildPerUnitBundles(zip);
    expect(units.ok).toBe(false);
    expect(units.errors[0]).toContain("DO_CLASS_MISSING");
  });
});
