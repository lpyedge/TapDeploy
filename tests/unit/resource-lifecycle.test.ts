import { describe, expect, it } from "vitest";
import {
  RESOURCE_MUTATION_MATRIX,
  mutationCapabilityFor,
  supportsMutation,
  mutationRequiresSeparateConfirmation,
  supportedMutations,
} from "../../src/cloudflare/resources/mutations.js";

// the resource mutation capability matrix is the single source of truth for
// which modify/rename/unbind/delete operations the installer may actually offer.
// It must be honest: an unsupported capability is never reported as success, and
// a destructive operation always needs a separate in-app confirmation.

describe("resource mutation capability matrix", () => {
  it("exposes a deterministic, non-empty matrix with honest rows", () => {
    expect(RESOURCE_MUTATION_MATRIX.length).toBeGreaterThan(0);
    const kinds = RESOURCE_MUTATION_MATRIX.map((r) => r.kind);
    // Every kind appears once.
    expect(new Set(kinds).size).toBe(kinds.length);
    // The core account resources the installer manages are all represented.
    for (const k of [
      "r2-bucket",
      "d1-database",
      "kv-namespace",
      "queue",
      "hyperdrive",
      "vectorize",
      "secrets-store",
    ]) {
      expect(kinds).toContain(k);
    }
  });

  it("never reports delete as supported for any account resource TapDeploy manages", () => {
    // TapDeploy never auto-deletes a shared store on upgrade (PASS oracle). The matrix
    // must not claim a delete capability that the installer does not safely apply.
    for (const row of RESOURCE_MUTATION_MATRIX) {
      if (row.operations.delete) {
        expect(
          row.operations.delete.supported,
          `delete must be unsupported for ${row.kind}`,
        ).toBe(false);
      }
    }
  });

  it("does not claim an unimplemented account-resource unbind execution path", () => {
    for (const k of ["r2-bucket", "d1-database", "kv-namespace", "queue", "hyperdrive", "vectorize", "secrets-store"]) {
      const cap = mutationCapabilityFor(k);
      const unbind = cap.operations.unbind;
      expect(unbind?.supported).toBe(false);
      if (unbind?.supported) {
        expect(unbind.requiresSeparateConfirmation).toBe(true);
      }
    }
  });

  it("marks immutable product fields as unsupported (Vectorize config, D1/R2 names)", () => {
    // Vectorize dimension/metric config is immutable on the live resource.
    expect(supportsMutation("vectorize", "edit")).toBe(false);
    // D1 database names are immutable (rename would recreate + migrate data).
    expect(supportsMutation("d1-database", "rename")).toBe(false);
    // R2 bucket names are immutable.
    expect(supportsMutation("r2-bucket", "rename")).toBe(false);
  });

  it("provider-editable settings are unavailable without an approved installer execution path", () => {
    expect(supportsMutation("kv-namespace", "edit")).toBe(false);
    expect(supportsMutation("queue", "edit")).toBe(false);
    expect(supportsMutation("hyperdrive", "edit")).toBe(false);
    expect(supportsMutation("secrets-store", "edit")).toBe(false);
  });

  it("resolves config resource kinds to the same canonical matrix row (kv -> kv-namespace)", () => {
    expect(supportsMutation("kv", "edit")).toBe(false);
    expect(supportsMutation("kv", "rename")).toBe(false);
    expect(supportsMutation("r2", "delete")).toBe(false);
    expect(supportsMutation("queues", "edit")).toBe(false);
    expect(supportsMutation("secrets-store", "unbind")).toBe(false);
  });

  it("returns unsupported for pseudo-resources (Workers AI / Browser Rendering) and unknown kinds", () => {
    for (const k of ["ai", "workers-ai", "browser-rendering", "browser-run", "definitely-not-a-kind"]) {
      const cap = mutationCapabilityFor(k);
      expect(cap.operations).toEqual({});
      expect(supportsMutation(k, "edit")).toBe(false);
      expect(supportsMutation(k, "unbind")).toBe(false);
      expect(supportsMutation(k, "delete")).toBe(false);
      expect(supportedMutations(k, () => true)).toEqual([]);
    }
  });

  it("surfaces only supported mutations when the config grants the allow-flag (none invented)", () => {
    // KV: config allows delete+unbind but not edit.
    const kv = supportedMutations("kv", (op) => op === "edit" || op === "unbind");
    const ops = kv.map((m) => m.operation);
    expect(ops).toEqual([]);
    // Delete is never in the supported set for an account resource.
    expect(ops).not.toContain("delete");
    // A destructive unbind always carries the separate-confirmation flag.
    expect(kv.find((m) => m.operation === "unbind")).toBeUndefined();
  });

  it("destructive operations always require a separate in-app confirmation, never a new OAuth", () => {
    expect(mutationRequiresSeparateConfirmation("r2-bucket", "unbind")).toBe(false);
    expect(mutationRequiresSeparateConfirmation("secrets-store", "unbind")).toBe(false);
    expect(mutationRequiresSeparateConfirmation("secrets-store", "edit")).toBe(false);
    // A non-destructive edit (KV) does not require a separate confirmation.
    expect(mutationRequiresSeparateConfirmation("kv-namespace", "edit")).toBe(false);
  });
});
