// The WebAssembly engine can be missing, blocked or fail on one call (for example out of memory on a huge
// input). None of that may change a hash or fail an install: the pure-JS hash answers instead.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pagesAssetHash } from "../../src/cloudflare/pages/manifest.js";

vi.mock("blake3-wasm/dist/wasm/web/blake3_js.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("blake3-wasm/dist/wasm/web/blake3_js.js")>();
  return {
    ...original,
    hash: (data: Uint8Array, out: Uint8Array) => {
      if (data.length > 1000) throw new RangeError("WebAssembly.Memory(): could not allocate memory");
      original.hash(data, out);
    },
  };
});
const { createPagesHasher } = await import("../../src/web/compute/pages-hasher.js");

const wasmBytes = () => readFileSync(new URL("../../node_modules/blake3-wasm/dist/wasm/web/blake3_js_bg.wasm", import.meta.url));
const bytesOf = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 13 + 5) & 255);

afterEach(() => vi.unstubAllGlobals());

describe("browser Pages hasher failure modes", () => {
  it("a single call that the WASM cannot take falls back to JS for that call, and the engine keeps working", async () => {
    const hasher = await createPagesHasher(async () => wasmBytes());
    expect(hasher.engine).toBe("wasm");
    const small = bytesOf(100);
    const large = bytesOf(5000); // over the mocked allocation limit
    expect(hasher.hash("/large.bin", large)).toBe(pagesAssetHash("/large.bin", large));
    expect(hasher.hash("/small.bin", small)).toBe(pagesAssetHash("/small.bin", small));
  });

  it("a browser without WebAssembly uses JS from the start", async () => {
    vi.stubGlobal("WebAssembly", undefined);
    const hasher = await createPagesHasher(async () => wasmBytes());
    expect(hasher.engine).toBe("js");
    const bytes = bytesOf(300);
    expect(hasher.hash("/a.js", bytes)).toBe(pagesAssetHash("/a.js", bytes));
  });
});
