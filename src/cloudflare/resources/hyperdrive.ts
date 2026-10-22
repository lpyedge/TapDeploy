// Cloudflare Hyperdrive config adapter.
//
// A Hyperdrive config is a distinct account resource. The installer only ever
// creates an explicitly-declared-and-permitted missing config; an existing
// config is preserved by identity and never recreated, overwritten, or
// re-pointed to a different database. There is no delete path and no database
// credential rotation: the connection `origin` fields are carried in the create
// request only, are never logged, and the provider never echoes the write-only
// `password` / `access_client_secret` back.

import type { CloudflareApiClient } from "../client/index.js";
import type { HyperdriveBindingSpec } from "../../core/deploy-spec.js";
import type { HyperdriveConfig, HyperdriveCreateRequest } from "../models/index.js";
import {
  ResourceConflictError,
  type ResourceAdapter,
  type ResourceSupport,
} from "./types.js";

export const HYPERDRIVE_SUPPORT: ResourceSupport = {
  kind: "hyperdrive",
  label: "Hyperdrive",
  install: "create-declared",
  upgrade: "preserve",
  deletes: "never",
  verified: "local-contract",
};

export const hyperdriveAdapter: ResourceAdapter = {
  support: HYPERDRIVE_SUPPORT,
  mutation: "ensureHyperdriveConfig",
};

export type HyperdriveAction =
  | { binding: string; configName: string; action: "preserve"; id: string }
  | { binding: string; configName: string; action: "create" }
  | { binding: string; configName: string; action: "conflict"; detail: string };

type KnownHyperdriveConfigs = readonly Pick<HyperdriveConfig, "name" | "id">[];

// Pure: decide what should happen to one declared hyperdrive binding against
// live configs.
export function hyperdriveActionFor(
  binding: HyperdriveBindingSpec,
  knownConfigs: KnownHyperdriveConfigs,
): HyperdriveAction {
  const existing = knownConfigs.find((c) => c.name === binding.configName);
  if (existing) {
    return {
      binding: binding.binding,
      configName: binding.configName,
      action: "preserve",
      id: existing.id,
    };
  }
  if (binding.createIfMissing) {
    return {
      binding: binding.binding,
      configName: binding.configName,
      action: "create",
    };
  }
  return {
    binding: binding.binding,
    configName: binding.configName,
    action: "conflict",
    detail: `Hyperdrive config "${binding.configName}" is missing and createIfMissing=false`,
  };
}

export interface EnsureHyperdriveConfigRequest {
  configName: string;
  createIfMissing: boolean;
  knownConfigs: KnownHyperdriveConfigs;
  // The connection origin to apply only when the config is actually created.
  // Never logged; the existing config is preserved without touching it.
  createRequest: HyperdriveCreateRequest;
}

export type EnsureHyperdriveConfigResult =
  | { action: "preserve"; name: string; id: string }
  | { action: "create"; name: string; id: string };

export async function ensureHyperdriveConfig(
  client: CloudflareApiClient,
  request: EnsureHyperdriveConfigRequest,
): Promise<EnsureHyperdriveConfigResult> {
  const action = hyperdriveActionFor(
    { binding: "", configName: request.configName, createIfMissing: request.createIfMissing },
    request.knownConfigs,
  );
  if (action.action === "preserve") {
    return { action: "preserve", name: action.configName, id: action.id };
  }
  if (action.action === "conflict") {
    throw new ResourceConflictError(action.detail);
  }
  if (!isSupportedHyperdriveOrigin(request.createRequest.origin)) throw new ResourceConflictError("Hyperdrive creation requires an explicit complete supported public database origin; no placeholder origin is permitted");
  const created = await client.createHyperdriveConfig(request.createRequest);
  if (created.name !== request.configName || !created.id || !hyperdriveOriginMatches(request.createRequest.origin, created.origin)) throw new ResourceConflictError("created Hyperdrive origin/identity did not match the approved request; inspect remote state before retry");
  return { action: "create", name: created.name, id: created.id };
}
export function hyperdriveOriginMatches(expected: NonNullable<HyperdriveCreateRequest["origin"]>, actual: HyperdriveCreateRequest["origin"] | undefined): boolean {
  if (!actual) return false;
  return (["database", "host", "port", "scheme", "user"] as const).every(key => expected[key] === undefined || expected[key] === actual[key]);
}
export function isSupportedHyperdriveOrigin(origin: unknown): boolean {
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) return false;
  const value = origin as Record<string, unknown>;
  const keys = new Set(["database", "host", "password", "port", "scheme", "user"]);
  return Object.keys(value).every(key => keys.has(key)) &&
    ["database", "host", "password", "user"].every(key => typeof value[key] === "string" && (value[key] as string).length > 0) &&
    typeof value.scheme === "string" && ["postgres", "postgresql", "mysql"].includes(value.scheme) && Number.isInteger(value.port) && Number(value.port) > 0 && Number(value.port) <= 65535;
}
