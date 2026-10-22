// Cloudflare central Secrets Store adapter.
//
// A Secrets Store has two distinct levels: the account-level **store** (a named
// container) and the **secret** inside it (a name + a write-only `value` with a
// scope list). The installer only ever creates an explicitly-declared-
// and-permitted missing store/secret; an existing store/secret is preserved by
// identity and never recreated. There is no delete path and no secret rotation.
// The secret `value` is write-only: it is forwarded only on create (or an
// explicit update) and is NEVER read back, echoed, logged or persisted. A Worker
// binds a specific secret by `store_id` + `secret_name` via the
// `secrets_store_secret` binding type, which is a different product from a
// Worker version secret.

import type { CloudflareApiClient } from "../client/index.js";
import type { SecretsStoreBindingSpec } from "../../core/deploy-spec.js";
import type {
  SecretsStore,
  SecretsStoreSecret,
  SecretsStoreSecretCreateRequest,
} from "../models/index.js";
import {
  ResourceConflictError,
  type ResourceAdapter,
  type ResourceSupport,
} from "./types.js";

export const SECRETS_STORE_SUPPORT: ResourceSupport = {
  kind: "secrets-store",
  label: "Secrets Store",
  install: "create-declared",
  upgrade: "preserve",
  deletes: "never",
  verified: "local-contract",
};

export const secretsStoreAdapter: ResourceAdapter = {
  support: SECRETS_STORE_SUPPORT,
  mutation: "ensureSecretsStore",
};

export type SecretsStoreAction =
  | { binding: string; storeName: string; action: "preserve"; id: string }
  | { binding: string; storeName: string; action: "create" }
  | { binding: string; storeName: string; action: "conflict"; detail: string };

type KnownStores = readonly Pick<SecretsStore, "name" | "id">[];
type KnownSecrets = readonly Pick<SecretsStoreSecret, "name" | "id" | "store_id">[];

// Pure: decide what should happen to one declared store against live stores.
export function secretsStoreActionFor(
  binding: SecretsStoreBindingSpec,
  knownStores: KnownStores,
): SecretsStoreAction {
  const existing = knownStores.find((s) => s.name === binding.storeName);
  if (existing) {
    return {
      binding: binding.binding,
      storeName: binding.storeName,
      action: "preserve",
      id: existing.id,
    };
  }
  if (binding.createIfMissing) {
    return {
      binding: binding.binding,
      storeName: binding.storeName,
      action: "create",
    };
  }
  return {
    binding: binding.binding,
    storeName: binding.storeName,
    action: "conflict",
    detail: `Secrets Store "${binding.storeName}" is missing and createIfMissing=false`,
  };
}

export interface EnsureSecretsStoreRequest {
  storeName: string;
  createIfMissing: boolean;
  knownStores: KnownStores;
}

export type EnsureSecretsStoreResult =
  | { action: "preserve"; name: string; id: string }
  | { action: "create"; name: string; id: string };

export async function ensureSecretsStore(
  client: CloudflareApiClient,
  request: EnsureSecretsStoreRequest,
): Promise<EnsureSecretsStoreResult> {
  const action = secretsStoreActionFor(
    { binding: "", storeName: request.storeName, createIfMissing: request.createIfMissing },
    request.knownStores,
  );
  if (action.action === "preserve") {
    return { action: "preserve", name: action.storeName, id: action.id };
  }
  if (action.action === "conflict") {
    throw new ResourceConflictError(action.detail);
  }
  const created = await client.createSecretsStore({ name: request.storeName });
  return { action: "create", name: created.name, id: created.id };
}

// Resolve the live store id for a declared secret binding, then ensure the named
// secret exists inside it. The secret is created only when the declared
// `createIfMissing` is true and the secret is absent; an existing secret is
// preserved by identity and its `value` is never read back or rewritten on a
// normal upgrade. `value` is forwarded only when the secret is actually created.
export interface EnsureSecretsStoreSecretRequest {
  secretName: string;
  createIfMissing: boolean;
  storeId: string;
  knownSecrets: KnownSecrets;
  // Write-only value applied only on create. Never logged or persisted.
  createRequest?: SecretsStoreSecretCreateRequest;
}

export type EnsureSecretsStoreSecretResult =
  | { action: "preserve"; name: string; id: string }
  | { action: "create"; name: string; id: string };

export async function ensureSecretsStoreSecret(
  client: CloudflareApiClient,
  request: EnsureSecretsStoreSecretRequest,
): Promise<EnsureSecretsStoreSecretResult> {
  const existing = request.knownSecrets.find((s) => s.name === request.secretName);
  if (existing) {
    return { action: "preserve", name: existing.name, id: existing.id };
  }
  if (!request.createIfMissing) {
    throw new ResourceConflictError(
      `Secrets Store secret "${request.secretName}" is missing and createIfMissing=false`,
    );
  }
  const created = await client.createSecretsStoreSecret(request.storeId, {
    name: request.secretName,
    scopes: request.createRequest?.scopes ?? ["workers"],
    value: request.createRequest?.value ?? "",
  });
  return { action: "create", name: created.name, id: created.id };
}

/** Allowed Secrets Store secret scopes (provider enum). */
const SECRETS_STORE_SECRET_SCOPES = [
  "workers",
  "ai_gateway",
  "dex",
  "cloudflare_workers_ai",
] as const;

/** Validate a declared secret scope against the provider's accepted enum. */
export function validateSecretsStoreScope(scope: string): boolean {
  return (SECRETS_STORE_SECRET_SCOPES as readonly string[]).includes(scope);
}
