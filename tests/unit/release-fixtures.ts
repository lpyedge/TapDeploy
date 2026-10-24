// The 38-archive release corpus (6 accepted, 31 refused, 1 observation) shared by the
// server-route parity test and the browser Worker probe. Built deterministically at
// test time; nothing here is a checked-in binary.
import { zipSync } from "fflate";
import { buildCraftedZip } from "./zip-builder.js";

export interface ReleaseFixture {
  name: string;
  kind: "positive" | "negative" | "observation";
  policy: Record<string, unknown>;
  zip: Uint8Array;
}

function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => (s ^= s << 13, s ^= s >>> 17, s ^= s << 5, s >>> 0);
}
function bytesOf(len: number, seed: number): Uint8Array {
  const r = prng(seed), out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = r() & 255;
  return out;
}

export function buildReleaseFixtures(): ReleaseFixture[] {
  const enc = new TextEncoder();
  const MiB = 1024 * 1024;
  const sym4 = (len: number, seed: number) => { const r = prng(seed), o = new Uint8Array(len); for (let i = 0; i < len; i++) o[i] = 65 + (r() & 3); return o; }; // 4 symbols: ~4x compressible
  const wr = (o: object) => enc.encode(JSON.stringify({ compatibility_date: "2026-10-17", ...o }));
  const MAIN = enc.encode("import { x } from './extra.mjs';\nexport default { fetch() { return new Response(x); } };\n");
  const EXTRA = enc.encode("export const x = 'ok';\n");
  const assets = (prefix: string, n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}/a/chunk-${i}.${i % 3 ? "js" : "css"}`, bytesOf(200 + (i * 37) % 3000, 700 + i)]));
  const workerPolicy = { appId: "example/api", allowLocalZip: true, units: [{ id: "api", kind: "worker", wrangler: "wrangler.jsonc" }] };
  const workerFiles = (extra: Record<string, Uint8Array> = {}, wrangler: object = { name: "api", main: "worker/main.mjs", assets: { directory: "public" } }) => ({
    "wrangler.jsonc": wr(wrangler), "worker/main.mjs": MAIN, "worker/extra.mjs": EXTRA, "worker/mod.wasm": new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    "public/index.html": enc.encode("<h1>hi</h1>"), ...extra,
  });
  const fx: ReleaseFixture[] = [];
  const add = (name: string, kind: ReleaseFixture["kind"], zip: Uint8Array, policy: Record<string, unknown> = workerPolicy) => fx.push({ name, kind, policy, zip });

  // positives
  add("worker-single", "positive", zipSync({ ...workerFiles(assets("public", 220)) }));
  add("pages", "positive", zipSync({ "wrangler.jsonc": wr({ name: "site", pages_build_output_dir: "public" }), "public/index.html": enc.encode("<h1>site</h1>"), "public/Logo.PNG": bytesOf(900, 3), ...assets("public", 40) }), { appId: "example/site", allowLocalZip: true, units: [{ id: "site", kind: "pages", wrangler: "wrangler.jsonc" }] });
  add("multi-unit", "positive", zipSync({
    "units/jobs/wrangler.jsonc": wr({ name: "jobs", main: "main.mjs" }), "units/jobs/main.mjs": EXTRA,
    "units/api/wrangler.jsonc": wr({ name: "api", main: "main.mjs", assets: { directory: "public" } }), "units/api/main.mjs": MAIN.slice(), "units/api/public/index.html": enc.encode("api"),
    "units/site/wrangler.jsonc": wr({ name: "site", pages_build_output_dir: "dist" }), "units/site/dist/index.html": enc.encode("site"),
  }), { appId: "example/stack", allowLocalZip: true, units: [{ id: "jobs", kind: "worker", wrangler: "units/jobs/wrangler.jsonc" }, { id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc" }, { id: "site", kind: "pages", wrangler: "units/site/wrangler.jsonc" }] });
  add("resource-only", "positive", zipSync({ "README.md": enc.encode("resources only") }), { appId: "example/res", allowLocalZip: true, units: [{ id: "resources", kind: "resources" }] });
  add("worker-5MiB-asset", "positive", zipSync({ ...workerFiles({ "public/big.wasm": bytesOf(5 * MiB, 55) }) }, { level: 0 }));
  add("worker-near-24MiB-expanded", "positive", zipSync({ ...workerFiles({ "public/p1.bin": sym4(7.3 * MiB | 0, 1), "public/p2.bin": sym4(7.3 * MiB | 0, 2), "public/p3.bin": sym4(7.3 * MiB | 0, 3) }) }, { level: 6 }));
  // negatives
  const craft = (entries: { name: string; content?: Uint8Array; isSymlink?: boolean }[]) => buildCraftedZip(entries.map((e) => ({ name: e.name, content: e.content ?? enc.encode("x"), ...(e.isSymlink ? { isSymlink: true } : {}) })));
  const base = (extra: Record<string, Uint8Array>, w?: object) => zipSync(workerFiles(extra, w));
  const W = wr({ name: "api", main: "worker/main.mjs" });
  const okEntries = [{ name: "wrangler.jsonc", content: W }, { name: "worker/main.mjs", content: MAIN }, { name: "worker/extra.mjs", content: EXTRA }];
  add("neg-traversal", "negative", craft([...okEntries, { name: "../evil.js" }]));
  add("neg-absolute", "negative", craft([...okEntries, { name: "/abs.js" }]));
  add("neg-backslash", "negative", craft([...okEntries, { name: "a\\..\\b.js" }]));
  add("neg-symlink", "negative", craft([...okEntries, { name: "link.js", isSymlink: true }]));
  add("neg-duplicate", "negative", craft([...okEntries, { name: "dup.js" }, { name: "dup.js" }]));
  add("neg-case-collision", "negative", craft([...okEntries, { name: "Public/A.js" }, { name: "public/a.js" }]));
  add("neg-env-file", "negative", base({ ".env": enc.encode("SECRET=1") }));
  add("neg-dev-vars", "negative", base({ "worker/.dev.vars": enc.encode("A=1") }));
  add("neg-private-key", "negative", base({ "worker/server.pem": enc.encode("k") }));
  add("neg-node-modules", "negative", base({ "node_modules/x/index.js": enc.encode("x") }));
  add("neg-wrangler-toml", "negative", base({ "wrangler.toml": enc.encode("name='x'") }));
  add("neg-typescript", "negative", base({ "worker/main.ts": enc.encode("export {}") }));
  add("neg-exec-hook", "negative", base({ "postinstall.sh": enc.encode("#!/bin/sh") }));
  add("neg-no-wrangler", "negative", zipSync({ "worker/main.mjs": MAIN }));
  add("neg-bomb-ratio", "negative", zipSync({ ...workerFiles({ "public/zeros.bin": new Uint8Array(7 * MiB) }) }, { level: 9 }));
  add("neg-oversize-compressed-9MiB", "negative", zipSync({ ...workerFiles({ "public/rnd.bin": bytesOf(9 * MiB, 99) }) }, { level: 0 }));
  add("neg-expanded-over-24MiB", "negative", zipSync({ ...workerFiles({ "public/p1.bin": sym4(7.5 * MiB | 0, 11), "public/p2.bin": sym4(7.5 * MiB | 0, 12), "public/p3.bin": sym4(7.5 * MiB | 0, 13), "public/p4.bin": sym4(2 * MiB, 14) }) }, { level: 6 }));
  add("neg-file-over-8MiB", "negative", zipSync({ ...workerFiles({ "public/one.bin": sym4(9 * MiB, 21) }) }, { level: 6 }));
  add("neg-too-many-files", "negative", zipSync({ ...workerFiles(Object.fromEntries(Array.from({ length: 1030 }, (_, i) => [`public/f${i}.txt`, enc.encode(String(i))]))) }));
  add("neg-bad-utf8-wrangler", "negative", zipSync({ "wrangler.jsonc": new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), "worker/main.mjs": MAIN }));
  add("neg-garbage", "negative", bytesOf(1000, 4));
  add("neg-empty-zip", "negative", zipSync({}));
  add("neg-truncated", "negative", (() => { const z = zipSync(workerFiles()); return z.slice(0, z.length - 10); })());
  add("neg-undeclared-wrangler", "negative", zipSync(workerFiles()), { ...workerPolicy, units: [{ id: "api", kind: "worker", wrangler: "other/wrangler.jsonc" }] });
  add("neg-kind-mismatch", "negative", zipSync(workerFiles()), { ...workerPolicy, units: [{ id: "api", kind: "pages", wrangler: "wrangler.jsonc" }] });
  add("neg-main-missing", "negative", zipSync({ "wrangler.jsonc": wr({ name: "api", main: "nope.mjs" }) }));
  add("neg-pages-functions", "negative", zipSync({ "wrangler.jsonc": wr({ name: "site", pages_build_output_dir: "public" }), "public/index.html": enc.encode("x"), "functions/api.js": enc.encode("x") }), { appId: "example/site", allowLocalZip: true, units: [{ id: "site", kind: "pages", wrangler: "wrangler.jsonc" }] });
  add("neg-pages-control-file", "negative", zipSync({ "wrangler.jsonc": wr({ name: "site", pages_build_output_dir: "public" }), "public/_headers": enc.encode("/*\n X: 1") }), { appId: "example/site", allowLocalZip: true, units: [{ id: "site", kind: "pages", wrangler: "wrangler.jsonc" }] });
  add("neg-pinned-sha-mismatch", "negative", zipSync(workerFiles()), { ...workerPolicy, expectedSha256: "0".repeat(64) });
  add("neg-local-zip-forbidden", "negative", zipSync(workerFiles()), { ...workerPolicy, allowLocalZip: false });
  add("neg-no-policy-units", "negative", zipSync(workerFiles()), { appId: "example/api", allowLocalZip: true });
  add("obs-crc-mismatch-accepted", "observation", (() => { const z = zipSync(workerFiles(), { level: 0 }).slice(); const i = Buffer.from(z).indexOf(Buffer.from("<h1>hi</h1>")); z[i] = z[i]! ^ 0xff; return z; })());
  return fx;
}
