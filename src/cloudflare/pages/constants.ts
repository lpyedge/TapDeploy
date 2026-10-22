// Cloudflare Pages direct-upload protocol.
//
// Pages deploys STATIC ASSETS (and an optional prebuilt `_worker.js` /
// Functions bundle) through a distinct path from the Workers version API. The
// Installer never reuses the Workers `scripts` / `versions` / `deployments`
// routes for Pages. The wire protocol is:
//
//   1. POST /accounts/{id}/pages/projects/{project}/upload-token  -> { jwt }
//      (the short-lived upload JWT; never the OAuth token).
//   2. POST /pages/assets/check-missing  with the JWT  -> string[] of 32-hex
//      hashes already stored (only missing ones need uploading).
//   3. POST /pages/assets/upload  with the JWT; a JSON array of
//      { key, value (base64), metadata:{contentType}, base64:true } parts,
//      grouped into buckets under MAX_BUCKET_SIZE / MAX_BUCKET_FILE_COUNT.
//   4. POST /accounts/{id}/pages/projects/{project}/deployments as
//      multipart/form-data with a `manifest` part = a JSON object mapping
//      URL-rooted paths ("/...") to 32-hex upload hashes, plus optional
//      `_worker.bundle` / `_routes.json` parts for a prebuilt `_worker.js`.
//
// The 32-hex Pages upload hash is the BLAKE3 of (base64(contents) + extension)
// truncated to 32 hex chars — deliberately DIFFERENT from the Workers asset
// upload hash (SHA-256 based). It is computed here from the file bytes so the
// browser can build the manifest without shipping the bytes through the
// installer server.

export const PAGES_UPLOAD_HASH_RE = /^[0-9a-f]{32}$/;

// Official Pages limits (wrangler constants). A single upload bucket holds at
// most 40 MiB / 2000 files; a deployment at most 20000 files. (The 25 MiB
// per-asset limit is never reached: the release ZIP caps a file at 8 MiB.)
export const PAGES_MAX_BUCKET_SIZE = 40 * 1024 * 1024;
export const PAGES_MAX_BUCKET_FILE_COUNT = 2000;
export const PAGES_MAX_ASSET_COUNT = 20000;

// Special files that are NOT static assets in a Pages deployment. They are
// excluded from the asset manifest / upload and, when the author ships a
// prebuilt `_worker.js`, handled as the `_worker.bundle` part of the deployment.
export const PAGES_SPECIAL_FILES = new Set([
  "_worker.js",
  "_redirects",
  "_headers",
  "_routes.json",
  "functions",
]);
