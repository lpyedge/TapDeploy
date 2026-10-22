// D1 database shapes returned/consumed by the Cloudflare v4 management API.
// Official list/create return result[] with {uuid, name, created_at, version,
// jurisdiction, ...}; the installer maps uuid into id so callers have a stable
// identifier without depending on the dashboard-only field naming.

export interface D1Database {
  id: string;
  uuid: string;
  name: string;
  created_at?: string;
  version?: string;
  jurisdiction?: string;
  file_size?: number;
}

export interface D1CreateRequest {
  name: string;
  jurisdiction?: "eu" | "fedramp" | "us";
  primary_location_hint?: "wnam" | "enam" | "weur" | "eeur" | "apac" | "oc";
  read_replication?: { mode: "auto" | "disabled" };
}

export interface D1DatabaseListResult {
  databases: D1Database[];
}
