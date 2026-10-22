// Server-authenticated Worker Static Assets session operations (official
// direct-upload protocol). The server registers the manifest with the OAuth
// access token and returns the JWT + buckets[][] grouping. The OAuth token
// never leaves the server; the browser uploads each bucket with the
// short-lived upload JWT via upload.ts to the account-level upload endpoint.

import {
  buildApiUrl,
  isAllowedCloudflareUrl,
  ROUTES,
  type Fetcher,
} from "../client/index.js";
import {
  makeCloudflareError,
  makeInvalidResponseError,
  makeNetworkError,
} from "../client/errors.js";
import type { AssetManifestEntry } from "../models/index.js";

export interface AssetSessionStartResult {
  jwt: string;
  buckets: string[][];
}

interface Envelope {
  success?: unknown;
  result?: { jwt?: string; buckets?: unknown };
}

export interface AssetSessionOptions {
  accessToken: string;
  accountId: string;
  scriptName: string;
  fetcher?: Fetcher;
}

function routeUrl(routeId: string, ctx: Record<string, string>): URL {
  const url = new URL(buildApiUrl(ROUTES[routeId]!.path(ctx)));
  if (!isAllowedCloudflareUrl(url)) {
    throw new Error("asset session route outside Cloudflare allowlist");
  }
  return url;
}

async function sessionRequest(
  url: URL,
  init: RequestInit,
  fetcher: Fetcher,
): Promise<Envelope> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch (error) {
    throw makeNetworkError(error);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    throw makeCloudflareError(response, body);
  }
  if (typeof body !== "object" || body === null || (body as Envelope).success !== true) {
    throw makeInvalidResponseError("asset session response success=false");
  }
  return body as Envelope;
}

// start-session registers the full asset manifest (rooted paths, 32-hex
// upload hashes) and returns the upload JWT plus buckets[][] grouping.
// Empty buckets means all assets are already stored: the session jwt is then
// the completion token for create-version and no bucket upload is needed.
export async function startAssetUploadSession(
  opts: AssetSessionOptions,
  manifest: Record<string, AssetManifestEntry>,
): Promise<AssetSessionStartResult> {
  const fetcher = opts.fetcher ?? ((input: string | URL, init?: RequestInit) => fetch(input, init));
  const url = routeUrl("startAssetUploadSession", {
    accountId: opts.accountId,
    scriptName: opts.scriptName,
  });
  const env = await sessionRequest(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ manifest }),
    },
    fetcher,
  );
  if (typeof env.result?.jwt !== "string" || env.result.jwt.length === 0) {
    throw makeInvalidResponseError("asset session result missing jwt");
  }
  if (!Array.isArray(env.result?.buckets)) {
    throw makeInvalidResponseError("asset session result.buckets is not an array");
  }
  const buckets: string[][] = [];
  for (let i = 0; i < (env.result.buckets as unknown[]).length; i++) {
    const bucket = (env.result.buckets as unknown[])[i];
    if (!Array.isArray(bucket)) {
      throw makeInvalidResponseError(`asset session buckets[${i}] is not an array`);
    }
    for (const h of bucket) {
      if (typeof h !== "string" || h.length === 0) {
        throw makeInvalidResponseError(`asset session buckets[${i}] contains a non-string hash`);
      }
    }
    buckets.push([...(bucket as string[])]);
  }
  return { jwt: env.result.jwt, buckets };
}
