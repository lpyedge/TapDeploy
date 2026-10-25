// Cloudflare Workers route adapter.
//
// A Workers route maps a URL pattern to a Worker within a zone. It is managed
// with Workers Routes Write (independent of Worker Admin). The installer only
// ever creates/replaces/removes a route the operator explicitly declared inside
// the preauthorized envelope; it never bulk-modifies a zone, and an ordinary
// Worker upgrade never removes a route. An existing route matching the same
// pattern is preserved by identity unless the operator picked `explicit-change`
// (a separate in-app confirmation). Removal is only offered for a route the
// operator explicitly manages.

import type { CloudflareApiClient } from "../client/index.js";
import type { WorkerRoute } from "../models/index.js";
import type { DomainEntrySpec } from "../../core/deploy-spec.js";

export type WorkerRouteAction =
  | { pattern: string; action: "preserve"; id: string }
  | { pattern: string; action: "create" }
  | { pattern: string; action: "update"; id: string };

type KnownRoute = Pick<WorkerRoute, "id" | "pattern">;

// Pure: decide what should happen to one declared route against the live routes
// in the selected zone.
export function workerRouteActionFor(
  entry: DomainEntrySpec,
  known: KnownRoute[],
): WorkerRouteAction {
  const pattern = entry.hostname;
  const existing = known.find((r) => r.pattern === pattern);
  if (existing) {
    if (entry.updateAction === "explicit-change") {
      return { pattern, action: "update", id: existing.id };
    }
    return { pattern, action: "preserve", id: existing.id };
  }
  return { pattern, action: "create" };
}

export interface EnsureWorkerRouteRequest {
  entry: DomainEntrySpec;
  zoneId: string;
  scriptName: string;
  knownRoutes: KnownRoute[];
}

export type EnsureWorkerRouteResult =
  | { action: "preserve"; id: string }
  | { action: "create"; id: string }
  | { action: "update"; id: string };

export async function ensureWorkerRoute(
  client: CloudflareApiClient,
  request: EnsureWorkerRouteRequest,
): Promise<EnsureWorkerRouteResult> {
  const action = workerRouteActionFor(request.entry, request.knownRoutes);
  if (action.action === "preserve") {
    return { action: "preserve", id: action.id };
  }
  const body = { pattern: action.pattern, script: request.scriptName };
  if (action.action === "update") {
    const updated = await client.updateWorkerRoute(request.zoneId, action.id, body);
    return { action: "update", id: updated.id };
  }
  const created = await client.createWorkerRoute(request.zoneId, body);
  return { action: "create", id: created.id };
}
