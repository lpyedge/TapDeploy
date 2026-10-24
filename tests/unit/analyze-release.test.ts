// The browser Worker and the server route share one verification sequence. This
// freezes that: for every archive of the 38-file corpus, the Worker's pure
// pipeline reaches the same verdict, error code, detail and summary as the real
// /api/deploy/prepare route, so the browser can neither accept what the server
// refuses nor show different failure text.

import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { deriveSealKey } from "../../src/auth/keys.js";
import { createSession, sessionCookieName } from "../../src/auth/session.js";
import type { PrebuiltReleasePolicy } from "../../src/release/verify-prebuilt-release.js";
import { analyzeRelease } from "../../src/web/compute/analyze-release.js";
import { buildReleaseFixtures } from "./release-fixtures.js";

const origin = "https://installer.example";
const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function prepareViaRoute(zip: Uint8Array, policy: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const env = { RUNTIME: "node" as const, PUBLIC_ORIGIN: origin, OAUTH_CLIENT_SECRET: secret };
  const key = await deriveSealKey(secret);
  const session = await createSession(key, { ttlMs: 120_000, publicOrigin: origin }, {
    accessToken: "offline-test-token", tokenType: "Bearer", scope: [], source: "v3", accountId: "a".repeat(32), configHash: "c".repeat(64),
    sourcePolicy: policy as NonNullable<Parameters<typeof createSession>[2]["sourcePolicy"]>,
  });
  const response = await createApp(env).request("/api/deploy/prepare", {
    method: "POST",
    headers: { origin, "x-tapdeploy-csrf": session.payload.csrf, cookie: `${sessionCookieName(origin)}=${session.cookieValue}`, "content-type": "application/zip" },
    body: zip as BodyInit,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("release analysis matches /api/deploy/prepare", () => {
  const fixtures = buildReleaseFixtures();

  it("covers the whole corpus", () => {
    expect(fixtures.filter((f) => f.kind === "positive")).toHaveLength(6);
    expect(fixtures.filter((f) => f.kind === "negative")).toHaveLength(31);
    expect(fixtures.filter((f) => f.kind === "observation")).toHaveLength(1);
  });

  // A policy without a units array is not something the browser can build
  // (the server session check refuses it before verification).
  const comparable = fixtures.filter((f) => Array.isArray(f.policy.units));

  it.each(comparable.map((f) => [f.name, f] as const))("%s", async (_name, fixture) => {
    const route = await prepareViaRoute(fixture.zip, fixture.policy);
    const analysis = await analyzeRelease(fixture.zip, fixture.policy as unknown as PrebuiltReleasePolicy);
    expect(route.status === 200).toBe(fixture.kind !== "negative");
    if (route.status === 200) {
      expect(analysis.ok).toBe(true);
      if (analysis.ok) expect(analysis.summary).toEqual(route.body.releaseSummary);
    } else {
      expect(analysis).toMatchObject({ ok: false, status: route.status, body: route.body });
    }
  }, 60_000);

  it("the server refuses a policy without units before verifying", async () => {
    const fixture = fixtures.find((f) => f.name === "neg-no-policy-units")!;
    expect(await prepareViaRoute(fixture.zip, fixture.policy)).toEqual({ status: 409, body: { error: "SOURCE_POLICY_MISMATCH" } });
  });
});
