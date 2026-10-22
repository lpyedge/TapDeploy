import { afterEach, describe, expect, it, vi } from "vitest";

import { getTargets } from "../../src/web/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("API error messages", () => {
  it("names what Cloudflare answered instead of a bare 'upstream'", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "upstream", upstream: "forbidden" }), { status: 502, headers: { "content-type": "application/json" } }));
    await expect(getTargets("csrf", "a".repeat(32))).rejects.toThrow("Cloudflare answered with an error (forbidden)");
  });
});
