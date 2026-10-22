// Configure-step custom-domain drafts -> plan request (browser helpers).

import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT, boundHostnames, domainRequest, draftErrors, draftHostname, hostnameOccupant, zoneOf, type HttpUnit } from "../../src/web/domain-choices.js";
import type { DomainsEnvelope } from "../../src/web/api.js";

const facts: DomainsEnvelope = {
  accountId: "a",
  zones: ["example.com", "shop.example.com"],
  workerDomains: [{ hostname: "api.example.com", service: "api", zone: "example.com" }, { hostname: "taken.example.com", service: "other" }],
  pagesDomains: { site: ["docs.example.com"] },
};
const records = { "example.com": [{ name: "www.example.com", type: "A", content: "192.0.2.1" }] };
const api: HttpUnit = { unitId: "main", kind: "worker", target: "api" };
const site: HttpUnit = { unitId: "web", kind: "pages", target: "site" };

describe("domain drafts", () => {
  it("builds the hostname from subdomain and zone (empty = apex)", () => {
    expect(draftHostname({ zone: "example.com", sub: "WWW" })).toBe("www.example.com");
    expect(draftHostname({ zone: "example.com", sub: "" })).toBe("example.com");
    expect(draftHostname({ zone: "", sub: "www" })).toBeNull();
    expect(draftHostname({ zone: "example.com", sub: "bad_name" })).toBeNull();
  });
  it("lists what is bound today and who occupies a hostname", () => {
    expect(boundHostnames(api, facts)).toEqual(["api.example.com"]);
    expect(boundHostnames(site, facts)).toEqual(["docs.example.com"]);
    expect(hostnameOccupant("api.example.com", api, facts, [])).toBeNull();
    expect(hostnameOccupant("taken.example.com", api, facts, [])).toContain("other");
    expect(hostnameOccupant("www.example.com", api, facts, records["example.com"])).toContain("DNS A");
    expect(zoneOf("a.shop.example.com", facts.zones)).toBe("shop.example.com");
  });
  it("requires consent for replacement and removal, and builds the plan request", () => {
    const drafts = { main: { ...EMPTY_DRAFT, bind: true, zone: "example.com", sub: "www" }, web: { ...EMPTY_DRAFT, remove: ["docs.example.com"] } };
    expect(draftErrors([api, site], drafts, facts, records)).toEqual({ main: "confirm the replacement first", web: "confirm the removal first" });
    const confirmed = { main: { ...drafts.main, confirmReplace: true }, web: { ...drafts.web, confirmRemove: true } };
    expect(draftErrors([api, site], confirmed, facts, records)).toEqual({});
    expect(domainRequest([api, site], confirmed, facts, records)).toEqual({
      main: { bind: [{ hostname: "www.example.com", zone: "example.com", replaceExisting: true }] },
      web: { remove: [{ hostname: "docs.example.com", zone: "example.com" }] },
    });
  });
  it("sends nothing for an untouched form or a hostname that is already bound", () => {
    expect(domainRequest([api], {}, facts, records)).toBeUndefined();
    expect(domainRequest([api], { main: { ...EMPTY_DRAFT, bind: true, zone: "example.com", sub: "api" } }, facts, records)).toBeUndefined();
  });
});
