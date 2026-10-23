// Browser-side asset transfer for the sealed-graph flow. Worker assets and Pages
// assets go straight to Cloudflare with the short-lived upload JWT minted by an
// approved step; the bytes are the sealed release bytes and never transit the
// installer server.

import { splitBucketsForUpload } from "../cloudflare/assets/batching.js";
import { ASSET_UPLOAD_BATCH_RAW_BYTES } from "../core/upload-limits.js";
import { createUploadProxy } from "./upload-proxy.js";
import { assetUploadHash, guessAssetContentType } from "../cloudflare/assets/manifest.js";
import { uploadAssetBucket, type AssetBucketFile } from "../cloudflare/assets/upload.js";
import {
  buildPagesManifest,
  checkPagesMissingHashes,
  planPagesBuckets,
  toPagesAssetPath,
  uploadPagesAssets,
  upsertPagesHashes,
  type PagesAssetRef,
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
  /** Exact retained ZIP bytes both sources converged on. */
  source: V3RetainedSource;
}

export async function v3PagesManifestFor(
  ctx: GraphUploadContext,
  wranglerPath: string | undefined,
): Promise<{ manifest: Record<string, string> }> {
  const { refs, dir } = v3PagesRefs(ctx, wranglerPath);
  const manifest = await buildPagesManifest(refs, dir);
  return { manifest };
}

/**
 * The Pages output set is exactly the retained files under the unit Wrangler's
 * resolved output directory — mirroring the server projection. Addressing
 * only; the deploy step verifies the exact set and every upload hash.
 */
function v3PagesRefs(
  ctx: GraphUploadContext,
  wranglerPath: string | undefined,
): { refs: PagesAssetRef[]; dir: string } {
  if (!wranglerPath) throw new Error("Pages unit declares no Wrangler path; cannot address static assets");
  let rawDir: string | undefined;
  try {
    const parsed = parseJsonc(new TextDecoder().decode(v3ModuleBytes(ctx.source, wranglerPath))) as {
      pages_build_output_dir?: unknown;
      assets?: { directory?: unknown };
    };
    if (typeof parsed.pages_build_output_dir === "string" && parsed.pages_build_output_dir) rawDir = parsed.pages_build_output_dir;
    else if (parsed.assets && typeof parsed.assets.directory === "string" && parsed.assets.directory) rawDir = parsed.assets.directory;
  } catch {
    rawDir = undefined;
  }
  const prefix = v3UnitDirOf(wranglerPath);
  const baseDir = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const dir = rawDir ? resolveV3UnitRelative(baseDir, rawDir) : null;
  if (!dir) throw new Error(`Pages unit Wrangler "${wranglerPath}" declares no resolvable output directory; cannot address static assets`);
  const refs: PagesAssetRef[] = ctx.source.files
    .filter((entry) => entry.path.startsWith(`${dir}/`))
    .map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256, bytes: entry.bytes }));
  return { refs, dir };
}

/**
 * upload the approved Worker static-asset buckets for one graph action.
 * Addressing only: the retained source files under the unit Wrangler's
 * declared assets directory are re-hashed with the official upload hash, and
 * only the server-provided bucket hashes are uploaded with the session JWT.
 * A bucket hash absent from the retained source (or a missing assets
 * directory) fails closed before any byte is sent. The provider attests
 * completion separately via complete-assets; no upload-leg token is trusted
 * as completion here.
 */
export async function uploadV3WorkerAssets(
  ctx: GraphUploadContext,
  wranglerPath: string | undefined,
  sessionJwt: string,
  buckets: unknown,
): Promise<void> {
  if (!wranglerPath) throw new Error("Worker unit declares no Wrangler path; cannot address static assets");
  let rawDir: string | undefined;
  try {
    const parsed = parseJsonc(new TextDecoder().decode(v3ModuleBytes(ctx.source, wranglerPath))) as {
      assets?: { directory?: unknown };
    };
    if (parsed.assets && typeof parsed.assets.directory === "string" && parsed.assets.directory) rawDir = parsed.assets.directory;
  } catch {
    rawDir = undefined;
  }
  const prefix = v3UnitDirOf(wranglerPath);
  const baseDir = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const dir = rawDir ? resolveV3UnitRelative(baseDir, rawDir) : null;
  if (!dir) throw new Error(`Worker unit Wrangler "${wranglerPath}" declares no resolvable assets directory; cannot address static assets`);
  const byHash = new Map<string, AssetBucketFile>();
  for (const entry of ctx.source.files) {
    if (!entry.path.startsWith(`${dir}/`)) continue;
    const rooted = `/${entry.path.slice(dir.length + 1)}`;
    const hash = await assetUploadHash(rooted, entry.bytes);
    byHash.set(hash, { hash, bytes: entry.bytes, contentType: guessAssetContentType(rooted) });
  }
  if (!Array.isArray(buckets) || buckets.length === 0) return;
  const fetcher = createUploadProxy(ctx.csrf);
  const sizeOf = (hash: string) => byHash.get(hash)?.bytes.length ?? 0;
  for (const bucket of splitBucketsForUpload(buckets, undefined, { sizeOf, maxBytes: ASSET_UPLOAD_BATCH_RAW_BYTES })) {
    const files = new Map<string, AssetBucketFile>();
    for (const hash of bucket) {
      const file = byHash.get(hash);
      if (!file) throw new Error(`approved asset bucket references hash "${hash}" absent from the retained source; refusing partial upload`);
      files.set(hash, file);
    }
    await uploadAssetBucket(ctx.accountId, bucket, files, { jwt: sessionJwt, fetcher });
  }
}

export async function uploadV3PagesAssets(
  ctx: GraphUploadContext,
  wranglerPath: string | undefined,
  jwt: string,
): Promise<void> {
  const { refs, dir } = v3PagesRefs(ctx, wranglerPath);
  const manifest = await buildPagesManifest(refs, dir);
  // Pages serves each file with the content type stored at upload: without
  // one a browser downloads an HTML page instead of showing it.
  const byHash = new Map<string, { hash: string; bytes: Uint8Array; contentType: string }>();
  for (const ref of refs) {
    const rooted = toPagesAssetPath(ref.path, dir);
    const hash = manifest[rooted];
    if (hash) byHash.set(hash, { hash, bytes: ref.bytes, contentType: guessAssetContentType(rooted) });
  }
  const fetcher = createUploadProxy(ctx.csrf);
  const missing = await checkPagesMissingHashes(Object.values(manifest), { jwt, fetcher });
  const toUpload = missing.map((hash) => byHash.get(hash)).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  if (toUpload.length > 0) {
    const buckets = planPagesBuckets(toUpload.map((entry) => ({ hash: entry.hash, size: entry.bytes.length })), ASSET_UPLOAD_BATCH_RAW_BYTES);
    for (const bucket of buckets) {
      const files = bucket.map((item) => {
        const { hash, bytes, contentType } = byHash.get(item.hash)!;
        return { hash, bytes, contentType };
      });
      await uploadPagesAssets(files, { jwt, fetcher });
    }
  }
  await upsertPagesHashes(Object.values(manifest), { jwt, fetcher });
}
