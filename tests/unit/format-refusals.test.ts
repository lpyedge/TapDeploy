// Only Config V3 exists: any other config shape is refused by the entry
// validator (never a silent pass), and unsafe archives are refused before
// planning.

import { describe, expect, it } from "vitest";
import { validateConfigV3Entry } from "../../src/manifest/config-v3.js";
import { extractPrebuiltZip } from "../../src/release/prebuilt-zip.js";
import { buildCraftedZip, buildValidZip } from "./zip-builder.js";

const enc = new TextEncoder();

describe("format refusals", () => {
  it("a non-V3 config shape is refused by the entry validator", () => {
    for (const other of [
      { schemaVersion: 2, app: { id: "x/y", name: "X" }, targets: [{ kind: "workers" }] },
      { schemaVersion: 1, project: { id: "x/y" } },
    ]) {
      const res = validateConfigV3Entry(other);
      expect(res.ok).toBe(false);
      expect(res.errors.length).toBeGreaterThan(0);
    }
  });

  it("oversize archives are rejected before extraction", async () => {
    const bytes = buildValidZip({ "wrangler.jsonc": "{}", "worker/main.mjs": "x" });
    const res = await extractPrebuiltZip(bytes, { maxArchiveBytes: 10 });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("ARCHIVE_TOO_LARGE"))).toBe(true);
  });

  it("traversal and symlink archives are rejected before manifest handling", async () => {
    for (const entries of [
      [{ name: "../../evil.txt", content: enc.encode("x") }],
      [{ name: "link", content: enc.encode("target"), isSymlink: true }],
    ] as const) {
      const res = await extractPrebuiltZip(buildCraftedZip(entries.map((e) => ({ ...e }))), {});
      expect(res.ok).toBe(false);
    }
  });
});
