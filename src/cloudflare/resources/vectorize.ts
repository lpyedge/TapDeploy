// Cloudflare Vectorize index adapter.
//
// A Vectorize index is a distinct account resource. The installer only ever
// creates an explicitly-declared-and-permitted missing index; an existing index
// is preserved by identity and never recreated, and its dimension/metric
// configuration is immutable on the live resource, so it is never silently
// changed in place. There is no delete path. The binding carried into the Worker
// version is the `vectorize` binding shape `{name, index_name, type:"vectorize"}`.

import type { CloudflareApiClient } from "../client/index.js";
import type { VectorizeBindingSpec } from "../../core/deploy-spec.js";
import type { VectorizeCreateRequest, VectorizeIndex } from "../models/index.js";
import {
  ResourceConflictError,
  type ResourceAdapter,
  type ResourceSupport,
} from "./types.js";

export const VECTORIZE_SUPPORT: ResourceSupport = {
  kind: "vectorize",
  label: "Vectorize index",
  install: "create-declared",
  upgrade: "preserve",
  deletes: "never",
  verified: "local-contract",
};

export const vectorizeAdapter: ResourceAdapter = {
  support: VECTORIZE_SUPPORT,
  mutation: "ensureVectorizeIndex",
};

export type VectorizeAction =
  | { binding: string; indexName: string; action: "preserve"; id: string }
  | { binding: string; indexName: string; action: "create" }
  | { binding: string; indexName: string; action: "conflict"; detail: string };

type KnownVectorizeIndexes = readonly Pick<VectorizeIndex, "name" | "id" | "config">[];

// Pure: decide what should happen to one declared vectorize binding against
// live indexes.
export function vectorizeActionFor(
  binding: VectorizeBindingSpec,
  knownIndexes: KnownVectorizeIndexes,
): VectorizeAction {
  if (binding.config && !isSupportedVectorizeConfig(binding.config)) return { binding: binding.binding, indexName: binding.indexName, action: "conflict", detail: "Vectorize configuration must use a supported preset OR dimensions/metric, never a mixed or invalid schema" };
  const matches = knownIndexes.filter(c => c.name === binding.indexName);
  if (matches.length > 1) return { binding: binding.binding, indexName: binding.indexName, action: "conflict", detail: "Vectorize name is ambiguous; no identity can be selected safely" };
  const existing = matches[0];
  if (existing) {
    if (binding.config && !vectorizeConfigMatches(binding.config, existing.config)) return { binding: binding.binding, indexName: binding.indexName, action: "conflict", detail: "existing Vectorize immutable schema is unavailable or differs from the approved dimensions/metric/preset" };
    return {
      binding: binding.binding,
      indexName: binding.indexName,
      action: "preserve",
      id: existing.id,
    };
  }
  if (binding.createIfMissing) {
    return {
      binding: binding.binding,
      indexName: binding.indexName,
      action: "create",
    };
  }
  return {
    binding: binding.binding,
    indexName: binding.indexName,
    action: "conflict",
    detail: `Vectorize index "${binding.indexName}" is missing and createIfMissing=false`,
  };
}

export interface EnsureVectorizeIndexRequest {
  indexName: string;
  createIfMissing: boolean;
  knownIndexes: KnownVectorizeIndexes;
  // The index config to apply only when the index is actually created. An
  // existing index is preserved without touching its dimension/metric config.
  createRequest: VectorizeCreateRequest;
}

export type EnsureVectorizeIndexResult =
  | { action: "preserve"; name: string; id: string }
  | { action: "create"; name: string; id: string };

export async function ensureVectorizeIndex(
  client: CloudflareApiClient,
  request: EnsureVectorizeIndexRequest,
): Promise<EnsureVectorizeIndexResult> {
  const action = vectorizeActionFor(
    { binding: "", indexName: request.indexName, createIfMissing: request.createIfMissing, config: request.createRequest.config },
    request.knownIndexes,
  );
  if (action.action === "preserve") {
    return { action: "preserve", name: action.indexName, id: action.id };
  }
  if (action.action === "conflict") {
    throw new ResourceConflictError(action.detail);
  }
  const created = await client.createVectorizeIndex(request.createRequest);
  if (created.name !== request.indexName || !created.id || !vectorizeConfigMatches(request.createRequest.config, created.config)) throw new ResourceConflictError("created Vectorize identity/schema did not match the approved request; inspect remote state before retry");
  return { action: "create", name: created.name, id: created.id };
}
export function vectorizeConfigMatches(expected: NonNullable<VectorizeBindingSpec["config"]>, actual: VectorizeIndex["config"]): boolean {
  if (!actual) return false;
  if (expected.preset) return actual.preset === expected.preset;
  return actual.dimensions === (expected.dimensions ?? 768) && actual.metric === (expected.metric ?? "cosine");
}
function isSupportedVectorizeConfig(config: NonNullable<VectorizeBindingSpec["config"]>): boolean {
  if (Object.keys(config).some(key => !["preset", "dimensions", "metric"].includes(key))) return false;
  if (config.preset !== undefined) return config.dimensions === undefined && config.metric === undefined && ["@cf/baai/bge-small-en-v1.5", "@cf/baai/bge-base-en-v1.5", "@cf/baai/bge-large-en-v1.5", "openai/text-embedding-ada-002", "cohere/embed-multilingual-v2.0"].includes(config.preset);
  return (config.dimensions === undefined || (Number.isInteger(config.dimensions) && config.dimensions > 0)) && (config.metric === undefined || ["cosine", "euclidean", "dot-product"].includes(config.metric));
}
