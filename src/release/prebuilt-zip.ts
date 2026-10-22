import {
  DEFAULT_ZIP_BOUNDS,
  extractZipAsync,
  inspectZip,
  type ZipBounds,
  type ZipExtractResult,
} from "./zip.js";

// ---------------------------------------------------------------------------
// V3 prebuilt release ZIP extraction.
//
// A V3 release ZIP is the FINAL published artifact: it carries the built
// worker module(s), optional binary `.wasm`, static assets, and the effective
// `wrangler.jsonc` at the ZIP root (or one per unit under `units/...`). It is
// NOT compiled in the browser. This module reuses the bounds/inspection layer
// in `./zip.js` (zip-slip, symlink, encryption, duplicate, ratio, depth, total
// size checks) and adds the V3-only policy on top:
//
//   - reject secret/env material (`.env*`, `.dev.vars*`), key/credential files
//   - reject banned directories (node_modules, .git, caches)
//   - reject uncompiled TypeScript sources (TS-only packages)
//   - reject executable/script hooks (.sh/.bat/.ps1/.exe/...)
//   - reject paths that only differ by case (case-insensitive collisions)
//   - reject v2 clean ZIPs (no embedded `wrangler.jsonc`) with a specific error
//   - reject `wrangler.toml` (only JSONC is accepted; convert and repackage)
//   - verify declared central-directory sizes against extracted bytes, plus a
//     per-file SHA-256 of the actual decompressed bytes and an archive SHA-256
//
// `./zip.js` provides only the shared bounded extraction primitives.
// ---------------------------------------------------------------------------

// Local body/memory bound for the compressed archive itself. This is NOT a
// claim about any Cloudflare product limit; it only fails absurd archives
// before parsing.
export const PREBUILT_ZIP_MAX_ARCHIVE_BYTES = 67108864; // 64 MiB

export type PrebuiltFileKind = "wrangler" | "esm" | "wasm" | "asset";

export interface PrebuiltZipEntry {
  path: string;
  size: number;
  sha256: string;
  kind: PrebuiltFileKind;
}

export interface PrebuiltZipFile extends PrebuiltZipEntry {
  bytes: Uint8Array;
}

export interface PrebuiltZipManifest {
  archiveBytes: number;
  archiveSha256: string;
  entryCount: number;
  entries: PrebuiltZipEntry[];
  wranglerPaths: string[];
  manifestDigest: string;
}

export interface PrebuiltZipResult {
  ok: boolean;
  files?: PrebuiltZipFile[];
  manifest?: PrebuiltZipManifest;
  errors: string[];
}

export interface PrebuiltZipOptions {
  bounds?: ZipBounds;
  maxArchiveBytes?: number;
  /** Only the server-derived resource-only projection may enable this. */
  allowResourceOnly?: boolean;
}

const BANNED_DIR_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".wrangler",
  ".vitest",
  ".ssh",
]);

const KEY_BASENAMES = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".netrc",
]);

const KEY_EXTENSIONS = [".pem", ".key", ".p12", ".pfx"];
const UNCOMPILED_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const EXECUTABLE_HOOK_EXTENSIONS = [
  ".sh",
  ".bash",
  ".zsh",
  ".bat",
  ".cmd",
  ".ps1",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
];

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isSecretBasename(lower: string): boolean {
  return (
    lower === ".env" ||
    lower.startsWith(".env.") ||
    lower === ".dev.vars" ||
    lower.startsWith(".dev.vars.")
  );
}

function isKeyBasename(lower: string): boolean {
  return (
    KEY_BASENAMES.has(lower) ||
    KEY_EXTENSIONS.some((ext) => lower.endsWith(ext))
  );
}

// Kind is informational for later tasks: the authoritative worker/module
// layout comes from parsing the effective Wrangler config, not from
// file extensions alone. `.js` files can be assets or chunks, so they stay
// "asset" here.
function classifyKind(path: string): PrebuiltFileKind {
  const lower = basename(path).toLowerCase();
  if (lower === "wrangler.jsonc") {
    return "wrangler";
  }
  if (lower.endsWith(".mjs")) {
    return "esm";
  }
  if (lower.endsWith(".wasm")) {
    return "wasm";
  }
  return "asset";
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    data as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Single content-addressed identity for the extracted bundle: the archive
// SHA-256 plus the canonical (path-sorted) entry list. Every field is derived
// from actual bytes; nothing is trusted from the ZIP's own declarations.
export async function computePrebuiltManifestDigest(
  archiveSha256: string,
  entries: ReadonlyArray<PrebuiltZipEntry>,
): Promise<string> {
  const sorted = [...entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const canonical = JSON.stringify({
    archiveSha256,
    entries: sorted.map((e) => ({
      kind: e.kind,
      path: e.path,
      sha256: e.sha256,
      size: e.size,
    })),
  });
  return sha256Hex(new TextEncoder().encode(canonical));
}

// Compare extracted (actual-bytes) files against an expected sealed entry list
// (e.g. a re-checked plan): every expected entry must exist with the exact
// size and SHA-256, and no undeclared file may appear.
export function verifyPrebuiltZipFiles(
  files: ReadonlyArray<{ path: string; size: number; sha256: string }>,
  expected: ReadonlyArray<{ path: string; size: number; sha256: string }>,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const byPath = new Map<string, { path: string; size: number; sha256: string }>();
  for (const f of files) {
    byPath.set(f.path, f);
  }

  const expectedPaths = new Set<string>();
  for (const spec of expected) {
    expectedPaths.add(spec.path);
    if (!/^[0-9a-f]{64}$/.test(spec.sha256)) {
      errors.push(
        `HASH_DRIFT: expected entry "${spec.path}" has a malformed sha256`,
      );
      continue;
    }
    const actual = byPath.get(spec.path);
    if (!actual) {
      errors.push(`MISSING_FILE: "${spec.path}" is not present`);
      continue;
    }
    if (actual.size !== spec.size) {
      errors.push(
        `SIZE_MISMATCH: "${spec.path}" expected ${spec.size} bytes, got ${actual.size}`,
      );
    }
    if (actual.sha256 !== spec.sha256) {
      errors.push(`HASH_DRIFT: "${spec.path}" sha256 does not match`);
    }
  }

  for (const f of files) {
    if (!expectedPaths.has(f.path)) {
      errors.push(`UNDECLARED_FILE: "${f.path}" is not in the sealed entry list`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export async function extractPrebuiltZip(
  bytes: Uint8Array,
  options: PrebuiltZipOptions = {},
): Promise<PrebuiltZipResult> {
  const bounds = options.bounds ?? DEFAULT_ZIP_BOUNDS;
  const maxArchiveBytes = options.maxArchiveBytes ?? PREBUILT_ZIP_MAX_ARCHIVE_BYTES;

  if (bytes.length > maxArchiveBytes) {
    return {
      ok: false,
      errors: [
        `ARCHIVE_TOO_LARGE: ${bytes.length} bytes exceeds the ${maxArchiveBytes} byte limit`,
      ],
    };
  }

  // Declared (central directory) sizes, for a post-extraction cross-check.
  const declaredSizes = new Map<string, number>();
  const inspected = inspectZip(bytes);
  if (!inspected.ok || !inspected.info) {
    return {
      ok: false,
      errors: [`INVALID_ZIP: ${inspected.error ?? "not a valid ZIP"}`],
    };
  }
  for (const entry of inspected.info) {
    if (!entry.isDir && !declaredSizes.has(entry.name)) {
      declaredSizes.set(entry.name, entry.uncompressedSize);
    }
  }

  let extracted: ZipExtractResult;
  try {
    extracted = await extractZipAsync(bytes, bounds);
  } catch (err) {
    return {
      ok: false,
      errors: [
        `INVALID_ZIP: unreadable archive (${
          err instanceof Error ? err.message : "unknown error"
        })`,
      ],
    };
  }
  if (!extracted.ok || !extracted.files) {
    return {
      ok: false,
      errors: [`INVALID_ZIP: ${extracted.error ?? "invalid archive"}`],
    };
  }

  const errors: string[] = [];
  const files: PrebuiltZipFile[] = [];
  let totalUncompressed = 0;

  for (const f of extracted.files) {
    if (f.path.endsWith("/")) {
      continue; // directory marker; carries no bytes
    }
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) {
      errors.push(`INVALID_ZIP: could not digest "${f.path}"`);
      continue;
    }
    files.push({
      path: f.path,
      bytes: f.bytes,
      size: f.size,
      sha256: f.sha256,
      kind: classifyKind(f.path),
    });

    const declared = declaredSizes.get(f.path);
    if (declared !== undefined && declared !== f.size) {
      errors.push(
        `SIZE_MISMATCH: "${f.path}" declares ${declared} bytes but extracted ${f.size}`,
      );
    }
    totalUncompressed += f.size;
    if (f.size > bounds.maxPerFile) {
      errors.push(
        `SIZE_MISMATCH: "${f.path}" extracted size exceeds the per-file limit`,
      );
    }
  }
  if (totalUncompressed > bounds.maxTotalUncompressed) {
    errors.push("SIZE_MISMATCH: extracted total exceeds the uncompressed limit");
  }

  // Case-insensitive collisions are rejected even though the canonical path
  // check above is case-sensitive: publish targets may be case-insensitive.
  const lowerSeen = new Map<string, string>();
  for (const f of files) {
    const lower = f.path.toLowerCase();
    const prev = lowerSeen.get(lower);
    if (prev !== undefined) {
      errors.push(
        `CASE_COLLISION: "${prev}" and "${f.path}" differ only by case`,
      );
    } else {
      lowerSeen.set(lower, f.path);
    }
  }

  let wranglerToml = false;
  for (const f of files) {
    const lower = f.path.toLowerCase();
    const base = basename(lower);
    const segments = lower.split("/");

    const bannedSegment = segments.find((s) => BANNED_DIR_SEGMENTS.has(s));
    if (bannedSegment) {
      errors.push(
        `BANNED_PATH: "${f.path}" contains banned directory "${bannedSegment}"`,
      );
    }

    if (isSecretBasename(base)) {
      errors.push(
        `SECRET_FILE: "${f.path}" is a secret/env file and is not allowed`,
      );
    } else if (isKeyBasename(base)) {
      errors.push(
        `SECRET_FILE: "${f.path}" looks like a key/credential file and is not allowed`,
      );
    }

    if (base === "wrangler.toml") {
      wranglerToml = true;
      errors.push(
        `WRANGLER_TOML_NOT_SUPPORTED: "${f.path}" — only wrangler.jsonc is accepted; convert TOML to JSONC and repackage`,
      );
    }

    if (UNCOMPILED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      errors.push(
        `UNCOMPILED_SOURCE: "${f.path}" is uncompiled TypeScript; the release ZIP must contain built modules only`,
      );
    }

    if (EXECUTABLE_HOOK_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
      errors.push(
        `EXECUTABLE_HOOK: "${f.path}" is an executable/script hook and is not allowed`,
      );
    }
  }

  const wranglerPaths = files
    .filter((f) => f.kind === "wrangler")
    .map((f) => f.path)
    .sort();
  if (wranglerPaths.length === 0 && !options.allowResourceOnly && !wranglerToml) {
    errors.push(
      "NO_WRANGLER_CONFIG: no wrangler.jsonc found — every Worker or Pages unit needs one (see docs/release-publisher-guide.md)",
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const archiveSha256 = await sha256Hex(bytes);
  const entries: PrebuiltZipEntry[] = files.map(({ path, size, sha256, kind }) => ({
    path,
    size,
    sha256,
    kind,
  }));
  const manifestDigest = await computePrebuiltManifestDigest(archiveSha256, entries);

  return {
    ok: true,
    files,
    manifest: {
      archiveBytes: bytes.length,
      archiveSha256,
      entryCount: entries.length,
      entries,
      wranglerPaths,
      manifestDigest,
    },
    errors: [],
  };
}
