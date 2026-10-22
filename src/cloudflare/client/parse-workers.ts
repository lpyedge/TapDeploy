// Cloudflare response parsers: Workers (scripts, versions, deployments, subdomain, schedules).
// Pure functions: they validate and normalize an already-parsed response body
// and throw an invalid-response error on any malformed shape; nothing here
// performs a request or swallows an upstream error.

import type {
  WorkerDeployment,
  WorkerScheduleMetadata,
  WorkerSubdomainState,
  WorkerScriptMeta,
  WorkerVersionMeta,
} from "../models/index.js";
import { makeInvalidResponseError, type CloudflareEnvelope } from "./errors.js";

export function parseWorkerList(env: CloudflareEnvelope<unknown>): WorkerScriptMeta[] {
  const result = env.result;
  if (!Array.isArray(result)) {
    throw makeInvalidResponseError("Worker list result is not an array");
  }
  return result as WorkerScriptMeta[];
}

export function parseVersionList(env: CloudflareEnvelope<unknown>): WorkerVersionMeta[] {
  const result = env.result as { items?: unknown } | undefined;
  const items = result?.items;
  if (!Array.isArray(items)) {
    throw makeInvalidResponseError("Version list result.items is not an array");
  }
  return items.map((item) => normalizeVersionItem(item));
}

export function normalizeVersionItem(item: unknown): WorkerVersionMeta {
  if (typeof item !== "object" || item === null) {
    throw makeInvalidResponseError("Version item is not an object");
  }
  const o = item as Record<string, unknown>;
  if (typeof o["id"] !== "string") {
    throw makeInvalidResponseError("Version item missing id");
  }
  const meta = o["metadata"];
  const metaObj =
    typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : undefined;
  const out: WorkerVersionMeta = { id: o["id"] as string };
  if (typeof o["number"] === "number") out.number = o["number"];
  const created = metaObj?.["created_on"] ?? o["created_on"];
  if (typeof created === "string") out.created_on = created;
  const modified = metaObj?.["modified_on"] ?? o["modified_on"];
  if (typeof modified === "string") out.modified_on = modified;
  // The version message is published as the `workers/message` annotation
  // (see the real versions list shape). Prefer a top-level `message` for
  // contract compatibility but fall back to the annotation so the ownership
  // marker (`TAPDEPLOY_MANAGED_MARKER`) is recognized against the live API.
  let message = o["message"];
  if (typeof message !== "string") {
    const annotations = o["annotations"];
    const annotationsObj =
      typeof annotations === "object" && annotations !== null
        ? (annotations as Record<string, unknown>)
        : undefined;
    message = annotationsObj?.["workers/message"];
    if (typeof message === "string") {
      if (annotationsObj) {
        out.annotations = {};
        for (const [k, v] of Object.entries(annotationsObj)) {
          if (typeof v === "string") out.annotations[k] = v;
        }
      }
    }
  }
  if (typeof message === "string") out.message = message;
  if (metaObj) {
    out.metadata = {
      ...(typeof metaObj["author_email"] === "string" ? { author_email: metaObj["author_email"] as string } : {}),
      ...(typeof metaObj["author_id"] === "string" ? { author_id: metaObj["author_id"] as string } : {}),
      ...(typeof metaObj["created_on"] === "string" ? { created_on: metaObj["created_on"] as string } : {}),
      ...(typeof metaObj["modified_on"] === "string" ? { modified_on: metaObj["modified_on"] as string } : {}),
      ...(typeof metaObj["source"] === "string" ? { source: metaObj["source"] as string } : {}),
      ...(typeof metaObj["hasPreview"] === "boolean" ? { hasPreview: metaObj["hasPreview"] as boolean } : {}),
    };
  }
  if (typeof o["deployment_id"] === "string") out.deployment_id = o["deployment_id"] as string;
  return out;
}

export function parseDeploymentList(env: CloudflareEnvelope<unknown>): WorkerDeployment[] {
  const result = env.result as { deployments?: unknown } | undefined;
  const deployments = result?.deployments;
  if (!Array.isArray(deployments)) {
    throw makeInvalidResponseError("Deployment list result.deployments is not an array");
  }
  return deployments.map((d) => normalizeDeployment(d));
}

function normalizeDeployment(item: unknown): WorkerDeployment {
  if (typeof item !== "object" || item === null) {
    throw makeInvalidResponseError("Deployment is not an object");
  }
  const o = item as Record<string, unknown>;
  if (typeof o["id"] !== "string") {
    throw makeInvalidResponseError("Deployment missing id");
  }
  const rawVersions = o["versions"];
  if (!Array.isArray(rawVersions)) {
    throw makeInvalidResponseError("Deployment versions is not an array");
  }
  const versions = rawVersions.map((v) => {
    if (typeof v !== "object" || v === null) {
      throw makeInvalidResponseError("Deployment version entry is not an object");
    }
    const e = v as Record<string, unknown>;
    const versionId = e["version_id"];
    if (typeof versionId !== "string") {
      throw makeInvalidResponseError("Deployment version entry missing version_id");
    }
    return {
      version_id: versionId,
      ...(typeof e["percentage"] === "number" ? { percentage: e["percentage"] as number } : {}),
      id: versionId,
    };
  });
  return {
    id: o["id"] as string,
    script_id: typeof o["script_id"] === "string" ? (o["script_id"] as string) : "",
    author_id: typeof o["author_id"] === "string" ? (o["author_id"] as string) : "",
    ...(typeof o["created_on"] === "string" ? { created_on: o["created_on"] as string } : {}),
    ...(typeof o["modified_on"] === "string" ? { modified_on: o["modified_on"] as string } : {}),
    ...(typeof o["source"] === "string" ? { source: o["source"] as string } : {}),
    ...(typeof o["strategy"] === "string" ? { strategy: o["strategy"] as string } : {}),
    versions,
    ...(typeof o["annotations"] === "object" && o["annotations"] !== null
      ? { annotations: o["annotations"] as Record<string, string> }
      : {}),
  };
}

// An account without a workers.dev subdomain answers 404 (code 10007); the
// request layer surfaces that as a "not-found" API error, handled by the caller.
export function parseAccountSubdomain(env: CloudflareEnvelope<unknown>): string | undefined {
  const subdomain = (env.result as { subdomain?: unknown } | undefined)?.subdomain;
  if (subdomain === undefined || subdomain === null || subdomain === "") return undefined;
  if (typeof subdomain !== "string" || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
    throw makeInvalidResponseError("account workers.dev subdomain is not a valid DNS label");
  }
  return subdomain;
}

export function parseSubdomainState(env: CloudflareEnvelope<unknown>): WorkerSubdomainState {
  const result = env.result as { enabled?: unknown; previews_enabled?: unknown } | undefined;
  if (typeof result?.enabled !== "boolean") {
    throw makeInvalidResponseError("Worker subdomain result.enabled is not a boolean");
  }
  return { enabled: result.enabled, previews_enabled: result.previews_enabled === true };
}

export function parseSchedules(env: CloudflareEnvelope<unknown>): WorkerScheduleMetadata {
  const result = env.result as { schedules?: unknown } | undefined;
  const schedules = result?.schedules;
  if (!Array.isArray(schedules)) {
    throw makeInvalidResponseError("Schedule result.schedules is not an array");
  }
  const crons = schedules.map((s) => {
    if (typeof s !== "object" || s === null || typeof (s as Record<string, unknown>)["cron"] !== "string") {
      throw makeInvalidResponseError("Schedule entry missing cron");
    }
    return (s as Record<string, unknown>)["cron"] as string;
  });
  return { crons };
}

// Official schedules update returns result.schedules[{cron}]; normalize to the
// internal {crons: string[]} model (same as the read side). The write request
// body is an array of {cron} objects, not a {crons} envelope.
export function parseScheduleUpdate(env: CloudflareEnvelope<unknown>): WorkerScheduleMetadata {
  const result = env.result as { schedules?: unknown } | undefined;
  const schedules = result?.schedules;
  if (!Array.isArray(schedules)) {
    throw makeInvalidResponseError("Schedule update result.schedules is not an array");
  }
  const crons = schedules.map((s) => {
    if (typeof s !== "object" || s === null || typeof (s as Record<string, unknown>)["cron"] !== "string") {
      throw makeInvalidResponseError("Schedule update entry missing cron");
    }
    return (s as Record<string, unknown>)["cron"] as string;
  });
  return { crons };
}
