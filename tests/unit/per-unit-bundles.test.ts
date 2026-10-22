import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { extractPrebuiltZip } from "../../src/release/prebuilt-zip.js";
import { buildPerUnitBundles } from "../../src/release/per-unit-bundles.js";

const enc = new TextEncoder();
const config = (name: string, main: string) => enc.encode(JSON.stringify({ name, main, compatibility_date: "2026-10-10" }));
describe("per-unit bundles", () => {
  it("derives independent unit identities from verified ZIP bytes", async () => {
    const zip = await extractPrebuiltZip(zipSync({ "units/a/wrangler.jsonc": config("a", "main.mjs"), "units/a/main.mjs": enc.encode("export default {}"), "units/b/wrangler.jsonc": config("b", "main.mjs"), "units/b/main.mjs": enc.encode("export default {}") }));
    const result = await buildPerUnitBundles(zip);
    expect(result.ok).toBe(true); expect(result.units).toHaveLength(2); expect(result.units?.[0]?.bundleDigest).not.toBe(result.units?.[1]?.bundleDigest);
  });
  it("rejects a worker whose declared main is absent", async () => {
    const zip = await extractPrebuiltZip(zipSync({ "wrangler.jsonc": config("a", "missing.mjs") }));
    await expect(buildPerUnitBundles(zip)).resolves.toMatchObject({ ok: false, errors: ["MAIN_MODULE_MISSING:wrangler.jsonc"] });
  });
  it("rejects duplicated unit identity rather than sharing authority", async () => {
    const zip = await extractPrebuiltZip(zipSync({ "units/a/wrangler.jsonc": config("same", "main.mjs"), "units/a/main.mjs": enc.encode("export default {}"), "units/b/wrangler.jsonc": config("same", "main.mjs"), "units/b/main.mjs": enc.encode("export default {}") }));
    await expect(buildPerUnitBundles(zip)).resolves.toMatchObject({ ok: false, errors: ["DUPLICATE_UNIT_ID"] });
  });
  it("permits a server-declared resource-only ZIP without inventing a Worker", async () => {
    const zip = await extractPrebuiltZip(zipSync({ "README.md": enc.encode("resources only") }), { allowResourceOnly: true });
    const result = await buildPerUnitBundles(zip, { resourceOnlyUnitIds: ["resources"] });
    expect(result).toMatchObject({ ok: true, units: [{ unitId: "resources", modules: [], assets: [] }] });
  });
  it("binds declared unit ids to exact Wrangler paths independently of provider names", async () => {
    const zip = await extractPrebuiltZip(zipSync({ "units/api/wrangler.jsonc": config("deployed-api", "main.mjs"), "units/api/main.mjs": enc.encode("export default {}") }));
    const result = await buildPerUnitBundles(zip, { unitDeclarations: [{ id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc" }] });
    expect(result).toMatchObject({ ok: true, units: [{ unitId: "api", canonicalWrangler: { name: "deployed-api" } }] });
  });
  it("keeps JavaScript under the Pages output directory as an asset", async () => {
    const zip = await extractPrebuiltZip(zipSync({ "wrangler.jsonc": enc.encode(JSON.stringify({ name: "site", pages_build_output_dir: "public", compatibility_date: "2026-10-17" })), "public/index.html": enc.encode("site"), "public/app.js": enc.encode("console.log('site')") }));
    const result = await buildPerUnitBundles(zip);
    expect(result.ok).toBe(true);
    expect(result.units?.[0]?.modules).toEqual([]);
    expect(result.units?.[0]?.assets.map(asset => asset.path)).toEqual(["public/app.js", "public/index.html"]);
  });
});
