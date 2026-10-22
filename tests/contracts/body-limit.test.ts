import { expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";

it.each(["node", "workers"] as const)("%s bounds config request bytes before JSON parsing", async runtime => {
  const app = createApp({ RUNTIME: runtime });
  const response = await app.request("/api/auth/start", { method: "POST", body: " ".repeat(192 * 1024 + 1) });
  expect(response.status).toBe(413);
});
it("a forged small Content-Length cannot bypass the actual streaming limit", async () => {
  const response = await createApp({ RUNTIME: "workers" }).request("/api/auth/start", { method: "POST", headers: { "content-length": "1" }, body: " ".repeat(192 * 1024 + 1) });
  expect(response.status).toBe(413);
});
it("deployment metadata/module requests have a finite shared Node/Workers bound", async () => {
  const response = await createApp({ RUNTIME: "node" }).request("/api/deploy/step", { method: "POST", body: " ".repeat(8 * 1024 * 1024 + 1) });
  expect(response.status).toBe(413);
});
it("small malformed config text still reaches the handler (not the byte bound)", async () => {
  const env = { RUNTIME: "workers", TAPDEPLOY_PUBLIC_ORIGIN: "https://installer.example", TAPDEPLOY_OAUTH_CLIENT_ID: "client", TAPDEPLOY_OAUTH_CLIENT_SECRET: "secret".repeat(43) } as const;
  const response = await createApp(env).request("/api/auth/start", { method: "POST", body: "not-json" });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBe("config_required");
});
