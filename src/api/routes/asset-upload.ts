// Same-origin forwarder for the JWT-scoped static-asset upload calls.
//
// api.cloudflare.com sends no CORS headers, so a browser cannot call these
// endpoints itself ("TypeError: Failed to fetch"). The browser instead POSTs the
// exact upload request here; this route relays it to one of four FIXED
// Cloudflare URLs with the short-lived upload JWT as the only credential. The
// OAuth access token is never involved, the destination cannot be chosen by the
// caller, the request and response bodies are bounded, and nothing is logged.

import type { Context, Hono } from "hono";
import type { AppEnv, TapDeployEnv } from "../app.js";
import { readBoundedResponse } from "../../core/bounded-response.js";
import { ASSET_UPLOAD_MAX_BODY_BYTES } from "../../core/upload-limits.js";
import { readBoundedBody } from "../read-bounded-body.js";
import {
  buildPagesAssetsCheckMissingUrl,
  buildPagesAssetsUploadUrl,
  buildPagesAssetsUpsertHashesUrl,
  buildWorkerAssetsUploadUrl,
} from "../../cloudflare/client/index.js";
import { authenticate } from "../session-guard.js";

const UPSTREAM_TIMEOUT_MS = 60_000;
const BODY_READ_DEADLINE_MS = 60_000;
const UPSTREAM_RESPONSE_MAX_BYTES = 1024 * 1024;
// Token characters only (no whitespace or control characters can reach a header).
const JWT_RE = /^[A-Za-z0-9._~+/=-]{16,8192}$/;

const TARGETS = {
  "workers-assets": { contentType: "multipart/form-data", url: (account: string | undefined) => buildWorkerAssetsUploadUrl(account ?? "") },
  "pages-check-missing": { contentType: "application/json", url: () => buildPagesAssetsCheckMissingUrl() },
  "pages-upload": { contentType: "application/json", url: () => buildPagesAssetsUploadUrl() },
  "pages-upsert-hashes": { contentType: "application/json", url: () => buildPagesAssetsUpsertHashesUrl() },
} as const;

type UploadTarget = keyof typeof TARGETS;

function isTarget(value: string | undefined): value is UploadTarget {
  return value !== undefined && Object.hasOwn(TARGETS, value);
}

export function attachAssetUploadRoutes(app: Hono<AppEnv>, env: TapDeployEnv): void {
  app.post("/api/upload/assets", (c) => forwardUpload(c, env));
}

async function forwardUpload(c: Context<AppEnv>, env: TapDeployEnv): Promise<Response> {
  const auth = await authenticate(c, env);
  if ("denied" in auth) return auth.denied;

  const target = c.req.query("target");
  if (!isTarget(target)) return c.json({ error: "unknown_target" }, 400);
  const spec = TARGETS[target];

  const jwt = c.req.header("x-tapdeploy-upload-jwt") ?? "";
  if (!JWT_RE.test(jwt)) return c.json({ error: "invalid_upload_token" }, 400);

  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith(spec.contentType)) {
    return c.json({ error: "unsupported_content_type", expected: spec.contentType }, 415);
  }

  let url: string;
  try {
    url = spec.url(c.req.query("account"));
  } catch {
    return c.json({ error: "invalid_account" }, 400);
  }

  // Provider acceptance does not attest Worker asset bytes. This mode stays
  // closed until uploads can be bound to a server-verified manifest.
  if (target === "workers-assets") return c.json({ error: "WORKER_ASSETS_UNSUPPORTED", detail: "Worker static assets are disabled: uploaded byte integrity is not verified. Use a static Pages site or a Worker without static assets." }, 409);

  // Only now, with the session, CSRF, target, token, type and account all
  // accepted, does the relay start consuming the body.
  const tooLarge = () => c.json({ error: "payload_too_large", detail: `request exceeds the ${ASSET_UPLOAD_MAX_BODY_BYTES}-byte API limit; ZIP and static asset bytes must remain in the browser` }, 413);
  if (Number(c.req.header("content-length")) > ASSET_UPLOAD_MAX_BODY_BYTES) {
    await c.req.raw.body?.cancel().catch(() => {});
    return tooLarge();
  }
  const read = await readBoundedBody(c.req.raw.body, ASSET_UPLOAD_MAX_BODY_BYTES, BODY_READ_DEADLINE_MS);
  if (!read.ok) {
    if (read.reason === "too_large") return tooLarge();
    return read.reason === "timeout"
      ? c.json({ error: "request_timeout", detail: "the upload did not arrive in time" }, 408)
      : c.json({ error: "invalid_body", detail: "request body could not be read" }, 400);
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": contentType },
      body: read.bytes as BodyInit,
      // The browser cancelling its upload also cancels the upstream request.
      signal: AbortSignal.any([AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), c.req.raw.signal]),
    });
  } catch {
    return c.json({ error: "upstream_unreachable" }, 502);
  }

  let body: Uint8Array;
  try {
    body = await readBoundedResponse(upstream, UPSTREAM_RESPONSE_MAX_BYTES);
  } catch {
    return c.json({ error: "upstream_response_too_large" }, 502);
  }
  const headers = new Headers({ "Content-Type": upstream.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" });
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter) headers.set("Retry-After", retryAfter);
  return new Response(body.slice().buffer as ArrayBuffer, { status: upstream.status, headers });
}
