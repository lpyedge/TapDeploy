import { describe, expect, it } from "vitest";

import { createApp, type TapDeployEnv } from "../../src/api/app.js";

const PUBLIC_ORIGIN = "https://installer.example";
const CLIENT_SECRET = "B".repeat(43);

function env(): TapDeployEnv {
  return {
    RUNTIME: "node",
    TAPDEPLOY_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    TAPDEPLOY_OAUTH_CLIENT_ID: "client-123",
    TAPDEPLOY_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    // Register the scopes the workers config fixture derives ().
  };
}

describe("deploy step: request validation", () => {
  it("requires an authenticated session", async () => {
    const app = createApp(env());
    const res = await app.request("/api/deploy/step", { method: "POST" });
    expect(res.status).toBe(401);
  });
});
