// Cloudflare DNS record adapter.
//
// DNS records are zone-scoped. The installer only ever creates/updates/removes
// a record the operator explicitly declared inside the preauthorized envelope;
// it never bulk-modifies a zone, and an ordinary Worker upgrade never deletes
// DNS. Collision detection is enforced here (A/AAAA cannot share a name with a
// CNAME; NS cannot share a name with any other record). An existing record is
// preserved by identity unless the operator picked `explicit-change`, in which
// case it is overwritten after a separate in-app confirmation. Removal is only
// offered for a record the operator explicitly manages (never auto-deleted).

import type { CloudflareApiClient } from "../client/index.js";
import type {
  DnsRecord,
  DnsRecordCreateRequest,
  DnsRecordUpdateRequest,
} from "../models/index.js";
import type { DomainEntrySpec } from "../../core/deploy-spec.js";
import {
  ResourceConflictError,
} from "./types.js";

// A record that already exists at the same name+type is preserved; a name that
// collides with an incompatible record type blocks (fail closed); otherwise the
// declared record is created.
export type DnsRecordAction =
  | { hostname: string; recordType: string; action: "preserve"; id: string }
  | { hostname: string; recordType: string; action: "create" }
  | { hostname: string; recordType: string; action: "update"; id: string }
  | { hostname: string; recordType: string; action: "conflict"; detail: string };

export type KnownDnsRecord = Pick<DnsRecord, "id" | "name" | "type" | "content">;

const BASE = (name: string) => name.replace(/\.$/, "").toLowerCase();

// A/AAAA cannot coexist with a CNAME at the same name; NS cannot coexist with
// any other record. This encodes the documented Cloudflare provider constraint.
export function dnsCollisionReason(
  hostname: string,
  recordType: string,
  known: KnownDnsRecord[],
): string | undefined {
  const base = BASE(hostname);
  const peers = known.filter((r) => BASE(r.name) === base);
  if (recordType === "NS") {
    if (peers.some((r) => r.type !== "NS")) {
      return `NS record "${hostname}" cannot coexist with any other record at the same name`;
    }
    return undefined;
  }
  if (peers.some((r) => r.type === "NS")) {
    return `DNS record "${hostname}" cannot coexist with an NS record at the same name`;
  }
  if (recordType === "A" || recordType === "AAAA") {
    if (peers.some((r) => r.type === "CNAME")) {
      return `A/AAAA record "${hostname}" cannot coexist with a CNAME at the same name`;
    }
    return undefined;
  }
  if (recordType === "CNAME") {
    if (peers.some((r) => r.type === "A" || r.type === "AAAA")) {
      return `CNAME record "${hostname}" cannot coexist with an A/AAAA record at the same name`;
    }
    return undefined;
  }
  return undefined;
}

// Pure: decide what should happen to one declared DNS record against the live
// records in the selected zone.
export function dnsRecordActionFor(
  entry: DomainEntrySpec,
  known: KnownDnsRecord[],
): DnsRecordAction {
  const recordType = entry.recordType ?? "";
  if (!recordType) {
    return {
      hostname: entry.hostname,
      recordType,
      action: "conflict",
      detail: "declared DNS record is missing a record type",
    };
  }
  const collision = dnsCollisionReason(entry.hostname, recordType, known);
  if (collision) {
    return {
      hostname: entry.hostname,
      recordType,
      action: "conflict",
      detail: collision,
    };
  }
  const existing = known.find(
    (r) => BASE(r.name) === BASE(entry.hostname) && r.type === recordType,
  );
  if (!entry.hostname || ((!existing || entry.updateAction === "explicit-change") && entry.recordContent === undefined)) {
    return { hostname: entry.hostname, recordType, action: "conflict", detail: "declared DNS create/update requires a hostname and record content" };
  }
  if (existing) {
    // A matching record already exists. Preserve by identity; only an explicit
    // change (with independent consent) overwrites it.
    if (entry.updateAction === "explicit-change") {
      return {
        hostname: entry.hostname,
        recordType,
        action: "update",
        id: existing.id,
      };
    }
    return {
      hostname: entry.hostname,
      recordType,
      action: "preserve",
      id: existing.id,
    };
  }
  return {
    hostname: entry.hostname,
    recordType,
    action: "create",
  };
}

export interface EnsureDnsRecordRequest {
  entry: DomainEntrySpec;
  zoneId: string;
  knownRecords: KnownDnsRecord[];
}

export type EnsureDnsRecordResult =
  | { action: "preserve"; id: string }
  | { action: "create"; id: string }
  | { action: "update"; id: string };

export async function ensureDnsRecord(
  client: CloudflareApiClient,
  request: EnsureDnsRecordRequest,
): Promise<EnsureDnsRecordResult> {
  const action = dnsRecordActionFor(request.entry, request.knownRecords);
  if (action.action === "conflict") {
    throw new ResourceConflictError(action.detail);
  }
  if (action.action === "preserve") {
    return { action: "preserve", id: action.id };
  }
  const recordType = request.entry.recordType ?? "";
  const body: DnsRecordCreateRequest = {
    type: recordType,
    name: request.entry.hostname,
    content: request.entry.recordContent ?? "",
    ...(request.entry.ttl !== undefined ? { ttl: request.entry.ttl } : {}),
    ...(request.entry.proxied !== undefined ? { proxied: request.entry.proxied } : {}),
  };
  if (action.action === "update") {
    const updated = await client.updateDnsRecord(
      request.zoneId,
      action.id,
      body as DnsRecordUpdateRequest,
    );
    return { action: "update", id: updated.id };
  }
  const created = await client.createDnsRecord(request.zoneId, body);
  return { action: "create", id: created.id };
}
