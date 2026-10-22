// Cloudflare Zone shapes returned/consumed by the v4 management API.
//
// A Zone is a DNS namespace owned by an account. Zones are the scope for DNS
// records (`/zones/{zone_id}/dns_records`) and Workers routes
// (`/zones/{zone_id}/workers/routes`). `GET /zones` lists the zones the bound
// token can see; the installer only ever *reads* zones and never bulk-modifies
// them. The list endpoint accepts Zone Read (and DNS Write) permissions; the
// installer only requests `zone.read` when a zone selector is actually needed.

export interface ZoneAccount {
  id: string;
  name?: string;
}

export interface Zone {
  id: string;
  name: string;
  status?: string;
  type?: string;
  paused?: boolean;
  account?: ZoneAccount;
  created_on?: string;
  modified_on?: string;
}

// The installer consumes only the identity it needs (id + name). Trailing
// fields from the provider are ignored so a forward-compatible response does
// not break the typed client.
export interface ZoneSummary {
  id: string;
  name: string;
}
