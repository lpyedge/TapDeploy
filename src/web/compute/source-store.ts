// The retained release as the rest of the page sees it: a narrow async accessor
// that answers only the addressing questions an approved graph action asks, not
// a generic file reader. The Worker holds one store per source; tests and the
// Node bridge use the same implementation in memory.

import type { AssetBucketFile } from "../../cloudflare/assets/upload.js";
import { assetUploadHash, guessAssetContentType, toRootedAssetPath } from "../../cloudflare/assets/manifest.js";
import { buildPagesManifest, toPagesAssetPath, type PagesAssetRef } from "../../cloudflare/pages/index.js";
import type { ExtractedFile } from "../../release/zip.js";
import { UploadHashCache, uploadHashExtension } from "./hash-cache.js";

export interface SourceFileInfo {
  path: string;
  size: number;
  sha256: string;
}

export interface SourceHashedFile {
  hash: string;
  size: number;
}

export interface SourceAccessor {
  /** Names, sizes and content digests; never bytes. */
  listFiles(): Promise<SourceFileInfo[]>;
  /** The exact retained bytes of one file (a fresh copy). */
  readFile(path: string): Promise<Uint8Array>;
  /** Worker static assets under `dir`: official upload hash and size per file. */
  workerAssetIndex(dir: string): Promise<SourceHashedFile[]>;
  /** Bytes for exactly the approved upload hashes; an unknown hash fails closed. */
  workerAssetFiles(dir: string, hashes: string[]): Promise<AssetBucketFile[]>;
  /** The Pages deployment manifest (rooted path -> upload hash) and each file's size. */
  pagesManifest(dir: string): Promise<{ manifest: Record<string, string>; sizes: Record<string, number> }>;
  /** Bytes for exactly the requested Pages upload hashes; an unknown hash fails closed. */
  pagesFiles(dir: string, hashes: string[]): Promise<Array<{ hash: string; bytes: Uint8Array; contentType: string }>>;
  /** Release the source (terminates the Worker that holds it). */
  dispose(): void;
}

export type PagesHashFn = (path: string, bytes: Uint8Array) => string;

// `loadPagesHash` is awaited only when a Pages unit is addressed, so a Worker-only
// release never loads the BLAKE3 engine.
export function createSourceStore(files: ExtractedFile[], loadPagesHash: () => Promise<PagesHashFn>): SourceAccessor {
  const cache = new UploadHashCache();
  const byPath = new Map(files.map((entry) => [entry.path, entry]));

  const filesUnder = (dir: string) => files.filter((entry) => entry.path.startsWith(`${dir}/`));

  const workerAssets = async (dir: string) => {
    const byHash = new Map<string, AssetBucketFile>();
    for (const entry of filesUnder(dir)) {
      // The path rules run before any cache lookup, so a cached hash can never stand in for a path check.
      const rooted = toRootedAssetPath(`/${entry.path.slice(dir.length + 1)}`);
      const extension = uploadHashExtension("workers", rooted);
      let hash = cache.get("workers", entry.sha256, extension);
      if (hash === undefined) {
        hash = await assetUploadHash(rooted, entry.bytes);
        cache.set("workers", entry.sha256, extension, hash);
      }
      byHash.set(hash, { hash, bytes: entry.bytes, contentType: guessAssetContentType(rooted) });
    }
    return byHash;
  };

  const pagesAssets = async (dir: string) => {
    const pagesHash = await loadPagesHash();
    const refs: PagesAssetRef[] = filesUnder(dir).map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256, bytes: entry.bytes }));
    const shaByPath = new Map(refs.map((ref) => [ref.path, ref.sha256]));
    const manifest = buildPagesManifest(refs, dir, (path, bytes) => {
      const sha256 = shaByPath.get(path)!;
      const extension = uploadHashExtension("pages", path);
      let hash = cache.get("pages", sha256, extension);
      if (hash === undefined) {
        hash = pagesHash(path, bytes);
        cache.set("pages", sha256, extension, hash);
      }
      return hash;
    });
    return { refs, manifest };
  };

  return {
    async listFiles() {
      return files.map((entry) => ({ path: entry.path, size: entry.size, sha256: entry.sha256 }));
    },
    async readFile(path) {
      const file = byPath.get(path);
      if (!file) throw new Error(`approved source does not contain "${path}"`);
      return file.bytes.slice();
    },
    async workerAssetIndex(dir) {
      return [...(await workerAssets(dir)).values()].map((file) => ({ hash: file.hash, size: file.bytes.length }));
    },
    async workerAssetFiles(dir, hashes) {
      const byHash = await workerAssets(dir);
      return hashes.map((hash) => {
        const file = byHash.get(hash);
        if (!file) throw new Error(`approved asset bucket references hash "${hash}" absent from the retained source; refusing partial upload`);
        return { hash, bytes: file.bytes.slice(), ...(file.contentType !== undefined ? { contentType: file.contentType } : {}) };
      });
    },
    async pagesManifest(dir) {
      const { refs, manifest } = await pagesAssets(dir);
      const sizes: Record<string, number> = {};
      for (const ref of refs) {
        const hash = manifest[toPagesAssetPath(ref.path, dir)];
        if (hash) sizes[hash] = ref.bytes.length;
      }
      return { manifest, sizes };
    },
    async pagesFiles(dir, hashes) {
      const { refs, manifest } = await pagesAssets(dir);
      const byHash = new Map<string, { bytes: Uint8Array; contentType: string }>();
      for (const ref of refs) {
        const rooted = toPagesAssetPath(ref.path, dir);
        const hash = manifest[rooted];
        if (hash) byHash.set(hash, { bytes: ref.bytes, contentType: guessAssetContentType(rooted) });
      }
      return hashes.map((hash) => {
        const file = byHash.get(hash);
        if (!file) throw new Error(`Pages upload hash "${hash}" is absent from the retained source; refusing partial upload`);
        return { hash, bytes: file.bytes.slice(), contentType: file.contentType };
      });
    },
    dispose() {},
  };
}
