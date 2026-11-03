// Minimal typed client for the installer's own API. The OAuth access token
// never appears here or anywhere in UI JS: the HttpOnly session cookie carries
// it server-side and this module only forwards the CSRF token bound to it.

import type { PrimitiveInputValue } from "../core/deploy-spec.js";

export interface SessionState {
  authenticated: boolean;
  expiresAt?: number;
  scope?: string[];
  accountId?: string;
  source?: string;
  csrf?: string;
  configHash?: string;
}

export interface AccountSummary {
  id: string;
  name: string;
}

export interface TargetsEnvelope {
  accountId: string;
  workers: { name: string }[];
  pages: { name: string; id: string }[];
}

interface StepEnvelope<T = unknown> {
  resourceReceipt?: unknown;
  domainReceipt?: unknown;
  ok: boolean;
  result?: T;
  error?: string;
  detail?: string;
  retryAfterSeconds?: number;
}

export interface ApiFailure extends Error {
  domainReceipt?: unknown;
  status: number;
  kind?: string;
  detail?: string;
  issues?: string[];
}

export function failure(status: number, body: unknown): ApiFailure {
  const detail = extractError(body, status);
  const err: ApiFailure = new Error(detail.message) as ApiFailure;
  err.status = status;
  err.kind = detail.kind;
  err.detail = detail.detail;
  err.issues = detail.issues;
  if (body && typeof body === "object" && "domainReceipt" in body) err.domainReceipt = body.domainReceipt;
  return err;
}

function extractError(
  body: unknown,
  status: number,
): { message: string; kind?: string; detail?: string; issues?: string[] } {
  if (body && typeof body === "object") {
    const b = body as { error?: unknown; detail?: unknown; issues?: unknown };
    const kind = typeof b.error === "string" ? b.error : undefined;
    const detail = typeof b.detail === "string" ? b.detail : undefined;
    const issues = Array.isArray(b.issues)
      ? b.issues.filter((i): i is string => typeof i === "string")
      : undefined;
    const upstream = kind === "upstream" && typeof (b as { upstream?: unknown }).upstream === "string" ? `Cloudflare answered with an error (${(b as { upstream: string }).upstream})` : undefined;
    // A bare provider kind ("unknown", "upstream") adds nothing when a detail explains it.
    const label = upstream ?? (detail && (kind === "unknown" || kind === "upstream") ? undefined : kind);
    const message = kind === "forbidden"
      ? "Cloudflare denied this action: the account you signed in with lacks a permission the install needs. Signing in again will not help; check the account's role or choose another account."
      : [label, detail, ...(issues ?? [])].filter(Boolean).join("; ");
    if (message) {
      return { message, kind, detail, issues };
    }
  }
  return { message: `request failed with status ${status}` };
}

async function request(
  path: string,
  csrf: string | undefined,
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (csrf) {
    headers["x-tapdeploy-csrf"] = csrf;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    const err: ApiFailure = new Error(`network error: ${String(error)}`) as ApiFailure;
    err.status = 0;
    throw err;
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    throw failure(res.status, json);
  }
  return json;
}

// The sign-in itself is no good (expired, revoked, CSRF/origin refused): signing in
// again for the same config is the way forward. A provider "forbidden" is different:
// the sign-in is valid but the account lacks a permission, and signing in again
// would only loop.
export function isAuthFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { status, kind } = error as { status?: number; kind?: string };
  return status === 401 || (status === 403 && kind !== "forbidden");
}

export async function getSession(): Promise<SessionState> {
  const json = (await request("/api/auth/session", undefined)) as SessionState;
  return json;
}

export interface SignOutResult {
  localSessionCleared: true;
  providerRevocation: "confirmed" | "unconfirmed" | "not_applicable";
}

/** Clear the local cookie and report the provider's independent revoke result. */
export async function signOut(csrf: string): Promise<SignOutResult> {
  return await request("/api/auth/logout", csrf, {}) as SignOutResult;
}

export interface StartOAuthResult {
  url: string;
  configHash: string;
  scopes: string[];
}

/**
 * Start the config-bounded one-shot OAuth. Sends the nonsecret config text so the
 * server derives the exact scope bundle and binds the config hash + scopes +
 * targets + modes into the sealed transaction. No token ever reaches the browser.
 */
export async function startOAuth(configText: string): Promise<StartOAuthResult> {
  return (await request("/api/auth/start", undefined, { text: configText })) as StartOAuthResult;
}

export interface ConfigCoverage {
  ok: boolean;
  matches: boolean;
  reason?: string;
  detail?: string;
}

/**
 * Read-only coverage probe: asks the server whether the given config text is
 * the exact config the current session's one-shot OAuth was granted for. Used
 * BEFORE upload/prepare/plan so a changed config surfaces an explicit
 * re-authorization state instead of a late config_mismatch. Fails closed
 * (matches:false) when unauthenticated; never mints or extends anything.
 */
export async function checkConfigCoverage(csrf: string, configText: string): Promise<ConfigCoverage> {
  return (await request("/api/auth/check-config", csrf, { text: configText })) as ConfigCoverage;
}

export async function getAccounts(csrf: string): Promise<AccountSummary[]> {
  const json = (await request("/api/cloudflare/accounts", csrf)) as {
    accounts: AccountSummary[];
  };
  return json.accounts ?? [];
}

// read-only target discovery for the selected account.
export async function getTargets(csrf: string, accountId: string): Promise<TargetsEnvelope> {
  const json = (await request("/api/cloudflare/targets", csrf, { accountId })) as TargetsEnvelope;
  return json;
}

/** Read-only custom-domain facts: zones, one zone's address records, bound domains. */
export interface DomainsEnvelope {
  accountId: string;
  zones: string[];
  zone?: string;
  records?: Array<{ name: string; type: string; content?: string }>;
  workerDomains: Array<{ hostname: string; service?: string; zone?: string }>;
  pagesDomains: Record<string, string[]>;
}

export async function getDomains(csrf: string, accountId: string, opts: { zone?: string; pagesProjects?: string[] } = {}): Promise<DomainsEnvelope> {
  return (await request("/api/cloudflare/domains", csrf, { accountId, ...opts })) as DomainsEnvelope;
}

/** The status Cloudflare reports for one Pages custom domain ("active" once DNS and the certificate are done; "missing" when it is not bound). */
export async function getPagesDomainStatus(csrf: string, accountId: string, project: string, hostname: string): Promise<string> {
  return ((await request("/api/cloudflare/pages-domain-status", csrf, { accountId, project, hostname })) as { status: string }).status;
}

/** Names of the account's Hyperdrive configurations (never connection details). */
export async function getHyperdriveConfigs(csrf: string, accountId: string): Promise<string[]> {
  return ((await request("/api/cloudflare/hyperdrive", csrf, { accountId })) as { configs: string[] }).configs;
}

/** Per HTTP unit: hostnames to bind (with replacement consent) and, on upgrade, to remove. */
export type GraphDomainRequest = Record<string, {
  bind?: Array<{ hostname: string; zone: string; replaceExisting?: boolean }>;
  remove?: Array<{ hostname: string; zone: string }>;
}>;

// ---------------------------------------------------------------------------
// V3 sealed-graph clients. The browser never authors graph identity: it
// forwards the server-issued releaseProof / executionContext / approval
// opaquely and re-sends exact action bytes from the retained ZIP at step time.
// A forged or stale value fails closed server-side (4xx, zero writes).
// ---------------------------------------------------------------------------

/** A renamable resource or Pages project of the release (server: resource-names.ts). */
export interface ReleaseResourceName {
  key: string;
  kind: string;
  name: string;
  bindings: Array<{ unitId: string; binding: string }>;
  changeOnUpgrade?: true;
}

export interface InventoryEnvelope {
  accountId: string;
  /** Existing names per kind (`r2`, `d1`, `kv`, `queue`, `vectorize`, `pages`). */
  names: Record<string, string[]>;
  /** The upgrade target Worker's bindings and the resource each uses today. */
  bindings?: Array<{ binding: string; kind: string; name: string }>;
  /** The upgrade target Worker's secret names (never values). */
  secrets?: string[];
}

export async function getInventory(csrf: string, accountId: string, kinds: string[], worker?: string): Promise<InventoryEnvelope> {
  return (await request("/api/cloudflare/inventory", csrf, { accountId, kinds, ...(worker ? { worker } : {}) })) as InventoryEnvelope;
}

export interface GraphPrepareEnvelope {
  releaseProof: unknown;
  releaseSummary: { archiveSha256: string; manifestDigest: string; entryCount: number; units?: Array<{ unitId: string; kind: string; name: string; hyperdrive?: string[] }>; resources?: ReleaseResourceName[] };
}

/**
 * Send the EXACT retained ZIP bytes, with the config this session was
 * authorized for, through the server trust boundary. The browser preview hash
 * (if any) is advisory; the returned releaseProof is the only release
 * authority the plan/step routes accept.
 */
export async function prepareReleaseZip(
  csrf: string,
  configText: string,
  zip: Blob,
  signal?: AbortSignal,
): Promise<GraphPrepareEnvelope> {
  const body = new FormData();
  body.append("config", configText);
  body.append("release", zip, "release.zip");
  let res: Response;
  try {
    // The browser sets the multipart Content-Type (with its boundary) itself.
    res = await fetch("/api/deploy/prepare", {
      method: "POST",
      headers: {
        Accept: "application/json",
        ...(csrf ? { "x-tapdeploy-csrf": csrf } : {}),
      },
      body,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    const err: ApiFailure = new Error(`network error: ${String(error)}`) as ApiFailure;
    err.status = 0;
    throw err;
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    throw failure(res.status, json);
  }
  return json as GraphPrepareEnvelope;
}

interface GraphPlanUnitDiff {
  resource: string;
  action: string;
  name?: string;
  detail?: string;
}

export interface GraphPlanUnit {
  unitId: string;
  kind: string;
  name: string;
  requiresBundle: boolean;
  diffs: GraphPlanUnitDiff[];
}

export interface GraphPlan {
  ok: boolean;
  blocked: boolean;
  digest: string;
  units: GraphPlanUnit[];
  guards: { code: string; level: string; detail: string }[];
  cost: { operations: { unitId: string; resource: string; action: string; name?: string }[]; requiresConfirmation: boolean; confirmed: boolean; blockedUnknownCost: boolean };
  /** Existing Workers TapDeploy did not deploy; upgrading them needs the takeover confirmation. */
  takeover: { workers: string[]; confirmed: boolean };
}

export interface GraphPlanEnvelope {
  authenticated: boolean;
  graphPlan: GraphPlan;
  references?: unknown;
  executionContext?: unknown;
  approval?: unknown;
  bundleDigests?: Record<string, string>;
  /** Non-secret dispatch-order advice (unit dependency edges); never authority. */
  schedulerHints?: unknown;
  paidRisk?: unknown;
  error?: string;
  detail?: string;
}

export interface GraphPlanRequest {
  accountId: string;
  releaseProof: unknown;
  config: { text: string };
  inputs?: Record<string, PrimitiveInputValue>;
  mode?: "install" | "upgrade";
  domains?: GraphDomainRequest;
  // Per unit: the account Hyperdrive configuration chosen for each binding.
  bindings?: Record<string, { hyperdrive: Record<string, string> }>;
  // Operator-chosen names, keyed like ReleaseResourceName.key.
  names?: Record<string, string>;
  // Secrets given a value they would not get by default (an optional one filled
  // in, a kept one replaced); names only, the values come with the deploy.
  suppliedSecrets?: string[];
  paidRiskConfirmed?: boolean;
  // Upgrade: take over Workers TapDeploy did not deploy (named by the previous plan).
  takeoverConfirmed?: boolean;
}

export async function fetchGraphPlan(
  csrf: string,
  req: GraphPlanRequest,
): Promise<GraphPlanEnvelope> {
  return (await request("/api/deploy/plan", csrf, req)) as GraphPlanEnvelope;
}

export interface GraphStepRequest {
  accountId: string;
  executionContext: unknown;
  approval: unknown;
  unitId: string;
  actionId: string;
  phase: string;
  step: string;
  bundleDigest?: string;
  args?: Record<string, unknown>;
}

export interface GraphStepEnvelope<T = unknown> extends StepEnvelope<T> {
  unitId?: string;
  actionId?: string;
  phaseReceipt?: unknown;
  status?: string;
}

export async function doGraphStep<T = unknown>(
  csrf: string,
  req: GraphStepRequest,
): Promise<GraphStepEnvelope<T>> {
  return (await request("/api/deploy/step", csrf, req)) as GraphStepEnvelope<T>;
}
