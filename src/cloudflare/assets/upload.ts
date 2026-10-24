// Browser-executed asset bucket uploads to the official account-level
// endpoint with the short-lived upload JWT:
// POST /accounts/{accountId}/workers/assets/upload?base64=true
// multipart/form-data, each part name = 32-hex upload hash, part body =
// base64 file content with its serving Content-Type.
// The OAuth access token never reaches the browser; this uploader
// authenticates only with the session JWT. Each upload response may carry the
// completion JWT for create-version; when buckets are empty the session JWT
// itself is the completion token and no upload is needed.
//
// api.cloudflare.com sends no CORS headers, so in the browser this runs with
// `opts.fetcher` = the installer's same-origin forwarder (src/web/upload-proxy.ts,
// src/api/routes/asset-upload.ts), which relays only the JWT-scoped multipart
// (never the OAuth token). It never fabricates a bucketHost PUT.

import { base64String } from "../../core/encoding/base64-ascii.js";
import { buildWorkerAssetsUploadUrl } from "../client/index.js";
import { ASSET_UPLOAD_HASH_RE, guessAssetContentType } from "./manifest.js";

export type AssetUploadErrorKind =
  | "token-expired"
  | "forbidden"
  | "rate-limited"
  | "invalid-response"
  | "timeout"
  | "network"
  | "server";

export interface AssetUploadError {
  kind: AssetUploadErrorKind;
  detail: string;
  retryAfterSeconds?: number;
}

export interface AssetBucketFile {
  hash: string;
  bytes: Uint8Array;
  contentType?: string;
}

export interface UploadBucketOptions {
  jwt: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetcher?: typeof fetch;
}

export interface UploadBucketResult {
  completionJwt?: string;
}

function uploadError(kind: AssetUploadErrorKind, detail: string): AssetUploadError {
  return { kind, detail };
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 0) {
    return Math.ceil(value);
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) {
    return Math.max(1, Math.ceil((parsed - Date.now()) / 1000));
  }
  return undefined;
}

function mapStatusToError(status: number, retryAfter?: number): AssetUploadError {
  if (status === 401) {
    return uploadError("token-expired", "asset upload JWT expired or invalid");
  }
  if (status === 403) {
    return uploadError("forbidden", "asset upload forbidden for this JWT");
  }
  if (status === 429) {
    const err = uploadError("rate-limited", "asset upload rate limited");
    err.retryAfterSeconds = retryAfter;
    return err;
  }
  if (status >= 500) {
    return uploadError("server", `asset upload host reported ${status}`);
  }
  return uploadError("invalid-response", `asset upload rejected with ${status}`);
}

// Upload one server-provided bucket (one POST). Returns the completion JWT
// when the provider includes it; otherwise empty (caller keeps the last seen
// JWT, falling back to the session JWT when buckets are empty).
export async function uploadAssetBucket(
  accountId: string,
  hashes: string[],
  filesByHash: Map<string, AssetBucketFile>,
  opts: UploadBucketOptions,
): Promise<UploadBucketResult> {
  if (hashes.length === 0) {
    throw uploadError("invalid-response", "asset bucket is empty");
  }
  const seen = new Set<string>();
  for (const h of hashes) {
    if (!ASSET_UPLOAD_HASH_RE.test(h)) {
      throw uploadError("invalid-response", "asset bucket contains a non-32-hex hash");
    }
    if (seen.has(h)) {
      continue;
    }
    seen.add(h);
    if (!filesByHash.has(h)) {
      throw new Error("release asset bytes are missing for an uploaded hash");
    }
  }
  const unique = [...seen];
  const url = buildWorkerAssetsUploadUrl(accountId);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxAttempts = opts.maxAttempts ?? 2;
  const doFetch = opts.fetcher ?? fetch;
  let lastError: AssetUploadError = uploadError("network", "asset bucket upload failed");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const form = new FormData();
    for (const hash of unique) {
      const file = filesByHash.get(hash)!;
      const contentType = file.contentType ?? guessAssetContentType(hash);
      const b64 = base64String(file.bytes);
      form.append(hash, new Blob([b64], { type: contentType }), hash);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.jwt}` },
        body: form,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof Error && error.name === "AbortError") {
        lastError = uploadError("timeout", `asset bucket upload timed out after ${timeoutMs}ms`);
      } else {
        lastError = uploadError("network", `asset bucket upload failed: ${String(error)}`);
      }
      if (attempt < maxAttempts) {
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      let completionJwt: string | undefined;
      try {
        const body = (await response.json()) as { result?: { jwt?: unknown }; jwt?: unknown };
        const jwt = body?.result?.jwt ?? body?.jwt;
        if (typeof jwt === "string" && jwt.length > 0) {
          completionJwt = jwt;
        }
      } catch {
        completionJwt = undefined;
      }
      return completionJwt ? { completionJwt } : {};
    }
    const retryAfter = parseRetryAfter(response.headers);
    const mapped = mapStatusToError(response.status, retryAfter);
    if (mapped.kind === "token-expired" || mapped.kind === "forbidden" || mapped.kind === "invalid-response") {
      throw mapped;
    }
    lastError = mapped;
    if (attempt < maxAttempts) {
      continue;
    }
    throw lastError;
  }
  throw lastError;
}
