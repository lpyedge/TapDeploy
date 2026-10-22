// Official Static Assets upload manifest helpers.
// Direct-upload protocol requires URL-rooted paths ("/...") and 32-hex upload
// identifiers. Official hash: SHA256(base64(file bytes) + file extension), first
// 32 hex characters. The server uses the approved workersHash from the manifest;
// it cannot derive the upload hash from an integrity SHA without file bytes.

export const ASSET_UPLOAD_HASH_RE = /^[0-9a-f]{32}$/;

const MIME_BY_EXT: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  txt: "text/plain",
  xml: "application/xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  map: "application/json",
};

export function toRootedAssetPath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("asset path is required");
  }
  if (path.includes("\0")) {
    throw new Error("asset path contains NUL");
  }
  const normalized = path.replace(/\\/g, "/");
  const rooted = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const segments = rooted.split("/");
  if (segments.some((s) => s === "..")) {
    throw new Error(`asset path escapes root: "${path}"`);
  }
  if (rooted.length > 512) {
    throw new Error("asset path too long");
  }
  return rooted;
}

export function guessAssetContentType(path: string): string {
  const dot = path.split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[dot] ?? "application/octet-stream";
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 32-hex upload identifier, distinct from the 64-hex release-integrity SHA.
export async function assetUploadHash(rootedPath: string, bytes: Uint8Array): Promise<string> {
  const path = toRootedAssetPath(rootedPath);
  const filename = path.split("/").at(-1)!;
  const dot = filename.lastIndexOf(".");
  const extension = dot > 0 ? filename.slice(dot + 1) : "";
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  const full = await sha256Hex(btoa(binary) + extension);
  return full.slice(0, 32);
}

export interface ReleaseAssetRef {
  path: string;
  size: number;
  sha256: string;
  workersHash?: string;
}

export async function buildAssetUploadManifest(
  assets: ReleaseAssetRef[],
  directory?: string,
): Promise<Record<string, { hash: string; size: number }>> {
  const out: Record<string, { hash: string; size: number }> = {};
  const root = directory?.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const prefix = root && root !== "." ? toRootedAssetPath(root) + "/" : undefined;
  for (const asset of assets) {
    const archivePath = toRootedAssetPath(asset.path);
    if (prefix && !archivePath.startsWith(prefix)) throw new Error("Worker asset lies outside the approved assets.directory");
    const rooted = prefix ? "/" + archivePath.slice(prefix.length) : archivePath;
    if (rooted === "/") throw new Error("Worker asset must identify a file, not the asset root");
    if (out[rooted]) {
      throw new Error(`duplicate asset path "${rooted}"`);
    }
    const hash = asset.workersHash;
    if (!hash || !ASSET_UPLOAD_HASH_RE.test(hash)) throw new Error("approved Worker asset has no official workersHash; refusing to invent one from integrity SHA");
    out[rooted] = { hash, size: asset.size };
  }
  return out;
}
