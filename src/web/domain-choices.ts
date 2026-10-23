// Configure-step custom-domain drafts -> the plan request's `domains` object.
//
// Pure helpers shared by the domain panel and the flow. The server re-validates
// every hostname and re-decides every replacement against live state; these
// only shape what the operator chose and flag what needs their confirmation.

import { normalizeHostname } from "../core/deploy/custom-domains.js";
import type { DomainsEnvelope, GraphDomainRequest } from "./api.js";

/** An HTTP unit of the prepared release and the Worker / Pages project it targets. */
export interface HttpUnit {
  unitId: string;
  kind: "worker" | "pages";
  target: string;
}

export interface UnitDomainDraft {
  // Add a hostname: `<sub>.<zone>` (`@` = the zone apex), typed as a new name
  // or picked from the names that already exist in the zone.
  bind: boolean;
  zone: string;
  subMode: "new" | "existing";
  sub: string;
  // The operator accepted replacing what serves the hostname today.
  confirmReplace: boolean;
  // Upgrade: hostnames bound today that the operator chose to unbind.
  remove: string[];
  confirmRemove: boolean;
}

export const EMPTY_DRAFT: UnitDomainDraft = { bind: false, zone: "", subMode: "new", sub: "", confirmReplace: false, remove: [], confirmRemove: false };

/** The hostname a draft would bind, or null when it is not a valid name in the zone. */
export function draftHostname(draft: Pick<UnitDomainDraft, "zone" | "sub">): string | null {
  if (!draft.zone) return null;
  // `@` (the DNS convention) is the domain itself; an empty name is not chosen yet.
  const sub = draft.sub.trim().toLowerCase().replace(/\.$/, "");
  if (!sub) return null;
  return normalizeHostname(sub === "@" ? draft.zone : `${sub}.${draft.zone}`);
}

/** Hostnames already bound to this unit's Worker / Pages project. */
export function boundHostnames(unit: HttpUnit, facts: DomainsEnvelope | null): string[] {
  if (!facts) return [];
  if (unit.kind === "worker") return facts.workerDomains.filter((domain) => domain.service === unit.target).map((domain) => domain.hostname).sort();
  return [...(facts.pagesDomains[unit.target] ?? [])].sort();
}

/** What serves `hostname` today (another Worker, or DNS records), or null when it is free or already this unit's. */
export function hostnameOccupant(hostname: string, unit: HttpUnit, facts: DomainsEnvelope | null, records: ReadonlyArray<{ name: string; type: string; content?: string }>): string | null {
  const worker = facts?.workerDomains.find((domain) => domain.hostname === hostname);
  if (worker) return worker.service === unit.target && unit.kind === "worker" ? null : `the Worker "${worker.service ?? "unknown"}"`;
  if (unit.kind === "pages" && (facts?.pagesDomains[unit.target] ?? []).includes(hostname)) return null;
  const occupying = records.filter((record) => record.name === hostname);
  if (occupying.length === 0) return null;
  return `DNS ${occupying.map((record) => `${record.type}${record.content ? ` → ${record.content}` : ""}`).join(", ")}`;
}

/**
 * Names that already exist in `zone` (DNS address records and Worker custom
 * domains), as subdomain labels relative to it; `""` is the zone apex.
 */
export function existingSubdomains(zone: string, facts: DomainsEnvelope | null, records: ReadonlyArray<{ name: string }>): string[] {
  if (!zone) return [];
  const names = [...records.map((record) => record.name), ...(facts?.workerDomains ?? []).map((domain) => domain.hostname)];
  const labels = names.flatMap((name) => {
    const host = name.toLowerCase().replace(/\.$/, "");
    if (host === zone) return [""];
    return host.endsWith(`.${zone}`) && !host.startsWith("*.") ? [host.slice(0, -zone.length - 1)] : [];
  });
  return [...new Set(labels)].sort((a, b) => a.localeCompare(b));
}

/** The zone (longest suffix match) a bound hostname belongs to. */
export function zoneOf(hostname: string, zones: readonly string[]): string | null {
  const matches = zones.filter((zone) => hostname === zone || hostname.endsWith(`.${zone}`));
  return matches.sort((a, b) => b.length - a.length)[0] ?? null;
}

/** Problems that keep the Configure step from continuing, keyed by unit id. */
export function draftErrors(
  units: readonly HttpUnit[],
  drafts: Readonly<Record<string, UnitDomainDraft>>,
  facts: DomainsEnvelope | null,
  recordsByZone: Readonly<Record<string, ReadonlyArray<{ name: string; type: string; content?: string }>>>,
  selfHostname?: string,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const unit of units) {
    const draft = drafts[unit.unitId] ?? EMPTY_DRAFT;
    if (draft.bind) {
      const hostname = draftHostname(draft);
      if (!hostname) { errors[unit.unitId] = "choose a domain and a subdomain (@ for the domain itself)"; continue; }
      if (hostname === selfHostname) { errors[unit.unitId] = `${hostname} is the address of this TapDeploy instance; binding it would take TapDeploy offline`; continue; }
      if (seen.has(hostname)) { errors[unit.unitId] = `${hostname} is already chosen for ${seen.get(hostname)}`; continue; }
      seen.set(hostname, unit.target);
      if (hostnameOccupant(hostname, unit, facts, recordsByZone[draft.zone] ?? []) && !draft.confirmReplace) { errors[unit.unitId] = "confirm the replacement first"; continue; }
    }
    if (draft.remove.length > 0 && !draft.confirmRemove) errors[unit.unitId] = "confirm the removal first";
  }
  return errors;
}

/** The plan request's `domains` object; undefined when nothing is chosen. */
export function domainRequest(
  units: readonly HttpUnit[],
  drafts: Readonly<Record<string, UnitDomainDraft>>,
  facts: DomainsEnvelope | null,
  recordsByZone: Readonly<Record<string, ReadonlyArray<{ name: string; type: string; content?: string }>>>,
): GraphDomainRequest | undefined {
  const request: GraphDomainRequest = {};
  for (const unit of units) {
    const draft = drafts[unit.unitId] ?? EMPTY_DRAFT;
    const hostname = draft.bind ? draftHostname(draft) : null;
    const bind = hostname && !boundHostnames(unit, facts).includes(hostname)
      ? [{ hostname, zone: draft.zone, ...(hostnameOccupant(hostname, unit, facts, recordsByZone[draft.zone] ?? []) ? { replaceExisting: true } : {}) }]
      : [];
    const remove = draft.remove.flatMap((name) => {
      const zone = zoneOf(name, facts?.zones ?? []);
      return zone ? [{ hostname: name, zone }] : [];
    });
    if (bind.length > 0 || remove.length > 0) request[unit.unitId] = { ...(bind.length > 0 ? { bind } : {}), ...(remove.length > 0 ? { remove } : {}) };
  }
  return Object.keys(request).length > 0 ? request : undefined;
}
