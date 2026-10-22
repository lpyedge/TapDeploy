import { unzipSync } from "fflate";

export interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  isDir: boolean;
  isSymlink: boolean;
}

export interface ZipBounds {
  maxFiles: number;
  maxTotalUncompressed: number;
  maxPerFile: number;
  maxCompressionRatio: number;
  maxPathDepth: number;
}

export const DEFAULT_ZIP_BOUNDS: ZipBounds = {
  maxFiles: 20001,
  maxTotalUncompressed: 67108864, // 64 MiB
  maxPerFile: 26214400, // 25 MiB
  maxCompressionRatio: 200,
  maxPathDepth: 16,
};

export interface ZipValidationResult {
  ok: boolean;
  info?: ZipEntryInfo[];
  error?: string;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const CENTRAL_HEADER_SIZE = 46;

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function findEocd(bytes: Uint8Array): number {
  const searchFrom = Math.max(0, bytes.length - 0xffff - 22);
  for (let i = bytes.length - 22; i >= searchFrom; i--) {
    if (readUInt32LE(bytes, i) === EOCD_SIG) {
      return i;
    }
  }
  return -1;
}

// Parse the ZIP central directory to gather per-entry sizes WITHOUT decompressing.
export function inspectZip(bytes: Uint8Array): ZipValidationResult {
  const eocd = findEocd(bytes);
  if (eocd < 0) {
    return { ok: false, error: "not a valid ZIP (no end-of-central-directory)" };
  }

  const centralCount = readUInt16LE(bytes, eocd + 10);
  const centralOffset = readUInt32LE(bytes, eocd + 16);

  if (centralCount === 0) {
    return { ok: false, error: "ZIP contains no entries" };
  }

  const info: ZipEntryInfo[] = [];
  let offset = centralOffset;

  for (let i = 0; i < centralCount; i++) {
    if (readUInt32LE(bytes, offset) !== CEN_SIG) {
      return { ok: false, error: "corrupt central directory" };
    }
    const flags = readUInt16LE(bytes, offset + 8);
    const compressedSize = readUInt32LE(bytes, offset + 20);
    const uncompressedSize = readUInt32LE(bytes, offset + 24);
    const nameLength = readUInt16LE(bytes, offset + 28);
    const extraLength = readUInt16LE(bytes, offset + 30);
    const commentLength = readUInt16LE(bytes, offset + 32);
    const externalAttrs = readUInt32LE(bytes, offset + 38);

    const nameStart = offset + CENTRAL_HEADER_SIZE;
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(nameStart, nameStart + nameLength),
      );
    } catch {
      return { ok: false, error: `invalid UTF-8 filename at entry ${i}` };
    }

    const isDir = name.endsWith("/");
    // High bits of external attrs hold unix mode; symlink 0xA000.
    const unixMode = (externalAttrs >>> 16) & 0xffff;
    const isSymlink = (unixMode & 0xf000) === 0xa000;
    const encrypted = (flags & 0x1) !== 0;

    if (encrypted) {
      return { ok: false, error: `encrypted ZIP entry "${name}" is not allowed` };
    }

    info.push({ name, compressedSize, uncompressedSize, isDir, isSymlink });

    offset += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
  }

  return { ok: true, info };
}

function normalizePath(name: string): string | null {
  if (name.includes("\0")) {
    return null;
  }
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return null; // absolute path
  }
  const segments = normalized.split("/");
  if (segments.some((s) => s === "..")) {
    return null; // traversal
  }
  // Collapse "." segments so "a/./b.txt" normalizes to "a/b.txt".
  const collapsed = segments.filter((s) => s !== ".").join("/");
  return collapsed;
}

export function validateZipEntries(
  info: ZipEntryInfo[],
  bounds: ZipBounds = DEFAULT_ZIP_BOUNDS,
): ZipValidationResult {
  if (info.length > bounds.maxFiles) {
    return { ok: false, error: `too many entries: ${info.length}` };
  }

  let totalUncompressed = 0;
  const seen = new Set<string>();

  for (const entry of info) {
    if (entry.isSymlink) {
      return { ok: false, error: `symlink entry "${entry.name}" is not allowed` };
    }

    const normalized = normalizePath(entry.name);
    if (!normalized) {
      return { ok: false, error: `unsafe path "${entry.name}"` };
    }

    if (entry.uncompressedSize > bounds.maxPerFile) {
      return { ok: false, error: `file "${entry.name}" exceeds per-file size limit` };
    }

    if (entry.uncompressedSize > 0 && entry.compressedSize > 0) {
      const ratio = entry.uncompressedSize / entry.compressedSize;
      if (ratio > bounds.maxCompressionRatio) {
        return { ok: false, error: `file "${entry.name}" suspicious compression ratio` };
      }
    }

    if (!entry.isDir) {
      const depth = normalized.split("/").filter(Boolean).length;
      if (depth > bounds.maxPathDepth) {
        return { ok: false, error: `file "${entry.name}" path too deep` };
      }
      const key = normalized;
      if (seen.has(key)) {
        return { ok: false, error: `duplicate normalized path "${key}"` };
      }
      seen.add(key);
      totalUncompressed += entry.uncompressedSize;
      if (totalUncompressed > bounds.maxTotalUncompressed) {
        return { ok: false, error: "total uncompressed size exceeds limit" };
      }
    }
  }

  return { ok: true, info };
}

export interface ExtractedFile {
  path: string;
  bytes: Uint8Array;
  size: number;
  sha256: string;
}

export interface ZipExtractResult {
  ok: boolean;
  files?: ExtractedFile[];
  error?: string;
}

async function digestHex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    data as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Extract and validate the ZIP in one step, hashing each file with SHA-256.
// Runs in both the browser and Node (crypto.subtle).
export async function extractZipAsync(
  bytes: Uint8Array,
  bounds?: ZipBounds,
): Promise<ZipExtractResult> {
  const inspected = inspectZip(bytes);
  if (!inspected.ok || !inspected.info) {
    return { ok: false, error: inspected.error };
  }
  const validated = validateZipEntries(inspected.info, bounds);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }

  const entries = unzipSync(bytes);
  const files: ExtractedFile[] = [];
  for (const [name, data] of Object.entries(entries)) {
    const normalized = normalizePath(name);
    if (!normalized || data === undefined) {
      continue;
    }
    const sha256 = await digestHex(data).catch(() => "");
    files.push({ path: normalized, bytes: data, size: data.length, sha256 });
  }
  return { ok: true, files };
}
