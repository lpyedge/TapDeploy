import type { DeploySpec } from "../deploy-spec.js";
import type { TargetSnapshot } from "../planning/types.js";
import { vectorizeActionFor } from "../../cloudflare/resources/vectorize.js";

// Preflight all declared families before ANY preparation, not only the family
// about to write. Denied discovery is handled by snapshot's required reads.
export function resourceCapabilityIssues(spec: DeploySpec, snapshot: TargetSnapshot, providedByOtherUnits?: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  if ((spec.cloudflare.domains ?? []).some(domain => spec.targetKind === "pages" ? domain.kind.startsWith("workers-") : domain.kind === "pages-custom-domain")) issues.push("domain family is incompatible with the approved target; start a supported target/config flow rather than escalate scopes");
  const families = [
    ["r2", "r2Buckets", "bucketName"], ["d1", "d1Databases", "databaseName"],
    ["kv", "kvNamespaces", "namespaceName"], ["queues", "queues", "queueName"],
    ["hyperdrive", "hyperdriveConfigs", "configName"], ["vectorize", "vectorizeIndexes", "indexName"],
    ["secretsStore", "secretsStores", "storeName"],
  ] as const;
  for (const [family, inventory, nameKey] of families) {
    const bindings = spec.cloudflare[family] as unknown as Array<Record<string, unknown>>;
    for (const binding of bindings) {
      const name = binding[nameKey];
      const matches = (snapshot[inventory] ?? []).filter(item => item.name === name);
      if (!matches.length && bindings.filter(other => other[nameKey] === name).length > 1) issues.push(`${family} repeated missing target requires a single creation followed by explicit existing selection; batch duplicate creation is unavailable`);
      if (matches.length > 1 || matches.some(item => !item.id)) issues.push(`${family} resource identity is ambiguous or unavailable`);
      if (spec.targetKind === "pages" && matches.length === 0) issues.push(`Pages requires an existing selected ${family} resource; provisioning is unavailable`);
    }
  }
  for (const binding of spec.cloudflare.vectorize) {
    if (providedByOtherUnits?.has(`vectorize:${binding.indexName}`)) continue;
    const action = vectorizeActionFor(binding, snapshot.vectorizeIndexes ?? []);
    if (action.action === "conflict") issues.push(action.detail);
  }
  for (const binding of spec.cloudflare.secretsStore) if (!binding.secretName) issues.push("Secrets Store requires a declared supported secret-name binding; store-only placeholder configuration is unavailable");
  if (spec.targetKind === "pages" && (spec.cloudflare.queues.length || (spec.cloudflare.workflows?.length ?? 0) || spec.cloudflare.hyperdrive.length || spec.cloudflare.vectorize.length || spec.cloudflare.secretsStore.length || spec.cloudflare.runtimeBindings.some(binding => binding.type === "ai"))) issues.push("declared resource family is not implemented for Pages; no project/account mutation permitted");
  return issues;
}
