// Workers KV namespace shapes returned/consumed by the Cloudflare v4 management
// API. Official list/create return result[] with {id, title, jurisdiction,
// mode, supports_url_encoding}; the installer maps title into name so callers
// have a consistent identity across Resources.

export interface KvNamespace {
  id: string;
  title: string;
  // Mirrored from title so callers can reference the human-readable identity
  // without switching field names (see the R2 model convention).
  name: string;
  jurisdiction?: "eu" | "fedramp" | "us";
  mode?: "instant";
  supports_url_encoding?: boolean;
}

export interface KvNamespaceCreateRequest {
  title: string;
  jurisdiction?: "eu" | "fedramp" | "us";
  mode?: "instant";
}
