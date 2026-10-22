// Config V3 one-shot scope + session binding regression.
//
// The v3 config's symbolic `capabilities` are the ONLY privilege input: they map
// through the code-owned scope registry into the one-shot OAuth scope bundle,
// are bound into the sealed transaction together with the canonical v3 config
// hash and the app/source policy, and are re-checked after the ZIP parses
// (subset check -> DEVELOPER_SCOPE_UNDERDECLARED). Nothing here may re-run
// authorization or expand scopes silently.

import { describe, expect, it } from "vitest";

import { prepareOAuthTxRequest, verifyGrantedScopes } from "../../src/auth/oauth-tx.js";
import {
  DEVELOPER_SCOPE_UNDERDECLARED,
  checkResolvedCapabilitiesWithin,
  planScopesForCapabilities,
} from "../../src/auth/scope-planner.js";
import { bindConfigToSession } from "../../src/core/config-envelope.js";
import {
  canonicalizeConfigV3,
  computeConfigV3Id,
  validateConfigV3Entry,
  type ConfigV3,
} from "../../src/manifest/config-v3.js";

function v3Config(overrides: Partial<ConfigV3> = {}): ConfigV3 {
  return {
    schemaVersion: 3,
    app: { id: "example/notes", name: "Example Notes" },
    source: { defaultUrl: "https://example.com/notes.zip" },
    capabilities: ["workers", "r2"],
    ...overrides,
  };
}

const SEED = {
  state: "s".repeat(24),
  nonce: "n".repeat(24),
  verifier: "v".repeat(24),
};

// A Worker config implies Zone Read + DNS Write (custom domains).

describe("v3 capability scope planning", () => {
  it("maps symbolic capabilities through the registry without redundancy", () => {
    const plan = planScopesForCapabilities([
      "workers",
      "r2",
      "workflows",
      "durable-objects",
    ]);
    expect(plan.scopes).toEqual(["workers-r2.write", "workers-scripts.admin"]);
    // One human-readable reason per distinct requested scope.
    expect(plan.reasons.map((r) => r.scope)).toEqual(plan.scopes);
    expect(plan.capabilities).toEqual(["r2-write", "worker-admin"]);
  });

  it("is deterministic regardless of declaration order", () => {
    const a = planScopesForCapabilities(["r2", "workers"]);
    const b = planScopesForCapabilities(["workers", "r2"]);
    expect(a).toEqual(b);
  });

  it("fails closed on an unknown symbolic capability", () => {
    expect(() => planScopesForCapabilities(["workers", "admin"])).toThrow(
      /unknown v3 capability/,
    );
  });
});

describe("v3 one-shot oauth transaction", () => {
  it("binds the canonical v3 hash, registry scopes and the app/source policy", async () => {
    const config = v3Config();
    const tx = await prepareOAuthTxRequest(config, SEED);

    expect(tx.v).toBe(2);
    expect(tx.configHash).toBe(await computeConfigV3Id(config));
    expect(tx.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tx.scopes).toEqual(["dns.write", "workers-r2.write", "workers-scripts.admin", "zone.read"]);
    expect(tx.capabilities).toEqual(["dns", "r2", "workers", "zone"]);
    expect(tx.appId).toBe("example/notes");
    expect(tx.source).toEqual({
      defaultUrl: "https://example.com/notes.zip",
      allowLocalZip: true,
    });
    expect(tx.modes).toEqual(["install", "upgrade"]);
    expect(tx.state).toBe(SEED.state);
    expect(tx.nonce).toBe(SEED.nonce);
    // The config text itself never carries a scope id; only the registry maps.
    expect(JSON.stringify(config)).not.toContain("workers-scripts.admin");
  });

  it("materializes the allowLocalZip default (same config, same hash)", async () => {
    const implicit = await computeConfigV3Id(
      v3Config({ source: { defaultUrl: "https://example.com/notes.zip" } }),
    );
    const explicit = await computeConfigV3Id(
      v3Config({
        source: { defaultUrl: "https://example.com/notes.zip", allowLocalZip: true },
      }),
    );
    expect(implicit).toBe(explicit);
  });

  it("re-plans the same scopes for the same config (no accretion, no second flow)", async () => {
    const first = await prepareOAuthTxRequest(v3Config(), SEED);
    const second = await prepareOAuthTxRequest(v3Config(), {
      ...SEED,
      state: "other-state-value-here!",
    });
    expect(second.scopes).toEqual(first.scopes);
    expect(second.configHash).toBe(first.configHash);

    // A changed capability set is a different config: different hash and scopes,
    // never a silent scope bump onto the existing session.
    const changedConfig = v3Config({ capabilities: ["workers", "r2", "queues"] });
    const changed = await prepareOAuthTxRequest(changedConfig, SEED);
    expect(changed.configHash).not.toBe(first.configHash);
    expect(changed.scopes).not.toEqual(first.scopes);
    expect(changed.capabilities).toEqual(["dns", "queues", "r2", "workers", "zone"]);
  });
});

describe("granted scope check", () => {
  it("a declined grant is reported as missing (never a re-authorization)", () => {
    const granted = verifyGrantedScopes(
      ["workers-r2.write", "workers-scripts.admin"],
      ["workers-scripts.admin"],
    );
    expect(granted.ok).toBe(false);
    expect(granted.missing).toEqual(["workers-r2.write"]);
    // RFC 6749 5.2: an omitted scope response means everything requested granted.
    expect(verifyGrantedScopes(["workers-scripts.admin"], undefined).ok).toBe(true);
  });

});

describe("post-ZIP capability subset check", () => {
  it("passes when every resolved capability was declared", () => {
    const check = checkResolvedCapabilitiesWithin(
      ["workers", "r2"],
      ["r2", "workers"],
    );
    expect(check.ok).toBe(true);
    expect(check.undeclared).toEqual([]);
  });

  it("fails with DEVELOPER_SCOPE_UNDERDECLARED listing the missing capabilities", () => {
    const check = checkResolvedCapabilitiesWithin(
      ["workers"],
      ["queues", "workers", "r2", "queues"],
    );
    expect(check.ok).toBe(false);
    expect(check.error).toBe(DEVELOPER_SCOPE_UNDERDECLARED);
    expect(check.undeclared).toEqual(["queues", "r2"]);
    expect(check.detail).toContain("did not declare");
    expect(check.detail).toContain("r2");
    expect(check.detail).toContain("no additional permission was requested");
  });

  it("treats an unknown resolved capability as undeclared (fail closed)", () => {
    const check = checkResolvedCapabilitiesWithin(
      ["workers"],
      ["workers", "mystery-capability"],
    );
    expect(check.ok).toBe(false);
    expect(check.undeclared).toEqual(["mystery-capability"]);
  });
});

describe("v3 session binding", () => {
  it("accepts the same config and refuses a changed one (no second oauth)", async () => {
    const text = JSON.stringify(v3Config());
    const hash = await computeConfigV3Id(v3Config());

    const same = await bindConfigToSession({
      sessionConfigHash: hash,
      configText: text,
    });
    expect(same.ok).toBe(true);

    const changed = await bindConfigToSession({
      sessionConfigHash: hash,
      configText: JSON.stringify(v3Config({ capabilities: ["workers", "r2", "queues"] })),
    });
    expect(changed.ok).toBe(false);
    if (!changed.ok) {
      expect(changed.error).toBe("config_mismatch");
      expect(changed.detail).toContain("start a new authorization");
    }
  });

  it("the canonical hash is key-order stable", async () => {
    const a = v3Config();
    const b = JSON.parse(
      JSON.stringify({
        capabilities: ["workers", "r2"],
        source: { defaultUrl: "https://example.com/notes.zip" },
        app: { name: "Example Notes", id: "example/notes" },
        schemaVersion: 3,
      }),
    ) as ConfigV3;
    expect(canonicalizeConfigV3(a)).toBe(canonicalizeConfigV3(b));
    expect(await computeConfigV3Id(a)).toBe(await computeConfigV3Id(b));
  });

  it("distinguishes missing, invalid and mismatched configs", async () => {
    const missing = await bindConfigToSession({
      sessionConfigHash: "x",
      configText: "   ",
    });
    expect(missing).toEqual({
      ok: false,
      error: "config_required",
      detail: "requests must carry the config",
    });

    const invalid = await bindConfigToSession({
      sessionConfigHash: "x",
      configText: "{ nope",
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error).toBe("invalid_config");

    // A v2 text is not silently accepted by the v3 path.
    const v2 = await bindConfigToSession({
      sessionConfigHash: "x",
      configText: JSON.stringify({ schemaVersion: 2 }),
    });
    expect(v2.ok).toBe(false);
    if (!v2.ok) expect(v2.error).toBe("invalid_config");
  });

  it("rejects smuggled raw scopes at the v3 entry pipeline", () => {
    const smuggled = { ...v3Config(), requestedScopes: ["workers-scripts.admin"] };
    expect(validateConfigV3Entry(smuggled).ok).toBe(false);

    const rawCapability = { ...v3Config(), capabilities: ["workers-scripts.admin"] };
    expect(validateConfigV3Entry(rawCapability).ok).toBe(false);
  });
});