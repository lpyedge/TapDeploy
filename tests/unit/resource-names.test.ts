import { describe, expect, it } from "vitest";
import { applyResourceNames, markChangeableOnUpgrade, releaseResourceNames } from "../../src/core/planning/resource-names.js";
import type { DeploySpec } from "../../src/core/deploy-spec.js";
import { plannedUnits, type ConfigV3 } from "../../src/manifest/config-v3.js";

const config = {
  schemaVersion: 3, app: { id: "a/b", name: "B" }, source: { allowLocalZip: true }, capabilities: ["workers", "pages", "r2", "d1", "queues", "vectorize"],
  units: [
    { id: "main", kind: "worker", wrangler: "main/wrangler.jsonc" },
    { id: "site", kind: "pages", wrangler: "site/wrangler.jsonc" },
  ],
  resources: [{ kind: "vectorize", name: "docs", dimensions: 32, metric: "cosine" }],
} as ConfigV3;
const planned = (value: ConfigV3) => ({ units: plannedUnits(value) });
const units = [
  { unitId: "resources", canonicalWrangler: {} },
  { unitId: "main", canonicalWrangler: { kind: "worker", name: "api",
    r2Buckets: [{ binding: "MEDIA", bucketName: "media" }],
    d1Databases: [{ binding: "DB", databaseName: "db" }, { binding: "OLD", databaseName: "fixed", databaseId: "id-1" }],
    queueProducers: [{ binding: "JOBS", queue: "jobs" }], queueConsumers: [{ queue: "jobs", type: "worker" }],
    vectorize: [{ binding: "VECTORS", indexName: "docs" }] } },
  { unitId: "site", canonicalWrangler: { kind: "pages", name: "site" } },
];

describe("releaseResourceNames", () => {
  it("lists every renamable name once, with the Worker bindings that use it", () => {
    expect(releaseResourceNames(units, planned(config))).toEqual([
      { key: "vectorize:docs", kind: "vectorize", name: "docs", bindings: [{ unitId: "main", binding: "VECTORS" }] },
      { key: "r2:media", kind: "r2", name: "media", bindings: [{ unitId: "main", binding: "MEDIA" }] },
      { key: "d1:db", kind: "d1", name: "db", bindings: [{ unitId: "main", binding: "DB" }] },
      { key: "queue:jobs", kind: "queue", name: "jobs", bindings: [{ unitId: "main", binding: "JOBS" }] },
      { key: "pages:site", kind: "pages", name: "site", bindings: [] },
    ]);
  });
});

describe("applyResourceNames", () => {
  it("renames every use of a name across units and the config, leaving the inputs untouched", () => {
    const result = applyResourceNames(units, config, { "vectorize:docs": "my-docs", "queue:jobs": "my-jobs", "pages:site": "my-site" });
    if (!result.ok) throw new Error(result.detail);
    const main = result.units.find((unit) => unit.unitId === "main")!.canonicalWrangler as Record<string, Array<Record<string, unknown>>>;
    expect(main.vectorize![0]!.indexName).toBe("my-docs");
    expect(main.queueProducers![0]!.queue).toBe("my-jobs");
    expect(main.queueConsumers![0]!.queue).toBe("my-jobs");
    expect(main.r2Buckets![0]!.bucketName).toBe("media");
    expect((result.units.find((unit) => unit.unitId === "site")!.canonicalWrangler as { name: string }).name).toBe("my-site");
    expect(result.config.resources![0]!.name).toBe("my-docs");
    expect((units[1]!.canonicalWrangler as Record<string, Array<Record<string, unknown>>>).vectorize![0]!.indexName).toBe("docs");
  });

  it("refuses unknown keys, invalid names, an id-bound D1 and two items ending up with one name", () => {
    expect(applyResourceNames(units, config, { "r2:other": "x-bucket" }).ok).toBe(false);
    expect(applyResourceNames(units, config, { "r2:media": "Bad_Name" }).ok).toBe(false);
    expect(applyResourceNames(units, config, { "d1:fixed": "renamed" }).ok).toBe(false);
    expect(applyResourceNames(units, config, { "queue:jobs": "docs", "vectorize:docs": "docs" }).ok).toBe(true);
    expect(applyResourceNames([...units, { unitId: "two", canonicalWrangler: { kind: "worker", name: "b", r2Buckets: [{ binding: "B", bucketName: "other" }] } }], config, { "r2:other": "media" }).ok).toBe(false);
  });
});

describe("markChangeableOnUpgrade", () => {
  const specs = () => ({ main: { cloudflare: { r2: [{ binding: "MEDIA", bucketName: "media" }], d1: [{ binding: "DB", databaseName: "db" }] } } }) as unknown as Record<string, DeploySpec>;
  const withMedia = (extra: Record<string, unknown>) => ({ ...config, resources: [...config.resources!, { kind: "r2", name: "media", ...extra }] }) as ConfigV3;

  it("marks the bindings of a resource whose config entry says upgradeKeep false, and only those", () => {
    const changeable = withMedia({ upgradeKeep: false });
    expect(releaseResourceNames(units, planned(changeable)).find((item) => item.key === "r2:media")?.changeOnUpgrade).toBe(true);
    expect(releaseResourceNames(units, planned(changeable)).find((item) => item.key === "d1:db")?.changeOnUpgrade).toBeUndefined();
    const marked = specs();
    markChangeableOnUpgrade(marked, units, planned(changeable));
    expect(marked.main!.cloudflare.r2![0]!.changeOnUpgrade).toBe(true);
    expect(marked.main!.cloudflare.d1![0]!.changeOnUpgrade).toBeUndefined();
  });

  it("marks nothing for the default (keep), for upgradeKeep true, or when the config does not mention the resource", () => {
    for (const changeable of [withMedia({}), withMedia({ upgradeKeep: true }), config]) {
      const marked = specs();
      markChangeableOnUpgrade(marked, units, planned(changeable));
      expect(marked.main!.cloudflare.r2![0]!.changeOnUpgrade).toBeUndefined();
    }
  });
});
