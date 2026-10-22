// Code-owned capability -> scope registry.
//
// This is the single place that maps each Cloudflare resource/operation the
// installer can perform to the OAuth scope ID(s) whose *capability* the provider
// needs. A config can NEVER author a scope request; the scope bundle is
// derived from this registry. It also encodes the "write implies read" policy:
// where the provider list/get endpoint accepts the product Write scope, we do
// NOT redundantly add a Read scope.
//
// The `level` field records whether a scope has been exercised against a real
// account; docs/release-status.md is the narrative record. The registry is what
// the scope planner (and the pre-auth permission preview) consults; it never
// invents a scope, and it never requests a scope the installer cannot actually
// use for a supported operation.

export type ScopeCapability =
  | "worker-admin"
  | "worker-edit"
  | "page-write"
  | "r2-write"
  | "d1-write"
  | "kv-write"
  | "queues-write"
  | "hyperdrive-write"
  | "vectorize-write"
  | "secrets-store-write"
  | "ai-write"
  | "browser-rendering-write"
  | "workers-routes-write"
  | "dns-write"
  | "zone-read";

export interface ScopeCapabilityRow {
  capability: ScopeCapability;
  scope: string; // registry/permission ID (never a dashboard label)
  apiTokenPermission: string; // matching API-token permission group name
  // Whether requesting this Write scope already satisfies the read/list/get
  // need for the same product (do not add redundant Read).
  writeCoversRead: boolean;
  // Proven level: "live" or "unverified-oauth".
  verified: "live" | "unverified-oauth";
  // Human-readable reason for the pre-auth permission preview.
  reason: string;
}

// The scope registry, keyed by capability. `workers-scripts.admin` is the single
// Worker scope that covers read + create + write + deploy + delete of Workers;
// we never add `workers-scripts.read`/`.edit` alongside it.
export const SCOPE_REGISTRY: Record<ScopeCapability, ScopeCapabilityRow> = {
  "worker-admin": {
    capability: "worker-admin",
    scope: "workers-scripts.admin",
    apiTokenPermission: "Workers Scripts Write",
    writeCoversRead: true,
    verified: "live",
    reason: "Install/upgrade/delete a Worker script; the planner needs to list workers and the first create requires Admin.",
  },
  "worker-edit": {
    capability: "worker-edit",
    scope: "workers-scripts.edit",
    apiTokenPermission: "Workers Scripts Read/Write",
    writeCoversRead: false,
    verified: "live",
    reason: "Read-only Worker introspection used by the snapshot; Admin covers this, edit is only for read-only callers.",
  },
  "page-write": {
    capability: "page-write",
    scope: "page.write",
    apiTokenPermission: "Pages Edit",
    writeCoversRead: true,
    verified: "unverified-oauth",
    reason: "Pages project list + create + deploy; the Pages list endpoint accepts Pages Write without a separate Read scope.",
  },
  "r2-write": {
    capability: "r2-write",
    scope: "workers-r2.write",
    apiTokenPermission: "Workers R2 Storage Edit",
    writeCoversRead: true,
    verified: "unverified-oauth",
    reason: "List + create an R2 bucket; the R2 list endpoint accepts Write, so no separate R2 Read is requested.",
  },
  "d1-write": {
    capability: "d1-write",
    scope: "d1.write",
    apiTokenPermission: "D1 Edit",
    writeCoversRead: true,
    verified: "unverified-oauth",
    reason: "List + create a D1 database; the D1 list endpoint accepts Write, so no separate D1 Read is requested.",
  },
  "kv-write": {
    capability: "kv-write",
    scope: "workers-kv-storage.write",
    apiTokenPermission: "Workers KV Storage Edit",
    writeCoversRead: true,
    verified: "unverified-oauth",
    reason: "List + create a KV namespace; the KV list endpoint accepts Write, so no separate KV Read is requested.",
  },
  "queues-write": {
    capability: "queues-write",
    scope: "queues.write",
    apiTokenPermission: "Queues Edit",
    writeCoversRead: true,
    verified: "unverified-oauth",
    reason: "List + create a Queue; the Queue list endpoint accepts Write, so no separate Queue Read is requested.",
  },
  "hyperdrive-write": {
    capability: "hyperdrive-write",
    scope: "query-cache.write",
    apiTokenPermission: "Hyperdrive Edit",
    writeCoversRead: true,
    verified: "unverified-oauth",
    reason: "List + create a Hyperdrive config; the config list endpoint accepts Write, so no separate Hyperdrive Read is requested.",
  },
  "vectorize-write": {
    capability: "vectorize-write",
    scope: "vectorize.write",
    apiTokenPermission: "Vectorize Edit",
    writeCoversRead: true,
    verified: "unverified-oauth",
    reason: "List + create a Vectorize index; the index list endpoint accepts Write, so no separate Vectorize Read is requested.",
  },
  "secrets-store-write": {
    capability: "secrets-store-write",
    scope: "secrets-store.write",
    apiTokenPermission: "Secrets Store Edit",
    writeCoversRead: true,
    verified: "unverified-oauth",
    reason: "List + create/manage central Secrets Store entries; distinct from Worker version secrets (which need Worker Admin).",
  },
  "ai-write": {
    capability: "ai-write",
    scope: "ai.write",
    apiTokenPermission: "Workers AI Edit",
    writeCoversRead: true,
    verified: "unverified-oauth",
    reason: "Account-level Workers AI management. A Worker `env.AI` binding alone does NOT require this — only actual AI API management does.",
  },
  "browser-rendering-write": {
    capability: "browser-rendering-write",
    scope: "browser-rendering.write",
    apiTokenPermission: "Browser Rendering Edit",
    writeCoversRead: true,
    verified: "unverified-oauth",
    reason: "Account-level Browser Rendering management. A runtime binding alone does NOT require this — only actual management does.",
  },
  "workers-routes-write": {
    capability: "workers-routes-write",
    scope: "workers-routes.write",
    apiTokenPermission: "Workers Routes Edit",
    writeCoversRead: true,
    verified: "unverified-oauth",
    reason: "List + create + update zone-scoped Workers routes; separate from Worker Admin. Workers custom domains use Scripts Write instead.",
  },
  "dns-write": {
    capability: "dns-write",
    scope: "dns.write",
    apiTokenPermission: "DNS Edit",
    writeCoversRead: true,
    verified: "unverified-oauth",
    reason: "List + create/update DNS records; the DNS record list accepts Write, so no separate DNS Read is requested.",
  },
  "zone-read": {
    capability: "zone-read",
    scope: "zone.read",
    apiTokenPermission: "Zone Read",
    writeCoversRead: false,
    verified: "unverified-oauth",
    reason: "Enumerate the account's zones so a zone can be selected for a route/DNS record. DNS Write does NOT imply Zone Read.",
  },
};
