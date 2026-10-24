// Browser-side asset transfer for the sealed-graph flow. The release files live in
// the browser's compute Worker: it hashes them and hands over only the bytes of
// the hashes an approved step asked for. api.cloudflare.com sends no CORS headers,
// so the upload calls are relayed by the installer's own origin (upload-proxy.ts ->
// POST /api/upload/assets) to four fixed Cloudflare URLs, authenticated with the
// short-lived upload JWT minted by that approved step (never the OAuth token).
// The bytes are the sealed release bytes; the relay only forwards them.

import { splitBucketsForUpload } from "../cloudflare/assets/batching.js";
import { ASSET_UPLOAD_BATCH_RAW_BYTES } from "../core/upload-limits.js";
import { createUploadProxy } from "./upload-proxy.js";
import { uploadAssetBucket, type AssetBucketFile } from "../cloudflare/assets/upload.js";
import {
  checkPagesMissingHashes,
  planPagesBuckets,
  uploadPagesAssets,
  upsertPagesHashes,
} from "../cloudflare/pages/index.js";
import {
  v3ModuleBytes,
  v3UnitDirOf,
  resolveV3UnitRelative,
  type V3RetainedSource,
} from "./release.js";
import { parse as parseJsonc } from "jsonc-parser";

/** The slice of the graph deploy context the asset transfer needs. */
export interface GraphUploadContext {
  csrf: string;
  accountId: string;
  /** Exact retained ZIP both sources converged on; its files live in the compute Worker. */
  source: V3RetainedSource;
}

export async function v3PagesManifestFor(
  ctx: GraphUploadContext,
  wranglerPath: string | undefined,
): Promise<{ manifest: Record<string, string> }> {
  const dir = await v3PagesDir(ctx, wranglerPath);
  const { manifest } = await ctx.source.access.pagesManifest(dir);
  return { manifest };
}

/**
 * The unit Wrangler's resolved directory for its static files, addressed from
 * the retained Wrangler bytes. Addressing only; the deploy step verifies the
 * exact set and every upload hash.
 */
async function unitStaticDir(
  ctx: GraphUploadContext,
  wranglerPath: string,
  directoryOf: (parsed: { pages_build_output_dir?: unknown; assets?: { directory?: unknown } }) => unknown,
): Promise<string | null> {
  let rawDir: string | undefined;
  try {
    const parsed = parseJsonc(new TextDecoder().decode(await v3ModuleBytes(ctx.source, wranglerPath))) as {
      pages_build_output_dir?: unknown;
      assets?: { directory?: unknown };
    };
    const value = directoryOf(parsed);
    if (typeof value === "string" && value) rawDir = value;
  } catch {
    rawDir = undefined;
  }
  const prefix = v3UnitDirOf(wranglerPath);
  const baseDir = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return rawDir ? resolveV3UnitRelative(baseDir, rawDir) : null;
}

async function v3PagesDir(ctx: GraphUploadContext, wranglerPath: string | undefined): Promise<string> {
  if (!wranglerPath) throw new Error("Pages unit declares no Wrangler path; cannot address static assets");
  const dir = await unitStaticDir(ctx, wranglerPath, (parsed) => (typeof parsed.pages_build_output_dir === "string" && parsed.pages_build_output_dir ? parsed.pages_build_output_dir : parsed.assets?.directory));
  if (!dir) throw new Error(`Pages unit Wrangler "${wranglerPath}" declares no resolvable output directory; cannot address static assets`);
  return dir;
}

/**
 * upload the approved Worker static-asset buckets for one graph action.
 * Addressing only: the retained source files under the unit Wrangler's
 * declared assets directory are hashed (in the compute Worker, once per
 * content) with the official upload hash, and only the server-provided bucket
 * hashes are asked for and uploaded with the session JWT. A bucket hash absent
 * from the retained source (or a missing assets directory) fails closed before
 * any byte is sent. The provider attests completion separately via
 * complete-assets; no upload-leg token is trusted as completion here.
 */
export async function uploadV3WorkerAssets(
  ctx: GraphUploadContext,
  wranglerPath: string | undefined,
  sessionJwt: string,
  buckets: unknown,
): Promise<void> {
  if (!wranglerPath) throw new Error("Worker unit declares no Wrangler path; cannot address static assets");
  const dir = await unitStaticDir(ctx, wranglerPath, (parsed) => parsed.assets?.directory);
  if (!dir) throw new Error(`Worker unit Wrangler "${wranglerPath}" declares no resolvable assets directory; cannot address static assets`);
  const index = await ctx.source.access.workerAssetIndex(dir);
  if (!Array.isArray(buckets) || buckets.length === 0) return;
  const sizes = new Map(index.map((file) => [file.hash, file.size]));
  const fetcher = createUploadProxy(ctx.csrf);
  const sizeOf = (hash: string) => sizes.get(hash) ?? 0;
  for (const bucket of splitBucketsForUpload(buckets, undefined, { sizeOf, maxBytes: ASSET_UPLOAD_BATCH_RAW_BYTES })) {
    const files = new Map<string, AssetBucketFile>();
    for (const file of await ctx.source.access.workerAssetFiles(dir, bucket)) files.set(file.hash, file);
    await uploadAssetBucket(ctx.accountId, bucket, files, { jwt: sessionJwt, fetcher });
  }
}

export async function uploadV3PagesAssets(
  ctx: GraphUploadContext,
  wranglerPath: string | undefined,
  jwt: string,
): Promise<void> {
  const dir = await v3PagesDir(ctx, wranglerPath);
  const { manifest, sizes } = await ctx.source.access.pagesManifest(dir);
  const fetcher = createUploadProxy(ctx.csrf);
  const hashes = Object.values(manifest);
  const missing = await checkPagesMissingHashes(hashes, { jwt, fetcher });
  const wanted = [...new Set(missing)].filter((hash) => sizes[hash] !== undefined);
  if (wanted.length > 0) {
    // Pages serves each file with the content type stored at upload: without
    // one a browser downloads an HTML page instead of showing it.
    const buckets = planPagesBuckets(wanted.map((hash) => ({ hash, size: sizes[hash]! })), ASSET_UPLOAD_BATCH_RAW_BYTES);
    for (const bucket of buckets) {
      await uploadPagesAssets(await ctx.source.access.pagesFiles(dir, bucket.map((item) => item.hash)), { jwt, fetcher });
    }
  }
  await upsertPagesHashes(hashes, { jwt, fetcher });
}
