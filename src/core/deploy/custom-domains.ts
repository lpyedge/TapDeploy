// Operator-chosen custom domains for HTTP units (Workers and Pages).
//
// The operator binds `<sub>.<zone>` (or the zone apex) to a Worker or Pages
// unit at install, and on upgrade may keep, add or remove bound domains. This
// module is pure: it validates the plan request's choices into sealed
// DomainEntrySpec entries and decides, against live provider facts, what each
// entry needs. The plan and the reconcile-domains step call the same decision
// so the step re-verifies exactly what the operator approved.
//
// Provider behaviour (developers.cloudflare.com, checked 2026-10-22):
// - Workers Custom Domains: `PUT /accounts/{id}/workers/domains` creates the
//   DNS record and certificate itself; an existing CNAME (or other record) on
//   the hostname blocks it, so replacing one is an explicit DNS delete first.
// - Pages: `POST /accounts/{id}/pages/projects/{name}/domains` only registers
//   the hostname; the CNAME `<hostname> -> <project>.pages.dev` is created
//   separately (proxied) in the zone.

import type { DomainEntrySpec } from "../deploy-spec.js";
import type { TargetSnapshot } from "../planning/types.js";

export type HttpUnitTarget = "workers" | "pages";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Lower-cased hostname when it is a valid DNS name (no wildcard, no trailing dot), else null. */
export function normalizeHostname(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const host = raw.trim().toLowerCase();
  if (host.length === 0 || host.length > 253) return null;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  return host;
}

/** True when `hostname` is the zone apex or a subdomain of it. */
export function hostnameInZone(hostname: string, zone: string): boolean {
  return hostname === zone || hostname.endsWith(`.${zone}`);
}

/** Per-unit domain request of a plan body: hostnames to bind and (upgrade) to remove. */
export interface UnitDomainChoices {
  bind?: Array<{ hostname?: unknown; zone?: unknown; replaceExisting?: unknown }>;
  remove?: Array<{ hostname?: unknown; zone?: unknown }>;
}

const MAX_DOMAINS_PER_UNIT = 20;

/**
 * Validate the plan request's `domains` object into DomainEntrySpec entries per
 * unit. Only HTTP units may carry domains; every hostname must lie in the zone
 * named next to it; a hostname appears at most once per request.
 */
export function domainEntriesFromChoices(
  raw: unknown,
  httpUnits: Readonly<Record<string, HttpUnitTarget>>,
): { ok: true; entries: Record<string, DomainEntrySpec[]> } | { ok: false; detail: string } {
  if (raw === undefined) return { ok: true, entries: {} };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, detail: "domains must be an object keyed by unit id" };
  const entries: Record<string, DomainEntrySpec[]> = {};
  const seen = new Set<string>();
  for (const [unitId, value] of Object.entries(raw as Record<string, unknown>)) {
    const target = Object.hasOwn(httpUnits, unitId) ? httpUnits[unitId] : undefined;
    if (!target) return { ok: false, detail: `unit "${unitId}" is not a Worker or Pages unit; only HTTP services can bind a domain` };
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, detail: `domains.${unitId} must be an object` };
    const choices = value as UnitDomainChoices;
    const bind = choices.bind ?? [];
    const remove = choices.remove ?? [];
    if (!Array.isArray(bind) || !Array.isArray(remove)) return { ok: false, detail: `domains.${unitId}.bind and .remove must be arrays` };
    if (bind.length + remove.length > MAX_DOMAINS_PER_UNIT) return { ok: false, detail: `domains.${unitId} lists more than ${MAX_DOMAINS_PER_UNIT} hostnames` };
    const kind = target === "workers" ? "workers-custom-domain" : "pages-custom-domain";
    const list: DomainEntrySpec[] = [];
    for (const [index, item] of [...bind.map((entry) => ["bind", entry] as const), ...remove.map((entry) => ["remove", entry] as const)].entries()) {
      const [mode, choice] = item;
      if (choice === null || typeof choice !== "object") return { ok: false, detail: `domains.${unitId} entry ${index} must be an object` };
      const hostname = normalizeHostname(choice.hostname);
      const zone = normalizeHostname(choice.zone);
      if (!hostname || !zone) return { ok: false, detail: `domains.${unitId} entry ${index} needs a valid hostname and zone` };
      if (!hostnameInZone(hostname, zone)) return { ok: false, detail: `"${hostname}" is not inside the zone "${zone}"` };
      if (seen.has(hostname)) return { ok: false, detail: `"${hostname}" is listed more than once` };
      seen.add(hostname);
      const replace = mode === "bind" && (choice as { replaceExisting?: unknown }).replaceExisting === true;
      list.push({ kind, hostname, zoneName: zone, updateAction: mode === "remove" ? "detach" : replace ? "explicit-change" : "preserve" });
    }
    if (list.length > 0) entries[unitId] = list;
  }
  return { ok: true, entries };
}

/** Live provider facts a custom-domain decision reads. */
export interface CustomDomainFacts {
  zones: ReadonlyArray<{ id: string; name: string }>;
  dnsRecords: ReadonlyArray<{ zoneId: string; id: string; name: string; type: string; content?: string }>;
  workerDomains: ReadonlyArray<{ id: string; hostname: string; service?: string }>;
  pagesDomains: ReadonlyArray<{ name: string }>;
  // The Pages project's `*.pages.dev` hostname; undefined before the project exists.
  pagesSubdomain?: string;
}

/** The live facts a custom-domain decision reads, taken from one unit snapshot. */
export function customDomainFacts(snapshot: TargetSnapshot): CustomDomainFacts {
  return {
    zones: snapshot.zones ?? [],
    dnsRecords: snapshot.dnsRecords ?? [],
    workerDomains: snapshot.workerDomains ?? [],
    pagesDomains: snapshot.pagesDomains ?? [],
    ...(snapshot.pagesSubdomain ? { pagesSubdomain: snapshot.pagesSubdomain } : {}),
  };
}

/** The `*.pages.dev` hostname a Pages custom domain's CNAME points at. */
export function pagesCnameTarget(owner: string, facts: Pick<CustomDomainFacts, "pagesSubdomain">): string {
  return (facts.pagesSubdomain ?? `${owner}.pages.dev`).toLowerCase();
}

export type CustomDomainDecision =
  | { action: "preserve"; detail?: string }
  | { action: "attach"; zoneId: string; replaceRecordIds: string[] }
  | { action: "update"; zoneId: string; domainId: string }
  | { action: "detach"; zoneId: string; domainId?: string; cnameRecordId?: string }
  | { action: "conflict"; detail: string };

// Records that occupy a hostname for HTTP: a custom domain cannot coexist with them.
const ADDRESS_TYPES = new Set(["A", "AAAA", "CNAME"]);

const sameName = (a: string, b: string) => a.replace(/\.$/, "").toLowerCase() === b;

/**
 * Decide what one custom-domain entry needs. `owner` is the Worker name or the
 * Pages project name of the unit. Replacing anything that serves the hostname
 * today (DNS records, another Worker's binding) requires `explicit-change`,
 * i.e. the operator's confirmation; removal only ever touches this unit's own
 * binding.
 */
export function decideCustomDomain(
  entry: DomainEntrySpec,
  owner: string,
  facts: CustomDomainFacts,
): CustomDomainDecision {
  const zoneName = entry.zoneName?.toLowerCase();
  const zone = zoneName ? facts.zones.find((candidate) => candidate.name.toLowerCase() === zoneName) : undefined;
  if (!zone) return { action: "conflict", detail: `the zone "${entry.zoneName ?? ""}" is not in this Cloudflare account` };
  const hostname = entry.hostname;
  const records = facts.dnsRecords.filter((record) => record.zoneId === zone.id && sameName(record.name, hostname) && ADDRESS_TYPES.has(record.type));
  const workerDomain = facts.workerDomains.find((domain) => domain.hostname.toLowerCase() === hostname);

  if (entry.kind === "workers-custom-domain") {
    if (entry.updateAction === "detach") {
      if (!workerDomain) return { action: "preserve", detail: `"${hostname}" is not bound; nothing to remove` };
      if (workerDomain.service !== owner) return { action: "conflict", detail: `"${hostname}" is bound to the Worker "${workerDomain.service ?? "unknown"}", not to "${owner}"; it is not removed` };
      return { action: "detach", zoneId: zone.id, domainId: workerDomain.id };
    }
    if (workerDomain) {
      if (workerDomain.service === owner) return { action: "preserve" };
      if (entry.updateAction !== "explicit-change") return { action: "conflict", detail: `"${hostname}" currently serves the Worker "${workerDomain.service ?? "unknown"}"; confirm the replacement to move it to "${owner}"` };
      return { action: "update", zoneId: zone.id, domainId: workerDomain.id };
    }
    if (records.length > 0 && entry.updateAction !== "explicit-change") {
      return { action: "conflict", detail: `"${hostname}" already has DNS records (${records.map((record) => record.type).join(", ")}); confirm the replacement, which may stop the service it points to today` };
    }
    return { action: "attach", zoneId: zone.id, replaceRecordIds: records.map((record) => record.id) };
  }

  // pages-custom-domain
  const target = pagesCnameTarget(owner, facts);
  const registered = facts.pagesDomains.some((domain) => domain.name.toLowerCase() === hostname);
  const ownCname = records.find((record) => record.type === "CNAME" && record.content !== undefined && sameName(record.content, target));
  if (entry.updateAction === "detach") {
    if (!registered && !ownCname) return { action: "preserve", detail: `"${hostname}" is not bound; nothing to remove` };
    return { action: "detach", zoneId: zone.id, ...(ownCname ? { cnameRecordId: ownCname.id } : {}) };
  }
  if (workerDomain) {
    // Another Worker's binding is never removed on its behalf.
    return { action: "conflict", detail: `"${hostname}" is bound to the Worker "${workerDomain.service ?? "unknown"}"; remove it there first` };
  }
  const foreign = records.filter((record) => record !== ownCname);
  if (registered && ownCname && foreign.length === 0) return { action: "preserve" };
  if (foreign.length > 0 && entry.updateAction !== "explicit-change") {
    return { action: "conflict", detail: `"${hostname}" already has DNS records (${foreign.map((record) => record.type).join(", ")}); confirm the replacement, which may stop the service it points to today` };
  }
  return { action: "attach", zoneId: zone.id, replaceRecordIds: foreign.map((record) => record.id) };
}
