// a route->fixture server for the fixed Cloudflare wire fixtures. This lets
// contract tests drive the real client against the *documented provider shapes*
// (loaded from static JSON under tests/fixtures/cloudflare) without
// reconstructing them inline. Each matcher reproduces the documented
// method+path and serves the fixture's `result` via the standard success
// envelope, so a client regression cannot be masked by a self-referential mock.

import type { Fetcher } from "../../src/cloudflare/client/client.js";
import { fixtureResponse, readFixture, type CloudflareFixture } from "../fixtures/cloudflare/load-fixture.js";

interface RouteMatcher {
  match: (url: URL, init?: RequestInit) => boolean;
  fixture: CloudflareFixture;
}

function routeFixtures(): RouteMatcher[] {
  return [
    {
      match: (u) => u.pathname.endsWith("/accounts") && u.search === "",
      fixture: readFixture("accounts-list"),
    },
    {
      match: (u) =>
        u.pathname.match(/\/accounts\/[^/]+\/workers\/scripts$/) !== null,
      fixture: readFixture("workers-list"),
    },
    {
      match: (u, init) =>
        u.pathname.match(/\/accounts\/[^/]+\/workers\/scripts\/[^/]+\/versions$/) !== null &&
        (init?.method ?? "GET") === "GET",
      fixture: readFixture("versions-list"),
    },
    {
      match: (u, init) =>
        u.pathname.match(/\/accounts\/[^/]+\/workers\/scripts\/[^/]+\/deployments$/) !== null &&
        (init?.method ?? "GET") === "GET",
      fixture: readFixture("deployments-list"),
    },
    {
      match: (u, init) =>
        u.pathname.endsWith("/r2/buckets") && (init?.method ?? "GET") === "GET",
      fixture: readFixture("r2-buckets-list"),
    },
    {
      match: (u, init) =>
        u.pathname.match(/\/accounts\/[^/]+\/workers\/scripts\/[^/]+\/schedules$/) !== null &&
        (init?.method ?? "GET") === "GET",
      fixture: readFixture("schedules-list"),
    },
    {
      match: (u) =>
        u.pathname.match(/\/accounts\/[^/]+\/workers\/scripts\/[^/]+\/settings$/) !== null,
      fixture: readFixture("worker-settings"),
    },
    {
      match: (u, init) =>
        u.pathname.endsWith("/d1/database") && (init?.method ?? "GET") === "GET",
      fixture: readFixture("d1-databases-list"),
    },
    {
      match: (u, init) =>
        u.pathname.endsWith("/storage/kv/namespaces") && (init?.method ?? "GET") === "GET",
      fixture: readFixture("kv-namespaces-list"),
    },
    {
      match: (u, init) =>
        u.pathname.endsWith("/queues") && (init?.method ?? "GET") === "GET",
      fixture: readFixture("queues-list"),
    },
    {
      match: (u, init) =>
        u.pathname.match(/\/accounts\/[^/]+\/hyperdrive\/configs$/) !== null &&
        (init?.method ?? "GET") === "GET",
      fixture: readFixture("hyperdrive-configs-list"),
    },
    {
      match: (u, init) =>
        u.pathname.match(/\/accounts\/[^/]+\/vectorize\/v2\/indexes$/) !== null &&
        (init?.method ?? "GET") === "GET",
      fixture: readFixture("vectorize-indexes-list"),
    },
    {
      match: (u, init) =>
        u.pathname.match(/\/accounts\/[^/]+\/secrets_store\/stores$/) !== null &&
        (init?.method ?? "GET") === "GET",
      fixture: readFixture("secrets-stores-list"),
    },
    {
      match: (u, init) =>
        u.pathname.match(/\/accounts\/[^/]+\/secrets_store\/stores\/[^/]+\/secrets$/) !== null &&
        (init?.method ?? "GET") === "GET",
      fixture: readFixture("secrets-store-secrets-list"),
    },
    {
      match: (u, init) =>
        u.pathname.match(/\/accounts\/[^/]+\/pages\/projects$/) !== null &&
        (init?.method ?? "GET") === "GET",
      fixture: readFixture("pages-projects-list"),
    },
    // Pages project get create.
    {
      match: (u, init) =>
        u.pathname.match(/\/accounts\/[^/]+\/pages\/projects\/[^/]+$/) !== null &&
        (init?.method ?? "GET") === "GET",
      fixture: readFixture("pages-project-get"),
    },
    {
      match: (u, init) =>
        u.pathname.match(/\/accounts\/[^/]+\/pages\/projects$/) !== null &&
        (init?.method ?? "GET") === "POST",
      fixture: readFixture("pages-project-create"),
    },
    {
      match: (u, init) =>
        u.pathname.match(/\/accounts\/[^/]+\/pages\/projects\/[^/]+\/upload-token$/) !== null &&
        (init?.method ?? "GET") === "GET",
      fixture: readFixture("pages-upload-token"),
    },
    {
      match: (u, init) =>
        u.pathname.match(/\/accounts\/[^/]+\/pages\/projects\/[^/]+\/deployments$/) !== null &&
        (init?.method ?? "GET") === "POST",
      fixture: readFixture("pages-deployment-create"),
    },
    {
      match: (u, init) =>
        u.pathname.match(/\/accounts\/[^/]+\/pages\/projects\/[^/]+\/deployments$/) !== null &&
        (init?.method ?? "GET") === "GET",
      fixture: readFixture("pages-deployments-list"),
    },
    {
      match: (u, init) =>
        u.pathname.match(/\/accounts\/[^/]+\/pages\/projects\/[^/]+\/deployments\/[^/]+$/) !== null &&
        (init?.method ?? "GET") === "GET",
      fixture: readFixture("pages-deployment-get"),
    },
    // zone discovery + zone-scoped DNS records / Workers routes / custom
    // domains + Pages custom domains. Zone reads only run when a domain intent is
    // present; DNS Write accepts the list endpoint, so no redundant `dns.read`.
    {
      match: (u, init) =>
        u.pathname.endsWith("/zones") && u.search === "" &&
        (init?.method ?? "GET") === "GET",
      fixture: readFixture("zones-list"),
    },
    {
      match: (u, init) =>
        u.pathname.match(/\/zones\/[^/]+\/dns_records$/) !== null &&
        (init?.method ?? "GET") === "GET",
      fixture: readFixture("dns-records-list"),
    },
    {
      match: (u, init) =>
        u.pathname.match(/\/zones\/[^/]+\/workers\/routes$/) !== null &&
        (init?.method ?? "GET") === "GET",
      fixture: readFixture("workers-routes-list"),
    },
    {
      match: (u, init) =>
        u.pathname.match(/\/accounts\/[^/]+\/workers\/domains$/) !== null &&
        (init?.method ?? "GET") === "GET",
      fixture: readFixture("workers-domains-list"),
    },
    {
      match: (u, init) =>
        u.pathname.match(/\/accounts\/[^/]+\/pages\/projects\/[^/]+\/domains$/) !== null &&
        (init?.method ?? "GET") === "GET",
      fixture: readFixture("pages-domains-list"),
    },
  ];
}

/**
 * Build a fetcher that serves the nearest matching fixed fixture for a request
 * URL, recording each call so the test can assert the exact method+path used.
 * Returns the fetcher plus a log of calls and a `schedule` override for tests
 * that need a specific one-off response (e.g. pagination or errors).
 */
export function fixtureFetcher() {
  const matchers = routeFixtures();
  const log: { url: string; init: RequestInit }[] = [];
  const queue: Response[] = [];
  const fn: Fetcher = (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    log.push({ url: String(input), init: init ?? {} });
    const queued = queue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    const match = matchers.find((m) => m.match(url, init));
    if (match) {
      return Promise.resolve(fixtureResponse(match.fixture));
    }
    return Promise.resolve(fixtureResponse({ label: "default ok", result: { ok: true } }));
  };
  return { fn, log, schedule: (response: Response) => queue.push(response), matchers };
}
