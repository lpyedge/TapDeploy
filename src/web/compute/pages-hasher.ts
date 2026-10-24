// Browser-only Pages upload hasher. The BLAKE3 step runs in WebAssembly when it
// loads and falls back to the pure-JS hash (which is also the server's) when it
// does not (blocked by CSP, unsupported, invalid module). Both engines digest
// the same bytes from `pagesHashInput`, so the result never depends on the engine.

import initWasm, { hash as wasmBlake3 } from "blake3-wasm/dist/wasm/web/blake3_js.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { pagesHashDigestHex, pagesHashInput } from "../../cloudflare/pages/manifest.js";

export interface PagesHasher {
  engine: "wasm" | "js";
  hash(path: string, bytes: Uint8Array): string;
}

// Vite emits this as a same-origin, content-hashed asset.
const wasmUrl = new URL("../../../node_modules/blake3-wasm/dist/wasm/web/blake3_js_bg.wasm", import.meta.url);

async function fetchWasm(): Promise<BufferSource> {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`WASM fetch failed: ${response.status}`);
  return response.arrayBuffer();
}

const jsHasher: PagesHasher = {
  engine: "js",
  hash: (path, bytes) => pagesHashDigestHex(blake3(pagesHashInput(path, bytes))),
};

export async function createPagesHasher(loadWasm: () => Promise<BufferSource> = fetchWasm): Promise<PagesHasher> {
  try {
    await initWasm(await loadWasm());
  } catch (error) {
    console.warn("BLAKE3 WASM unavailable, using JavaScript fallback:", error);
    return jsHasher;
  }
  const digest = new Uint8Array(32);
  return {
    engine: "wasm",
    hash(path, bytes) {
      const input = pagesHashInput(path, bytes);
      try {
        wasmBlake3(input, digest);
        return pagesHashDigestHex(digest);
      } catch (error) {
        console.warn("BLAKE3 WASM hash failed, using JavaScript fallback:", error);
        return jsHasher.hash(path, bytes);
      }
    },
  };
}

let shared: Promise<PagesHasher> | undefined;
export function getPagesHasher(): Promise<PagesHasher> {
  shared ??= createPagesHasher();
  return shared;
}
