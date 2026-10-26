import { readFileSync } from "node:fs";
import { SECURITY_HEADERS } from "../../src/api/security-headers.js";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";

describe.each(["node", "workers"] as const)("HTTP security headers (%s)", (runtime) => {
  it.each([
    ["/api/health", "GET", 200], ["/api/auth/session", "GET", 200],
    ["/api/auth/logout", "POST", 403], ["/api/auth/start", "POST", 400],
    ["/api/auth/callback?error=access_denied", "GET", 302],
    ["/api/deploy/step", "POST", 401], ["/api/not-found", "GET", 404],
  ])("%s preserves status and protects dynamic responses", async (path, method, status) => {
    const app = createApp({ RUNTIME: runtime, PUBLIC_ORIGIN: "https://installer.example", OAUTH_CLIENT_ID: "synthetic", OAUTH_CLIENT_SECRET: "synthetic" });
    const response = await app.request(String(path), { method: String(method), ...(path === "/api/auth/logout" ? { headers: { origin: "https://evil.example" } } : {}) });
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    if (status === 302) expect(response.headers.get("location")).toBe("https://installer.example/?auth=error&error=access_denied");
  });
});

it("Workers static policy matches dynamic/Node policy", () => {
  const text = readFileSync(new URL("../../src/web/public/_headers", import.meta.url), "utf8");
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) expect(text).toContain(`  ${key}: ${value}\n`);
  expect(text).toContain("  Cache-Control: no-cache");
});
