// Pages direct-upload hash + manifest helpers.
//
// The Pages upload hash is NOT the Workers asset upload hash. It is the BLAKE3
// of `base64(fileContents) + fileExtension` (extension WITHOUT the leading dot)
// truncated to the first 32 hex characters. This is the exact algorithm
// wrangler uses (`hashFile`), so the manifest the Installer builds matches what
// the provider / the author's own wrangler compute. The release-integrity
// SHA-256 (64 hex) and the Workers asset upload hash are never reused here.
//
// Pure synchronous BLAKE3 is browser/Node/Workers safe without a deferred WASM
// initializer or reliance on Wrangler's transitive development dependencies.

import { blake3 } from "@noble/hashes/blake3.js";
import { PAGES_SPECIAL_FILES, PAGES_UPLOAD_HASH_RE } from "./constants.js";

// Compute the 32-hex Pages upload hash for a file path + byte contents.
// `extension` is derived from the file path's basename extension (no dot).
export function pagesAssetHash(path: string, contents: Uint8Array): string {
  const base64 = base64FromBytes(contents);
  const extension = fileExtension(path);
  return [...blake3(new TextEncoder().encode(base64 + extension)).subarray(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function assertPagesUploadHash(hash: string): void {
  if (!PAGES_UPLOAD_HASH_RE.test(hash)) {
    throw new Error(`Pages upload hash must be 32-hex, got "${hash.slice(0, 16)}…"`);
  }
}

// The manifest part sent to the deployment create: URL-rooted path -> 32-hex
// upload hash. Pages URLs are rooted ("/index.html"), matching the `toRooted`
// convention used by the Workers asset manifest.
function toRootedPath(path: string): string {
  if (!path || path.includes("\0")) throw new Error("Pages asset path must be a nonempty file path without NUL");
  const normalized = path.replace(/\\/g, "/");
  const rooted = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const segments = rooted.split("/");
  if (segments.some((s) => s === "..")) {
    throw new Error(`Pages asset path escapes root: "${path}"`);
  }
  if (rooted.length > 512) {
    throw new Error("Pages asset path too long");
  }
  return rooted;
}
export function toPagesAssetPath(path: string, directory?: string): string {
  const archivePath = toRootedPath(path);
  const root = directory?.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const prefix = root && root !== "." ? toRootedPath(root) + "/" : undefined;
  if (prefix && !archivePath.startsWith(prefix)) throw new Error("Pages asset lies outside the approved assets directory");
  const rooted = prefix ? "/" + archivePath.slice(prefix.length) : archivePath;
  if (rooted === "/") throw new Error("Pages asset must identify a file, not the asset root");
  return rooted;
}

export interface PagesAssetRef {
  path: string;
  size: number;
  sha256: string;
  bytes: Uint8Array;
}

// the root-level deployment control files (`_worker.js`, `_redirects`,
// `_headers`, `_routes.json`) and the `functions/` directory declared by
// PAGES_SPECIAL_FILES are NOT static assets. The provider receives `_worker.js`
// as the separate `_worker.bundle` part and never accepts the remaining control
// files through the asset manifest, so a release that ships one at the output
// root must fail closed instead of hashing it into the manifest as a regular
// file. The names are reserved only at the output root: `sub/_redirects` is a
// normal static file.
export function pagesControlFileAtRoot(rootedPath: string): string | undefined {
  const normalized = rootedPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = (normalized.startsWith("/") ? normalized.slice(1) : normalized).split("/");
  const head = segments[0];
  if (!head) return undefined;
  if (head === "functions") return "functions";
  if (segments.length === 1 && PAGES_SPECIAL_FILES.has(head)) return head;
  return undefined;
}

// Build the Pages deployment manifest (rooted path -> 32-hex hash) from the
// extracted static asset files. Duplicate rooted paths fail closed, and a
// deployment control file at the output root is never hashed as a static asset.
export function buildPagesManifest(assets: PagesAssetRef[], directory?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const asset of assets) {
    const rooted = toPagesAssetPath(asset.path, directory);
    const control = pagesControlFileAtRoot(rooted);
    if (control !== undefined) {
      throw new Error(
        `refusing to hash Pages control file "${control}" ("${rooted}") into the asset manifest; deployment control files are not static assets`,
      );
    }
    if (out[rooted] !== undefined) {
      throw new Error(`duplicate Pages asset path "${rooted}"`);
    }
    const hash = pagesAssetHash(asset.path, asset.bytes);
    assertPagesUploadHash(hash);
    out[rooted] = hash;
  }
  return out;
}

function fileExtension(path: string): string {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}
