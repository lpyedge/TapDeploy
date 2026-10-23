import { describe, expect, it } from "vitest";
import { applyResourceNames, markSwitchable, releaseResourceNames } from "../../src/core/planning/resource-names.js";
import type { DeploySpec } from "../../src/core/deploy-spec.js";
import type { ConfigV3 } from "../../src/manifest/config-v3.js";

const config = {
  schemaVersion: 3, app: { id: "a/b", name: "B" }, source: { allowLocalZip: true }, capabilities: ["workers", "pages", "r2", "d1", "queues", "vectorize"],
  units: [
    { id: "data", kind: "resources", resources: [{ kind: "vectorize", name: "docs", mode: "ensure", dimensions: 32, metric: "cosine" }] },
    { id: "main", kind: "worker", wrangler: "main/wrangler.jsonc" },
    { id: "site", kind: "pages", wrangler: "site/wrangler.jsonc" },
  ],
} as ConfigV3;
const units = [
  { unitId: "data", canonicalWrangler: {} },
  { unitId: "main", canonicalWrangler: { kind: "worker", name: "api",
    r2Buckets: [{ binding: "MEDIA", bucketName: "media" }],
    d1Databases: [{ binding: "DB", databaseName: "db" }, { binding: "OLD", databaseName: "fixed", databaseId: "id-1" }],
    queueProducers: [{ binding: "JOBS", queue: "jobs" }], queueConsumers: [{ queue: "jobs", type: "worker" }],
    vectorize: [{ binding: "VECTORS", indexName: "docs" }] } },
  { unitId: "site", canonicalWrangler: { kind: "pages", name: "site" } },
];

describe("releaseResourceNames", () => {
  it("lists every renamable name once, with the Worker bindings that use it", () => {
    expect(releaseResourceNames(units, config)).toEqual([
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
    expect(result.config.units![0]!.resources![0]!.name).toBe("my-docs");
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

describe("markSwitchable", () => {
  const specs = () => ({ main: { cloudflare: { r2: [{ binding: "MEDIA", bucketName: "media" }], d1: [{ binding: "DB", databaseName: "db" }] } } }) as unknown as Record<string, DeploySpec>;

  it("marks the bindings of the resources the config lists, and only those", () => {
    const listed = { ...config, upgrade: { switchable: ["r2:media"] } } as ConfigV3;
    expect(releaseResourceNames(units, listed).find((item) => item.key === "r2:media")?.switchable).toBe(true);
    const marked = specs();
    expect(markSwitchable(marked, units, listed)).toEqual({ ok: true });
    expect(marked.main!.cloudflare.r2![0]!.switchable).toBe(true);
    expect(marked.main!.cloudflare.d1![0]!.switchable).toBeUndefined();
  });

  it("refuses a key that is not a resource of this release", () => {
    for (const key of ["r2:other", "pages:site"]) {
      const result = markSwitchable(specs(), units, { ...config, upgrade: { switchable: [key] } } as ConfigV3);
      expect(result).toEqual({ ok: false, detail: `upgrade.switchable lists "${key}", which is not a resource of this release` });
    }
  });
});
