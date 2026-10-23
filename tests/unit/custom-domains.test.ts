// Operator-chosen custom domains: request validation, the live decision the
// plan and the step share, and the scopes an HTTP unit implies.

import { describe, expect, it } from "vitest";
import {
  decideCustomDomain,
  domainEntriesFromChoices,
  hostnameInZone,
  normalizeHostname,
  type CustomDomainFacts,
} from "../../src/core/deploy/custom-domains.js";
import { planScopesForConfigV3 } from "../../src/auth/scope-planner.js";
import { configHasHttpUnits, effectiveCapabilities, type ConfigV3 } from "../../src/manifest/config-v3.js";
import type { DomainEntrySpec } from "../../src/core/deploy-spec.js";

const ZONE = { id: "zone-1", name: "example.com" };
const facts = (overrides: Partial<CustomDomainFacts> = {}): CustomDomainFacts => ({ zones: [ZONE], dnsRecords: [], workerDomains: [], pagesDomains: [], ...overrides });
const worker = (hostname: string, updateAction: DomainEntrySpec["updateAction"] = "preserve"): DomainEntrySpec => ({ kind: "workers-custom-domain", hostname, zoneName: "example.com", updateAction });
const pages = (hostname: string, updateAction: DomainEntrySpec["updateAction"] = "preserve"): DomainEntrySpec => ({ kind: "pages-custom-domain", hostname, zoneName: "example.com", updateAction });

describe("hostname rules", () => {
  it("normalizes valid names and refuses wildcards, single labels and bad labels", () => {
    expect(normalizeHostname(" App.Example.com ")).toBe("app.example.com");
    for (const bad of ["*.example.com", "example", "-a.example.com", "a..example.com", "", 7, "a_b.example.com"]) expect(normalizeHostname(bad), String(bad)).toBeNull();
  });
  it("accepts the apex and subdomains of the zone only", () => {
    expect(hostnameInZone("example.com", "example.com")).toBe(true);
    expect(hostnameInZone("a.b.example.com", "example.com")).toBe(true);
    expect(hostnameInZone("badexample.com", "example.com")).toBe(false);
  });
});

describe("domainEntriesFromChoices", () => {
  const units = { api: "workers", site: "pages" } as const;
  it("turns per-unit bind/remove choices into sealed entries", () => {
    const out = domainEntriesFromChoices({
      api: { bind: [{ hostname: "API.example.com", zone: "example.com", replaceExisting: true }], remove: [{ hostname: "old.example.com", zone: "example.com" }] },
      site: { bind: [{ hostname: "example.com", zone: "example.com" }] },
    }, units);
    expect(out).toEqual({ ok: true, entries: {
      api: [
        { kind: "workers-custom-domain", hostname: "api.example.com", zoneName: "example.com", updateAction: "explicit-change" },
        { kind: "workers-custom-domain", hostname: "old.example.com", zoneName: "example.com", updateAction: "detach" },
      ],
      site: [{ kind: "pages-custom-domain", hostname: "example.com", zoneName: "example.com", updateAction: "preserve" }],
    } });
  });
  it("never binds the address of this TapDeploy instance (removing it stays possible)", () => {
    expect(domainEntriesFromChoices({ api: { bind: [{ hostname: "deploy.example.com", zone: "example.com", replaceExisting: true }] } }, units, "deploy.example.com")).toEqual({ ok: false, detail: expect.stringContaining("address of this TapDeploy instance") });
    expect(domainEntriesFromChoices({ api: { remove: [{ hostname: "deploy.example.com", zone: "example.com" }] } }, units, "deploy.example.com").ok).toBe(true);
  });
  it("refuses a non-HTTP unit, a hostname outside its zone and a repeated hostname", () => {
    expect(domainEntriesFromChoices({ data: { bind: [{ hostname: "a.example.com", zone: "example.com" }] } }, units).ok).toBe(false);
    expect(domainEntriesFromChoices({ api: { bind: [{ hostname: "a.other.com", zone: "example.com" }] } }, units).ok).toBe(false);
    expect(domainEntriesFromChoices({ api: { bind: [{ hostname: "a.example.com", zone: "example.com" }] }, site: { bind: [{ hostname: "a.example.com", zone: "example.com" }] } }, units).ok).toBe(false);
  });
  it("is empty when the request carries no domains", () => {
    expect(domainEntriesFromChoices(undefined, units)).toEqual({ ok: true, entries: {} });
  });
});

describe("decideCustomDomain: Worker", () => {
  it("attaches a free hostname and preserves one already bound to this Worker", () => {
    expect(decideCustomDomain(worker("app.example.com"), "app", facts())).toEqual({ action: "attach", zoneId: "zone-1", replaceRecordIds: [] });
    expect(decideCustomDomain(worker("app.example.com"), "app", facts({ workerDomains: [{ id: "d1", hostname: "app.example.com", service: "app" }] }))).toEqual({ action: "preserve" });
  });
  it("needs consent to replace DNS records or another Worker's binding", () => {
    const records = facts({ dnsRecords: [{ zoneId: "zone-1", id: "r1", name: "app.example.com", type: "A", content: "192.0.2.1" }, { zoneId: "zone-1", id: "mx", name: "app.example.com", type: "MX", content: "mail" }] });
    expect(decideCustomDomain(worker("app.example.com"), "app", records).action).toBe("conflict");
    expect(decideCustomDomain(worker("app.example.com", "explicit-change"), "app", records)).toEqual({ action: "attach", zoneId: "zone-1", replaceRecordIds: ["r1"] });
    const foreign = facts({ workerDomains: [{ id: "d2", hostname: "app.example.com", service: "other" }] });
    expect(decideCustomDomain(worker("app.example.com"), "app", foreign).action).toBe("conflict");
    expect(decideCustomDomain(worker("app.example.com", "explicit-change"), "app", foreign)).toEqual({ action: "update", zoneId: "zone-1", domainId: "d2" });
  });
  it("removes only this Worker's own binding", () => {
    expect(decideCustomDomain(worker("app.example.com", "detach"), "app", facts({ workerDomains: [{ id: "d1", hostname: "app.example.com", service: "app" }] }))).toEqual({ action: "detach", zoneId: "zone-1", domainId: "d1" });
    expect(decideCustomDomain(worker("app.example.com", "detach"), "app", facts({ workerDomains: [{ id: "d2", hostname: "app.example.com", service: "other" }] })).action).toBe("conflict");
    expect(decideCustomDomain(worker("app.example.com", "detach"), "app", facts()).action).toBe("preserve");
  });
  it("refuses a zone outside the account", () => {
    expect(decideCustomDomain({ ...worker("app.other.com"), zoneName: "other.com" }, "app", facts()).action).toBe("conflict");
  });
});

describe("decideCustomDomain: Pages", () => {
  const cname = { zoneId: "zone-1", id: "c1", name: "docs.example.com", type: "CNAME", content: "site.pages.dev" };
  it("attaches with its own CNAME and preserves a complete binding", () => {
    expect(decideCustomDomain(pages("docs.example.com"), "site", facts())).toEqual({ action: "attach", zoneId: "zone-1", replaceRecordIds: [] });
    expect(decideCustomDomain(pages("docs.example.com"), "site", facts({ dnsRecords: [cname] }))).toEqual({ action: "attach", zoneId: "zone-1", replaceRecordIds: [] });
    expect(decideCustomDomain(pages("docs.example.com"), "site", facts({ dnsRecords: [cname], pagesDomains: [{ name: "docs.example.com" }] }))).toEqual({ action: "preserve" });
  });
  it("uses the provider subdomain when the project name was taken", () => {
    const own = { ...cname, content: "site-abc.pages.dev" };
    expect(decideCustomDomain(pages("docs.example.com"), "site", facts({ dnsRecords: [own], pagesDomains: [{ name: "docs.example.com" }], pagesSubdomain: "site-abc.pages.dev" }))).toEqual({ action: "preserve" });
  });
  it("needs consent for foreign records and for taking a Worker's hostname", () => {
    const foreign = facts({ dnsRecords: [{ ...cname, content: "elsewhere.example.net" }] });
    expect(decideCustomDomain(pages("docs.example.com"), "site", foreign).action).toBe("conflict");
    expect(decideCustomDomain(pages("docs.example.com", "explicit-change"), "site", foreign)).toEqual({ action: "attach", zoneId: "zone-1", replaceRecordIds: ["c1"] });
    const worker = facts({ workerDomains: [{ id: "d", hostname: "docs.example.com", service: "w" }] });
    expect(decideCustomDomain(pages("docs.example.com"), "site", worker).action).toBe("conflict");
    expect(decideCustomDomain(pages("docs.example.com", "explicit-change"), "site", worker)).toEqual({ action: "attach", zoneId: "zone-1", replaceRecordIds: [], replaceWorkerDomainId: "d" });
  });
  it("removes the project domain and its own CNAME", () => {
    expect(decideCustomDomain(pages("docs.example.com", "detach"), "site", facts({ dnsRecords: [cname], pagesDomains: [{ name: "docs.example.com" }] }))).toEqual({ action: "detach", zoneId: "zone-1", cnameRecordId: "c1" });
    expect(decideCustomDomain(pages("docs.example.com", "detach"), "site", facts()).action).toBe("preserve");
  });
});

describe("HTTP units imply custom-domain scopes", () => {
  const base = { schemaVersion: 3, app: { id: "a/b", name: "B" }, source: { allowLocalZip: true } } as const;
  it("adds Zone Read + DNS Write for Worker and Pages configs only", () => {
    const workerConfig = { ...base, capabilities: ["workers"], units: [{ id: "w", kind: "worker", wrangler: "wrangler.jsonc" }] } as ConfigV3;
    const resourceConfig = { ...base, capabilities: ["r2"], units: [], resources: [{ kind: "r2", name: "data" }] } as ConfigV3;
    const implicitPages = { ...base, capabilities: ["pages"] } as ConfigV3;
    expect(configHasHttpUnits(workerConfig)).toBe(true);
    expect(configHasHttpUnits(implicitPages)).toBe(true);
    expect(configHasHttpUnits(resourceConfig)).toBe(false);
    expect(effectiveCapabilities(workerConfig)).toEqual(["dns", "workers", "zone"]);
    expect(planScopesForConfigV3(workerConfig).scopes).toEqual(["dns.write", "workers-scripts.admin", "zone.read"]);
    expect(planScopesForConfigV3(resourceConfig).scopes).toEqual(["workers-r2.write"]);
  });
});
