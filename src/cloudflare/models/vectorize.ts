// Cloudflare Vectorize shapes returned/consumed by the v4 management API.
//
// Official list returns `result[]` of index objects keyed by `id` with `name`,
// `config` (dimensions/metric or preset), `description`, `created_on` and
// `modified_on`. The installer maps `id` into the stable identity and mirrors
// `name` so callers have a consistent identity across resources (the R2/D1/KV
// convention). Index dimension/metric configuration is immutable on the live
// resource — the installer never silently changes it in place.

export type VectorizeMetric = "cosine" | "euclidean" | "dot-product";

export interface VectorizeIndexConfig {
  dimensions?: number;
  metric?: VectorizeMetric;
  preset?: string;
}

export interface VectorizeIndex {
  id: string;
  name: string;
  description?: string;
  config?: VectorizeIndexConfig;
  created_on?: string;
  modified_on?: string;
}

export type VectorizeCreateConfig =
  | { dimensions: number; metric: VectorizeMetric }
  | { preset: string };

export interface VectorizeCreateRequest {
  name: string;
  config: VectorizeCreateConfig;
  description?: string;
}
