import { describe, expect, it } from "vitest";
import { nameRows, requestNames } from "../../src/web/name-choices.js";
import type { InventoryEnvelope, ReleaseResourceName } from "../../src/web/api.js";

const resources: ReleaseResourceName[] = [
  { key: "d1:db", kind: "d1", name: "db", bindings: [{ unitId: "main", binding: "DB" }] },
  { key: "vectorize:docs", kind: "vectorize", name: "docs", bindings: [] },
  { key: "pages:site", kind: "pages", name: "site", bindings: [] },
];
const inventory: InventoryEnvelope = { accountId: "a", names: { d1: ["db", "live-db"], vectorize: ["other-docs"], pages: ["site"] }, bindings: [{ binding: "DB", kind: "d1", name: "live-db" }] };

describe("nameRows", () => {
  it("install: editable, prefilled from the release, flags reuse and invalid names", () => {
    const rows = nameRows(resources, "install", inventory, { "vectorize:docs": "Bad Name" });
    expect(rows.map((row) => [row.key, row.mode, row.value, row.exists, Boolean(row.error)])).toEqual([
      ["d1:db", "input", "db", true, false],
      ["vectorize:docs", "input", "Bad Name", false, true],
      ["pages:site", "input", "site", true, false],
    ]);
  });

  it("upgrade: locks what the Worker binds today, otherwise picks an existing one", () => {
    const rows = nameRows(resources, "upgrade", inventory, {});
    expect(rows.map((row) => [row.key, row.mode, row.value, Boolean(row.error)])).toEqual([
      ["d1:db", "locked", "live-db", false],
      ["vectorize:docs", "select", "", true],
      ["pages:site", "select", "site", false],
    ]);
    expect(requestNames(rows)).toEqual({ "d1:db": "live-db" });
  });

  it("upgrade: a resource marked onUpgrade change stays editable, starting at what the Worker binds today", () => {
    const changeable = resources.map((item) => (item.key === "d1:db" ? { ...item, changeOnUpgrade: true as const } : item));
    const rows = nameRows(changeable, "upgrade", inventory, {});
    expect([rows[0]!.mode, rows[0]!.value, rows[0]!.exists]).toEqual(["input", "live-db", true]);
    const renamed = nameRows(changeable, "upgrade", inventory, { "d1:db": "new-db" });
    expect([renamed[0]!.value, renamed[0]!.exists, Boolean(renamed[0]!.error)]).toEqual(["new-db", false, false]);
    expect(requestNames(renamed)).toEqual({ "d1:db": "new-db" });
  });
});
