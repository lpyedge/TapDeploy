import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pagesAssetHash } from "../../src/cloudflare/pages/manifest.js";
import { createPagesHasher } from "../../src/web/compute/pages-hasher.js";

const wasmBytes = () => readFileSync(new URL("../../node_modules/blake3-wasm/dist/wasm/web/blake3_js_bg.wasm", import.meta.url));
const patterned = (length: number, seed: number) => Uint8Array.from({ length }, (_, i) => (i * 131 + seed * 17 + (i >> 8)) & 255);
const cases: Array<[string, Uint8Array]> = [
  ["/empty.txt", new Uint8Array(0)],
  ["/one.bin", new Uint8Array([200])],
  ["/bytes.BIN", Uint8Array.from({ length: 256 }, (_, i) => i)],
  ["/テスト/файл.PNG", patterned(1000, 3)],
  ["/.dotfile", patterned(33, 4)],
  ["/no-ext", patterned(32769, 5)],
  ["/big.wasm", patterned(3 * 1024 * 1024 + 7, 6)],
];

describe("browser Pages hasher", () => {
  it("uses WASM when it loads and matches the JS hash exactly", async () => {
    const hasher = await createPagesHasher(async () => wasmBytes());
    expect(hasher.engine).toBe("wasm");
    for (const [path, bytes] of cases) expect(hasher.hash(path, bytes)).toBe(pagesAssetHash(path, bytes));
  });
  it("falls back to JS when the WASM cannot be loaded", async () => {
    const hasher = await createPagesHasher(async () => { throw new Error("blocked by CSP"); });
    expect(hasher.engine).toBe("js");
    for (const [path, bytes] of cases) expect(hasher.hash(path, bytes)).toBe(pagesAssetHash(path, bytes));
  });
  it("falls back to JS when the WASM bytes are not a valid module", async () => {
    const hasher = await createPagesHasher(async () => new Uint8Array([1, 2, 3, 4]));
    expect(hasher.engine).toBe("js");
    expect(hasher.hash("/a.js", patterned(10, 1))).toBe(pagesAssetHash("/a.js", patterned(10, 1)));
  });
  it("keeps the lowercase-extension rule", async () => {
    const hasher = await createPagesHasher(async () => wasmBytes());
    const bytes = patterned(64, 9);
    expect(hasher.hash("/A.JS", bytes)).toBe(hasher.hash("/a.js", bytes));
  });
});
