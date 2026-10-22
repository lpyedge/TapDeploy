// Provider version uploads accept exactly one migration object
// (Cloudflare 10021 rejects the wrangler-style array). This folds validated
// single entries and fails multi-tag histories closed with an actionable
// message instead of a provider 400.
import { describe, expect, it } from "vitest";
import { migrationObjectForUpload } from "../../src/core/deploy/wrangler-binding-plan.js";

describe("migrationObjectForUpload", () => {
  it("returns no migration for an empty list", () => {
    expect(migrationObjectForUpload([])).toEqual({ ok: true });
  });

  it("folds one pure new-class entry into the provider object", () => {
    expect(migrationObjectForUpload([{ tag: "v1", new_classes: ["Counter"] }])).toEqual({
      ok: true,
      migration: { new_tag: "v1", new_classes: ["Counter"] },
    });
  });

  it("carries new_sqlite_classes alongside new_classes", () => {
    const out = migrationObjectForUpload([{ tag: "v2", new_classes: ["A"], new_sqlite_classes: ["B"] }]);
    expect(out).toEqual({ ok: true, migration: { new_tag: "v2", new_classes: ["A"], new_sqlite_classes: ["B"] } });
  });

  it("refuses multi-tag histories instead of inventing an order", () => {
    const out = migrationObjectForUpload([
      { tag: "v1", new_classes: ["A"] },
      { tag: "v2", new_classes: ["B"] },
    ]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.detail).toMatch(/single|ordered history/i);
    // Already-deployed tags are never rewritten, so no squash is suggested.
    expect(out.detail).not.toMatch(/squash/i);
  });

  it("refuses non-object entries instead of filtering them out as no migration", () => {
    for (const entries of [[null], ["v1"], [[]], [{ tag: "v1", new_classes: ["A"] }, null]]) {
      const out = migrationObjectForUpload(entries as never);
      expect(out.ok, JSON.stringify(entries)).toBe(false);
    }
  });

  it("refuses destructive or unknown fields instead of dropping them", () => {
    const refused = [
      { tag: "v1", new_classes: ["A"], renamed_classes: [{ from: "X", to: "A" }] },
      { tag: "v1", new_classes: ["A"], deleted_classes: ["Gone"] },
      { tag: "v1", new_classes: ["A"], transferred_classes: [{ from: "X", from_script: "s", to: "A" }] },
      { tag: "v1", new_classes: ["A"], steps: [] , extra: "x" },
    ];
    for (const entry of refused) expect(migrationObjectForUpload([entry]).ok, JSON.stringify(entry)).toBe(false);
    // Empty optional lists carry no operation and are accepted.
    expect(migrationObjectForUpload([{ tag: "v1", new_classes: ["A"], renamed_classes: [], deleted_classes: [] }])).toEqual({
      ok: true,
      migration: { new_tag: "v1", new_classes: ["A"] },
    });
  });

  it("refuses malformed entries instead of forwarding them", () => {
    expect(migrationObjectForUpload([{ tag: "" }]).ok).toBe(false);
    expect(migrationObjectForUpload([{ tag: "v1", new_classes: "nope" }]).ok).toBe(false);
    expect(migrationObjectForUpload([{ tag: "v1" }]).ok).toBe(false);
  });
});
