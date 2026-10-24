import { describe, expect, it } from "vitest";
import { prepareOAuthTxRequest } from "../../src/auth/oauth-tx.js";
import type { ConfigV3 } from "../../src/manifest/config-v3.js";
import { releasePolicyFromConfigText } from "../../src/web/compute/release-policy.js";

const seed = { state: "s", nonce: "n", verifier: "v".repeat(43) };
const configs: ConfigV3[] = [
  { schemaVersion: 3, app: { id: "a/one", name: "One" }, source: { allowLocalZip: true }, capabilities: ["workers"] },
  { schemaVersion: 3, app: { id: "a/two", name: "Two" }, source: { defaultUrl: "https://example.com/x.zip", allowLocalZip: false, expectedSha256: "f".repeat(64) }, capabilities: ["workers", "pages", "r2"], units: [{ id: "api", kind: "worker", wrangler: "units/api/wrangler.jsonc" }, { id: "site", kind: "pages", wrangler: "units/site/wrangler.jsonc" }], resources: [{ kind: "r2", name: "media" }] },
  { schemaVersion: 3, app: { id: "a/three", name: "Three" }, source: { defaultUrl: "https://example.com/y.zip" }, capabilities: ["r2"], units: [], resources: [{ kind: "r2", name: "media" }] },
];

describe("releasePolicyFromConfigText", () => {
  it.each(configs.map((config) => [config.app.id, config] as const))("equals the policy the server seals for %s", async (_id, config) => {
    const tx = await prepareOAuthTxRequest(config, seed);
    expect(releasePolicyFromConfigText(JSON.stringify(config))).toEqual({ ...tx.source, appId: tx.appId, units: tx.units });
  });
  it("returns null for text that is not a config", () => {
    expect(releasePolicyFromConfigText("not json")).toBeNull();
    expect(releasePolicyFromConfigText("{}")).toBeNull();
    expect(releasePolicyFromConfigText(JSON.stringify({ app: { id: "x" } }))).toBeNull();
  });
});
