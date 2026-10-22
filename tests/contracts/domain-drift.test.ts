import { describe, expect, it, vi } from "vitest";
import { buildDeployPlan } from "../../src/core/planning/plan.js";
import { planReference } from "../../src/core/planning/drift.js";
import { reconcileDomains } from "../../src/core/deploy/domains.js";
import type { DeploySpec } from "../../src/core/deploy-spec.js";
import type { TargetSnapshot } from "../../src/core/planning/types.js";
import type { CloudflareApiClient } from "../../src/cloudflare/client/client.js";

function fixture() {
  const spec: DeploySpec = { schemaVersion: 1, targetKind: "workers", project: { id: "dns/app", version: "1" }, assets: [], inputs: {}, wrangler: { name: "app", compatibility_date: "2026-10-10", r2_buckets: [], crons: [] }, cloudflare: { workerName: "app", r2: [], d1: [], kv: [], queues: [], hyperdrive: [], vectorize: [], secretsStore: [], runtimeBindings: [], cron: [], secrets: {}, domains: [{ kind: "dns-record", hostname: "app.example.com", zoneName: "example.com", recordType: "A", recordContent: "192.0.2.2", updateAction: "explicit-change" }] } };
  const snapshot: TargetSnapshot = { accountId: "a".repeat(32), workerName: "app", workerExists: false, versions: [], activeDeploymentVersionIds: [], r2Buckets: [], d1Databases: [], kvNamespaces: [], queues: [], hyperdriveConfigs: [], vectorizeIndexes: [], secretsStores: [], secretsStoreSecrets: [], secretNames: [], scheduleCrons: [], rateLimitCount: 0, zones: [{ id: "zone-a", name: "example.com" }, { id: "zone-b", name: "other.com" }], dnsRecords: [{ zoneId: "zone-a", id: "r1", name: "app.example.com", type: "A", content: "192.0.2.1" }, { zoneId: "zone-b", id: "r2", name: "app.other.com", type: "A", content: "192.0.2.99" }] };
  return { spec, snapshot };
}
describe("scoped DNS approval drift", () => {
  it("external same-ID DNS content change invalidates approval", async () => {
    const { spec, snapshot } = fixture();
    const plan = await buildDeployPlan({ spec }, snapshot, { salt: "fake" });
    const expected = planReference(plan, snapshot);
    const changed = structuredClone(snapshot);
    changed.dnsRecords![0]!.content = "192.0.2.111";
    expect((await buildDeployPlan({ spec }, changed, { salt: "fake", expected })).blocked).toBe(true);
  });
  it("unrelated record changes do not acquire ownership or block scoped intent", async () => {
    const { spec, snapshot } = fixture();
    const plan = await buildDeployPlan({ spec }, snapshot, { salt: "fake" });
    const expected = planReference(plan, snapshot);
    const changed = structuredClone(snapshot);
    changed.dnsRecords![1]!.content = "192.0.2.222";
    expect((await buildDeployPlan({ spec }, changed, { salt: "fake", expected })).blocked).toBe(false);
  });
  it("refuses a supplied zone ID outside the approved name/identity pair before all batch writes", async () => {
    const { spec, snapshot } = fixture();
    spec.cloudflare.domains!.push({ ...spec.cloudflare.domains![0]!, hostname: "next.example.com", zoneId: "zone-b" });
    const update = vi.fn(async () => ({ id: "r1" }));
    const client = { updateDnsRecord: update } as unknown as CloudflareApiClient;
    const outcome = await reconcileDomains({ client, spec, snapshot, accountId: snapshot.accountId, workerName: "app", accessToken: "fake" }, { confirmDomainChanges: true });
    expect(outcome.ok).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
  it("requires separate change consent and updates only the approved zone/record, never deletes", async () => {
    const { spec, snapshot } = fixture();
    const update = vi.fn(async () => ({ id: "r1" }));
    const remove = vi.fn();
    const client = { updateDnsRecord: update, deleteDnsRecord: remove } as unknown as CloudflareApiClient;
    const ctx = { client, spec, snapshot, accountId: snapshot.accountId, workerName: "app", accessToken: "fake" };
    expect((await reconcileDomains(ctx, {})).ok).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect((await reconcileDomains(ctx, { confirmDomainChanges: true })).ok).toBe(true);
    expect(update).toHaveBeenCalledExactlyOnceWith("zone-a", "r1", { name: "app.example.com", type: "A", content: "192.0.2.2" });
    expect(remove).not.toHaveBeenCalled();
  });
});
