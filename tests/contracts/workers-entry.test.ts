import { describe, expect, it } from "vitest";
import worker from "../../src/runtime/workers.js";

function env(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    PUBLIC_ORIGIN: "https://installer.example",
    OAUTH_CLIENT_ID: "client-123",
    OAUTH_CLIENT_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ...overrides,
  };
}

describe("workers entry routing", () => {
  it("routes /api/health to the app and returns 200", async () => {
    const res = await worker.fetch(new Request("https://installer.example/api/health"), env());
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("routes /api/auth/start (a config-bounded POST) to the app", async () => {
    // Start is a config-bounded POST (config-first, ). The legacy
    // v2 config no longer validates; an equivalent V3 config exercises
    // the same route.
    const configText = JSON.stringify({
      schemaVersion: 3,
      app: { id: "fixture/entry", name: "Entry" },
      source: { allowLocalZip: true },
      capabilities: ["workers"],
      units: [{ id: "main", kind: "worker", wrangler: "wrangler.jsonc" }],
    });
    const res = await worker.fetch(
      new Request("https://installer.example/api/auth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Sec-Fetch-Mode": "navigate" },
        body: JSON.stringify({ text: configText }),
      }),
      env(),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).url).toContain("dash.cloudflare.com");
  });

  it("fails closed on /api/auth/session when the seal key is missing", async () => {
    const res = await worker.fetch(
      new Request("https://installer.example/api/auth/session"),
      env({ OAUTH_CLIENT_SECRET: undefined }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).authenticated).toBe(false);
  });
});
