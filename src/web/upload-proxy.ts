// Fetcher for the browser asset uploaders. Cloudflare's upload endpoints cannot
// be called cross-origin from a page (no CORS), so each call is relayed by the
// installer's own origin (POST /api/upload/assets, see
// src/api/routes/asset-upload.ts). The upload JWT moves from the Authorization
// header to a dedicated header; the OAuth token is never in the browser.

import { ASSET_UPLOAD_MAX_BODY_BYTES } from "../core/upload-limits.js";

const PAGES_PATHS: Record<string, string> = {
  "/client/v4/pages/assets/check-missing": "pages-check-missing",
  "/client/v4/pages/assets/upload": "pages-upload",
  "/client/v4/pages/assets/upsert-hashes": "pages-upsert-hashes",
};
const WORKERS_PATH = /^\/client\/v4\/accounts\/([0-9a-f]{32})\/workers\/assets\/upload$/;

function describeTarget(input: string | URL): { target: string; account?: string } {
  const { hostname, pathname } = new URL(String(input));
  if (hostname === "api.cloudflare.com") {
    const pages = PAGES_PATHS[pathname];
    if (pages) return { target: pages };
    const workers = WORKERS_PATH.exec(pathname);
    if (workers) return { target: "workers-assets", account: workers[1]! };
  }
  throw new Error("this request is not an asset upload and cannot be forwarded");
}

// Bytes of a body whose size is knowable without reading it; a stream is not.
function knownBodyBytes(body: BodyInit | null | undefined): number | undefined {
  if (body == null) return 0;
  if (typeof body === "string") return new TextEncoder().encode(body).length;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof FormData) {
    let total = 0;
    for (const [name, value] of body.entries()) total += name.length + (typeof value === "string" ? value.length : value.size);
    return total;
  }
  return undefined;
}

export function createUploadProxy(csrf: string): typeof fetch {
  return async (input, init) => {
    const { target, account } = describeTarget(input as string | URL);
    const source = new Headers(init?.headers);
    const jwt = /^Bearer (.+)$/.exec(source.get("authorization") ?? "")?.[1];
    if (!jwt) throw new Error("asset upload requires its upload token");
    const headers = new Headers({ "x-tapdeploy-csrf": csrf, "x-tapdeploy-upload-jwt": jwt });
    const contentType = source.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    const query = new URLSearchParams({ target, ...(account ? { account } : {}) });
    // The relay refuses anything larger anyway; fail here instead of uploading it first.
    const size = knownBodyBytes(init?.body);
    if (size !== undefined && size > ASSET_UPLOAD_MAX_BODY_BYTES) {
      throw new Error(`asset upload batch is ${size} bytes; the installer relays at most ${ASSET_UPLOAD_MAX_BODY_BYTES}`);
    }
    return fetch(`/api/upload/assets?${query}`, {
      method: "POST",
      headers,
      body: init?.body,
      signal: init?.signal,
    });
  };
}
