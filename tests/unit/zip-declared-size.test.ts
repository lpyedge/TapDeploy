import { deflateSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractZipAsync } from "../../src/release/zip.js";
import { extractPrebuiltZip } from "../../src/release/prebuilt-zip.js";

const enc = new TextEncoder();
const u16 = (v: number) => [v & 255, (v >>> 8) & 255];
const u32 = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// One deflated entry whose central directory declares `declared` bytes while the
// stream inflates to `real.length` bytes.
function zipDeclaring(name: string, real: Uint8Array, declared: number): Uint8Array {
  const compressed = deflateSync(real, { level: 9 });
  const nameBytes = enc.encode(name);
  const crc = crc32(real);
  const local = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(compressed.length), ...u32(declared), ...u16(nameBytes.length), ...u16(0), ...nameBytes, ...compressed]);
  const central = new Uint8Array([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(8), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(compressed.length), ...u32(declared), ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...nameBytes]);
  const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(1), ...u16(1), ...u32(central.length), ...u32(local.length), ...u16(0)]);
  return Uint8Array.from([...local, ...central, ...end]);
}

const text = enc.encode("export default { fetch() { return new Response('ok'); } };\n".repeat(20));

describe("a ZIP entry must inflate to exactly its declared size", () => {
  it("extracts an honest deflated entry byte for byte", async () => {
    const result = await extractZipAsync(zipDeclaring("worker/main.mjs", text, text.length));
    expect(result.ok, result.error).toBe(true);
    expect(result.files?.[0]?.bytes).toEqual(text);
  });

  it("refuses an entry that inflates past its declared size instead of truncating it", async () => {
    const result = await extractZipAsync(zipDeclaring("worker/main.mjs", text, 100));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("declared size");
  });

  it("refuses an entry that inflates to less than its declared size", async () => {
    const result = await extractZipAsync(zipDeclaring("worker/main.mjs", text, text.length + 100));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("declared size");
  });

  it("refuses a small declared size over a very large stream without producing it", async () => {
    const zip = zipDeclaring("assets/zeros.bin", new Uint8Array(96 * 1024 * 1024), 100);
    const started = Date.now();
    const result = await extractZipAsync(zip);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("declared size");
    expect(result.files).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("surfaces as a refused prebuilt release", async () => {
    const result = await extractPrebuiltZip(zipDeclaring("wrangler.jsonc", new Uint8Array(4 * 1024 * 1024), 100));
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("declared size");
  });
});
