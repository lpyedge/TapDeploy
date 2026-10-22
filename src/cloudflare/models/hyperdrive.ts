// Cloudflare Hyperdrive configuration shapes returned/consumed by the v4
// management API.
//
// Official list/get return `result[]`/`result` with `id`, `name`, `caching`
// and `origin`. The `origin` field combines database connection fields with
// exactly one network location; the provider never returns the write-only
// `password` / `access_client_secret` values, so the installer must never log
// them and must only ever carry them in a create/edit request.

export type HyperdriveScheme = "postgres" | "postgresql" | "mysql";

export interface HyperdriveOrigin {
  database: string;
  host?: string;
  port?: number;
  scheme?: HyperdriveScheme;
  user?: string;
  // Write-only connection secrets. The API never returns these, and the
  // installer never persists or logs them.
  password?: string;
  access_client_id?: string;
  access_client_secret?: string;
}

export interface HyperdriveCaching {
  disabled?: boolean;
  max_age?: number;
  stale_while_revalidate?: number;
}

export interface HyperdriveConfig {
  id: string;
  name: string;
  caching?: HyperdriveCaching;
  origin?: HyperdriveOrigin;
  created_on?: string;
  modified_on?: string;
}

export interface HyperdriveCreateRequest {
  name: string;
  origin: HyperdriveOrigin;
  caching?: HyperdriveCaching;
}
