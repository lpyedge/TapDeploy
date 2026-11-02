// The browser Worker and the server route share one verification sequence. This
// freezes that: for every archive of the 36-file corpus, the Worker's pure
// pipeline (with the policy the browser builds from the config text) reaches the
// same verdict, error code, detail and summary as the real /api/deploy/prepare
// route given that config, so the browser can neither accept what the server
// refuses nor show different failure text.

import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { deriveSealKey } from "../../src/auth/keys.js";
import { createSession, sessionCookieName } from "../../src/auth/session.js";
import type { ConfigV3 } from "../../src/manifest/config-v3.js";
import { analyzeRelease } from "../../src/web/compute/analyze-release.js";
import { releasePolicyFromConfigText } from "../../src/web/compute/release-policy.js";
import { prepareForm, sessionBinding } from "../contracts/login.js";
import { buildReleaseFixtures } from "./release-fixtures.js";

const origin = "https://installer.example";
const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function prepareViaRoute(zip: Uint8Array, config: ConfigV3): Promise<{ status: number; body: Record<string, unknown> }> {
  const env = { RUNTIME: "node" as const, PUBLIC_ORIGIN: origin, OAUTH_CLIENT_SECRET: secret };
  const key = await deriveSealKey(secret);
  const session = await createSession(key, { ttlMs: 120_000, publicOrigin: origin }, {
    accessToken: "offline-test-token", tokenType: "Bearer", scope: [], source: "v3", accountId: "a".repeat(32), ...(await sessionBinding(config)),
  });
  const response = await createApp(env).request("/api/deploy/prepare", {
    method: "POST",
    headers: { origin, "x-tapdeploy-csrf": session.payload.csrf, cookie: `${sessionCookieName(origin)}=${session.cookieValue}` },
    body: prepareForm(JSON.stringify(config), zip),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("release analysis matches /api/deploy/prepare", () => {
  const fixtures = buildReleaseFixtures();

  it("covers the whole corpus", () => {
    expect(fixtures.filter((f) => f.kind === "positive")).toHaveLength(6);
    expect(fixtures.filter((f) => f.kind === "negative")).toHaveLength(29);
    expect(fixtures.filter((f) => f.kind === "observation")).toHaveLength(1);
  });

  it.each(fixtures.map((f) => [f.name, f] as const))("%s", async (_name, fixture) => {
    const route = await prepareViaRoute(fixture.zip, fixture.config);
    const analysis = await analyzeRelease(fixture.zip, releasePolicyFromConfigText(JSON.stringify(fixture.config))!);
    // Structurally valid historical corpus entries can be unsupported products.
    const disabledWorkerAssets = ["worker-single", "multi-unit", "worker-5MiB-asset", "worker-near-24MiB-expanded", "obs-crc-mismatch-accepted"].includes(fixture.name);
    expect(route.status === 200).toBe(fixture.kind !== "negative" && !disabledWorkerAssets);
    if (disabledWorkerAssets) expect(route).toMatchObject({ status: 409, body: { error: "WORKER_ASSETS_UNSUPPORTED" } });
    if (route.status === 200) {
      expect(analysis.ok).toBe(true);
      if (analysis.ok) expect(analysis.summary).toEqual(route.body.releaseSummary);
    } else {
      expect(analysis).toMatchObject({ ok: false, status: route.status, body: route.body });
    }
  }, 60_000);
});
