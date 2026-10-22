// Limits for the static-asset upload forwarder (POST /api/upload/assets).
//
// api.cloudflare.com sends no CORS headers, so the browser cannot call the
// JWT-scoped asset endpoints itself; the installer forwards them. Each forwarded
// request is bounded so it fits an API isolate: the raw bytes of one request are
// capped, which also caps the largest single asset the installer can upload.

// A release ZIP, uploaded or downloaded (a download passes through the installer
// as a stream and is cut off at this size).
export const RELEASE_MAX_BYTES = 64 * 1024 * 1024;

// What the API accepts for one forwarded request (base64 payload + framing).
export const ASSET_UPLOAD_MAX_BODY_BYTES = 16 * 1024 * 1024;

// Raw file bytes per forwarded request. Base64 grows this by 4/3 (12 MiB), which
// leaves headroom under the body limit for multipart/JSON framing.
export const ASSET_UPLOAD_BATCH_RAW_BYTES = 9 * 1024 * 1024;
