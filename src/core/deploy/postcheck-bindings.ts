// post-deploy binding verification. A version cutover alone does not prove
// the Worker is bound to the resources the plan approved, so the postcheck
// compares the Worker's resulting settings bindings (read fresh from Cloudflare)
// with the desired stable identities: bucket/queue/index names and account
// resource ids resolved from the same fresh snapshot. Pure.

import type { DeploySpec } from "../deploy-spec.js";
import type { TargetSnapshot } from "../planning/types.js";
import { vectorizeConfigMatches } from "../../cloudflare/resources/vectorize.js";

export interface BindingVerification {
  ok: boolean;
  mismatches: string[];
}

export function verifyDeployedBindings(spec: DeploySpec, snapshot: TargetSnapshot): BindingVerification {
  const mismatches: string[] = [];
  const live = snapshot.deployedBindings ?? {};

  const check = (family: string, binding: string, actual: string | undefined, expected: string) => {
    if (actual === undefined) {
      mismatches.push(`${family} binding "${binding}" is missing from the deployed Worker`);
    } else if (actual !== expected) {
      mismatches.push(`${family} binding "${binding}" resolves to ${actual}, expected ${expected}`);
    }
  };
  // Resources bound by account id: the id must come from the live account list.
  const checkById = (
    family: string,
    binding: string,
    actual: string | undefined,
    list: { name: string; id: string }[],
    name: string,
    noun: string,
  ) => {
    const resource = list.find((item) => item.name === name);
    if (!resource) {
      mismatches.push(`${family} binding "${binding}": ${noun} "${name}" does not exist in the account`);
      return;
    }
    check(family, binding, actual, resource.id);
  };

  for (const b of spec.cloudflare.r2) {
    check("r2", b.binding, live.r2?.[b.binding], b.bucketName);
  }
  for (const b of spec.cloudflare.d1) {
    checkById("d1", b.binding, live.d1?.[b.binding], snapshot.d1Databases, b.databaseName, "database");
  }
  for (const b of spec.cloudflare.kv) {
    checkById("kv", b.binding, live.kv?.[b.binding], snapshot.kvNamespaces, b.namespaceName, "namespace");
  }
  for (const b of spec.cloudflare.queues) {
    // A consumer is a trigger registration on the queue, not a Worker binding;
    // a consumer-only queue has no environment binding at all.
    if (b.role !== "consumer" && b.binding !== undefined) {
      check("queue", b.binding, live.queue?.[b.binding], b.queueName);
    }
  }
  for (const b of spec.cloudflare.hyperdrive) {
    checkById("hyperdrive", b.binding, live.hyperdrive?.[b.binding], snapshot.hyperdriveConfigs, b.configName, "config");
  }
  for (const b of spec.cloudflare.vectorize) {
    check("vectorize", b.binding, live.vectorize?.[b.binding], b.indexName);
    if (b.config && !vectorizeConfigMatches(b.config, snapshot.vectorizeIndexes.find(index => index.name === b.indexName)?.config)) mismatches.push(`vectorize binding "${b.binding}" immutable schema differs from approval`);
  }
  for (const b of spec.cloudflare.secretsStore) {
    if (!b.secretName) {
      continue;
    }
    const store = snapshot.secretsStores.find((s) => s.name === b.storeName);
    if (!store) {
      mismatches.push(`secrets-store binding "${b.binding}": store "${b.storeName}" does not exist in the account`);
      continue;
    }
    const deployed = live.secretsStore?.[b.binding];
    if (!deployed) {
      mismatches.push(`secrets-store binding "${b.binding}" is missing from the deployed Worker`);
    } else if (deployed.storeId !== store.id || deployed.secretName !== b.secretName) {
      mismatches.push(
        `secrets-store binding "${b.binding}" resolves to ${deployed.storeId}/${deployed.secretName}, expected ${store.id}/${b.secretName}`,
      );
    }
  }
  for (const b of spec.cloudflare.runtimeBindings) {
    if (live.runtime?.[b.binding] !== b.type) {
      mismatches.push(`runtime binding "${b.binding}" (${b.type}) is missing from the deployed Worker`);
    }
  }
  // rate-limit metadata bindings are version bindings, not account
  // resources: verify each declared binding name is present on the exact
  // active Worker. Full field comparison (namespace_id/simple) happens at the
  // version readback; this is the post-cutover presence check.
  for (const b of spec.wrangler.ratelimits ?? []) {
    if (!(snapshot.activeBindings ?? []).some((binding) => binding.name === b.name && binding.type === "ratelimit")) {
      mismatches.push(`rate-limit binding "${b.name}" is missing from the deployed Worker`);
    }
  }
  for (const name of Object.keys(spec.cloudflare.secrets ?? {})) {
    if (!(snapshot.secretNames ?? []).includes(name)) mismatches.push(`secret binding "${name}" is missing from the exact active Worker`);
  }
  for (const [name, value] of Object.entries(spec.wrangler.vars ?? {})) {
    if (!(snapshot.activeBindings ?? []).some(b => b.name === name && b.type === "plain_text" && b.text === String(value))) mismatches.push(`plaintext binding "${name}" differs from the approved value`);
  }
  if (spec.assets.length && !(snapshot.activeBindings ?? []).some(b => b.name === (spec.wrangler.assets?.binding ?? "ASSETS") && b.type === "assets")) mismatches.push("approved static assets binding is missing from the exact active Worker");
  return { ok: mismatches.length === 0, mismatches };
}
