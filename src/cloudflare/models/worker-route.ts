// Cloudflare Workers route shapes returned/consumed by the v4 management
// API.
//
// A Workers route maps a URL pattern to a Worker within a specific zone:
// `GET/POST /zones/{zone_id}/workers/routes`, `PUT /zones/{zone_id}/workers/routes/{id}`
// (Replace), `DELETE /zones/{zone_id}/workers/routes/{id}`. Routes are
// independent of Worker Admin; the installer requests `workers-routes.write`
// for route/custom-domain operations. The installer models the fields it
// manages (`pattern`, `script`) plus the stable `id`; trailing fields are
// ignored.

export interface WorkerRoute {
  id: string;
  pattern: string;
  script?: string;
  zone_id?: string;
  zone_name?: string;
}

export interface WorkerRouteCreateRequest {
  pattern: string;
  script?: string;
}

export interface WorkerRouteUpdateRequest {
  pattern: string;
  script?: string;
}
