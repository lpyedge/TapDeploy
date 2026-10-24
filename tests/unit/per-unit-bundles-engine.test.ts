// The Pages asset hash engine is swappable (the browser passes its WASM BLAKE3) but the release identity is not:
// bundle digests, per-asset hashes and the combined root must be identical to the default engine's.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import { extractPrebuiltZip } from "../../src/release/prebuilt-zip.js";
import { buildPerUnitBundles } from "../../src/release/per-unit-bundles.js";
import { verifyPrebuiltRelease, type PrebuiltReleasePolicy } from "../../src/release/verify-prebuilt-release.js";
import { createPagesHasher } from "../../src/web/compute/pages-hasher.js";

const enc = new TextEncoder();
const wasm = () => readFileSync(new URL("../../node_modules/blake3-wasm/dist/wasm/web/blake3_js_bg.wasm", import.meta.url));
// Incompressible-looking bytes (a periodic pattern would trip the compression-ratio bound).
const bytesOf = (n: number, seed: number) => { let x = seed >>> 0 || 1; return Uint8Array.from({ length: n }, () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 24)); };
const zip = zipSync({
  "wrangler.jsonc": enc.encode(JSON.stringify({ name: "site", pages_build_output_dir: "public", compatibility_date: "2026-10-17" })),
  "public/index.html": enc.encode("<h1>x</h1>"), "public/Logo.PNG": bytesOf(5000, 3), "public/app/main.js": bytesOf(70000, 9), "public/.well-known": bytesOf(10, 1),
});
const policy: PrebuiltReleasePolicy = { appId: "a/site", allowLocalZip: true, units: [{ id: "site", kind: "pages", wrangler: "wrangler.jsonc" }] };

describe("Pages hash engine injection", () => {
  it("the WASM engine yields the identical bundles, asset hashes and root as the default engine", async () => {
    const extracted = await extractPrebuiltZip(zip);
    const options = { unitDeclarations: policy.units };
    const baseline = await buildPerUnitBundles(extracted, options);
    const hasher = await createPagesHasher(async () => wasm());
    expect(hasher.engine).toBe("wasm");
    const spy = vi.fn(hasher.hash);
    const swapped = await buildPerUnitBundles(extracted, { ...options, pagesHash: spy });
    expect(spy).toHaveBeenCalledTimes(4);
    expect(swapped).toEqual(baseline);
  });

  it("the full verification (what the browser Worker runs) is unchanged by the engine", async () => {
    const hasher = await createPagesHasher(async () => wasm());
    const [plain, accelerated] = await Promise.all([verifyPrebuiltRelease(zip, policy), verifyPrebuiltRelease(zip, policy, { pagesHash: hasher.hash })]);
    expect(plain.ok && accelerated.ok).toBe(true);
    if (plain.ok && accelerated.ok) expect(accelerated.perUnit).toEqual(plain.perUnit);
  });
});
