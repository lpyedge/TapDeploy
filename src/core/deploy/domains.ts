// opt-in domain/route/DNS reconciliation step.
//
// This step only ever applies a domain/route/DNS change the operator explicitly
// declared inside the preauthorized envelope. It never bulk-modifies a zone, and
// an ordinary Worker upgrade never removes DNS. The browser re-sends the
// confirmed plan digest for every step; the server re-plans against a fresh live
// snapshot and refuses on any drift (an outside change blocks). Every mutation
// is idempotent or fails closed, and a remove is only reached after an
// independent in-app confirmation that the step itself re-verifies.

import type { DeployStepContext } from "./steps.js";
import type { DomainEntrySpec } from "../deploy-spec.js";
import { domainBaseline } from "../planning/drift.js";
import type { ExpectedTarget } from "../planning/types.js";
import { toStepFailure } from "./bindings.js";
import { canonicalJson } from "../planning/digest.js";
import {
  ensureDnsRecord,
  dnsRecordActionFor,
} from "../../cloudflare/resources/dns.js";
import { ensureWorkerRoute } from "../../cloudflare/resources/routes.js";
import { customDomainFacts, decideCustomDomain, pagesCnameTarget } from "./custom-domains.js";

export interface ReconcileDomainsResult {
  progressBaseline?: ExpectedTarget["domainBaseline"];
  applied: Array<{
    kind: string;
    hostname: string;
    action: "create" | "update" | "preserve" | "attach" | "detach";
  }>;
}

// The deploy step engine surfaces failures in a normalized shape; here we reuse
// the same contract so no raw Cloudflare detail reaches the browser.
type StepOutcome =
  | { ok: true; result: ReconcileDomainsResult }
  | { ok: false; error: { kind: string; detail: string }; progressBaseline?: ExpectedTarget["domainBaseline"] };

export async function reconcileDomains(
  ctx: DeployStepContext,
  args: Record<string, unknown>,
): Promise<StepOutcome> {
  const domains = ctx.spec.cloudflare.domains ?? [];
  if (domains.length === 0) {
    return { ok: true, result: { applied: [] } };
  }
  // An author-declared explicit-change is not the operator's independent consent.
  // Check the whole batch before any write, so a later entry cannot bypass consent
  // after earlier entries have already mutated remote state.
  if (domains.some((entry) => entry.updateAction === "explicit-change") && args.confirmDomainChanges !== true) {
    return { ok: false, error: { kind: "invalid-args", detail: "domain changes require separate in-app confirmation" } };
  }
  // A Pages unit's custom domains belong to its project; a Worker's to its script.
  const owner = ctx.spec.cloudflare.pages?.projectName ?? ctx.spec.cloudflare.workerName;
  // Validate the complete batch before the first write. A later bad zone or
  // ownership conflict must not partially mutate earlier approved entries.
  for (const entry of domains) {
    if (entry.kind === "dns-record" || entry.kind === "workers-route") {
      const zoneId = resolveZoneId(entry, ctx);
      if (!zoneId) return { ok: false, error: { kind: "domain_error", detail: "declared zone name/identity could not be verified" } };
      if (entry.kind === "dns-record") {
        const action = dnsRecordActionFor(entry, (ctx.snapshot.dnsRecords ?? []).filter(r => r.zoneId === zoneId));
        if (action.action === "conflict") return { ok: false, error: { kind: "domain_error", detail: action.detail } };
      }
    }
    if (entry.kind === "workers-route") {
      const existing = (ctx.snapshot.workerRoutes ?? []).find(r => r.zoneId === resolveZoneId(entry, ctx) && r.pattern === entry.hostname);
      if (existing && existing.script !== ctx.spec.cloudflare.workerName && entry.updateAction !== "explicit-change") return { ok: false, error: { kind: "domain_error", detail: "existing route points to another or unknown Worker; explicit rebind approval required" } };
    }
    if (entry.kind === "workers-custom-domain" || entry.kind === "pages-custom-domain") {
      const decision = decideCustomDomain(entry, owner, customDomainFacts(ctx.snapshot));
      if (decision.action === "conflict") return { ok: false, error: { kind: "domain_error", detail: decision.detail } };
    }
  }
  const applied: ReconcileDomainsResult["applied"] = [];
  const facts = customDomainFacts(ctx.snapshot);
  const progress = structuredClone(ctx.snapshot);
  const baseline = () => domainBaseline(progress, domains.map(entry => entry.hostname));
  const verifyCurrentProgress = async () => {
    if (!ctx.trackDomainProgress) return;
    const current = structuredClone(progress);
    const zonesFor = (kind: string) => [...new Set(domains.filter(entry => entry.kind === kind).map(entry => resolveZoneId(entry, ctx)!))];
    if (domains.some(entry => entry.kind === "dns-record")) current.dnsRecords = (await Promise.all(zonesFor("dns-record").map(async zoneId => (await ctx.client.listDnsRecords(zoneId)).map(r => ({ zoneId, id: r.id, name: r.name, type: r.type, content: r.content, ttl: r.ttl, proxied: r.proxied }))))).flat();
    if (domains.some(entry => entry.kind === "workers-route")) current.workerRoutes = (await Promise.all(zonesFor("workers-route").map(async zoneId => (await ctx.client.listWorkerRoutes(zoneId)).map(r => ({ zoneId, id: r.id, pattern: r.pattern, script: r.script }))))).flat();
    if (domains.some(entry => entry.kind === "workers-custom-domain")) current.workerDomains = (await ctx.client.listWorkerDomains()).map(d => ({ id: d.id, hostname: d.hostname, service: d.service, zone_id: d.zone_id }));
    if (domains.some(entry => entry.kind === "pages-custom-domain")) current.pagesDomains = await ctx.client.listPagesDomains(ctx.workerName);
    if (canonicalJson(domainBaseline(current, domains.map(entry => entry.hostname))) !== canonicalJson(baseline())) throw Object.assign(new Error("approved domain baseline changed before mutation"), { kind: "conflict" });
  };
  try {
    for (const entry of domains) {
      // Resolve the zone for a zone-scoped entry against the live snapshot.
      const zoneId = resolveZoneId(entry, ctx);
      if ((entry.kind === "dns-record" || entry.kind === "workers-route") && !zoneId) {
        return {
          ok: false,
          error: {
            kind: "domain_error",
            detail: `no matching zone for "${entry.zoneName ?? entry.hostname}"; a zone is required for ${entry.kind}`,
          },
        };
      }

      if (entry.kind === "dns-record") {
        // Re-plan the record against the fresh snapshot; a collision blocks.
        const known = (ctx.snapshot.dnsRecords ?? []).filter((r) => r.zoneId === zoneId);
        const action = dnsRecordActionFor(entry, known);
        if (action.action === "conflict") {
          return { ok: false, error: { kind: "domain_error", detail: action.detail } };
        }
        if (action.action === "preserve") {
          applied.push({ kind: "dns-record", hostname: entry.hostname, action: "preserve" });
          continue;
        }
        const updateId = action.action === "update" ? action.id : undefined;
        const matching = known.find(r => r.id === updateId && r.content === entry.recordContent && (entry.ttl === undefined || r.ttl === entry.ttl) && (entry.proxied === undefined || r.proxied === entry.proxied));
        if (matching && action.action === "update") {
          applied.push({ kind: "dns-record", hostname: entry.hostname, action: "preserve" });
          continue;
        }
        await verifyCurrentProgress();
        await ctx.beforeMutation?.();
        const result = await ensureDnsRecord(ctx.client, {
          entry,
          zoneId: zoneId!,
          knownRecords: known,
        });
        applied.push({ kind: "dns-record", hostname: entry.hostname, action: result.action });
        if (ctx.trackDomainProgress) {
          const records = await ctx.client.listDnsRecords(zoneId!);
          const read = records.find(r => r.id === result.id);
          if (!read || read.name !== entry.hostname || read.type !== entry.recordType || read.content !== entry.recordContent || (entry.ttl !== undefined && read.ttl !== entry.ttl) || (entry.proxied !== undefined && read.proxied !== entry.proxied)) throw new Error("approved DNS write could not be verified; re-plan before retry");
          progress.dnsRecords = [...(progress.dnsRecords ?? []).filter(r => !(r.zoneId === zoneId && r.id === read.id)), { zoneId: zoneId!, id: read.id, name: read.name, type: read.type, content: read.content, ...(read.ttl !== undefined ? { ttl: read.ttl } : {}), ...(read.proxied !== undefined ? { proxied: read.proxied } : {}) }];
        }
      } else if (entry.kind === "workers-route") {
        const known = (ctx.snapshot.workerRoutes ?? []).filter((r) => r.zoneId === zoneId);
        await verifyCurrentProgress();
        await ctx.beforeMutation?.();
        const result = await ensureWorkerRoute(ctx.client, {
          entry,
          zoneId: zoneId!,
          scriptName: ctx.spec.cloudflare.workerName,
          knownRoutes: known,
        });
        applied.push({ kind: "workers-route", hostname: entry.hostname, action: result.action });
        if (ctx.trackDomainProgress) {
          const read = (await ctx.client.listWorkerRoutes(zoneId!)).find(r => r.id === result.id);
          if (!read || read.pattern !== entry.hostname || read.script !== ctx.workerName) throw new Error("approved route write could not be verified; re-plan before retry");
          progress.workerRoutes = [...(progress.workerRoutes ?? []).filter(r => !(r.zoneId === zoneId && r.id === read.id)), { zoneId: zoneId!, id: read.id, pattern: read.pattern, script: read.script }];
        }
      } else {
        // Operator-chosen Worker / Pages custom domain, re-decided against the
        // fresh step snapshot; the decision equals the approved plan diff or
        // the step refuses.
        const decision = decideCustomDomain(entry, owner, facts);
        if (decision.action === "conflict") return { ok: false, error: { kind: "domain_error", detail: decision.detail } };
        if (decision.action === "preserve") {
          applied.push({ kind: entry.kind, hostname: entry.hostname, action: "preserve" });
          continue;
        }
        await verifyCurrentProgress();
        await ctx.beforeMutation?.();
        if (entry.kind === "workers-custom-domain") {
          if (decision.action === "detach") {
            await ctx.client.detachWorkerDomain(decision.domainId!);
          } else {
            if (decision.action === "attach") for (const id of decision.replaceRecordIds) await ctx.client.deleteDnsRecord(decision.zoneId, id);
            await ctx.client.attachWorkerDomain({ hostname: entry.hostname, service: owner, zone_id: decision.zoneId });
          }
          if (ctx.trackDomainProgress) {
            const read = (await ctx.client.listWorkerDomains()).find(d => d.hostname === entry.hostname);
            if (decision.action === "detach" ? read !== undefined : read?.service !== owner) throw new Error("approved custom-domain change could not be verified; re-plan before retry");
            progress.workerDomains = [...(progress.workerDomains ?? []).filter(d => d.hostname !== entry.hostname), ...(read ? [{ id: read.id, hostname: read.hostname, service: read.service, zone_id: read.zone_id }] : [])];
          }
        } else {
          const registered = facts.pagesDomains.some(d => d.name.toLowerCase() === entry.hostname);
          if (decision.action === "detach") {
            if (registered) await ctx.client.deletePagesDomain(owner, entry.hostname);
            if (decision.cnameRecordId) await ctx.client.deleteDnsRecord(decision.zoneId, decision.cnameRecordId);
          } else {
            if (decision.action === "attach" && decision.replaceWorkerDomainId) await ctx.client.detachWorkerDomain(decision.replaceWorkerDomainId);
            for (const id of decision.action === "attach" ? decision.replaceRecordIds : []) await ctx.client.deleteDnsRecord(decision.zoneId, id);
            if (!registered) await ctx.client.addPagesDomain(owner, { name: entry.hostname });
            const target = pagesCnameTarget(owner, facts);
            const hasCname = facts.dnsRecords.some(r => r.zoneId === decision.zoneId && r.type === "CNAME" && r.name.toLowerCase() === entry.hostname && r.content?.toLowerCase() === target);
            if (!hasCname) await ctx.client.createDnsRecord(decision.zoneId, { type: "CNAME", name: entry.hostname, content: target, proxied: true, ttl: 1 });
          }
          if (ctx.trackDomainProgress) {
            const read = (await ctx.client.listPagesDomains(owner)).find(d => d.name === entry.hostname);
            if ((decision.action === "detach") === (read !== undefined)) throw new Error("approved Pages domain change could not be verified; re-plan before retry");
            progress.pagesDomains = [...(progress.pagesDomains ?? []).filter(d => d.name !== entry.hostname), ...(read ? [{ id: read.id, domain_id: read.domain_id, name: read.name }] : [])];
          }
        }
        applied.push({ kind: entry.kind, hostname: entry.hostname, action: decision.action });
      }
    }
    return { ok: true, result: { applied, ...(ctx.trackDomainProgress ? { progressBaseline: baseline() } : {}) } };
  } catch (error) {
    return { ...normalizeFailure(error), ...(ctx.trackDomainProgress ? { progressBaseline: baseline() } : {}) };
  }
}

function resolveZoneId(entry: DomainEntrySpec, ctx: DeployStepContext): string | undefined {
  const name = entry.zoneName?.toLowerCase();
  if (!name) {
    return undefined;
  }
  return (ctx.snapshot.zones ?? []).find((z) => z.name.toLowerCase() === name && (!entry.zoneId || entry.zoneId === z.id))?.id;
}

function normalizeFailure(error: unknown): { ok: false; error: { kind: string; detail: string } } {
  // Do not echo provider/network error messages; they may include request data.
  return toStepFailure(error);
}
