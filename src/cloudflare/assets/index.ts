// Static Assets upload machinery: server-authenticated session ops (official
// assets-upload-session returning JWT + buckets[][]), browser-side JWT-scoped
// bucket uploads to the account endpoint, upload manifest helpers, and bucket
// batching.

export {
  startAssetUploadSession,
  type AssetSessionStartResult,
} from "./session.js";
export { buildAssetUploadManifest } from "./manifest.js";
