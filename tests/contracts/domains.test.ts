// opt-in domain/route/DNS contract.
//
// These tests drive the planning layer directly (buildDeployPlan) against a
// hand-built spec + snapshot, verifying the PASS oracle:
//   - No DNS scope is requested for a default workers.dev release.
//   - A DNS collision (A vs CNAME at the same name) blocks the mutation.
//   - An existing record/route/domain is preserved by identity; an explicit
//     change requires independent consent (updateAction) and is never auto-applied.
//   - A zone-scoped write only resolves against the selected zone; a missing
//     zone blocks.
//
// Regression oracle: the planner must never mutate. A blocked plan is the only
// safe outcome when a declared domain change cannot be applied.

import { describe, expect, it, vi } from "vitest";
import type { DeploySpec, DomainEntrySpec } from "../../src/core/deploy-spec.js";
import type { TargetSnapshot } from "../../src/core/planning/types.js";
import { buildDeployPlan } from "../../src/core/planning/plan.js";
import { reconcileDomains } from "../../src/core/deploy/domains.js";
import type { CloudflareApiClient } from "../../src/cloudflare/client/index.js";
import { dnsRecordActionFor } from "../../src/cloudflare/resources/dns.js";

const ACCOUNT = "c".repeat(32);
const WORKER = "tapdeploy-domains";

function makeSpec(domains: DomainEntrySpec[]): DeploySpec {
  return {
    schemaVersion: 1,
    project: { id: "example/domains-app", version: "1.0.0" },
    assets: [],
    inputs: {},
    cloudflare: {
      workerName: WORKER,
      r2: [],
      d1: [],
      kv: [],
      queues: [],
      hyperdrive: [],
      vectorize: [],
      secretsStore: [],
      runtimeBindings: [],
      cron: [],
      secrets: {},
      ...(domains.length > 0 ? { domains } : {}),
    },
    wrangler: {
      name: WORKER,
      main: "./worker/main.mjs",
      compatibility_date: "2026-10-10",
      r2_buckets: [],
      crons: [],
    },
    targetKind: "workers",
  };
}

function makeSnapshot(overrides: Partial<TargetSnapshot> = {}): TargetSnapshot {
  return {
    accountId: ACCOUNT,
    workerName: WORKER,
    workerExists: false,
    versions: [],
    activeDeploymentVersionIds: [],
    r2Buckets: [],
    d1Databases: [],
    kvNamespaces: [],
    queues: [],
    hyperdriveConfigs: [],
    vectorizeIndexes: [],
    secretsStores: [],
    secretsStoreSecrets: [],
    secretNames: [],
    scheduleCrons: [],
    rateLimitCount: 0,
    ...overrides,
  };
}

describe("domain plan guards", () => {
  it("carries validated config DNS fields through manifest, spec, plan and mutation", async () => {
    // the v2 config→manifest→projection preamble was removed with the
    // legacy pipeline; the live plan/mutation assertions now build the
    // DeploySpec directly, exactly like the other tests in this file.
    const spec = makeSpec([{
      kind: "dns-record", hostname: "app.example.com", zoneName: "example.com",
      recordType: "A", recordContent: "192.0.2.1", ttl: 120, proxied: false,
    }]);
    const snapshot = makeSnapshot({ zones: [{ id: "zone", name: "example.com" }] });
    const createDnsRecord = vi.fn(async () => ({ id: "record" }));
    const plan = await buildDeployPlan({ spec }, snapshot, { salt: "salt" });
    expect(plan.blocked).toBe(false);
    expect(plan.diffs).toContainEqual(expect.objectContaining({ resource: "dns-record", action: "create", name: "app.example.com" }));
    expect(createDnsRecord).not.toHaveBeenCalled();
    const result = await reconcileDomains({ spec, snapshot, client: { createDnsRecord } as unknown as CloudflareApiClient, workerName: WORKER, accountId: ACCOUNT, accessToken: "unused" }, {});
    expect(result.ok).toBe(true);
    expect(createDnsRecord).toHaveBeenCalledWith("zone", { name: "app.example.com", type: "A", content: "192.0.2.1", ttl: 120, proxied: false });
  });
  it("rejects an incomplete DNS create before any deployment can proceed", async () => {
    const spec = makeSpec([{ kind: "dns-record", hostname: "app.example.com", zoneName: "example.com", recordType: "A" }]);
    const plan = await buildDeployPlan({ spec }, makeSnapshot({ zones: [{ id: "zone", name: "example.com" }] }), { salt: "salt" });
    expect(plan.blocked).toBe(true);
    expect(plan.guards).toContainEqual(expect.objectContaining({ code: "domain-drift" }));
  });
  it("requires independent confirmation before replacing an existing DNS record", async () => {
    const spec = makeSpec([{ kind: "dns-record", hostname: "app.example.com", zoneName: "example.com", recordType: "A", recordContent: "192.0.2.2", updateAction: "explicit-change" }]);
    const snapshot = makeSnapshot({ zones: [{ id: "zone", name: "example.com" }], dnsRecords: [{ zoneId: "zone", id: "record", name: "app.example.com", type: "A", content: "192.0.2.1" }] });
    const updateDnsRecord = vi.fn(async () => ({ id: "record" }));
    const ctx = { spec, snapshot, client: { updateDnsRecord } as unknown as CloudflareApiClient, workerName: WORKER, accountId: ACCOUNT, accessToken: "unused" };
    const denied = await reconcileDomains(ctx, {});
    expect(denied.ok).toBe(false);
    expect(updateDnsRecord).not.toHaveBeenCalled();
    const allowed = await reconcileDomains(ctx, { confirmDomainChanges: true });
    expect(allowed.ok).toBe(true);
    expect(updateDnsRecord).toHaveBeenCalledOnce();
  });
  it("blocks writes beside an NS record and preserves an existing NS by identity", () => {
    const record = { id: "ns", name: "app.example.com", type: "NS", content: "ns.example.net" };
    expect(dnsRecordActionFor({ kind: "dns-record", hostname: record.name, recordType: "TXT", recordContent: "new" }, [record]).action).toBe("conflict");
    expect(dnsRecordActionFor({ kind: "dns-record", hostname: record.name, recordType: "NS" }, [record])).toMatchObject({ action: "preserve", id: "ns" });
  });
  it("creates a dns-record when the zone resolves and no record exists", async () => {
    const spec = makeSpec([
      { kind: "dns-record", hostname: "www.example.com", zoneName: "example.com", recordType: "A", recordContent: "192.0.2.1" },
    ]);
    const snapshot = makeSnapshot({
      zones: [{ id: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", name: "example.com" }],
      dnsRecords: [],
    });
    const plan = await buildDeployPlan({ spec }, snapshot, { salt: "salt" });
    expect(plan.blocked).toBe(false);
    expect(plan.diffs).toContainEqual({ resource: "dns-record", action: "create", name: "www.example.com" });
  });

  it("blocks a DNS collision (A vs CNAME at the same name)", async () => {
    const spec = makeSpec([
      { kind: "dns-record", hostname: "www.example.com", zoneName: "example.com", recordType: "A", recordContent: "192.0.2.1" },
    ]);
    const snapshot = makeSnapshot({
      zones: [{ id: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", name: "example.com" }],
      dnsRecords: [{ zoneId: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", id: "r1", name: "www.example.com", type: "CNAME", content: "target.example.com" }],
    });
    const plan = await buildDeployPlan({ spec }, snapshot, { salt: "salt" });
    expect(plan.blocked).toBe(true);
    const guard = plan.guards.find((g) => g.code === "domain-drift");
    expect(guard).toBeDefined();
    expect(guard!.detail).toMatch(/cannot coexist with a CNAME/i);
  });

  it("preserves an existing matching record by identity (no auto-change)", async () => {
    const spec = makeSpec([
      { kind: "dns-record", hostname: "www.example.com", zoneName: "example.com", recordType: "A", recordContent: "192.0.2.1" },
    ]);
    const snapshot = makeSnapshot({
      zones: [{ id: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", name: "example.com" }],
      dnsRecords: [{ zoneId: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", id: "r1", name: "www.example.com", type: "A", content: "192.0.2.1" }],
    });
    const plan = await buildDeployPlan({ spec }, snapshot, { salt: "salt" });
    expect(plan.blocked).toBe(false);
    expect(plan.diffs).toContainEqual({ resource: "dns-record", action: "preserve", name: "www.example.com" });
  });

  it("blocks a zone-scoped write when the selected zone does not resolve", async () => {
    const spec = makeSpec([
      { kind: "dns-record", hostname: "www.example.com", zoneName: "missing.test", recordType: "A", recordContent: "192.0.2.1" },
    ]);
    const snapshot = makeSnapshot({ zones: [] });
    const plan = await buildDeployPlan({ spec }, snapshot, { salt: "salt" });
    expect(plan.blocked).toBe(true);
    const guard = plan.guards.find((g) => g.code === "domain-drift");
    expect(guard).toBeDefined();
  });

  it("creates a workers-route when the pattern is absent", async () => {
    const spec = makeSpec([
      { kind: "workers-route", hostname: "example.com/*", zoneName: "example.com" },
    ]);
    const snapshot = makeSnapshot({
      zones: [{ id: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", name: "example.com" }],
      workerRoutes: [],
    });
    const plan = await buildDeployPlan({ spec }, snapshot, { salt: "salt" });
    expect(plan.blocked).toBe(false);
    expect(plan.diffs).toContainEqual({ resource: "worker-route", action: "create", name: "example.com/*" });
  });

  it("no-ops the domain plan when the release declares no domain intent", async () => {
    const spec = makeSpec([]);
    const snapshot = makeSnapshot();
    const plan = await buildDeployPlan({ spec }, snapshot, { salt: "salt" });
    expect(plan.blocked).toBe(false);
    expect(plan.diffs.some((d) => d.resource === "dns-record" || d.resource === "worker-route")).toBe(false);
  });
});

// Operator-chosen custom domains: the plan diff and the step execution share
// one decision; replacing or removing a live address needs explicit consent.
describe("custom domains (plan + reconcile-domains)", () => {
  const zone = { id: "zone", name: "example.com" };
  const worker = (updateAction: DomainEntrySpec["updateAction"] = "preserve"): DomainEntrySpec => ({ kind: "workers-custom-domain", hostname: "app.example.com", zoneName: "example.com", updateAction });
  const pagesSpec = (updateAction: DomainEntrySpec["updateAction"] = "preserve"): DeploySpec => {
    const spec = makeSpec([{ kind: "pages-custom-domain", hostname: "docs.example.com", zoneName: "example.com", updateAction }]);
    return { ...spec, targetKind: "pages", cloudflare: { ...spec.cloudflare, workerName: "site", pages: { projectName: "site" } } };
  };
  const ctxFor = (spec: DeploySpec, snapshot: TargetSnapshot, client: Record<string, unknown>) => ({ spec, snapshot, client: client as unknown as CloudflareApiClient, workerName: spec.cloudflare.workerName, accountId: ACCOUNT, accessToken: "unused" });

  it("plans an attach diff for a free hostname and a blocking conflict for an occupied one", async () => {
    const free = await buildDeployPlan({ spec: makeSpec([worker()]) }, makeSnapshot({ zones: [zone] }), { salt: "s" });
    expect(free.diffs).toContainEqual(expect.objectContaining({ resource: "worker-custom-domain", action: "attach", name: "app.example.com" }));
    expect(free.blocked).toBe(false);
    const occupied = await buildDeployPlan({ spec: makeSpec([worker()]) }, makeSnapshot({ zones: [zone], dnsRecords: [{ zoneId: "zone", id: "r1", name: "app.example.com", type: "CNAME", content: "old.example.net" }] }), { salt: "s" });
    expect(occupied.blocked).toBe(true);
    expect(occupied.guards).toContainEqual(expect.objectContaining({ code: "domain-drift" }));
  });

  it("replaces existing records only with consent, then attaches the Worker", async () => {
    const snapshot = makeSnapshot({ zones: [zone], dnsRecords: [{ zoneId: "zone", id: "r1", name: "app.example.com", type: "A", content: "192.0.2.1" }] });
    const deleteDnsRecord = vi.fn(async () => undefined);
    const attachWorkerDomain = vi.fn(async () => ({ id: "d1", hostname: "app.example.com", service: WORKER }));
    const ctx = ctxFor(makeSpec([worker("explicit-change")]), snapshot, { deleteDnsRecord, attachWorkerDomain });
    expect((await reconcileDomains(ctx, {})).ok).toBe(false);
    expect(deleteDnsRecord).not.toHaveBeenCalled();
    const done = await reconcileDomains(ctx, { confirmDomainChanges: true });
    expect(done.ok).toBe(true);
    expect(deleteDnsRecord).toHaveBeenCalledExactlyOnceWith("zone", "r1");
    expect(attachWorkerDomain).toHaveBeenCalledExactlyOnceWith({ hostname: "app.example.com", service: WORKER, zone_id: "zone" });
  });

  it("refuses an occupied hostname without consent and writes nothing", async () => {
    const snapshot = makeSnapshot({ zones: [zone], workerDomains: [{ id: "d9", hostname: "app.example.com", service: "other" }] });
    const attachWorkerDomain = vi.fn();
    const outcome = await reconcileDomains(ctxFor(makeSpec([worker()]), snapshot, { attachWorkerDomain }), { confirmDomainChanges: true });
    expect(outcome.ok).toBe(false);
    expect(attachWorkerDomain).not.toHaveBeenCalled();
  });

  it("unbinds only this Worker's own domain", async () => {
    const detachWorkerDomain = vi.fn(async () => undefined);
    const own = makeSnapshot({ zones: [zone], workerDomains: [{ id: "d1", hostname: "app.example.com", service: WORKER }] });
    expect((await reconcileDomains(ctxFor(makeSpec([worker("detach")]), own, { detachWorkerDomain }), {})).ok).toBe(true);
    expect(detachWorkerDomain).toHaveBeenCalledExactlyOnceWith("d1");
    const foreign = makeSnapshot({ zones: [zone], workerDomains: [{ id: "d2", hostname: "app.example.com", service: "other" }] });
    detachWorkerDomain.mockClear();
    expect((await reconcileDomains(ctxFor(makeSpec([worker("detach")]), foreign, { detachWorkerDomain }), {})).ok).toBe(false);
    expect(detachWorkerDomain).not.toHaveBeenCalled();
  });

  it("binds a Pages domain: registers it on the project and creates the proxied CNAME", async () => {
    const addPagesDomain = vi.fn(async () => ({ name: "docs.example.com" }));
    const createDnsRecord = vi.fn(async () => ({ id: "c1" }));
    const snapshot = makeSnapshot({ workerName: "site", zones: [zone], pagesSubdomain: "site-x1.pages.dev" });
    expect((await reconcileDomains(ctxFor(pagesSpec(), snapshot, { addPagesDomain, createDnsRecord }), {})).ok).toBe(true);
    expect(addPagesDomain).toHaveBeenCalledExactlyOnceWith("site", { name: "docs.example.com" });
    expect(createDnsRecord).toHaveBeenCalledExactlyOnceWith("zone", { type: "CNAME", name: "docs.example.com", content: "site-x1.pages.dev", proxied: true, ttl: 1 });
  });

  it("unbinds a Pages domain and removes only its own CNAME", async () => {
    const deletePagesDomain = vi.fn(async () => undefined);
    const deleteDnsRecord = vi.fn(async () => undefined);
    const snapshot = makeSnapshot({ workerName: "site", zones: [zone], pagesDomains: [{ name: "docs.example.com" }], dnsRecords: [{ zoneId: "zone", id: "c1", name: "docs.example.com", type: "CNAME", content: "site.pages.dev" }] });
    expect((await reconcileDomains(ctxFor(pagesSpec("detach"), snapshot, { deletePagesDomain, deleteDnsRecord }), {})).ok).toBe(true);
    expect(deletePagesDomain).toHaveBeenCalledExactlyOnceWith("site", "docs.example.com");
    expect(deleteDnsRecord).toHaveBeenCalledExactlyOnceWith("zone", "c1");
  });
});
