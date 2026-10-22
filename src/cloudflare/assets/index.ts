// Static Assets upload machinery: server-authenticated session ops (official
// assets-upload-session returning JWT + buckets[][]), browser-side JWT-scoped
// bucket uploads to the account endpoint, upload manifest helpers, and bucket
// batching.

export {
  startAssetUploadSession,
  type AssetSessionOptions,
  type AssetSessionStartResult,
} from "./session.js";
export {
  uploadAssetBucket,
  type AssetBucketFile,
  type AssetUploadError,
  type AssetUploadErrorKind,
  type UploadBucketOptions,
  type UploadBucketResult,
} from "./upload.js";
export {
  planUploadBatches,
  splitBucketsForUpload,
  DEFAULT_MAX_PARTS_PER_BATCH,
} from "./batching.js";
export {
  assetUploadHash,
  buildAssetUploadManifest,
  toRootedAssetPath,
  type ReleaseAssetRef,
} from "./manifest.js";
