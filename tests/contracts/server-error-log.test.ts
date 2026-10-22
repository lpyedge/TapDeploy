import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";

afterEach(() => vi.restoreAllMocks());

it("a 5xx API response leaves one log line with route, status and error codes, and no body content", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const app = createApp({ RUNTIME: "node" });
  app.post("/api/test-fail", (c) => c.json({ error: "upstream", upstream: "forbidden", secret: "do-not-log" }, 502));
  const res = await app.request("/api/test-fail", { method: "POST", body: "{}" });
  expect(res.status).toBe(502);
  expect(log).toHaveBeenCalledTimes(1);
  expect(String(log.mock.calls[0]![0])).toBe("[tapdeploy] POST /api/test-fail -> 502 upstream | forbidden");
});

it("a 4xx response is not logged", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await createApp({ RUNTIME: "node" }).request("/api/auth/session");
  expect(log).not.toHaveBeenCalled();
});
