// The auth routes run unmocked on the built Node server and on the real Worker
// (wrangler dev --local): config validation must work on both runtimes (the
// Workers runtime forbids compiling a JSON Schema at runtime). Nothing here
// reaches Cloudflare: OAuth start only builds the consent URL.

import { expect, test } from "@playwright/test";

const runtime = process.env.PW_RUNTIME ?? "vite";
const CONFIG = {
  schemaVersion: 3,
  app: { id: "example/notes", name: "Notes" },
  source: { allowLocalZip: true },
  capabilities: ["workers", "r2"],
};

test.describe("auth routes on the real runtime", () => {
  test.skip(runtime === "vite", "the Vite dev server has no API");

  test("OAuth start validates a config and returns the consent URL", async ({ request, baseURL }) => {
    const res = await request.post("/api/auth/start", { data: { text: JSON.stringify(CONFIG) }, headers: { origin: baseURL! } });
    expect(res.status(), await res.text()).toBe(200);
    const url = new URL(((await res.json()) as { url: string }).url);
    expect(url.hostname).toBe("dash.cloudflare.com");
    expect(url.searchParams.get("redirect_uri")).toBe(`${baseURL}/api/auth/callback`);
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual(["dns.write", "workers-r2.write", "workers-scripts.admin", "zone.read"]);
  });

  test("OAuth start refuses an invalid config with a typed error", async ({ request, baseURL }) => {
    const res = await request.post("/api/auth/start", { data: { text: JSON.stringify({ ...CONFIG, capabilities: ["teleport"] }) }, headers: { origin: baseURL! } });
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_config");
  });
});
