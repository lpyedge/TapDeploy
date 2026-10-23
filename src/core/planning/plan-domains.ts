// The domain / route / DNS part of a plan: records the intended diff for each
// declared entry and emits a guard when a change cannot be safely applied.
// Read-only: nothing here mutates.

import { dnsRecordActionFor } from "../../cloudflare/resources/dns.js";
import { workerRouteActionFor } from "../../cloudflare/resources/routes.js";
import { customDomainFacts, decideCustomDomain } from "../deploy/custom-domains.js";
import type { DomainEntrySpec } from "../deploy-spec.js";
import type { PlanGuard, PlanResource, ResourceDiff, TargetSnapshot } from "./types.js";

// plan the opt-in domain/route/DNS changes. This never mutates — it only
// records the intended diff and emits a guard when a declared change cannot be
// safely applied (unsupported kind, missing zone, or a record/route whose exact
// identity was expected but no longer matches). A DNS write is never auto-applied
// outside the preauthorized envelope and never part of an ordinary Worker upgrade.
export function planDomainGuards(
  diffs: ResourceDiff[],
  domains: DomainEntrySpec[],
  snapshot: TargetSnapshot,
  owner: string,
): PlanGuard[] {
  const guards: PlanGuard[] = [];
  const zones = snapshot.zones ?? [];
  const zoneByName = new Map(zones.map((z) => [z.name.toLowerCase(), z.id]));
  const knownDns = snapshot.dnsRecords ?? [];
  const knownRoutes = snapshot.workerRoutes ?? [];

  for (const entry of domains) {
    const resource = domainResourceKind(entry.kind);
    // A dns-record / workers-route needs a zone. Workers/Pages custom domains are
    // account-scoped, not zone-scoped; the worker domain list already carries them.
    if (entry.kind === "dns-record" || entry.kind === "workers-route") {
      const zoneId = entry.zoneId ?? (entry.zoneName ? zoneByName.get(entry.zoneName.toLowerCase()) : undefined);
      if (!zoneId) {
        diffs.push({
          resource,
          action: "conflict",
          name: entry.hostname,
          detail: `no matching zone for "${entry.zoneName ?? entry.hostname}"; a zone is required for ${entry.kind}`,
        });
        guards.push({
          code: "domain-drift",
          level: "block",
          detail: `Declared ${entry.kind} "${entry.hostname}" could not resolve to a zone`,
        });
        continue;
      }
      if (entry.kind === "dns-record") {
        const depth = planDnsRecordDiff(entry, zoneId, knownDns, diffs);
        const lastDiff = diffs[diffs.length - 1];
        if (depth === "conflict") {
          guards.push({
            code: "domain-drift",
            level: "block",
            detail:
              lastDiff?.detail ??
              `Declared DNS record "${entry.hostname}" is blocked by a collision`,
          });
        }
      } else {
        const action = workerRouteActionFor(entry, knownRoutes.filter((r) => r.zoneId === zoneId));
        diffs.push({ resource, action: action.action, name: entry.hostname });
      }
    } else {
      // Workers / Pages custom domain chosen by the operator.
      const decision = decideCustomDomain(entry, owner, customDomainFacts(snapshot));
      if (decision.action === "conflict") {
        diffs.push({ resource, action: "conflict", name: entry.hostname, detail: decision.detail });
        guards.push({ code: "domain-drift", level: "block", detail: decision.detail });
      } else {
        diffs.push({ resource, action: decision.action, name: entry.hostname, ...("detail" in decision && decision.detail ? { detail: decision.detail } : {}) });
      }
    }
  }
  return guards;
}

function domainResourceKind(kind: DomainEntrySpec["kind"]): PlanResource {
  switch (kind) {
    case "dns-record":
      return "dns-record";
    case "workers-route":
      return "worker-route";
    case "workers-custom-domain":
      return "worker-custom-domain";
    case "pages-custom-domain":
      return "pages-custom-domain";
  }
}

// Record the diff for one declared DNS record against the live records in the
// selected zone. Returns "conflict" when the collision rule blocks the write.
function planDnsRecordDiff(
  entry: DomainEntrySpec,
  zoneId: string,
  knownDns: NonNullable<TargetSnapshot["dnsRecords"]>,
  diffs: ResourceDiff[],
): "ok" | "conflict" {
  const zoneRecords = knownDns.filter((r) => r.zoneId === zoneId);
  const action = dnsRecordActionFor(entry, zoneRecords);
  diffs.push({
    resource: "dns-record",
    action: action.action,
    name: entry.hostname,
    ...(action.action === "conflict" && "detail" in action ? { detail: action.detail } : {}),
  });
  return action.action === "conflict" ? "conflict" : "ok";
}
