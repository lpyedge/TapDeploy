// KV namespace adapter. Only ever creates an explicitly-declared-and-permitted
// missing namespace; an existing namespace is preserved by identity and never
// recreated or overwritten. There is no delete path and no key mutation (no
// writes to a namespace's keys happen here — the release owns its key lifecycle).

import type { CloudflareApiClient } from "../client/index.js";
import type { KvBindingSpec } from "../../core/deploy-spec.js";
import type { KvNamespace } from "../models/index.js";
import {
  ResourceConflictError,
} from "./types.js";

export type NamespaceAction =
  | { binding: string; namespaceName: string; action: "preserve"; id: string }
  | { binding: string; namespaceName: string; action: "create" }
  | { binding: string; namespaceName: string; action: "conflict"; detail: string };

type KnownNamespaces = readonly Pick<KvNamespace, "name" | "id">[];

// Pure: decide what should happen to one declared KV binding against live namespaces.
export function namespaceActionFor(
  binding: KvBindingSpec,
  knownNamespaces: KnownNamespaces,
): NamespaceAction {
  const existing = knownNamespaces.find((n) => n.name === binding.namespaceName);
  if (existing) {
    return {
      binding: binding.binding,
      namespaceName: binding.namespaceName,
      action: "preserve",
      id: existing.id,
    };
  }
  if (binding.createIfMissing) {
    return {
      binding: binding.binding,
      namespaceName: binding.namespaceName,
      action: "create",
    };
  }
  return {
    binding: binding.binding,
    namespaceName: binding.namespaceName,
    action: "conflict",
    detail: `KV namespace "${binding.namespaceName}" is missing and createIfMissing=false`,
  };
}

export interface EnsureNamespaceRequest {
  namespaceName: string;
  createIfMissing: boolean;
  knownNamespaces: KnownNamespaces;
}

// a declared KV binding handle from the final Wrangler config. A
// kv_namespaces entry carries only the provider namespace id — there is no
// title, so KV namespaces are never created from a wrangler binding; the
// declared id is verified against the live account and a missing id is a
// conflict, never a silent recreation.
export interface DeclaredKvNamespace {
  binding: string;
  namespaceId: string;
}

// Pure: verify one declared KV binding against live namespaces.
export function plannedNamespaceActionFor(
  declared: DeclaredKvNamespace,
  knownNamespaces: KnownNamespaces,
): NamespaceAction {
  if (!declared.namespaceId) {
    return {
      binding: declared.binding,
      namespaceName: declared.namespaceId,
      action: "conflict",
      detail: `KV binding "${declared.binding}" declares no namespace id to verify`,
    };
  }
  const matches = knownNamespaces.filter((n) => n.id === declared.namespaceId);
  if (matches.length > 1) {
    return {
      binding: declared.binding,
      namespaceName: declared.namespaceId,
      action: "conflict",
      detail: `KV namespace id for binding "${declared.binding}" matches ${matches.length} live namespaces; refusing to guess`,
    };
  }
  const existing = matches[0];
  if (!existing) {
    return {
      binding: declared.binding,
      namespaceName: declared.namespaceId,
      action: "conflict",
      detail: `declared KV namespace id for binding "${declared.binding}" is not present in this account; a KV namespace is never recreated from a wrangler binding`,
    };
  }
  return {
    binding: declared.binding,
    namespaceName: existing.name,
    action: "preserve",
    id: existing.id,
  };
}

export type EnsureNamespaceResult =
  | { action: "preserve"; name: string; id: string }
  | { action: "create"; name: string; id: string };

export async function ensureKvNamespace(
  client: CloudflareApiClient,
  request: EnsureNamespaceRequest,
): Promise<EnsureNamespaceResult> {
  const action = namespaceActionFor(
    { binding: "", namespaceName: request.namespaceName, createIfMissing: request.createIfMissing },
    request.knownNamespaces,
  );
  if (action.action === "preserve") {
    return { action: "preserve", name: action.namespaceName, id: action.id };
  }
  if (action.action === "conflict") {
    throw new ResourceConflictError(action.detail);
  }
  const created = await client.createKvNamespace({ title: request.namespaceName });
  return { action: "create", name: created.name, id: created.id };
}
