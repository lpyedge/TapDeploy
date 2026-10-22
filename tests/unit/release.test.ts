import { describe, expect, it } from "vitest";
import { isPrivateHost } from "../../src/release/url.js";
import {
  inspectZip,
  validateZipEntries,
  extractZipAsync,
  DEFAULT_ZIP_BOUNDS,
} from "../../src/release/zip.js";
import { buildValidZip, buildCraftedZip } from "./zip-builder.js";

const enc = new TextEncoder();

describe("private host policy", () => {
  it("recognizes private/local hosts", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("192.168.1.1")).toBe(true);
    expect(isPrivateHost("169.254.1.1")).toBe(true);
    expect(isPrivateHost("github.com")).toBe(false);
  });
});

describe("zip validation", () => {
  it("accepts a valid minimal package and extracts wrangler/worker", async () => {
    const bytes = buildValidZip({
      "wrangler.jsonc": JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17" }),
      "worker/main.mjs": "export default { fetch() { return new Response('ok'); } };",
    });
    const res = await extractZipAsync(bytes);
    expect(res.ok).toBe(true);
    const names = (res.files ?? []).map((f) => f.path);
    expect(names).toContain("wrangler.jsonc");
    expect(names).toContain("worker/main.mjs");
    const worker = res.files?.find((f) => f.path === "worker/main.mjs");
    expect(worker?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects ZIP slip traversal paths", async () => {
    const bytes = buildCraftedZip([
      { name: "../../evil.txt", content: enc.encode("x") },
    ]);
    const inspected = inspectZip(bytes);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok || !inspected.info) return;
    const v = validateZipEntries(inspected.info);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/unsafe path/i);
  });

  it("rejects duplicate normalized paths", async () => {
    const bytes = buildCraftedZip([
      { name: "a/b.txt", content: enc.encode("a") },
      { name: "a/./b.txt", content: enc.encode("b") },
    ]);
    const inspected = inspectZip(bytes);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok || !inspected.info) return;
    const v = validateZipEntries(inspected.info);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/duplicate/i);
  });

  it("rejects symlink entries", async () => {
    const bytes = buildCraftedZip([
      { name: "link", content: enc.encode("target"), isSymlink: true },
    ]);
    const inspected = inspectZip(bytes);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok || !inspected.info) return;
    const v = validateZipEntries(inspected.info);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/symlink/i);
  });

  it("rejects excessive compression ratio (bomb)", async () => {
    // Valid small ZIP; then treat entry as a bomb by setting a large
    // uncompressed:compressed ratio while keeping size under per-file limit.
    const bytes = buildCraftedZip([
      { name: "bomb.bin", content: new Uint8Array(1024) },
    ]);
    const inspected = inspectZip(bytes);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok || !inspected.info) return;
    const bombEntry = inspected.info[0]!;
    const v = validateZipEntries(
      [{ ...bombEntry, uncompressedSize: 100_000, compressedSize: 1 }],
      DEFAULT_ZIP_BOUNDS,
    );
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/compression ratio/i);
  });

  it("rejects per-file size exceed limit", async () => {
    const bytes = buildCraftedZip([
      { name: "big.bin", content: new Uint8Array(2 * 1024 * 1024) },
    ]);
    const inspected = inspectZip(bytes);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok || !inspected.info) return;
    const v = validateZipEntries(
      [{ ...inspected.info[0]!, uncompressedSize: 30 * 1024 * 1024 }],
      DEFAULT_ZIP_BOUNDS,
    );
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/per-file/i);
  });
});

// The V3 prebuilt path: extractPrebuiltZip checks the wire format and requires
// a Wrangler config.
async function extractPrebuilt(bytes: Uint8Array) {
  const { extractPrebuiltZip } = await import("../../src/release/prebuilt-zip.js");
  return extractPrebuiltZip(bytes, {});
}

describe("V3 prebuilt release integrity", () => {
  it("accepts a valid V3 prebuilt ZIP (wrangler + main module)", async () => {
    const bytes = buildValidZip({
      "wrangler.jsonc": JSON.stringify({ name: "api", main: "worker/main.mjs", compatibility_date: "2026-10-17" }),
      "worker/main.mjs": "export default { fetch() { return new Response('ok'); } };",
    });
    const res = await extractPrebuilt(bytes);
    expect(res.ok).toBe(true);
  });

  it("rejects traversal archives before any manifest handling", async () => {
    const bytes = buildCraftedZip([{ name: "../../evil.txt", content: enc.encode("x") }]);
    const res = await extractPrebuilt(bytes);
    expect(res.ok).toBe(false);
  });

  it("rejects symlink archives before any manifest handling", async () => {
    const bytes = buildCraftedZip([{ name: "link", content: enc.encode("target"), isSymlink: true }]);
    const res = await extractPrebuilt(bytes);
    expect(res.ok).toBe(false);
  });

  it("rejects a layout with no Wrangler config", async () => {
    const bytes = buildValidZip({ "worker/main.mjs": "export default {};" });
    const res = await extractPrebuilt(bytes);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("NO_WRANGLER_CONFIG"))).toBe(true);
  });
});
