// Cloudflare Worker (custom) domain shapes returned/consumed by the v4
// management API.
//
// A custom domain attaches a hostname directly to a Worker and asks Cloudflare
// to create the supporting DNS record and issue a certificate. It is account-
// scoped: `GET /accounts/{account_id}/workers/domains`,
// `PUT /accounts/{account_id}/workers/domains` (attach),
// `DELETE /accounts/{account_id}/workers/domains/{domain_id}` (detach). Custom
// domains use Workers Scripts Write (covered by Worker Admin). The installer
// models the fields it manages (`hostname`, `service`, `enabled`,
// `previews_enabled`, `zone_id`/`zone_name`) plus the stable `id`.

export interface WorkerDomain {
  id: string;
  hostname: string;
  service: string;
  enabled?: boolean;
  previews_enabled?: boolean;
  zone_id?: string;
  zone_name?: string;
  cert_id?: string;
  created_on?: string;
}

export interface WorkerDomainAttachRequest {
  hostname: string;
  service: string;
  enabled?: boolean;
  previews_enabled?: boolean;
  zone_id?: string;
  zone_name?: string;
}

// a Pages custom domain. Pages domains are project-scoped and addressed by
// hostname (`name`), not an id. `domain_id` is the stable id; `zone_tag` is the
// zone that hosts the domain.
export interface PagesDomain {
  id?: string;
  domain_id?: string;
  name: string;
  status?: string;
  zone_tag?: string;
  created_on?: string;
}

export interface PagesDomainAddRequest {
  // The fully qualified domain name to attach to the project.
  name: string;
}
