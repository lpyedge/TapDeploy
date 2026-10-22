// Scope planner regression.
//
// The planner must compute a SINGLE strongest-necessary OAuth scope bundle from
// a validated Config V3, covering BOTH install and upgrade, WITHOUT redundant
// Read where the provider accepts Write. It must never invent a scope,
// and a config can never author its own scope request.

import { describe, expect, it } from "vitest";

import { planScopesForCapabilities } from "../../src/auth/scope-planner.js";
import { SCOPE_REGISTRY } from "../../src/auth/scope-registry.js";
import {
  V3_CAPABILITIES,
  V3_CAPABILITY_META,
} from "../../src/manifest/config-v3.js";

describe("scope registry", () => {
  it("has a registered row for every scope capability", () => {
    for (const row of Object.values(SCOPE_REGISTRY)) {
      expect(row.scope.length).toBeGreaterThan(0);
      expect(row.apiTokenPermission.length).toBeGreaterThan(0);
    }
  });

  it("every registered scope is a valid scope ID", () => {
    for (const row of Object.values(SCOPE_REGISTRY)) expect(row.scope).toMatch(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/);
  });

  it("never registers a dashboard label", () => {
    for (const row of Object.values(SCOPE_REGISTRY)) {
      expect(row.scope).not.toMatch(/[A-Z]|\s/);
      expect(row.scope).not.toMatch(/:/);
    }
  });
});

describe("v3 capability planner", () => {
  // The single-source oracle table: one registry scope set per symbolic
  // capability. `workflows`/`durable-objects` ship inside the unit's Worker
  // script, so they require Workers Scripts Admin and nothing else.
  const EXPECTED: Record<string, string[]> = {
    workers: ["workers-scripts.admin"],
    pages: ["page.write"],
    r2: ["workers-r2.write"],
    d1: ["d1.write"],
    kv: ["workers-kv-storage.write"],
    queues: ["queues.write"],
    hyperdrive: ["query-cache.write"],
    vectorize: ["vectorize.write"],
    "secrets-store": ["secrets-store.write"],
    "workers-ai": ["ai.write"],
    "browser-rendering": ["browser-rendering.write"],
    routes: ["workers-routes.write"],
    dns: ["dns.write"],
    zone: ["zone.read"],
    workflows: ["workers-scripts.admin"],
    "durable-objects": ["workers-scripts.admin"],
  };

  it("maps every symbolic capability in the vocabulary to its registry scope", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...V3_CAPABILITIES].sort());
    for (const [capability, scopes] of Object.entries(EXPECTED)) {
      expect(planScopesForCapabilities([capability]).scopes, capability).toEqual(
        scopes,
      );
    }
  });

  it("a workflow + durable-objects carrier asks only Workers Admin for them", () => {
    const plan = planScopesForCapabilities(["workflows", "durable-objects"]);
    expect(plan.scopes).toEqual(["workers-scripts.admin"]);
    expect(plan.reasons).toHaveLength(1);
  });

  it("deduplicates synonyms and sorts deterministically", () => {
    const a = planScopesForCapabilities(["r2", "workers", "workflows"]);
    const b = planScopesForCapabilities(["workflows", "r2", "workers"]);
    expect(a).toEqual(b);
    expect(a.scopes).toEqual(["workers-r2.write", "workers-scripts.admin"]);
    expect(a.reasons).toHaveLength(2);
  });

  it("refuses an unknown (e.g. raw scope) symbolic capability", () => {
    expect(() =>
      planScopesForCapabilities(["workers", "workers-scripts.admin"]),
    ).toThrow(/unknown v3 capability/);
  });

  it("every v3 capability meta row references registered capabilities", () => {
    for (const capability of V3_CAPABILITIES) {
      const meta = V3_CAPABILITY_META[capability];
      expect(meta.scopeCapabilities.length).toBeGreaterThan(0);
      for (const registryCapability of meta.scopeCapabilities) {
        expect(SCOPE_REGISTRY[registryCapability]).toBeDefined();
      }
    }
  });
});
