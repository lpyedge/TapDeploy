import { describe, expect, it } from "vitest";
import {
  RESOURCE_MUTATION_MATRIX,
  mutationCapabilityFor,
  supportsMutation,
  mutationRequiresSeparateConfirmation,
  supportedMutations,
} from "../../src/cloudflare/resources/index.js";

// Contract: resource modify/delete operations are only offered when the
// adapter + provider actually support them, and a destructive action always
// requires a separate in-app confirmation within the same one-shot OAuth
// envelope — never an additional OAuth, never a silent cascade/delete of a
// shared store, and never on a normal upgrade.

describe("safe resource mutation capability (offline contract)", () => {
  it("exports a deterministic mutation capability matrix from the resource registry", () => {
    // The matrix is exported and accessible through the resource registry.
    expect(Array.isArray(RESOURCE_MUTATION_MATRIX)).toBe(true);
    expect(RESOURCE_MUTATION_MATRIX.length).toBeGreaterThan(0);
    // Every resource kind the installer registers is represented.
    for (const k of ["r2-bucket", "d1-database", "kv-namespace", "queue", "hyperdrive", "vectorize", "secrets-store"]) {
      expect(mutationCapabilityFor(k).operations).toBeTruthy();
    }
  });

  it("reports unsupported for immutable product fields, never as a success", () => {
    // Vectorize dimension/metric config is immutable; D1/R2 names are immutable.
    expect(supportsMutation("vectorize", "edit")).toBe(false);
    expect(supportsMutation("d1-database", "rename")).toBe(false);
    expect(supportsMutation("r2-bucket", "rename")).toBe(false);
    // An unsupported capability is not surfaced by the picker helper.
    expect(supportedMutations("vectorize", () => true).some((m) => m.operation === "edit")).toBe(false);
  });

  it("every destructive mutation carries the separate-in-app-confirmation flag", () => {
    // Unbind for a store is destructive and requires separate confirmation.
    for (const k of ["r2-bucket", "d1-database", "kv-namespace", "queue", "vectorize", "secrets-store"]) {
      const unbind = mutationCapabilityFor(k).operations.unbind;
      if (unbind?.supported) {
        expect(unbind.requiresSeparateConfirmation).toBe(true);
        expect(mutationRequiresSeparateConfirmation(k, "unbind")).toBe(true);
      }
    }
  });
});
