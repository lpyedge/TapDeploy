import { describe, expect, it, vi } from "vitest";
import { snapshotTarget } from "../../src/core/planning/snapshot.js";
import type { CloudflareApiClient } from "../../src/cloudflare/client/index.js";

const denied = { kind: "forbidden", message: "permission denied" };
function client(overrides: Record<string, unknown> = {}): CloudflareApiClient {
  const mock = {
    withAccount: () => mock,
    getWorker: async () => { throw { kind: "not-found" }; },
    getPagesProject: async () => { throw { kind: "not-found" }; },
    listR2Buckets: async () => { throw denied; },
    listD1Databases: async () => { throw denied; },
    listKvNamespaces: async () => { throw denied; },
    listQueues: async () => { throw denied; },
    listHyperdriveConfigs: async () => { throw denied; },
    listVectorizeIndexes: async () => { throw denied; },
    listSecretsStores: async () => { throw denied; },
    ...overrides,
  };
  return mock as unknown as CloudflareApiClient;
}
const needs = { r2: false, d1: false, kv: false, queues: false, hyperdrive: false, vectorize: false, secretsStore: false, domains: false };

describe("required discovery fails closed", () => {
  it("does not hide denied declared cron discovery", async () => {
    const mock = client({ getWorker: async () => ({ id: "app" }), listVersions: async () => [], listDeployments: async () => [], getWorkerSettings: async () => ({ bindings: [] }), getSchedules: async () => { throw denied; } });
    await expect(snapshotTarget(mock, { accountId: "a".repeat(32), workerName: "app", needs: { ...needs, schedules: true, rateLimits: false, secrets: false } })).rejects.toEqual(denied);
  });
  it("does not treat denied deployed-binding inspection as an empty binding map", async () => {
    const mock = client({ getWorker: async () => ({ id: "app" }), listVersions: async () => [], listDeployments: async () => [], getWorkerSettings: async () => { throw denied; } });
    await expect(snapshotTarget(mock, { accountId: "a".repeat(32), workerName: "app", needs: { ...needs, schedules: false, rateLimits: false, secrets: false } })).rejects.toEqual(denied);
  });
  it.each(["r2", "d1", "kv", "queues", "hyperdrive", "vectorize", "secretsStore"] as const)("does not turn denied %s access into an empty safe list", async (kind) => {
    await expect(snapshotTarget(client(), { accountId: "a".repeat(32), workerName: "app", needs: { ...needs, [kind]: true } })).rejects.toEqual(denied);
  });
  it("does not turn denied Pages discovery into a new install target", async () => {
    await expect(snapshotTarget(client({ getPagesProject: async () => { throw denied; } }), { accountId: "a".repeat(32), workerName: "app", targetKind: "pages", needs })).rejects.toEqual(denied);
  });
  it("reads routes only in the selected zone, never DNS or Worker domains", async () => {
    const listWorkerRoutes = vi.fn(async () => []);
    const listDnsRecords = vi.fn(async () => { throw new Error("unneeded DNS read"); });
    const listWorkerDomains = vi.fn(async () => { throw new Error("unneeded domain read"); });
    const mock = client({ listZones: async () => [{ id: "one", name: "example.com" }, { id: "two", name: "unrelated.com" }], listWorkerRoutes, listDnsRecords, listWorkerDomains });
    await snapshotTarget(mock, { accountId: "a".repeat(32), workerName: "app", needs: { ...needs, domains: true, domainKinds: ["workers-route"], zoneNames: ["example.com"] } });
    expect(listWorkerRoutes.mock.calls).toEqual([["one"]]);
    expect(listDnsRecords).not.toHaveBeenCalled();
    expect(listWorkerDomains).not.toHaveBeenCalled();
  });
  it("does not swallow denied DNS collision discovery", async () => {
    const mock = client({ listZones: async () => [{ id: "one", name: "example.com" }], listDnsRecords: async () => { throw denied; } });
    await expect(snapshotTarget(mock, { accountId: "a".repeat(32), workerName: "app", needs: { ...needs, domains: true, domainKinds: ["dns-record"], zoneNames: ["example.com"] } })).rejects.toEqual(denied);
  });
  it("does not list domains before a new Pages project exists", async () => {
    const listPagesDomains = vi.fn(async () => { throw { kind: "not-found" }; });
    const result = await snapshotTarget(client({ listPagesDomains }), { accountId: "a".repeat(32), workerName: "app", targetKind: "pages", needs: { ...needs, domains: true } });
    expect(result.pagesProjectExists).toBe(false);
    expect(listPagesDomains).not.toHaveBeenCalled();
  });
});
