// The installer API is a short, fixed list of typed operations. There is no generic
// bridge (`fetch(url, method)`, per-Cloudflare-call relay) and none may appear by
// accident: adding a route means editing this list on purpose, in review.

import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";

const EXPECTED = [
  "GET /api/auth/callback",
  "GET /api/auth/session",
  "GET /api/cloudflare/accounts",
  "GET /api/health",
  "POST /api/auth/check-config",
  "POST /api/auth/logout",
  "POST /api/auth/start",
  "POST /api/cloudflare/domains",
  "POST /api/cloudflare/hyperdrive",
  "POST /api/cloudflare/inventory",
  "POST /api/cloudflare/pages-domain-status",
  "POST /api/cloudflare/targets",
  "POST /api/deploy/plan",
  "POST /api/deploy/prepare",
  "POST /api/deploy/step",
  "POST /api/release/download",
  "POST /api/upload/assets",
];

describe("API surface", () => {
  const routes = createApp({ RUNTIME: "node", PUBLIC_ORIGIN: "https://installer.example" }).routes
    .filter((route) => route.method !== "ALL")
    .map((route) => `${route.method} ${route.path}`);

  it("is exactly the reviewed list of typed operations", () => {
    expect([...new Set(routes)].sort()).toEqual([...EXPECTED].sort());
  });

  it("has no wildcard or parameterised route that could act as a generic relay", () => {
    expect(routes.filter((route) => /[*:]/.test(route))).toEqual([]);
  });

  it("the only routes that carry an upstream request are the two fixed relays", () => {
    const relays = routes.filter((route) => /(upload|download|bridge|proxy|relay|fetch|forward)/i.test(route)).sort();
    expect(relays).toEqual(["POST /api/release/download", "POST /api/upload/assets"]);
  });
});
