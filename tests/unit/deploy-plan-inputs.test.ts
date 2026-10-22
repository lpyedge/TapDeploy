// Operator-renamable Worker identity: preparedGraphInputs honors a declared
// non-secret `workerName` input (server-side validated, publisher opt-in) and
// fails closed otherwise. Pure function: no provider calls by construction.
import { describe, expect, it } from "vitest";
import { preparedGraphInputs } from "../../src/api/routes/deploy-plan.js";
import type { ConfigV3 } from "../../src/manifest/config-v3.js";

const baseConfig = (inputs: ConfigV3["inputs"] = []): ConfigV3 => ({
  schemaVersion: 3,
  app: { id: "example/renamed", name: "Renamed" },
  source: { allowLocalZip: true },
  capabilities: ["workers"],
  ...(inputs.length ? { inputs } : {}),
});

const workerNameInput: ConfigV3["inputs"] = [
  {
    key: "workerName",
    type: "string",
    label: "Worker name",
    requiredWhen: "install",
    validation: { minLength: 3, maxLength: 63, pattern: "^[a-z0-9-]+$" },
  },
];

const unit = (overrides: Record<string, unknown> = {}) => ({
  unitId: "main",
  canonicalWrangler: {
    kind: "worker",
    name: "release-fixed",
    compatibility_date: "2026-10-17",
    compatibility_flags: [],
    ...overrides,
  },
  wranglerPath: "wrangler.jsonc",
  wranglerSha256: "a".repeat(64),
  wranglerEffectiveHash: "b".repeat(64),
  modules: [{ path: "worker/main.mjs", sha256: "c".repeat(64), size: 10, mime: "application/javascript+module" as const }],
  assets: [],
  mainModule: { path: "worker/main.mjs", sha256: "c".repeat(64), size: 10 },
  bundleDigest: "d".repeat(64),
});

describe("preparedGraphInputs workerName override", () => {
  it("keeps the release name when no override is supplied", () => {
    const out = preparedGraphInputs(baseConfig(workerNameInput), [unit()], "a".repeat(64), "m".repeat(64), {});
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.specs["main"]?.cloudflare.workerName).toBe("release-fixed");
  });

  it("applies a declared, valid workerName to the sealed spec", () => {
    const out = preparedGraphInputs(baseConfig(workerNameInput), [unit()], "a".repeat(64), "m".repeat(64), { workerName: "renamed-worker" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.specs["main"]?.cloudflare.workerName).toBe("renamed-worker");
    expect((out.specs["main"]?.wrangler as { name?: string }).name).toBe("renamed-worker");
  });

  it("applies a baseline-valid override even without a declared input", () => {
    const out = preparedGraphInputs(baseConfig(), [unit()], "a".repeat(64), "m".repeat(64), { workerName: "renamed-worker" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.specs["main"]?.cloudflare.workerName).toBe("renamed-worker");
  });

  it("refuses values outside the declared pattern", () => {
    const out = preparedGraphInputs(baseConfig(workerNameInput), [unit()], "a".repeat(64), "m".repeat(64), { workerName: "Bad_Name!" });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.detail).toContain("pattern");
  });

  it("refuses values outside the safe baseline even without declared validation", () => {
    const loose: ConfigV3["inputs"] = [{ key: "workerName", type: "string", label: "Worker name", requiredWhen: "both" }];
    const out = preparedGraphInputs(baseConfig(loose), [unit()], "a".repeat(64), "m".repeat(64), { workerName: "UPPER" });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.detail).toContain("a-z0-9");
  });

  it("refuses the override for multi-worker releases", () => {
    const config: ConfigV3 = {
      ...baseConfig(workerNameInput),
      units: [
        { id: "jobs", kind: "worker", wrangler: "units/jobs/wrangler.jsonc" },
        { id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc" },
      ],
    };
    const units = [
      { ...unit(), unitId: "jobs", canonicalWrangler: { ...(unit().canonicalWrangler as object), name: "jobs-worker" } },
      { ...unit(), unitId: "api", canonicalWrangler: { ...(unit().canonicalWrangler as object), name: "api-worker" } },
    ];
    const out = preparedGraphInputs(config, units, "a".repeat(64), "m".repeat(64), { workerName: "renamed" });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.detail).toContain("one worker unit");
  });

  it("applies the override to the worker of a worker+pages release", () => {
    const config: ConfigV3 = {
      ...baseConfig(workerNameInput),
      units: [
        { id: "main", kind: "worker", wrangler: "wrangler.jsonc" },
        { id: "site", kind: "pages", wrangler: "units/site/wrangler.jsonc" },
      ],
    };
    const units = [
      unit(),
      {
        ...unit(),
        unitId: "site",
        canonicalWrangler: { kind: "pages", name: "site", compatibility_date: "2026-10-17", compatibility_flags: [] },
        wranglerPath: "units/site/wrangler.jsonc",
        modules: [],
        mainModule: undefined,
      },
    ];
    const out = preparedGraphInputs(config, units, "a".repeat(64), "m".repeat(64), { workerName: "renamed-worker" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.specs["main"]?.cloudflare.workerName).toBe("renamed-worker");
    expect((out.specs["site"]?.cloudflare as { pages?: { projectName?: string } }).pages?.projectName).toBe("site");
  });

  it("defaults the pages production branch to main unless the release declares one", () => {
    const config: ConfigV3 = {
      schemaVersion: 3,
      app: { id: "example/site", name: "Site" },
      source: { allowLocalZip: true },
      capabilities: ["pages"],
      units: [{ id: "site", kind: "pages", wrangler: "wrangler.jsonc" }],
    };
    const siteUnit = (wrangler: Record<string, unknown>) => ({
      ...unit(),
      unitId: "site",
      canonicalWrangler: { kind: "pages", name: "site", compatibility_date: "2026-10-17", compatibility_flags: [] as string[], ...wrangler },
      wranglerPath: "wrangler.jsonc",
      modules: [],
      mainModule: undefined,
    });
    const plain = preparedGraphInputs(config, [siteUnit({})], "a".repeat(64), "m".repeat(64), {});
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect((plain.specs["site"]?.cloudflare as { pages?: { productionBranch?: string } }).pages?.productionBranch).toBe("main");
    const declared = preparedGraphInputs(config, [siteUnit({ production_branch: "staging" })], "a".repeat(64), "m".repeat(64), {});
    expect(declared.ok).toBe(true);
    if (!declared.ok) return;
    expect((declared.specs["site"]?.cloudflare as { pages?: { productionBranch?: string } }).pages?.productionBranch).toBe("staging");
  });
});
