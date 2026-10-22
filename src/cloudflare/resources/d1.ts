// D1 database adapter. Only ever creates an explicitly-declared-and-permitted
// missing database; an existing database is preserved by identity and never
// recreated, migrated, or overwritten. There is no delete path and no automatic
// migration (tables/schema are the release's responsibility).

import type { CloudflareApiClient } from "../client/index.js";
import type { D1BindingSpec } from "../../core/deploy-spec.js";
import type { D1Database } from "../models/index.js";
import {
  ResourceConflictError,
  type ResourceAdapter,
  type ResourceSupport,
} from "./types.js";

export const D1_DATABASE_SUPPORT: ResourceSupport = {
  kind: "d1-database",
  label: "D1 database",
  install: "create-declared",
  upgrade: "preserve",
  deletes: "never",
  verified: "local-contract",
};

export const d1DatabaseAdapter: ResourceAdapter = {
  support: D1_DATABASE_SUPPORT,
  mutation: "ensureD1Database",
};

export type DatabaseAction =
  | { binding: string; databaseName: string; action: "preserve"; id: string }
  | { binding: string; databaseName: string; action: "create" }
  | { binding: string; databaseName: string; action: "conflict"; detail: string };

type KnownDatabases = readonly Pick<D1Database, "name" | "id">[];

// a declared D1 binding handle from the final Wrangler config. The name is
// the creation handle; a declared `databaseId` is an identity claim that must be
// verified against the current account and is never recreated (creating under
// the same name would silently bind a different database).
export interface DeclaredD1Database {
  binding: string;
  databaseName: string;
  databaseId?: string;
}

export interface D1EnsureOptions {
  createIfMissing: boolean;
}

// Pure: decide the safe action for one declared binding against live databases.
export function plannedDatabaseActionFor(
  declared: DeclaredD1Database,
  knownDatabases: KnownDatabases,
  options: D1EnsureOptions,
): DatabaseAction {
  const claimedId = declared.databaseId;
  if (claimedId !== undefined) {
    const byId = knownDatabases.filter((d) => d.id === claimedId);
    if (byId.length > 1) {
      return {
        binding: declared.binding,
        databaseName: declared.databaseName,
        action: "conflict",
        detail: `D1 database id for binding "${declared.binding}" matches ${byId.length} live databases; refusing to guess`,
      };
    }
    const matchById = byId[0];
    if (matchById) {
      if (!matchById.id) {
        return {
          binding: declared.binding,
          databaseName: declared.databaseName,
          action: "conflict",
          detail: `D1 database "${declared.databaseName}" exists but its live identity is unavailable`,
        };
      }
      if (matchById.name !== declared.databaseName) {
        return {
          binding: declared.binding,
          databaseName: declared.databaseName,
          action: "conflict",
          detail: `declared database_id for binding "${declared.binding}" belongs to live database "${matchById.name}", not "${declared.databaseName}"; refusing a silent rebind`,
        };
      }
      return {
        binding: declared.binding,
        databaseName: declared.databaseName,
        action: "preserve",
        id: matchById.id,
      };
    }
    const byName = knownDatabases.filter((d) => d.name === declared.databaseName);
    if (byName.length > 0) {
      return {
        binding: declared.binding,
        databaseName: declared.databaseName,
        action: "conflict",
        detail: `D1 database "${declared.databaseName}" exists in this account with a different id than the declared database_id; refusing a silent rebind (remove database_id to select by name)`,
      };
    }
    // The declared identity is absent from the verified live account. A declared
    // provider id is never recreated: creation is by name only, so proceeding
    // would bind a different database than the config declares.
    return {
      binding: declared.binding,
      databaseName: declared.databaseName,
      action: "conflict",
      detail: `declared database_id for binding "${declared.binding}" is not present in this account; a declared D1 id is never recreated (remove database_id to create by name)`,
    };
  }

  const matches = knownDatabases.filter((d) => d.name === declared.databaseName);
  if (matches.length > 1) {
    return {
      binding: declared.binding,
      databaseName: declared.databaseName,
      action: "conflict",
      detail: `D1 database "${declared.databaseName}" has ${matches.length} live identities in this account; refusing to guess`,
    };
  }
  const existing = matches[0];
  if (existing) {
    if (!existing.id) {
      return {
        binding: declared.binding,
        databaseName: declared.databaseName,
        action: "conflict",
        detail: `D1 database "${declared.databaseName}" exists but its live identity is unavailable`,
      };
    }
    return {
      binding: declared.binding,
      databaseName: declared.databaseName,
      action: "preserve",
      id: existing.id,
    };
  }
  if (options.createIfMissing) {
    return {
      binding: declared.binding,
      databaseName: declared.databaseName,
      action: "create",
    };
  }
  return {
    binding: declared.binding,
    databaseName: declared.databaseName,
    action: "conflict",
    detail: `D1 database "${declared.databaseName}" is missing and createIfMissing=false`,
  };
}

// Pure: decision with identical semantics to
// plannedDatabaseActionFor without a declared provider id.
export function databaseActionFor(
  binding: D1BindingSpec,
  knownDatabases: KnownDatabases,
): DatabaseAction {
  return plannedDatabaseActionFor(binding, knownDatabases, {
    createIfMissing: binding.createIfMissing,
  });
}

export interface EnsureDatabaseRequest {
  databaseName: string;
  createIfMissing: boolean;
  knownDatabases: KnownDatabases;
}

export type EnsureDatabaseResult =
  | { action: "preserve"; name: string; id: string }
  | { action: "create"; name: string; id: string };

export async function ensureD1Database(
  client: CloudflareApiClient,
  request: EnsureDatabaseRequest,
): Promise<EnsureDatabaseResult> {
  const action = databaseActionFor(
    { binding: "", databaseName: request.databaseName, createIfMissing: request.createIfMissing },
    request.knownDatabases,
  );
  if (action.action === "preserve") {
    return { action: "preserve", name: action.databaseName, id: action.id };
  }
  if (action.action === "conflict") {
    throw new ResourceConflictError(action.detail);
  }
  const created = await client.createD1Database({ name: request.databaseName });
  return { action: "create", name: created.name, id: created.id };
}
