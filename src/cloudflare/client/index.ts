// Typed Cloudflare management adapter entry points.

export { createCloudflareClient } from "./client.js";
export type { CloudflareApiClient, CloudflareClientOptions, Fetcher } from "./client.js";
export type {
  CloudflareApiError,
  CloudflareErrorKind,
} from "./errors.js";
export { ROUTES } from "./routes.js";
export type { ApiRoute } from "./routes.js";
export {
  buildApiUrl,
  buildWorkerAssetsUploadUrl,
  buildPagesAssetsUploadUrl,
  buildPagesAssetsCheckMissingUrl,
  buildPagesAssetsUpsertHashesUrl,
  isAllowedCloudflareUrl,
} from "./url-guard.js";
export type * from "../models/index.js";