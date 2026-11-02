// T01_V3_CONTRACT regression.
//
// The standalone public TapDeploy v3 config is the minimal author contract for the
// prebuilt-ZIP flow: schemaVersion/app/source/capabilities are required, and
// units/resources/inputs/install are opt-in. It must never express scripts/hooks/commands,
// raw OAuth scopes or arbitrary endpoints, and it must stay strictly separate
// from the v2 shapes (no fallback). This suite freezes the contract shape used
// by later tasks (parser/scope binding, UI).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFIG_V3_MAX_BYTES,
  DEFAULT_V3_UNIT_ID,
  V3_CAPABILITIES,
  V3_CAPABILITY_META,
  assertConfigV3Safe,
  canonicalizeConfigV3,
  computeConfigV3Id,
  parseConfigV3Text,
  plannedUnits,
  validateConfigV3,
  validateConfigV3Entry,
  type ConfigV3,
} from "../../src/manifest/config-v3.js";
import schemaData from "../../schemas/tapdeploy.config.v3.schema.json";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(dir, "../fixtures/prebuilt-v3/configs");

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(fixtures, `${name}.json`), "utf8")) as Record<string, unknown>;
}

function expectValid(input: unknown): ConfigV3 {
  const res = validateConfigV3Entry(input);
  expect(res.ok, `config should validate: ${!res.ok ? JSON.stringify(res.errors) : ""}`).toBe(true);
  if (!res.ok || !res.config) throw new Error("unreachable");
  return res.config;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("tapdeploy.config.v3 schema contract", () => {
  it("accepts the minimal example: schemaVersion/app/source/capabilities only", () => {
    const config = expectValid(loadFixture("minimal"));
    expect(config.schemaVersion).toBe(3);
    expect(config.app.id).toBe("example/notes");
    expect(config.capabilities).toEqual(["workers"]);
    // The minimal config never re-declares Worker/R2 details.
    expect("targets" in (config as unknown as Record<string, unknown>)).toBe(false);
    expect(config.resources).toBeUndefined();
    expect(plannedUnits(config)).toBeUndefined();
  });

  it("accepts the resource-only example (no Worker, no Pages)", () => {
    const config = expectValid(loadFixture("resource-only"));
    expect(config.units).toEqual([]);
    expect(config.resources!.map((r) => `${r.kind}:${r.name}`)).toEqual(["r2:example-data", "kv:example-cache"]);
    expect(config.capabilities).toEqual(["r2", "kv"]);
    expect(plannedUnits(config)!.map((unit) => [unit.id, unit.kind])).toEqual([["resources", "resources"]]);
  });

  it("accepts the multi-unit example with dependsOn DAG", () => {
    const config = expectValid(loadFixture("multi-unit"));
    expect(config.units!.map((u) => u.id)).toEqual(["jobs", "api"]);
    expect(config.units![1]!.dependsOn).toEqual(["jobs"]);
    expect(config.units!.map((u) => u.wrangler)).toEqual([
      "units/jobs/wrangler.jsonc",
      "units/api/wrangler.jsonc",
    ]);
  });

  it("accepts the owner-bootstrap install profile with the implicit default unit", () => {
    const config = expectValid(loadFixture("owner-bootstrap"));
    const policy = config.install!.policies[0]!;
    expect(policy.kind).toBe("private-r2-owner-bootstrap/v1");
    expect(policy.unitId).toBe(DEFAULT_V3_UNIT_ID);
    expect(policy.armValue).toBe("yes");
    expect(config.units).toBeUndefined();
  });

  it("accepts typed inputs including select options", () => {
    const config = expectValid(loadFixture("worker-inputs"));
    expect(config.inputs!.map((i) => i.key)).toEqual(["workerName", "region"]);
    expect(config.inputs![1]!.options).toHaveLength(2);
  });

  it("accepts a $schema pointer for editors", () => {
    expectValid({ ...loadFixture("minimal"), $schema: "https://raw.githubusercontent.com/lpyedge/TapDeploy/main/schemas/tapdeploy.config.v3.schema.json" });
  });

  it("no longer has an authorization block", () => {
    expect(validateConfigV3({ ...loadFixture("minimal"), authorization: { mode: "one-shot-bounded-max" } }).ok).toBe(false);
  });

  it("accepts resources with upgradeKeep / create flags and inputs with required / upgradeKeep / generate", () => {
    const base = loadFixture("minimal");
    const config = expectValid({ ...base, resources: [{ kind: "r2", name: "cache", upgradeKeep: false }, { kind: "d1", name: "main-db", create: false }], inputs: [
      { key: "EXPIRES", type: "date", label: "Expires", required: false },
      { key: "REGIONS", type: "multiselect", label: "Regions", upgradeKeep: true, options: ["eu", 3, { label: "US", value: "us" }] },
      { key: "SALT", type: "secret", label: "Salt", generate: true },
    ] });
    expect(config.resources![0]!.upgradeKeep).toBe(false);
    expect(config.inputs![1]!.options).toHaveLength(3);
    for (const bad of [
      { resources: [{ kind: "r2", name: "cache", upgradeKeep: "no" }] },
      { resources: [{ kind: "r2", name: "cache", mode: "ensure" }] },
      { inputs: [{ key: "REGIONS", type: "multiselect", label: "Regions" }] },
      { inputs: [{ key: "A", type: "string", label: "A", generate: true }] },
      { inputs: [{ key: "A", type: "string", label: "A", requiredWhen: "both" }] },
    ]) expect(validateConfigV3({ ...base, ...bad }).ok, JSON.stringify(bad)).toBe(false);
  });

  it("plans resources as one unit, a resources-only release as units: [], and refuses mistakes", () => {
    const base = loadFixture("minimal");
    const withResources = expectValid({ ...base, resources: [{ kind: "vectorize", name: "docs", dimensions: 8, metric: "cosine", upgradeKeep: false }, { kind: "kv", name: "cache", create: false }] });
    expect(plannedUnits(withResources)).toEqual([
      { id: "resources", kind: "resources", resources: [
        { kind: "vectorize", name: "docs", mode: "ensure", dimensions: 8, metric: "cosine", upgradeKeep: false },
        { kind: "kv", name: "cache", mode: "bind-existing", upgradeKeep: true },
      ] },
      { id: "main", kind: "worker", wrangler: "wrangler.jsonc" },
    ]);
    const issues = (extra: Record<string, unknown>) => assertConfigV3Safe({ ...base, ...extra } as unknown as ConfigV3).map((issue) => issue.detail);
    expect(issues({ units: [] })).toEqual(["an empty units list needs resources to create"]);
    expect(issues({ resources: [{ kind: "r2", name: "a" }, { kind: "r2", name: "a" }] })).toEqual(["duplicate resources"]);
    expect(issues({ resources: [{ kind: "vectorize", name: "docs" }] })).toEqual(['vectorize index "docs" needs dimensions and metric to be created (or set create to false)']);
    expect(issues({ resources: [{ kind: "r2", name: "a", dimensions: 3 }] })).toEqual(['dimensions/metric apply only to vectorize resources ("a")']);
    expect(issues({ units: [{ id: "resources", kind: "worker", wrangler: "w.jsonc" }] })).toEqual(['unit id "resources" is reserved for the config\'s resources']);
  });

  it("keeps the schema capability enum in sync with the code-owned vocabulary", () => {
    const schema = schemaData as unknown as {
      properties: { capabilities: { items: { enum: string[] } } };
    };
    expect(schema.properties.capabilities.items.enum).toEqual([...V3_CAPABILITIES]);
    for (const capability of V3_CAPABILITIES) {
      expect(V3_CAPABILITY_META[capability].scopeCapabilities.length).toBeGreaterThan(0);
    }
  });

  it("rejects v2 and v1 shapes as v3 configs (no fallback)", () => {
    const v2Shape = {
      schemaVersion: 2,
      app: { id: "x", name: "x" },
      source: { default: { kind: "https-zip", url: "https://example.org/x.zip" }, allowOverride: true },
      targets: [{ id: "t", kind: "workers", entrypoint: "worker/main.mjs", assetsDirectory: "public", compatibilityDate: "2025-01-01" }],
      inputs: [],
      resources: [],
    };
    expect(validateConfigV3(v2Shape).ok).toBe(false);
    expect(validateConfigV3({ schemaVersion: 1, project: { id: "x", version: "1" } }).ok).toBe(false);
  });

  it("rejects empty, duplicate and raw-scope capabilities", () => {
    const base = loadFixture("minimal");
    expect(validateConfigV3({ ...base, capabilities: [] }).ok).toBe(false);
    expect(validateConfigV3({ ...base, capabilities: ["workers", "workers"] }).ok).toBe(false);
    expect(validateConfigV3({ ...base, capabilities: ["workers-scripts.admin"] }).ok).toBe(false);
    // Duplicate capabilities are also caught by the semantic guard (defence in depth).
    const dup = { ...base, capabilities: ["workers", "workers"] } as unknown as ConfigV3;
    expect(assertConfigV3Safe(dup).some((i) => /unique/.test(i.detail))).toBe(true);
  });

  it("rejects executable / raw-scope / endpoint fields by schema (additionalProperties:false)", () => {
    const base = loadFixture("minimal");
    for (const bad of [
      { ...base, script: "rm -rf /" },
      { ...base, hook: { then: "run" } },
      { ...base, rawScope: ["workers-scripts.admin"] },
      { ...base, app: { id: "example/notes", name: "Notes", command: "npm run build" } },
      { ...base, costPolicy: { mode: "free-preferred", requireExplicitPaidConfirmation: true } },
    ]) {
      expect(validateConfigV3(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("semantic guard rejects smuggled executable/scope/endpoint shapes and non-https URL strings", () => {
    const base = expectValid(loadFixture("minimal"));
    const smuggled = clone(base) as unknown as Record<string, unknown>;
    smuggled.connection = {
      requestedScopes: ["workers-scripts.admin"],
      apiUrl: "https://evil.example/x",
      command: "rm -rf /",
    };
    smuggled.authorization = { mode: "one-shot-bounded-max", then: "deploy" };
    const issues = assertConfigV3Safe(smuggled as unknown as ConfigV3);
    expect(issues.some((i) => /scope/i.test(i.detail))).toBe(true);
    expect(issues.some((i) => /endpoint/i.test(i.detail))).toBe(true);
    expect(issues.some((i) => /executable/.test(i.detail))).toBe(true);

    const schemeSmuggle = clone(base) as unknown as ConfigV3;
    (schemeSmuggle.app as unknown as Record<string, unknown>).description = "javascript:alert(1)";
    expect(assertConfigV3Safe(schemeSmuggle).some((i) => /https/.test(i.detail))).toBe(true);
  });

  it("enforces source URL policy: https-only, no credentials, no private hosts", () => {
    const base = loadFixture("minimal");
    expect(validateConfigV3({ ...base, source: { defaultUrl: "http://insecure.example/x.zip" } }).ok).toBe(false);
    // Schema-valid URL forms the guard must still reject.
    const withUrl = (defaultUrl: string): ConfigV3 =>
      ({ ...base, source: { defaultUrl } }) as unknown as ConfigV3;
    expect(assertConfigV3Safe(withUrl("https://user:pass@example.org/x.zip")).some((i) => /credentials/.test(i.detail))).toBe(true);
    expect(assertConfigV3Safe(withUrl("https://127.0.0.1/x.zip")).some((i) => /private/.test(i.detail))).toBe(true);
    expect(assertConfigV3Safe(withUrl("https://localhost/x.zip")).some((i) => /private/.test(i.detail))).toBe(true);
  });

  it("requires defaultUrl when allowLocalZip is false (schema and guard)", () => {
    const base = loadFixture("minimal");
    expect(validateConfigV3({ ...base, source: { allowLocalZip: false } }).ok).toBe(false);
    const cast = { ...base, source: { allowLocalZip: false } } as unknown as ConfigV3;
    expect(assertConfigV3Safe(cast).some((i) => /defaultUrl is required/.test(i.detail))).toBe(true);
  });

  // The browser downloads the release, so a config without local ZIPs can only
  // be satisfied by a pinned hash; without one, /prepare could never accept it.
  it("requires expectedSha256 when allowLocalZip is false (schema and guard)", () => {
    const base = loadFixture("minimal");
    const unpinned = { ...base, source: { allowLocalZip: false, defaultUrl: "https://example.com/app.zip" } };
    expect(validateConfigV3(unpinned).ok).toBe(false);
    expect(assertConfigV3Safe(unpinned as unknown as ConfigV3).some((i) => /expectedSha256 is required/.test(i.detail))).toBe(true);
    expect(validateConfigV3Entry({ ...unpinned, source: { ...unpinned.source, expectedSha256: "a".repeat(64) } }).ok).toBe(true);
  });

  it("rejects duplicate unit ids, unknown dependencies and dependency cycles", () => {
    const base = expectValid(loadFixture("multi-unit"));

    const dupIds = clone(base) as unknown as ConfigV3;
    dupIds.units![1]!.id = "jobs";
    expect(assertConfigV3Safe(dupIds).some((i) => /unit ids must be unique/.test(i.detail))).toBe(true);

    const unknownDep = clone(base) as unknown as ConfigV3;
    unknownDep.units![1]!.dependsOn = ["nope"];
    expect(assertConfigV3Safe(unknownDep).some((i) => /unknown unit id/.test(i.detail))).toBe(true);
    expect(validateConfigV3Entry(unknownDep).ok).toBe(false);

    const cycle = clone(base) as unknown as ConfigV3;
    cycle.units![0]!.dependsOn = ["api"];
    expect(assertConfigV3Safe(cycle).some((i) => /cycle/.test(i.detail))).toBe(true);
    expect(validateConfigV3Entry(cycle).ok).toBe(false);
  });

  it("rejects malformed unit wrangler paths and empty units/policies arrays", () => {
    const base = loadFixture("minimal");
    const unit = (wrangler: string) => ({ ...base, units: [{ id: "app", kind: "worker", wrangler }] });
    expect(validateConfigV3(unit("units/app/wrangler.jsonc")).ok).toBe(true);
    expect(validateConfigV3(unit("/abs/wrangler.jsonc")).ok).toBe(false);
    expect(validateConfigV3(unit("units/../x/wrangler.jsonc")).ok).toBe(false);
    expect(validateConfigV3(unit("units/app/wrangler.toml")).ok).toBe(false);
    expect(validateConfigV3Entry({ ...base, units: [] }).ok).toBe(false);
    expect(validateConfigV3({ ...base, install: { policies: [] } }).ok).toBe(false);
  });

  it("rejects unknown install policy kinds and policies that exceed the declared capabilities", () => {
    const ownerApp = expectValid(loadFixture("owner-bootstrap"));

    const unknownKind = clone(ownerApp) as unknown as Record<string, unknown>;
    (unknownKind.install as { policies: Array<Record<string, unknown>> }).policies[0]!.kind = "arbitrary-policy/v9";
    expect(validateConfigV3(unknownKind).ok).toBe(false);

    const noR2 = clone(ownerApp) as unknown as ConfigV3;
    noR2.capabilities = ["workers"];
    expect(assertConfigV3Safe(noR2).some((i) => /capability "r2" is not declared/.test(i.detail))).toBe(true);
    expect(validateConfigV3Entry(noR2).ok).toBe(false);
  });

  it("rejects an install policy that references a unit which does not exist", () => {
    const ownerApp = expectValid(loadFixture("owner-bootstrap"));
    const withUnits = clone(ownerApp) as unknown as ConfigV3;
    withUnits.units = [{ id: "app", kind: "worker", wrangler: "units/app/wrangler.jsonc" }];
    expect(assertConfigV3Safe(withUnits).some((i) => /unknown unit id "main"/.test(i.detail))).toBe(true);
    expect(validateConfigV3Entry(withUnits).ok).toBe(false);
  });

  it("rejects a select input without options and oversized option lists", () => {
    const base = loadFixture("minimal");
    const selectInput = (extra: Record<string, unknown>) => ({
      ...base,
      inputs: [{ key: "region", type: "select", label: "Region", ...extra }],
    });
    expect(validateConfigV3(selectInput({})).ok).toBe(false);
    expect(validateConfigV3(selectInput({ options: [{ label: "Auto", value: "auto" }] })).ok).toBe(true);
    const tooMany = Array.from({ length: 65 }, (_, i) => ({ label: `Option ${i}`, value: i }));
    expect(validateConfigV3(selectInput({ options: tooMany })).ok).toBe(false);
  });

  it("bounds config text parse by size and depth", () => {
    const oversized = `"${"x".repeat(CONFIG_V3_MAX_BYTES + 1)}"`;
    const sizeResult = parseConfigV3Text(oversized);
    expect(sizeResult.ok).toBe(false);

    let deep: unknown = {};
    for (let i = 0; i < 18; i += 1) deep = { nested: deep };
    const depthResult = parseConfigV3Text(JSON.stringify(deep));
    expect(depthResult.ok).toBe(false);

    expect(parseConfigV3Text("{").ok).toBe(false);
    const ok = parseConfigV3Text(JSON.stringify(loadFixture("minimal")));
    expect(ok.ok).toBe(true);
  });

  it("computes a deterministic id over canonical normalized bytes", async () => {
    const base = expectValid(loadFixture("minimal"));
    const withDefaultSpelled: ConfigV3 = clone(base);
    const withoutDefault: ConfigV3 = clone(base);
    delete (withoutDefault.source as { allowLocalZip?: boolean }).allowLocalZip;
    expect(canonicalizeConfigV3(withDefaultSpelled)).toBe(canonicalizeConfigV3(withoutDefault));

    const reordered: ConfigV3 = {
      capabilities: base.capabilities,
      source: { defaultUrl: base.source.defaultUrl, allowLocalZip: base.source.allowLocalZip },
      app: { name: base.app.name, id: base.app.id },
      schemaVersion: 3,
    };
    const idBase = await computeConfigV3Id(base);
    expect(await computeConfigV3Id(reordered)).toBe(idBase);

    const changed = clone(base);
    changed.capabilities = ["workers", "r2"];
    expect(await computeConfigV3Id(changed)).not.toBe(idBase);
  });
});
