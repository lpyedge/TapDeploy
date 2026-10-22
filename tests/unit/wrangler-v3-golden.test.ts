// Golden lock for the Wrangler V3 parser: a generated corpus (every top-level
// field and every entry key of every resource family x scalar variants, path and
// JSONC edge cases) is normalized and hashed. The pinned digest was taken from
// the single-file parser before it was split into schema/keys/resources/parser
// modules; any change to accepted output, issue codes, fields or ordering moves
// it. A deliberate parser change must update the digest in the same commit.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeWranglerV3, resolveZipRelativePath, WRANGLER_V3_FIELD_MATRIX } from "../../src/manifest/wrangler-v3.js";

const workerBase = { name: "w", main: "src/index.js", compatibility_date: "2026-10-17" };
const pagesBase = { name: "p", pages_build_output_dir: "dist", compatibility_date: "2026-10-17" };
const valid: Array<[string, unknown]> = [
  ["worker-min", workerBase],
  ["pages-min", pagesBase],
  ["worker-r2-kv-d1", { ...workerBase, r2_buckets: [{ binding: "R", bucket_name: "b" }], kv_namespaces: [{ binding: "K", id: "abc" }], d1_databases: [{ binding: "D", database_name: "db", database_id: "id1" }] }],
  ["worker-queues", { ...workerBase, queues: { producers: [{ binding: "Q", queue: "jobs" }], consumers: [{ queue: "jobs", max_batch_size: 10, max_retries: 3, dead_letter_queue: "dlq" }] } }],
  ["worker-ratelimit", { ...workerBase, ratelimits: [{ name: "RL", namespace_id: "1001", simple: { limit: 5, period: 60 } }] }],
  ["worker-workflow", { ...workerBase, workflows: [{ name: "wf", binding: "WF", class_name: "WF", schedules: ["0 * * * *"] }] }],
  ["worker-do", { ...workerBase, durable_objects: { bindings: [{ name: "C", class_name: "Counter" }] }, migrations: [{ tag: "v1", new_sqlite_classes: ["Counter"] }] }],
  ["worker-do-destructive", { ...workerBase, durable_objects: { bindings: [{ name: "C", class_name: "Counter" }] }, migrations: [{ tag: "v1", renamed_classes: [{ from: "A", to: "Counter" }] }, { tag: "v2", deleted_classes: ["X"], new_classes: ["Y"] }] }],
  ["worker-services", { ...workerBase, services: [{ binding: "S", service: "other", entrypoint: "Api" }] }],
  ["worker-routes", { ...workerBase, workers_dev: true, routes: [{ pattern: "example.com/*", zone_name: "example.com" }, "x.example.com/*"] }],
  ["worker-assets", { ...workerBase, assets: { directory: "./public", binding: "ASSETS", html_handling: "auto-trailing-slash", not_found_handling: "404-page", run_worker_first: ["/api/*"] } }],
  ["worker-triggers-vars-rules", { ...workerBase, triggers: { crons: ["*/5 * * * *"] }, vars: { A: "1", B: 2, C: true }, rules: [{ type: "ESModule", globs: ["**/*.js"] }], compatibility_flags: ["nodejs_compat"], observability: { enabled: true } }],
  ["name-collision", { ...workerBase, vars: { R: "x" }, r2_buckets: [{ binding: "R", bucket_name: "b" }] }],
];
const scalarVariants: unknown[] = [null, "", "a", 1, true, [], ["a"], {}];
const entryKeys = ["binding", "bucket_name", "database_name", "database_id", "id", "preview_id", "remote", "queue", "delivery_delay", "name", "namespace_id", "simple", "limit", "period", "class_name", "script_name", "schedules", "environment", "service", "entrypoint", "props", "type", "globs", "fallthrough", "tag", "new_classes", "new_sqlite_classes", "renamed_classes", "deleted_classes", "transferred_classes", "pattern", "custom_domain", "zone_id", "zone_name", "max_batch_size", "max_batch_timeout", "max_retries", "dead_letter_queue", "max_concurrency", "retry_delay", "jurisdiction", "migrations_dir", "unknown_key"];
const sections: Array<[string, (entry: unknown) => Record<string, unknown>]> = [
  ["r2_buckets", (e) => ({ r2_buckets: [e] })], ["d1_databases", (e) => ({ d1_databases: [e] })], ["kv_namespaces", (e) => ({ kv_namespaces: [e] })],
  ["queues.producers", (e) => ({ queues: { producers: [e] } })], ["queues.consumers", (e) => ({ queues: { consumers: [e] } })],
  ["ratelimits", (e) => ({ ratelimits: [e] })], ["workflows", (e) => ({ workflows: [e] })], ["durable_objects", (e) => ({ durable_objects: { bindings: [e] } })],
  ["migrations", (e) => ({ migrations: [e] })], ["services", (e) => ({ services: [e] })], ["routes", (e) => ({ routes: [e] })], ["rules", (e) => ({ rules: [e] })],
  ["assets", (e) => ({ assets: e })], ["triggers", (e) => ({ triggers: e })], ["queues", (e) => ({ queues: e })], ["durable_objects-root", (e) => ({ durable_objects: e })],
];
const cases: Array<[string, string, string?]> = [];
const add = (id: string, value: unknown, configPath?: string) => cases.push([id, typeof value === "string" ? value : JSON.stringify(value), configPath]);
for (const [id, v] of valid) add(`valid:${id}`, v);
// every top-level field x scalar variant, on both kinds
for (const key of [...Object.keys(WRANGLER_V3_FIELD_MATRIX), "totally_unknown_field"]) {
  for (const [i, variant] of scalarVariants.entries()) {
    add(`top:worker:${key}:${i}`, { ...workerBase, [key]: variant });
    add(`top:pages:${key}:${i}`, { ...pagesBase, [key]: variant });
  }
}
// nested entry mutations: section x key x variant (worker base), plus valid-ish whole-section variants
for (const [section, wrap] of sections) {
  for (const variant of scalarVariants) add(`sec:${section}:whole:${JSON.stringify(variant)}`, { ...workerBase, ...wrap(variant) });
  for (const key of entryKeys) for (const [i, variant] of scalarVariants.entries()) add(`sec:${section}:${key}:${i}`, { ...workerBase, ...wrap({ [key]: variant }) });
}
// duplicate bindings / names across sections
add("dup:r2", { ...workerBase, r2_buckets: [{ binding: "X", bucket_name: "a" }, { binding: "X", bucket_name: "b" }] });
add("dup:kv-d1", { ...workerBase, kv_namespaces: [{ binding: "X", id: "a" }], d1_databases: [{ binding: "X", database_name: "n", database_id: "i" }] });
add("dup:queue", { ...workerBase, queues: { producers: [{ binding: "X", queue: "a" }, { binding: "Y", queue: "a" }], consumers: [{ queue: "a" }, { queue: "a" }] } });
add("dup:workflow", { ...workerBase, workflows: [{ name: "a", binding: "W", class_name: "A" }, { name: "a", binding: "W2", class_name: "B" }] });
add("dup:ratelimit", { ...workerBase, ratelimits: [{ name: "A", namespace_id: "1", simple: { limit: 1, period: 10 } }, { name: "B", namespace_id: "1", simple: { limit: 1, period: 10 } }] });
// invalid documents, comments, trailing commas, paths
add("jsonc:comments", `{ // c\n "name": "w", "main": "a.js", "compatibility_date": "2026-10-17", /* x */ }`);
add("jsonc:invalid", `{ "name": `);
add("jsonc:array-root", `[]`);
add("jsonc:null-root", `null`);
add("jsonc:empty", ``);
for (const path of ["wrangler.jsonc", "units/api/wrangler.jsonc", "a/b/c/wrangler.jsonc"]) {
  add(`path:${path}:main-rel`, { ...workerBase, main: "./src/index.js" }, path);
  add(`path:${path}:main-up`, { ...workerBase, main: "../shared/index.js" }, path);
  add(`path:${path}:main-ts`, { ...workerBase, main: "src/index.ts" }, path);
  add(`path:${path}:assets-up`, { ...workerBase, assets: { directory: "../../public" } }, path);
  add(`path:${path}:pages-dir`, { ...pagesBase, pages_build_output_dir: "./dist/../out" }, path);
}
for (const compat of ["", "2026-13-40", "2026-10-17", "bad", 5]) add(`compat:${compat}`, { ...workerBase, compatibility_date: compat });
for (const name of ["", "A", "a b", "x".repeat(70), "ok-name", 7]) add(`name:${name}`, { ...workerBase, name });


const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b))) : v));

describe("wrangler-v3 golden corpus", () => {
  const results = cases.map(([id, text, configPath]) => [id, normalizeWranglerV3(text, configPath ? { configPath } : {})] as const);

  it("pins the corpus size and the accepted/refused split", () => {
    expect(results).toHaveLength(6705);
    expect(results.filter(([, result]) => result.ok)).toHaveLength(126);
  });

  it("pins the canonical output of every case", () => {
    const out: Record<string, string> = {};
    for (const [id, result] of results) out[id] = canonical(result);
    expect(createHash("sha256").update(JSON.stringify(out)).digest("hex")).toBe("66f2f09b6076f0beb2e678ea3aa6106377e7245723f4671ef0b7dcb65725c1b4");
  });

  it("keeps strict rejections strict (spot checks)", () => {
    const refusedCodes = (id: string) => {
      const result = results.find(([name]) => name === id)![1];
      return result.ok ? [] : result.issues.map((issue) => `${issue.code}@${issue.field}`);
    };
    expect(refusedCodes("valid:name-collision")).toEqual([expect.stringContaining("INVALID_SHAPE@")]);
    expect(refusedCodes("sec:r2_buckets:jurisdiction:2")).toContain("UNSUPPORTED_WRANGLER_FEATURE@r2_buckets[0].jurisdiction");
    expect(refusedCodes("sec:kv_namespaces:unknown_key:2")).toContain("UNKNOWN_WRANGLER_FIELD@kv_namespaces[0].unknown_key");
    expect(refusedCodes("top:worker:totally_unknown_field:2")).toEqual(["UNKNOWN_WRANGLER_FIELD@totally_unknown_field"]);
    expect(refusedCodes("jsonc:invalid")).toEqual(["INVALID_JSONC@(root)"]);
  });

  it("re-exports the parser surface from one module", () => {
    expect(resolveZipRelativePath("units/api", "../shared/a.js")).toBe("units/shared/a.js");
    expect(resolveZipRelativePath("", "../a.js")).toBeNull();
    expect(Object.keys(WRANGLER_V3_FIELD_MATRIX).length).toBeGreaterThan(40);
  });
});
