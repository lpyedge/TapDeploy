// R2 bucket adapter. Only ever creates an explicitly-declared-and-permitted
// missing bucket; an existing bucket is preserved by identity and never
// recreated or overwritten. There is no delete path.

import type { CloudflareApiClient } from "../client/index.js";
import type { CloudflareErrorKind } from "../client/errors.js";
import type { R2BindingSpec } from "../../core/deploy-spec.js";
import type {
  R2BucketPrivacyView,
  R2PrivacyFacts,
  R2PrivacyRead,
} from "../../core/deploy/r2-private-guard.js";
import type { R2Bucket, R2CustomDomain, R2ManagedDomain } from "../models/index.js";
import {
  ResourceConflictError,
  type ResourceAdapter,
  type ResourceSupport,
} from "./types.js";

export const R2_BUCKET_SUPPORT: ResourceSupport = {
  kind: "r2-bucket",
  label: "R2 bucket",
  install: "create-declared",
  upgrade: "preserve",
  deletes: "never",
  verified: "local-contract",
};

export const r2BucketAdapter: ResourceAdapter = {
  support: R2_BUCKET_SUPPORT,
  mutation: "ensureR2Bucket",
};

export type BucketAction =
  | { binding: string; bucketName: string; action: "preserve"; id: string }
  | { binding: string; bucketName: string; action: "create" }
  | { binding: string; bucketName: string; action: "conflict"; detail: string };

type KnownBuckets = readonly Pick<R2Bucket, "name" | "id">[];

// a declared R2 binding handle from the final Wrangler config. R2 carries
// no provider id in the config; the bucket name is the only creation handle and
// the live identity (`name@creation_date`) is always read back from the
// account, never assumed from the config.
export interface DeclaredR2Bucket {
  binding: string;
  bucketName: string;
}

export interface R2EnsureOptions {
  createIfMissing: boolean;
}

// Pure: decide the safe action for one declared binding against live buckets.
// Creation happens only for a verified-missing bucket when explicitly approved;
// an existing bucket is preserved by its unique live identity; an ambiguous or
// identity-less live match is a conflict. Denied discovery never reaches here:
// required snapshot reads fail closed instead of returning an empty list.
export function plannedBucketActionFor(
  declared: DeclaredR2Bucket,
  knownBuckets: KnownBuckets,
  options: R2EnsureOptions,
): BucketAction {
  const matches = knownBuckets.filter((b) => b.name === declared.bucketName);
  if (matches.length > 1) {
    return {
      binding: declared.binding,
      bucketName: declared.bucketName,
      action: "conflict",
      detail: `R2 bucket "${declared.bucketName}" has ${matches.length} live identities in this account; refusing to guess`,
    };
  }
  const existing = matches[0];
  if (existing) {
    if (!existing.id) {
      return {
        binding: declared.binding,
        bucketName: declared.bucketName,
        action: "conflict",
        detail: `R2 bucket "${declared.bucketName}" exists but its live identity is unavailable`,
      };
    }
    return {
      binding: declared.binding,
      bucketName: declared.bucketName,
      action: "preserve",
      id: existing.id,
    };
  }
  if (options.createIfMissing) {
    return {
      binding: declared.binding,
      bucketName: declared.bucketName,
      action: "create",
    };
  }
  return {
    binding: declared.binding,
    bucketName: declared.bucketName,
    action: "conflict",
    detail: `R2 bucket "${declared.bucketName}" is missing and createIfMissing=false`,
  };
}

// Pure: decision with identical semantics to
// plannedBucketActionFor with createIfMissing taken from the declared spec.
export function bucketActionFor(
  binding: R2BindingSpec,
  knownBuckets: KnownBuckets,
): BucketAction {
  return plannedBucketActionFor(binding, knownBuckets, {
    createIfMissing: binding.createIfMissing,
  });
}

export interface EnsureBucketRequest {
  bucketName: string;
  createIfMissing: boolean;
  // Live buckets gathered read-only by the planner snapshot.
  knownBuckets: KnownBuckets;
}

export type EnsureBucketResult =
  | { action: "preserve"; name: string; id: string }
  | { action: "create"; name: string; id: string };

export async function ensureR2Bucket(
  client: CloudflareApiClient,
  request: EnsureBucketRequest,
): Promise<EnsureBucketResult> {
  const action = bucketActionFor(
    { binding: "", bucketName: request.bucketName, createIfMissing: request.createIfMissing },
    request.knownBuckets,
  );
  if (action.action === "preserve") {
    return { action: "preserve", name: action.bucketName, id: action.id };
  }
  if (action.action === "conflict") {
    throw new ResourceConflictError(action.detail);
  }
  const created = await client.createR2Bucket(request.bucketName);
  return { action: "create", name: created.name, id: created.id };
}

// ---------------------------------------------------------------------------
// read-only privacy facts for the R2 owner-bootstrap guard
// ---------------------------------------------------------------------------

/** The three read surfaces the privacy guard classifies (minimal metadata). */
export interface R2PrivacyReadClient {
  getR2Bucket(bucketName: string): Promise<R2Bucket>;
  getR2ManagedDomain(bucketName: string): Promise<R2ManagedDomain>;
  listR2CustomDomains(bucketName: string): Promise<R2CustomDomain[]>;
}

export interface R2PrivacyReadRequest {
  accountId: string;
  bucketName: string;
  /** Jurisdiction claim the plan targets, when present. */
  jurisdiction?: string;
  /** When the reads are taken (ms epoch); the caller owns the clock. */
  readAtMs: number;
}

function errorKindOf(error: unknown): CloudflareErrorKind {
  if (
    error !== null &&
    typeof error === "object" &&
    typeof (error as { kind?: unknown }).kind === "string"
  ) {
    return (error as { kind: CloudflareErrorKind }).kind;
  }
  return "unknown";
}

async function capture<T, V>(
  call: () => Promise<T>,
  view: (value: T) => V,
): Promise<R2PrivacyRead<V>> {
  try {
    return { ok: true, value: view(await call()) };
  } catch (error) {
    return { ok: false, kind: errorKindOf(error) };
  }
}

/**
 * Read-only: capture the bucket identity plus the two official public
 * exposure surfaces as privacy facts. Each surface is captured independently
 * so any failure (scope shortfall, API error, timeout, missing/invalid
 * response) is preserved as an explicit error kind — the guard turns every
 * failure into UNKNOWN and never into "private". No write happens here, and
 * no object contents are read.
 */
export async function readR2PrivacyFacts(
  client: R2PrivacyReadClient,
  request: R2PrivacyReadRequest,
): Promise<R2PrivacyFacts> {
  const bucket = await capture(
    () => client.getR2Bucket(request.bucketName),
    (value): R2BucketPrivacyView => ({
      name: value.name,
      ...(value.jurisdiction !== undefined ? { jurisdiction: value.jurisdiction } : {}),
    }),
  );
  const managedDomain = await capture(
    () => client.getR2ManagedDomain(request.bucketName),
    (value) => ({ domain: value.domain, enabled: value.enabled }),
  );
  const customDomains = await capture(
    () => client.listR2CustomDomains(request.bucketName),
    (value) => value.map((domain) => ({ domain: domain.domain, enabled: domain.enabled })),
  );
  return {
    accountId: request.accountId,
    bucketName: request.bucketName,
    ...(request.jurisdiction !== undefined ? { jurisdiction: request.jurisdiction } : {}),
    readAtMs: request.readAtMs,
    bucket,
    managedDomain,
    customDomains,
  };
}
