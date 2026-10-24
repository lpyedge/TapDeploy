import { describe, expect, it } from "vitest";
import { blake3 } from "@noble/hashes/blake3.js";
import { base64Ascii, base64String } from "../../src/core/encoding/base64-ascii.js";
import { assetUploadHash } from "../../src/cloudflare/assets/manifest.js";
import { pagesAssetHash } from "../../src/cloudflare/pages/manifest.js";

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const patterned = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 131 + (i >> 8) * 17) & 255);
const sizes = [0, 1, 2, 3, 4, 5, 255, 256, 257, 32768, 32769, 65536 + 1];
const allByteValues = Uint8Array.from({ length: 256 }, (_, i) => i);

// Independent oracles: Node's Buffer base64 plus the documented hash formulas.
const oracleWorkers = async (path: string, bytes: Uint8Array) => {
  const filename = path.split("/").at(-1)!;
  const dot = filename.lastIndexOf(".");
  const input = new TextEncoder().encode(Buffer.from(bytes).toString("base64") + (dot > 0 ? filename.slice(dot + 1) : ""));
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", input as Uint8Array<ArrayBuffer>))).slice(0, 32);
};
const oraclePages = (path: string, bytes: Uint8Array) => {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return hex(blake3(new TextEncoder().encode(Buffer.from(bytes).toString("base64") + (dot > 0 ? base.slice(dot + 1).toLowerCase() : ""))).subarray(0, 16));
};

describe("base64 ASCII encoder", () => {
  it.each(sizes)("matches Buffer base64 for %i bytes", (size) => {
    const bytes = patterned(size);
    const expected = Buffer.from(bytes).toString("base64");
    expect(new TextDecoder().decode(base64Ascii(bytes))).toBe(expected);
    expect(base64String(bytes)).toBe(expected);
  });
  it("encodes every byte value", () => {
    expect(base64String(allByteValues)).toBe(Buffer.from(allByteValues).toString("base64"));
  });
  it("appends the suffix bytes after the base64 text", () => {
    const out = base64Ascii(patterned(5), new TextEncoder().encode("é.js"));
    expect(new TextDecoder().decode(out)).toBe(Buffer.from(patterned(5)).toString("base64") + "é.js");
  });
  it("encodes a large buffer", () => {
    const bytes = patterned(22 * 1024 * 1024 + 1);
    expect(base64String(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});

describe("asset upload hashes keep their official formulas", () => {
  const paths = ["/a.js", "/A.JS", "/.dotfile", "/noext", "/dir/ü-файл.Html", "/archive.tar.GZ", "/trailing."];
  it.each(paths)("Workers (case-preserved ext) and Pages (lowercase ext) match the oracle for %s", async (path) => {
    for (const bytes of [new Uint8Array(0), new Uint8Array([7]), allByteValues, patterned(70001)]) {
      expect(await assetUploadHash(path, bytes)).toBe(await oracleWorkers(path, bytes));
      expect(pagesAssetHash(path, bytes)).toBe(oraclePages(path, bytes));
    }
  });
  it("keeps the two hashes distinct for an uppercase extension", async () => {
    expect(await assetUploadHash("/A.JS", allByteValues)).not.toBe(pagesAssetHash("/A.JS", allByteValues).slice(0, 32));
  });
  it("still rejects invalid Worker asset paths", async () => {
    await expect(assetUploadHash("/../x.js", new Uint8Array(1))).rejects.toThrow();
    await expect(assetUploadHash("a\0b", new Uint8Array(1))).rejects.toThrow();
  });
});
