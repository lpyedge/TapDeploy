// Cloudflare DNS record shapes returned/consumed by the v4 management API.
//
// DNS is zone-scoped: `GET/POST /zones/{zone_id}/dns_records` list/create and
// `PUT /zones/{zone_id}/dns_records/{id}` overwrite, `DELETE` removes a record
// (a destructive route only reached after independent in-app confirmation). The
// list endpoint accepts DNS Write, so the installer never requests a redundant
// `dns.read`. The installer models the records it can create/update/remove
// (A, AAAA, CNAME, TXT) plus a generic carry shape for anything already present;
// trailing provider fields are ignored.
//
// Provider constraints encoded here for collision detection (see the record
// adapter): A/AAAA cannot share a name with a CNAME, and NS cannot share a name
// with any other record type.

export type DnsRecordType = "A" | "AAAA" | "CNAME" | "TXT";

export interface DnsRecord {
  id: string;
  // Full record name including the zone, in Punycode.
  name: string;
  type: string;
  content?: string;
  ttl?: number;
  proxied?: boolean;
  comment?: string;
  created_on?: string;
  modified_on?: string;
}

export interface DnsRecordCreateRequest {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
  comment?: string;
}

export interface DnsRecordUpdateRequest {
  // Overwrite accepts the same shape as create; only the fields the installer
  // manages are forwarded (the provider keeps metadata like created_on).
  type?: string;
  name?: string;
  content?: string;
  ttl?: number;
  proxied?: boolean;
  comment?: string;
}
