import { expect, it } from "vitest";
import { ROUTES } from "../../src/cloudflare/client/routes.js";
import { ENDPOINT_SCOPE_LEDGER, endpointScope } from "../../src/auth/endpoint-scope-ledger.js";
import { planScopesForCapabilities } from "../../src/auth/scope-planner.js";

it("every fixed provider route has an explicit scope/credential/reachability ledger entry", () => {
  expect(Object.keys(ENDPOINT_SCOPE_LEDGER).sort()).toEqual(Object.keys(ROUTES).sort());
  for (const [id, row] of Object.entries(ENDPOINT_SCOPE_LEDGER)) {
    if (row.capability) expect(endpointScope(id)).toBeTruthy();
    else expect(row.note).toBeTruthy();
    // The only reachable deletes remove an operator-chosen custom domain (and its DNS record).
    if (ROUTES[id]!.method === "DELETE") expect(row.reachable, id).toBe(["deleteDnsRecord", "detachWorkerDomain", "deletePagesDomain"].includes(id));
  }
  expect(ENDPOINT_SCOPE_LEDGER.updateSecret!.reachable).toBe(false);
  expect(ENDPOINT_SCOPE_LEDGER.uploadWorkerAssets!.credential).toBe("asset-jwt");
});
it("supported Worker/R2 and Pages/DNS paths are covered by one config-derived consent", () => {
  const workerScopes = planScopesForCapabilities(["workers", "r2"]).scopes;
  for (const id of ["listWorkers", "getVersion", "createWorkerResourceVersion", "createDeployment", "listR2Buckets", "createR2Bucket"]) expect(workerScopes).toContain(endpointScope(id));
  expect(workerScopes).not.toContain("ai.write");
  const pageScopes = planScopesForCapabilities(["pages", "dns", "zone"]).scopes;
  for (const id of ["getPagesProject", "updatePagesProject", "getPagesUploadToken", "createPagesDeployment", "getPagesDeployment", "listZones", "listDnsRecords", "createDnsRecord", "updateDnsRecord"]) expect(pageScopes).toContain(endpointScope(id));
  expect(pageScopes).not.toContain("workers-scripts.admin");
});
