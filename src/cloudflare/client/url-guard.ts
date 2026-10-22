// URL allowlisting for the Cloudflare management adapter. Only the fixed v4
// management base may ever be contacted; everything else (arbitrary hosts,
// plain http, unexpected path prefixes) is rejected before any fetch is made.
// This is the interception seam.

const API_V4_BASE = "https://api.cloudflare.com/client/v4";

// Static Assets direct-upload uses the account-level upload endpoint with a
// JWT bearer (not the OAuth token) and `?base64=true`:
// POST /accounts/{accountId}/workers/assets/upload?base64=true
// The older `*.upload-api.cloudflare.com` bucketHost PUT transport was a
// fabricated shape and has been removed. Any bucketHost value is rejected.

export function buildWorkerAssetsUploadUrl(accountId: string): string {
  assertAccountId(accountId);
  return buildApiUrl(`/accounts/${encodeURIComponent(accountId)}/workers/assets/upload?base64=true`);
}

// Pages Direct Upload asset endpoints are under the account-scoped
// `?`-less base but NOT under `/accounts/` — they are `POST /pages/assets/upload`
// and `POST /pages/assets/check-missing`. They authenticate with the short-lived
// upload JWT (never the OAuth token) via `Authorization: Bearer <jwt>`.
// `buildApiUrl` already enforces the fixed v4 base allowlist, so only these
// exact fixed paths are reachable.

export function buildPagesAssetsUploadUrl(): string {
  return buildApiUrl("/pages/assets/upload");
}

export function buildPagesAssetsCheckMissingUrl(): string {
  return buildApiUrl("/pages/assets/check-missing");
}

export function buildPagesAssetsUpsertHashesUrl(): string {
  return buildApiUrl("/pages/assets/upsert-hashes");
}

const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/;
const SCRIPT_NAME_RE = /^[a-zA-Z0-9_.-]{1,128}$/;
// Zone ids and DNS record / route / domain ids are all 32-hex Cloudflare
// identifiers (the provider reports them as `maxLength 32` identifiers).
const ZONE_ID_RE = /^[a-f0-9]{1,32}$/;
const RESOURCE_ID_RE = /^[a-f0-9]{1,32}$/;

export function isAllowedCloudflareUrl(raw: string | URL): boolean {
  const url = typeof raw === "string" ? safeParse(raw) : raw;
  const base = new URL(API_V4_BASE);
  if (!url || url.protocol !== "https:" || url.origin !== base.origin) {
    return false;
  }
  return (
    url.pathname === base.pathname ||
    url.pathname.startsWith(`${base.pathname}/`)
  );
}

export function buildApiUrl(pathTail: string): string {
  if (!pathTail.startsWith("/")) {
    pathTail = `/${pathTail}`;
  }
  const url = new URL(`${API_V4_BASE}${pathTail}`);
  if (!isAllowedCloudflareUrl(url)) {
    throw new Error("Cloudflare URL outside allowlist");
  }
  return url.toString();
}

export function assertAccountId(value: string): void {
  if (!ACCOUNT_ID_RE.test(value)) {
    throw new Error("Invalid Cloudflare account id");
  }
}

export function assertScriptName(value: string): void {
  if (!SCRIPT_NAME_RE.test(value)) {
    throw new Error("Invalid Cloudflare worker script name");
  }
}

// a Workflow is addressed by its account-unique name in the URL path.
// Allow the same identifier shape as scripts, but require at least one
// alphanumeric character so a bare "." / ".." can never reach URL resolution.
const WORKFLOW_NAME_RE = /^(?=.*[a-zA-Z0-9])[a-zA-Z0-9_.-]{1,128}$/;

export function assertWorkflowName(value: string): void {
  if (!WORKFLOW_NAME_RE.test(value)) {
    throw new Error("Invalid Cloudflare workflow name");
  }
}

export function assertZoneId(value: string): void {
  if (!ZONE_ID_RE.test(value)) {
    throw new Error("Invalid Cloudflare zone id");
  }
}

export function assertResourceId(value: string): void {
  if (!RESOURCE_ID_RE.test(value)) {
    throw new Error("Invalid Cloudflare resource id");
  }
}

function safeParse(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}