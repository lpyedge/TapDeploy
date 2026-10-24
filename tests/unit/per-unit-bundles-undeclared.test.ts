import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { extractPrebuiltZip } from "../../src/release/prebuilt-zip.js";
import { buildPerUnitBundles } from "../../src/release/per-unit-bundles.js";

const enc = new TextEncoder();
const config = (name: string) => enc.encode(JSON.stringify({ name, main: "main.mjs", compatibility_date: "2026-10-10" }));
const worker = (dir: string, name: string) => ({ [`${dir}/wrangler.jsonc`]: config(name), [`${dir}/main.mjs`]: enc.encode("export default {}") });

describe("undeclared Wrangler configs (UNDECLARED_WRANGLER oracle)", () => {
  it("rejects a Wrangler config the source policy did not declare", async () => {
    const zip = await extractPrebuiltZip(zipSync({ ...worker("units/api", "api"), ...worker("units/extra", "extra") }));
    await expect(buildPerUnitBundles(zip, { unitDeclarations: [{ id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc" }] }))
      .resolves.toMatchObject({ ok: false, errors: ["UNDECLARED_WRANGLER:units/extra/wrangler.jsonc"] });
  });
  it("rejects a declared path whose Wrangler kind differs from the declaration", async () => {
    const zip = await extractPrebuiltZip(zipSync(worker("units/api", "api")));
    await expect(buildPerUnitBundles(zip, { unitDeclarations: [{ id: "api", kind: "pages", wrangler: "units/api/wrangler.jsonc" }] }))
      .resolves.toMatchObject({ ok: false, errors: ["UNDECLARED_WRANGLER:units/api/wrangler.jsonc"] });
  });
});
