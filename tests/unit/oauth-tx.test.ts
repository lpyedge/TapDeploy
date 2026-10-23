// Config-bounded one-shot OAuth transaction regression.
//
// The transaction must bind the canonical config hash, the exact derived scope
// set, the declared capabilities, the app/source policy and the modes. The
// callback verifies that the granted scope set covers every
// requested scope; a declined scope blocks rather than silently re-authorizing.

import { describe, expect, it } from "vitest";

import {
  prepareOAuthTxRequest,
  verifyGrantedScopes,
} from "../../src/auth/oauth-tx.js";
import type { ConfigV3 } from "../../src/manifest/config-v3.js";

function config(capabilities: string[], units: ConfigV3["units"] = [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }]): ConfigV3 {
  return {
    schemaVersion: 3,
    app: { id: "example/notes-service", name: "Notes" },
    source: { allowLocalZip: true },
    capabilities,
    units,
  } as ConfigV3;
}

const seed = { state: "state-abc", nonce: "nonce-xyz", verifier: "verifier-long-value" };

describe("prepareOAuthTxRequest", () => {
  it("binds config hash + derived scopes + capabilities + source policy + modes", async () => {
    const tx = await prepareOAuthTxRequest(config(["workers", "r2"]), seed);
    expect(tx.v).toBe(2);
    expect(tx.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tx.scopes).toEqual(["dns.write", "workers-r2.write", "workers-scripts.admin", "zone.read"]);
    expect(tx.capabilities).toEqual(["dns", "r2", "workers", "zone"]);
    expect(tx.appId).toBe("example/notes-service");
    expect(tx.source).toEqual({ allowLocalZip: true });
    expect(tx.units).toEqual([{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }]);
    expect(tx.modes).toEqual(["install", "upgrade"]);
    expect(tx.state).toBe("state-abc");
  });

  it("derives the Pages scope plus the custom-domain scopes for a pages config", async () => {
    const tx = await prepareOAuthTxRequest(config(["pages"], [{ id: "site", kind: "pages", wrangler: "wrangler.jsonc" }]), seed);
    expect(tx.scopes).toEqual(["dns.write", "page.write", "zone.read"]);
  });

  it("a resource-only config implies no custom-domain scopes", async () => {
    const tx = await prepareOAuthTxRequest({ ...config(["r2"], []), resources: [{ kind: "r2", name: "data" }] }, seed);
    expect(tx.scopes).toEqual(["workers-r2.write"]);
  });

  it("never lets a config author its own scope (planner-derived only)", async () => {
    const smuggled = { ...config(["workers", "r2"]), requestedScopes: ["admin"] } as unknown as ConfigV3;
    const tx = await prepareOAuthTxRequest(smuggled, seed);
    expect(tx.scopes).toEqual(["dns.write", "workers-r2.write", "workers-scripts.admin", "zone.read"]);
  });
});

describe("verifyGrantedScopes", () => {
  it("treats an omitted scope as all-requested granted", () => {
    expect(verifyGrantedScopes(["a", "b"], undefined)).toEqual({ ok: true, missing: [] });
  });
  it("an explicit empty grant is not an omitted scope and cannot authorize writes", () => {
    expect(verifyGrantedScopes(["a", "b"], [])).toEqual({ ok: false, missing: ["a", "b"] });
  });

  it("passes when the granted set covers every requested scope", () => {
    expect(verifyGrantedScopes(["a.write", "b.write"], ["a.write", "b.write"])).toEqual({
      ok: true,
      missing: [],
    });
  });

  it("fails (blocks) when a necessary scope was declined", () => {
    const res = verifyGrantedScopes(["a.write", "b.write"], ["a.write"]);
    expect(res.ok).toBe(false);
    expect(res.missing).toEqual(["b.write"]);
  });

  it("does not stop for scopes the client did not actually request", () => {
    const res = verifyGrantedScopes(["a.write"], ["a.write", "extra.write"]);
    expect(res.ok).toBe(true);
  });
});
