// Cloudflare response parsers: Pages, asset sessions, zones, DNS, routes and domains.
// Pure functions: they validate and normalize an already-parsed response body
// and throw an invalid-response error on any malformed shape; nothing here
// performs a request or swallows an upstream error.

import type {
  AssetSessionResult,
  DnsRecord,
  PagesDeployment,
  PagesDeploymentConfig,
  PagesDeploymentStage,
  PagesDomain,
  PagesProject,
  PagesProjectSummary,
  WorkerDomain,
  WorkerRoute,
  ZoneSummary,
} from "../models/index.js";
import { makeInvalidResponseError, type CloudflareEnvelope } from "./errors.js";

// Pages projects list — `result` is an ARRAY of project objects (the
// endpoint does not paginate). Each project carries `id`, `name`, `subdomain`,
// `created_on`, `modified_on`, `domains[]` and a `canonical_deployment`. We model
// only the fields the installer needs for target/upgrade discovery and fail
// closed on a malformed entry (missing id or name).
export function parsePagesProjectList(env: CloudflareEnvelope<unknown>): PagesProjectSummary[] {
  const result = env.result;
  if (!Array.isArray(result)) {
    throw makeInvalidResponseError("Pages project list result is not an array");
  }
  return result.map((item) => normalizePagesProject(item));
}

function normalizePagesProject(item: unknown): PagesProjectSummary {
  if (typeof item !== "object" || item === null) {
    throw makeInvalidResponseError("Pages project is not an object");
  }
  const o = item as Record<string, unknown>;
  const id = o["id"];
  const name = o["name"];
  if (typeof id !== "string" || id.length === 0) {
    throw makeInvalidResponseError("Pages project missing id");
  }
  if (typeof name !== "string" || name.length === 0) {
    throw makeInvalidResponseError("Pages project missing name");
  }
  const out: PagesProjectSummary = { id, name };
  if (typeof o["subdomain"] === "string") out.subdomain = o["subdomain"];
  if (typeof o["created_on"] === "string") out.created_on = o["created_on"];
  if (typeof o["modified_on"] === "string") out.modified_on = o["modified_on"];
  if (Array.isArray(o["domains"])) {
    out.domains = o["domains"].filter((d): d is string => typeof d === "string");
  }
  const canonical = o["canonical_deployment"];
  if (typeof canonical === "object" && canonical !== null) {
    const dep = canonical as Record<string, unknown>;
    const latest: NonNullable<PagesProjectSummary["latestDeployment"]> = {};
    if (typeof dep["id"] === "string") latest.id = dep["id"];
    if (typeof dep["url"] === "string") latest.url = dep["url"];
    if (dep["environment"] === "preview" || dep["environment"] === "production") {
      latest.environment = dep["environment"];
    }
    if (typeof dep["created_on"] === "string") latest.created_on = dep["created_on"];
    if (Object.keys(latest).length > 0) out.latestDeployment = latest;
  }
  return out;
}

// parse a full Pages project (GET /pages/projects/{project_name}).
export function parsePagesProject(env: CloudflareEnvelope<unknown>): PagesProject {
  const result = env.result;
  if (typeof result !== "object" || result === null) {
    throw makeInvalidResponseError("Pages project result is not an object");
  }
  const o = result as Record<string, unknown>;
  if (typeof o["id"] !== "string" || typeof o["name"] !== "string") {
    throw makeInvalidResponseError("Pages project missing id/name");
  }
  return normalizePagesProjectFull(o);
}

export function normalizeCreatePagesProject(env: CloudflareEnvelope<unknown>): PagesProject {
  const result = env.result;
  if (typeof result !== "object" || result === null) {
    throw makeInvalidResponseError("Pages project create result is not an object");
  }
  return normalizePagesProjectFull(result as Record<string, unknown>);
}

function normalizePagesProjectFull(o: Record<string, unknown>): PagesProject {
  const out: PagesProject = {
    id: o["id"] as string,
    name: o["name"] as string,
  };
  if (typeof o["subdomain"] === "string") out.subdomain = o["subdomain"];
  if (typeof o["created_on"] === "string") out.created_on = o["created_on"];
  if (typeof o["modified_on"] === "string") out.modified_on = o["modified_on"];
  if (Array.isArray(o["domains"])) {
    out.domains = o["domains"].filter((d): d is string => typeof d === "string");
  }
  if (typeof o["production_branch"] === "string") out.production_branch = o["production_branch"];
  const canonical = o["canonical_deployment"];
  if (typeof canonical === "object" && canonical !== null) {
    out.canonical_deployment = normalizePagesDeployment(canonical as Record<string, unknown>);
  }
  const latest = o["latest_deployment"];
  if (typeof latest === "object" && latest !== null) {
    out.latest_deployment = normalizePagesDeployment(latest as Record<string, unknown>);
  }
  const configs = o["deployment_configs"];
  if (typeof configs === "object" && configs !== null) {
    const dc = configs as Record<string, unknown>;
    const production = normalizePagesDeploymentConfig(dc["production"]);
    const preview = normalizePagesDeploymentConfig(dc["preview"]);
    if (production || preview) {
      out.deployment_configs = {};
      if (production) out.deployment_configs.production = production;
      if (preview) out.deployment_configs.preview = preview;
    }
  }
  return out;
}

// parse the Pages deployment(s) list (result is an ARRAY).
export function parsePagesDeploymentList(env: CloudflareEnvelope<unknown>): PagesDeployment[] {
  const result = env.result;
  if (!Array.isArray(result)) {
    throw makeInvalidResponseError("Pages deployment list result is not an array");
  }
  return result.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw makeInvalidResponseError("Pages deployment is not an object");
    }
    return normalizePagesDeployment(item as Record<string, unknown>);
  });
}

export function parsePagesDeployment(env: CloudflareEnvelope<unknown>): PagesDeployment {
  const result = env.result;
  if (typeof result !== "object" || result === null) {
    throw makeInvalidResponseError("Pages deployment result is not an object");
  }
  return normalizePagesDeployment(result as Record<string, unknown>);
}

export function normalizePagesDeployment(o: Record<string, unknown>): PagesDeployment {
  const out: PagesDeployment = {};
  if (typeof o["id"] === "string") out.id = o["id"];
  if (typeof o["project_name"] === "string") out.project_name = o["project_name"];
  if (typeof o["project_id"] === "string") out.project_id = o["project_id"];
  if (o["env_vars"] && typeof o["env_vars"] === "object" && !Array.isArray(o["env_vars"])) {
    out.env_vars = {};
    for (const [name, value] of Object.entries(o["env_vars"] as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const variable = value as Record<string, unknown>;
      out.env_vars[name] = { ...(typeof variable.type === "string" ? { type: variable.type } : {}), ...(variable.type === "plain_text" && typeof variable.value === "string" ? { value: variable.value } : {}) };
    }
  }
  if (typeof o["url"] === "string") out.url = o["url"];
  if (o["environment"] === "preview" || o["environment"] === "production") {
    out.environment = o["environment"];
  }
  if (typeof o["created_on"] === "string") out.created_on = o["created_on"];
  if (typeof o["modified_on"] === "string") out.modified_on = o["modified_on"];
  const stage = o["latest_stage"];
  if (typeof stage === "object" && stage !== null) {
    const s = stage as Record<string, unknown>;
    const normalized: PagesDeploymentStage = {};
    if (typeof s["name"] === "string") normalized.name = s["name"];
    if (typeof s["status"] === "string") normalized.status = s["status"];
    if (typeof s["started_on"] === "string") normalized.started_on = s["started_on"];
    if (typeof s["ended_on"] === "string") normalized.ended_on = s["ended_on"];
    out.latest_stage = normalized;
  }
  const trigger = o["deployment_trigger"];
  if (typeof trigger === "object" && trigger !== null) {
    const t = trigger as Record<string, unknown>;
    const meta = t["metadata"];
    const metaObj = typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : undefined;
    out.deployment_trigger = {
      ...(typeof t["type"] === "string" ? { type: t["type"] as string } : {}),
      ...(metaObj
        ? {
            metadata: {
              ...(typeof metaObj["branch"] === "string" ? { branch: metaObj["branch"] as string } : {}),
              ...(typeof metaObj["commit_hash"] === "string" ? { commit_hash: metaObj["commit_hash"] as string } : {}),
            },
          }
        : {}),
    };
  }
  return out;
}

function normalizePagesDeploymentConfig(input: unknown): PagesDeploymentConfig | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const o = input as Record<string, unknown>;
  // Preserve unmodified provider configuration (including binding families the
  // installer does not author). Do not synthesize or drop unknown fields.
  const out: PagesDeploymentConfig = { ...o };
  if (typeof o["compatibility_date"] === "string") out.compatibility_date = o["compatibility_date"];
  if (Array.isArray(o["compatibility_flags"])) {
    out.compatibility_flags = o["compatibility_flags"].filter((f): f is string => typeof f === "string");
  }
  if (typeof o["env_vars"] === "object" && o["env_vars"] !== null) {
    const env: NonNullable<PagesDeploymentConfig["env_vars"]> = {};
    for (const [k, v] of Object.entries(o["env_vars"] as Record<string, unknown>)) {
      if (typeof v === "object" && v !== null) {
        const ev = v as Record<string, unknown>;
        env[k] = {
          ...(typeof ev["value"] === "string" ? { value: ev["value"] } : {}),
          ...(typeof ev["type"] === "string" ? { type: ev["type"] } : {}),
        };
      }
    }
    out.env_vars = env;
  }
  const r2 = o["r2_buckets"];
  if (typeof r2 === "object" && r2 !== null) {
    const m: NonNullable<PagesDeploymentConfig["r2_buckets"]> = {};
    for (const [k, v] of Object.entries(r2 as Record<string, unknown>)) {
      if (typeof v === "object" && v !== null) {
        const b = v as Record<string, unknown>;
        if (typeof b["name"] === "string") m[k] = { ...b, name: b["name"] };
      }
    }
    if (Object.keys(m).length > 0) out.r2_buckets = m;
  }
  const d1 = o["d1_databases"];
  if (typeof d1 === "object" && d1 !== null) {
    const m: NonNullable<PagesDeploymentConfig["d1_databases"]> = {};
    for (const [k, v] of Object.entries(d1 as Record<string, unknown>)) {
      if (typeof v === "object" && v !== null) {
        const b = v as Record<string, unknown>;
        if (typeof b["id"] === "string") m[k] = { id: b["id"] };
      }
    }
    if (Object.keys(m).length > 0) out.d1_databases = m;
  }
  const kv = o["kv_namespaces"];
  if (typeof kv === "object" && kv !== null) {
    const m: NonNullable<PagesDeploymentConfig["kv_namespaces"]> = {};
    for (const [k, v] of Object.entries(kv as Record<string, unknown>)) {
      if (typeof v === "object" && v !== null) {
        const b = v as Record<string, unknown>;
        if (typeof b["namespace_id"] === "string") m[k] = { namespace_id: b["namespace_id"] };
      }
    }
    if (Object.keys(m).length > 0) out.kv_namespaces = m;
  }
  const queueProducers = o["queue_producers"];
  if (typeof queueProducers === "object" && queueProducers !== null) {
    const m: NonNullable<PagesDeploymentConfig["queue_producers"]> = {};
    for (const [k, v] of Object.entries(queueProducers as Record<string, unknown>)) {
      if (typeof v === "object" && v !== null) {
        const b = v as Record<string, unknown>;
        if (typeof b["name"] === "string") m[k] = { name: b["name"] };
      }
    }
    if (Object.keys(m).length > 0) out.queue_producers = m;
  }
  return out;
}

// official assets-upload-session result is {jwt, buckets: string[][]}.
// Empty buckets means all assets already stored; the session jwt is then the
// completion token for create-version.
export function parseAssetSessionResult(env: CloudflareEnvelope<unknown>): AssetSessionResult {
  const result = env.result as { jwt?: unknown; buckets?: unknown } | undefined;
  if (typeof result?.jwt !== "string" || result.jwt.length === 0) {
    throw makeInvalidResponseError("Asset session result missing jwt");
  }
  if (!Array.isArray(result.buckets)) {
    throw makeInvalidResponseError("Asset session result.buckets is not an array");
  }
  const buckets: string[][] = result.buckets.map((bucket, i) => {
    if (!Array.isArray(bucket)) {
      throw makeInvalidResponseError(`Asset session buckets[${i}] is not an array`);
    }
    for (const h of bucket) {
      if (typeof h !== "string" || h.length === 0) {
        throw makeInvalidResponseError(`Asset session buckets[${i}] contains a non-string hash`);
      }
    }
    return [...bucket] as string[];
  });
  return { jwt: result.jwt, buckets };
}

// zone list normalization. The list endpoint returns `result[]`; the
// installer keeps only the stable identity (id + name) so a forward-compatible
// response is never broken by added fields.
export function parseZoneList(env: CloudflareEnvelope<unknown>): ZoneSummary[] {
  const result = env.result;
  if (!Array.isArray(result)) {
    throw makeInvalidResponseError("Zone list result is not an array");
  }
  return result.map((item) => normalizeZone(item));
}

function normalizeZone(item: unknown): ZoneSummary {
  if (typeof item !== "object" || item === null) {
    throw makeInvalidResponseError("Zone is not an object");
  }
  const o = item as Record<string, unknown>;
  if (typeof o["id"] !== "string" || o["id"].length === 0) {
    throw makeInvalidResponseError("Zone missing id");
  }
  return { id: o["id"] as string, name: typeof o["name"] === "string" ? o["name"] as string : "" };
}

// DNS record list + create/update normalization.
export function parseDnsRecordList(env: CloudflareEnvelope<unknown>): DnsRecord[] {
  const result = env.result as { result?: unknown } | undefined;
  const records = Array.isArray(result) ? result : result?.result;
  if (!Array.isArray(records)) {
    throw makeInvalidResponseError("DNS record list result is not an array");
  }
  return records.map((item) => normalizeDnsRecord(item));
}

export function normalizeDnsRecord(item: unknown): DnsRecord {
  if (typeof item !== "object" || item === null) {
    throw makeInvalidResponseError("DNS record is not an object");
  }
  const o = item as Record<string, unknown>;
  if (typeof o["id"] !== "string" || o["id"].length === 0) {
    throw makeInvalidResponseError("DNS record missing id");
  }
  const out: DnsRecord = { id: o["id"] as string, name: "", type: "" };
  if (typeof o["name"] === "string") out.name = o["name"];
  if (typeof o["type"] === "string") out.type = o["type"];
  if (typeof o["content"] === "string") out.content = o["content"];
  if (typeof o["ttl"] === "number") out.ttl = o["ttl"];
  if (typeof o["proxied"] === "boolean") out.proxied = o["proxied"];
  if (typeof o["comment"] === "string") out.comment = o["comment"];
  if (typeof o["created_on"] === "string") out.created_on = o["created_on"];
  if (typeof o["modified_on"] === "string") out.modified_on = o["modified_on"];
  return out;
}

// Workers route list + create/update normalization.
export function parseWorkerRouteList(env: CloudflareEnvelope<unknown>): WorkerRoute[] {
  const result = env.result;
  if (!Array.isArray(result)) {
    throw makeInvalidResponseError("Worker route list result is not an array");
  }
  return result.map((item) => normalizeWorkerRoute(item));
}

export function normalizeWorkerRoute(item: unknown): WorkerRoute {
  if (typeof item !== "object" || item === null) {
    throw makeInvalidResponseError("Worker route is not an object");
  }
  const o = item as Record<string, unknown>;
  if (typeof o["id"] !== "string" || o["id"].length === 0) {
    throw makeInvalidResponseError("Worker route missing id");
  }
  const out: WorkerRoute = { id: o["id"] as string, pattern: "" };
  if (typeof o["pattern"] === "string") out.pattern = o["pattern"];
  if (typeof o["script"] === "string") out.script = o["script"];
  if (typeof o["zone_id"] === "string") out.zone_id = o["zone_id"];
  if (typeof o["zone_name"] === "string") out.zone_name = o["zone_name"];
  return out;
}

// Workers custom domain list + attach normalization.
export function parseWorkerDomainList(env: CloudflareEnvelope<unknown>): WorkerDomain[] {
  const result = env.result;
  if (!Array.isArray(result)) {
    throw makeInvalidResponseError("Worker domain list result is not an array");
  }
  return result.map((item) => normalizeWorkerDomain(item));
}

export function normalizeWorkerDomain(item: unknown): WorkerDomain {
  if (typeof item !== "object" || item === null) {
    throw makeInvalidResponseError("Worker domain is not an object");
  }
  const o = item as Record<string, unknown>;
  if (typeof o["id"] !== "string" || o["id"].length === 0) {
    throw makeInvalidResponseError("Worker domain missing id");
  }
  const out: WorkerDomain = { id: o["id"] as string, hostname: "", service: "" };
  if (typeof o["hostname"] === "string") out.hostname = o["hostname"];
  if (typeof o["service"] === "string") out.service = o["service"];
  if (typeof o["enabled"] === "boolean") out.enabled = o["enabled"];
  if (typeof o["previews_enabled"] === "boolean") out.previews_enabled = o["previews_enabled"];
  if (typeof o["zone_id"] === "string") out.zone_id = o["zone_id"];
  if (typeof o["zone_name"] === "string") out.zone_name = o["zone_name"];
  if (typeof o["cert_id"] === "string") out.cert_id = o["cert_id"];
  if (typeof o["created_on"] === "string") out.created_on = o["created_on"];
  return out;
}

// Pages custom domain list + add normalization. Pages domains are addressed
// by `name` (the hostname); `domain_id` is the stable id. The install keeps only
// the identity it needs (`name` + `id`/`domain_id` + `status`).
export function parsePagesDomainList(env: CloudflareEnvelope<unknown>): PagesDomain[] {
  const result = env.result;
  if (!Array.isArray(result)) {
    throw makeInvalidResponseError("Pages domain list result is not an array");
  }
  return result.map((item) => normalizePagesDomain(item));
}

export function normalizePagesDomain(item: unknown): PagesDomain {
  if (typeof item !== "object" || item === null) {
    throw makeInvalidResponseError("Pages domain is not an object");
  }
  const o = item as Record<string, unknown>;
  const out: PagesDomain = { name: "" };
  if (typeof o["name"] === "string") out.name = o["name"];
  if (typeof o["id"] === "string") out.id = o["id"];
  if (typeof o["domain_id"] === "string") out.domain_id = o["domain_id"];
  if (typeof o["status"] === "string") out.status = o["status"];
  if (typeof o["zone_tag"] === "string") out.zone_tag = o["zone_tag"];
  if (typeof o["created_on"] === "string") out.created_on = o["created_on"];
  if (!out.name && !out.id && !out.domain_id) {
    throw makeInvalidResponseError("Pages domain missing required identity");
  }
  return out;
}

// a DELETE result is a bare `{success:true, result:{id}}` (or an object
// with an optional id). The typed client returns void; an unexpected non-object
// result still fails closed.
export function parseDeleteResult(env: CloudflareEnvelope<unknown>): null {
  // Some delete endpoints (Workers / Pages custom domains) answer `result: null`;
  // a successful delete carries no data, so the parsed value is always null.
  const result = env.result;
  if (result !== undefined && result !== null && typeof result !== "object") {
    throw makeInvalidResponseError("Delete result is not an object");
  }
  return null;
}
