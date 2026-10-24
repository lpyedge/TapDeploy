// What the step route says when Cloudflare itself answers about the credentials.
// A rejected token is an auth state the browser can act on (401: sign in again);
// a valid token that lacks the permission is a different one (403: signing in
// again will not help); only a genuinely missing target is a 404. Neither
// may be reported as "not found", and none may leave a write behind.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigV3 } from "../../src/manifest/config-v3.js";
import { graphHonoFixture } from "./graph-hono-fixture.js";

afterEach(() => vi.unstubAllGlobals());

const enc = new TextEncoder();
const config: ConfigV3 = { schemaVersion: 3, app: { id: "example/auth", name: "Auth" }, source: { allowLocalZip: true }, capabilities: ["r2"], units: [], resources: [{ kind: "r2", name: "media" }] };

async function stepWithProviderAnswer(status: number) {
  const f = await graphHonoFixture(config, { "README.md": enc.encode("resource release") });
  expect(f.plannedBody.graphPlan.blocked).toBe(false);
  const calls: Array<{ method: string; path: string }> = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", path: new URL(String(input)).pathname });
    return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "provider says no" }] }), { status, headers: { "content-type": "application/json" } });
  });
  const response = await f.step("resources", "r2", "create", "media", "create-r2-buckets");
  return { response, body: (await response.json()) as Record<string, unknown>, writes: calls.filter((call) => call.method !== "GET") };
}

describe("step route status for a provider answer about the credentials", () => {
  it("a rejected token is a 401 (sign in again), not a 404", async () => {
    const { response, body, writes } = await stepWithProviderAnswer(401);
    expect(response.status).toBe(401);
    expect(JSON.stringify(body)).toMatch(/unauthorized/);
    expect(writes).toEqual([]);
  });

  it("a missing permission is a 403 that says so (signing in again will not help)", async () => {
    const { response, body, writes } = await stepWithProviderAnswer(403);
    expect(response.status).toBe(403);
    expect(JSON.stringify(body)).toMatch(/forbidden/);
    expect(writes).toEqual([]);
  });

  it("a genuinely missing target stays a 404", async () => {
    const { response, writes } = await stepWithProviderAnswer(404);
    expect(response.status).toBe(404);
    expect(writes).toEqual([]);
  });

  it("an upstream fault stays a 502", async () => {
    const { response, writes } = await stepWithProviderAnswer(500);
    expect(response.status).toBe(502);
    expect(writes).toEqual([]);
  });
});
