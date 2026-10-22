// Fetcher for the browser asset uploaders. Cloudflare's upload endpoints cannot
// be called cross-origin from a page (no CORS), so each call is relayed by the
// installer's own origin (POST /api/upload/assets, see
// src/api/routes/asset-upload.ts). The upload JWT moves from the Authorization
// header to a dedicated header; the OAuth token is never in the browser.

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
    return fetch(`/api/upload/assets?${query}`, {
      method: "POST",
      headers,
      body: init?.body,
      signal: init?.signal,
    });
  };
}
