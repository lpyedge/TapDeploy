// Workers rate-limiting metadata adapter. v1 declares no rate limits in the
// manifest, so this adapter is read/verify only: it reads the documented worker
// settings bindings (GET .../settings, type:"ratelimit") and preserves whatever
// already exists by name. It never writes and never deletes. A future manifest
// that declares rate limits must fail closed here until a live-verified
// contract exists. The undocumented /rate-limits provider path is not
// used: the snapshot and this step both derive rate-limit state from
// settings bindings.

import type { CloudflareApiClient } from "../client/index.js";
import type { WorkerSettings } from "../models/index.js";
import {
  ResourceConflictError,
} from "./types.js";

function isTolerableAbsent(error: unknown): boolean {
  const e = error as { kind?: string };
  return (
    typeof e === "object" &&
    e !== null &&
    (e.kind === "not-found" || e.kind === "forbidden" || e.kind === "unauthorized")
  );
}

// A preserved rate-limit binding is identified by its binding name (identity
// only — settings bindings carry name + type, not period/limit metadata).
export interface NormalizedRateLimit {
  name: string;
}

// Map the documented worker settings bindings (GET .../settings) to a
// normalized, identity-only view. Ratelimit bindings appear as
// { type: "ratelimit", name: "<binding>" }. Malformed entries fail closed
// rather than being silently coerced.
function mapRateLimitMetadata(settings: unknown): NormalizedRateLimit[] {
  if (typeof settings !== "object" || settings === null) {
    throw new ResourceConflictError("Rate-limit settings are not an object");
  }
  const bindings = (settings as WorkerSettings).bindings;
  if (bindings !== undefined && !Array.isArray(bindings)) {
    throw new ResourceConflictError("Rate-limit settings bindings is not an array");
  }
  const names: string[] = [];
  for (const binding of bindings ?? []) {
    const b = binding as { type?: unknown; name?: unknown };
    if (b?.type !== "ratelimit") {
      continue;
    }
    if (typeof b.name !== "string" || b.name.length === 0) {
      throw new ResourceConflictError("Ratelimit binding is missing a name");
    }
    names.push(b.name);
  }
  return names.map((name) => ({ name }));
}

export interface ReconcileRateLimitsResult {
  preserved: NormalizedRateLimit[];
  unchanged: true;
}

// Read the documented worker settings bindings and confirm the existing rate
// limits are preserved untouched. A missing script or missing scope means there
// is nothing bound yet (install), not an error. Never writes.
export async function readPreservedRateLimits(
  client: CloudflareApiClient,
  workerName: string,
): Promise<ReconcileRateLimitsResult> {
  try {
    const settings = await client.getWorkerSettings(workerName);
    return { preserved: mapRateLimitMetadata(settings), unchanged: true };
  } catch (error) {
    if (isTolerableAbsent(error)) {
      return { preserved: [], unchanged: true };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// projection from the final Wrangler config (`ratelimits[]`) to Worker
// metadata bindings. This is a binding projection ONLY: rate limits are not
// account/zone resources, no provider-side rate-limit rule is ever created,
// updated or deleted, and no counter state is mutated. The official metadata
// shape is {name, type:"ratelimit", namespace_id, simple:{limit, period}}.
// ---------------------------------------------------------------------------

// A declared rate limit from the final Wrangler config. Structurally matches
// WranglerV3RateLimit; the adapter takes the minimal shape so it stays
// independent of the manifest layer. Shape validation (positive integer limit,
// official period set) happens at parse time; this layer re-checks the basics
// and the counters-ownership rules.
export interface DeclaredRateLimit {
  name: string;
  namespace_id: string;
  limit: number;
  period: number;
}

interface RateLimitMetadataBinding {
  name: string;
  type: "ratelimit";
  namespace_id: string;
  simple: { limit: number; period: number };
}

export interface RateLimitBindingPlan {
  /** Metadata bindings in declaration order (deterministic). */
  bindings: RateLimitMetadataBinding[];
  /** Declared names read back from the live Worker settings (identity readback). */
  preserved: string[];
  /** Declared names with no live binding yet (added by the next version). */
  added: string[];
}

// Pure: project declared rate limits to Worker metadata bindings and classify
// each against the live settings bindings. Counters ownership rules:
//   - a preserved name keeps the namespace it is declared with; the live
//     settings carry no namespace/rule readback, so nothing is silently
//     re-pointed to another namespace or recreated;
//   - every namespace_id must be unique across the declaration — two bindings
//     sharing a namespace would share counters and fail closed instead;
//   - binding names must be unique (the version metadata rejects duplicates);
//   - no account/zone rate-limit resource is created or modified; the result
//     describes version metadata only.
// the declared shape is verified against the official Oct-2026 binding
// contract — positive integer limit, period 10 or 60 seconds, and a positive
// decimal-string namespace_id. Anything else fails closed here, before any
// provider read or write (the Wrangler parser accepts a wider shape).
export function planRateLimitBindings(
  declared: readonly DeclaredRateLimit[],
  existing: readonly NormalizedRateLimit[],
): RateLimitBindingPlan {
  const namesSeen = new Map<string, string>();
  const namespacesSeen = new Map<string, string>();
  const bindings: RateLimitMetadataBinding[] = [];
  for (const entry of declared) {
    const duplicateName = namesSeen.get(entry.name);
    if (duplicateName !== undefined) {
      throw new ResourceConflictError(
        `rate limit binding "${entry.name}" is declared twice; binding names must be unique`,
      );
    }
    namesSeen.set(entry.name, entry.namespace_id);
    const namespaceOwner = namespacesSeen.get(entry.namespace_id);
    if (namespaceOwner !== undefined) {
      throw new ResourceConflictError(
        `rate limits "${namespaceOwner}" and "${entry.name}" share namespace_id "${entry.namespace_id}"; counters ownership must stay unique`,
      );
    }
    namespacesSeen.set(entry.namespace_id, entry.name);
    if (!Number.isInteger(entry.limit) || entry.limit <= 0) {
      throw new ResourceConflictError(
        `rate limit "${entry.name}" limit must be a positive integer`,
      );
    }
    if (entry.period !== 10 && entry.period !== 60) {
      throw new ResourceConflictError(
        `rate limit "${entry.name}" period must be 10 or 60 seconds (official binding contract)`,
      );
    }
    if (!/^[1-9][0-9]*$/.test(entry.namespace_id)) {
      throw new ResourceConflictError(
        `rate limit "${entry.name}" namespace_id must be a positive decimal string`,
      );
    }
    bindings.push({
      name: entry.name,
      type: "ratelimit",
      namespace_id: entry.namespace_id,
      simple: { limit: entry.limit, period: entry.period },
    });
  }
  const existingNames = new Set(existing.map((entry) => entry.name));
  return {
    bindings,
    preserved: declared.filter((entry) => existingNames.has(entry.name)).map((entry) => entry.name),
    added: declared.filter((entry) => !existingNames.has(entry.name)).map((entry) => entry.name),
  };
}
