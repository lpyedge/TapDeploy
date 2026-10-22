import { zipSync } from "fflate";

export interface ZipBuildEntry {
  name: string;
  content: Uint8Array;
  // Crafted negatives only:
  isSymlink?: boolean;
  unixMode?: number;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]!;
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff];
}
function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

function encodeName(name: string): Uint8Array {
  return new TextEncoder().encode(name);
}

// Builds a minimal but valid ZIP (stored, method 0) allowing crafted filenames
// (traversal, duplicate), and symlink external attributes in the central dir.
export function buildCraftedZip(entries: ZipBuildEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encodeName(entry.name);
    const data = entry.content;
    const crc = crc32(data);
    const method = entry.isSymlink ? 0 : 0; // stored
    const isDir = entry.name.endsWith("/");

    // Local file header
    const localHeader = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(20), // version needed
      ...u16(0), // flags (no encryption)
      ...u16(method),
      ...u16(0), // mod time
      ...u16(0x21), // mod date
      ...u32(crc),
      ...u32(data.length), // compressed size (stored)
      ...u32(data.length), // uncompressed size
      ...u16(nameBytes.length),
      ...u16(0), // extra len
    ]);
    localParts.push(localHeader, nameBytes, data);

    const externalAttrs = entry.isSymlink
      ? 0xa000 << 16
      : (entry.unixMode ?? (isDir ? 0x4000 : 0x8000)) << 16;

    const centralHeader = new Uint8Array([
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(method),
      ...u16(0),
      ...u16(0x21),
      ...u32(crc),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(externalAttrs),
      ...u32(offset),
    ]);
    centralParts.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + data.length;
  }

  const centralSize = centralParts.reduce((n, p) => n + p.length, 0);

  const eocd = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(centralSize),
    ...u32(offset),
    ...u16(0),
  ]);

  return concat([...localParts, ...centralParts, eocd]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const enc = new TextEncoder();

export function buildValidZip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    entries[name] = enc.encode(content);
  }
  return zipSync(entries, { level: 6 });
}
