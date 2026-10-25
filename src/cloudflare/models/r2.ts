// R2 bucket shapes returned/consumed by the Cloudflare v4 management API.
// Official list returns result.buckets (cursor-paginated via result_info.cursor);
// each bucket carries name + creation_date (no stable numeric id — name is the
// identity; client mirrors name into id for older callers).

export interface R2Bucket {
  id: string;
  name: string;
  creation_date: string;
  jurisdiction?: string;
  location?: string;
  storage_class?: string;
}

// R2 bucket domain surfaces (managed r2.dev endpoint + custom domains).
// These are policy/identity metadata reads only — never object contents.
export interface R2ManagedDomain {
  /** The bucket's managed r2.dev hostname. */
  domain: string;
  /** true when the managed public endpoint is enabled. */
  enabled: boolean;
}

export interface R2CustomDomain {
  domain: string;
  enabled: boolean;
  zoneId?: string;
}