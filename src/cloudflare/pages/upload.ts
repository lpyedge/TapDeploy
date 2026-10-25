// Browser-executed Pages asset uploads.
//
// Pages Direct Upload uses a short-lived upload JWT (provided by the server via
// the project's upload-token endpoint) to:
//   - POST /pages/assets/check-missing  -> string[] of already-stored hashes
//   - POST /pages/assets/upload  with a JSON array of
//     { key, value (base64), metadata:{contentType}, base64:true }
//   - POST /pages/assets/upsert-hashes  -> register the hashes for future deploys
//
// The OAuth access token never reaches the browser; these requests authenticate
// only with the upload JWT. api.cloudflare.com has no CORS, so in the browser
// `opts.fetcher` is the installer's same-origin forwarder (src/web/upload-proxy.ts
// -> src/api/routes/asset-upload.ts), which relays each bounded request to the
// fixed asset endpoint without storing or logging the bytes.

import {
  buildPagesAssetsCheckMissingUrl,
  buildPagesAssetsUploadUrl,
  buildPagesAssetsUpsertHashesUrl,
} from "../client/index.js";
import { PAGES_UPLOAD_HASH_RE } from "./constants.js";
import { base64String } from "../../core/encoding/base64-ascii.js";
import { parseRetryAfter, waitBeforeRetry } from "../upload-retry.js";

type PagesUploadErrorKind =
  | "token-expired"
  | "forbidden"
  | "rate-limited"
  | "invalid-response"
  | "timeout"
  | "network"
  | "server";

interface PagesUploadError {
  kind: PagesUploadErrorKind;
  detail: string;
  retryAfterSeconds?: number;
}

export interface PagesUploadFile {
  hash: string;
  bytes: Uint8Array;
  contentType?: string;
}

export interface PagesUploadOptions {
  jwt: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetcher?: typeof fetch;
}

function uploadError(kind: PagesUploadErrorKind, detail: string): PagesUploadError {
  return { kind, detail };
}

function mapStatusToError(status: number, retryAfter?: number): PagesUploadError {
  if (status === 401) {
    return uploadError("token-expired", "Pages upload JWT expired or invalid");
  }
  if (status === 403) {
    return uploadError("forbidden", "Pages upload forbidden for this JWT");
  }
  if (status === 429) {
    const err = uploadError("rate-limited", "Pages upload rate limited");
    err.retryAfterSeconds = retryAfter;
    return err;
  }
  if (status >= 500) {
    return uploadError("server", `Pages upload host reported ${status}`);
  }
  return uploadError("invalid-response", `Pages upload rejected with ${status}`);
}

async function readJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

// Ask the provider which hashes are already stored for this project. Called
// before uploading so we only transfer the missing assets.
export async function checkPagesMissingHashes(
  hashes: string[],
  opts: PagesUploadOptions,
): Promise<string[]> {
  for (const h of hashes) {
    if (!PAGES_UPLOAD_HASH_RE.test(h)) {
      throw uploadError("invalid-response", `Pages hash must be 32-hex, got "${h.slice(0, 16)}…"`);
    }
  }
  const doFetch = opts.fetcher ?? fetch;
  const url = buildPagesAssetsCheckMissingUrl();
  const res = await doFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.jwt}`,
    },
    body: JSON.stringify({ hashes }),
  });
  if (!res.ok) {
    throw mapStatusToError(res.status);
  }
  const body = (await readJsonSafe(res)) as { result?: unknown };
  const result = body?.result;
  if (!Array.isArray(result)) {
    throw uploadError("invalid-response", "Pages check-missing result is not an array");
  }
  return result.filter((r): r is string => typeof r === "string");
}

// Upload a batch of Pages asset parts (one POST). Each part is a JSON object
// { key, value (base64), metadata:{contentType}, base64:true }.
export async function uploadPagesAssets(
  files: PagesUploadFile[],
  opts: PagesUploadOptions,
): Promise<void> {
  if (files.length === 0) {
    throw uploadError("invalid-response", "Pages upload batch is empty");
  }
  const payload = files.map((file) => {
    if (!PAGES_UPLOAD_HASH_RE.test(file.hash)) {
      throw uploadError(
        "invalid-response",
        `Pages hash must be 32-hex, got "${file.hash.slice(0, 16)}…"`,
      );
    }
    return {
      key: file.hash,
      value: base64String(file.bytes),
      metadata: { contentType: file.contentType ?? "application/octet-stream" },
      base64: true,
    };
  });
  const doFetch = opts.fetcher ?? fetch;
  const url = buildPagesAssetsUploadUrl();
  const maxAttempts = opts.maxAttempts ?? 2;
  // Uploads are keyed by content hash, so repeating a batch is safe.
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.jwt}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      if (attempt < maxAttempts) {
        await waitBeforeRetry(attempt);
        continue;
      }
      throw uploadError("network", `Pages upload failed: ${String(error)}`);
    }
    if (!res.ok) {
      const mapped = mapStatusToError(res.status, parseRetryAfter(res.headers));
      if ((mapped.kind === "rate-limited" || mapped.kind === "server") && attempt < maxAttempts) {
        await waitBeforeRetry(attempt, mapped.retryAfterSeconds);
        continue;
      }
      throw mapped;
    }
    const body = (await readJsonSafe(res)) as { success?: unknown };
    if (body?.success !== true) {
      throw uploadError("invalid-response", "Pages upload response success=false");
    }
    return;
  }
}

// Register the uploaded hashes so future deploys know they are stored.
export async function upsertPagesHashes(
  hashes: string[],
  opts: PagesUploadOptions,
): Promise<void> {
  if (hashes.length === 0) {
    return;
  }
  const doFetch = opts.fetcher ?? fetch;
  const url = buildPagesAssetsUpsertHashesUrl();
  const res = await doFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.jwt}`,
    },
    body: JSON.stringify({ hashes }),
  });
  if (!res.ok) {
    // upsert-hashes failure is non-fatal (wrangler treats it as a warning);
    // the deployment still succeeds, just slower on the next deploy.
    return;
  }
}
