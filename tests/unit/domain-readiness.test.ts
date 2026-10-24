import { describe, expect, it } from "vitest";
import { pagesReadiness, probeHostname, readinessDelay } from "../../src/web/domain-readiness.js";
import { boundDomains, resultLinks } from "../../src/web/result-links.js";
import type { DomainsEnvelope, GraphPlan } from "../../src/web/api.js";

describe("pagesReadiness", () => {
  it("is live only when Cloudflare says active, and flags the states the owner must resolve", () => {
    expect(pagesReadiness("active")).toEqual({ state: "live" });
    expect(pagesReadiness("pending")).toEqual({ state: "pending", status: "pending" });
    expect(pagesReadiness("initializing")).toEqual({ state: "pending", status: "initializing" });
    expect(pagesReadiness(undefined)).toEqual({ state: "pending" });
    for (const status of ["blocked", "error", "deactivated"]) expect(pagesReadiness(status)).toEqual({ state: "problem", status });
  });
});

describe("readinessDelay", () => {
  it("checks soon, then spreads out to every 30 seconds, so a 5 minute watch is about a dozen requests", () => {
    expect([0, 1, 2, 3, 4, 10].map(readinessDelay)).toEqual([5000, 10000, 20000, 30000, 30000, 30000]);
  });
});

describe("probeHostname", () => {
  it("is true once the hostname answers over https, with an opaque request", async () => {
    const seen: Array<[string, RequestInit | undefined]> = [];
    const answers = (async (input: RequestInfo | URL, init?: RequestInit) => { seen.push([String(input), init]); return new Response(null); }) as typeof fetch;
    expect(await probeHostname("app.example.com", answers)).toBe(true);
    expect(seen[0]![0]).toBe("https://app.example.com/");
    expect(seen[0]![1]).toMatchObject({ mode: "no-cors", cache: "no-store" });
  });

  it("is false while DNS or the certificate is not there, and when nothing answers in time", async () => {
    expect(await probeHostname("app.example.com", (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch)).toBe(false);
    const hangs = ((_: unknown, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch;
    expect(await probeHostname("app.example.com", hangs, 10)).toBe(false);
  });
});

describe("resultLinks", () => {
  const plan = {
    ok: true, blocked: false, digest: "d", guards: [],
    cost: { operations: [], requiresConfirmation: false, confirmed: true, blockedUnknownCost: false },
    units: [
      { unitId: "api", kind: "worker", name: "api", requiresBundle: true, diffs: [{ resource: "worker", action: "create", name: "api" }, { resource: "worker-custom-domain", action: "attach", name: "App.Example.com" }] },
      { unitId: "site", kind: "pages-static", name: "notes-site", requiresBundle: true, diffs: [{ resource: "pages-project", action: "create", name: "notes-site" }, { resource: "pages-custom-domain", action: "attach", name: "www.example.com" }] },
    ],
  } as unknown as GraphPlan;

  it("tells a custom domain, workers.dev and a Pages address apart, in the order given", () => {
    expect(resultLinks(["https://app.example.com/", "https://www.example.com/", "https://api.me.workers.dev/", "https://notes-site.pages.dev/"], plan)).toEqual([
      { url: "https://app.example.com/", kind: "domain", domain: { hostname: "app.example.com", kind: "worker" } },
      { url: "https://www.example.com/", kind: "domain", domain: { hostname: "www.example.com", kind: "pages", project: "notes-site" } },
      { url: "https://api.me.workers.dev/", kind: "workers-dev" },
      { url: "https://notes-site.pages.dev/", kind: "pages" },
    ]);
  });

  it("a kept domain (no attach in the plan) is not watched", () => {
    expect(resultLinks(["https://kept.example.com/"], plan)).toEqual([{ url: "https://kept.example.com/", kind: "pages" }]);
  });
});

describe("domains an upgrade kept", () => {
  const plan = {
    ok: true, blocked: false, digest: "d", guards: [],
    cost: { operations: [], requiresConfirmation: false, confirmed: true, blockedUnknownCost: false },
    units: [
      { unitId: "api", kind: "worker", name: "api", requiresBundle: true, diffs: [{ resource: "worker", action: "update", name: "api" }] },
      { unitId: "site", kind: "pages-static", name: "notes-site", requiresBundle: true, diffs: [{ resource: "pages-project", action: "preserve", name: "notes-site" }, { resource: "deployment", action: "create", name: "notes-site" }] },
    ],
  } as unknown as GraphPlan;
  const facts: DomainsEnvelope = {
    accountId: "a", zones: ["example.com"],
    workerDomains: [{ hostname: "App.example.com", service: "api" }, { hostname: "other.example.com", service: "someone-else" }],
    pagesDomains: { "notes-site": ["notes-site.pages.dev", "www.example.com"] },
  };

  it("takes the account's domains bound to what was deployed, not another service's and not the project's own pages.dev address", () => {
    expect(boundDomains(facts, plan)).toEqual([
      { hostname: "app.example.com", kind: "worker" },
      { hostname: "www.example.com", kind: "pages", project: "notes-site" },
    ]);
  });

  it("lists a kept domain even though this deploy attached nothing, ahead of the other addresses", () => {
    const links = resultLinks(["https://notes-site.pages.dev/"], plan, boundDomains(facts, plan));
    expect(links.map((link) => [link.url, link.kind])).toEqual([
      ["https://app.example.com/", "domain"],
      ["https://www.example.com/", "domain"],
      ["https://notes-site.pages.dev/", "pages"],
    ]);
  });

  it("does not list a domain twice when the deploy also reported it", () => {
    const links = resultLinks(["https://www.example.com/", "https://notes-site.pages.dev/"], plan, boundDomains(facts, plan));
    expect(links.filter((link) => link.url === "https://www.example.com/")).toHaveLength(1);
  });
});
