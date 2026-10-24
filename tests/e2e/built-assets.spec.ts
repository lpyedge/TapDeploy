// The built release must ship what the browser compute needs, same-origin and
// without widening the page's security policy: the compute Worker chunk, and the
// BLAKE3 WebAssembly it loads, are served as real assets, the WASM validates, and
// no response asks for `unsafe-eval`. Meaningful on the built runtimes only (the
// Vite dev server serves modules from /@fs/ instead).

import { expect, test } from "@playwright/test";

test.describe("built assets", () => {
  test.skip((process.env.PW_RUNTIME ?? "vite") === "vite", "needs a built runtime (PW_RUNTIME=node|workers)");

  test("the compute Worker chunk and the BLAKE3 WASM are served same-origin and the WASM is valid", async ({ page, request }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-security-policy"] ?? "").not.toContain("unsafe-eval");
    const html = await response!.text();
    const entry = /src="(\/assets\/index-[^"]+\.js)"/.exec(html)?.[1];
    expect(entry, "entry script in index.html").toBeTruthy();
    const entryJs = await (await request.get(entry!)).text();
    const workerChunk = /(release\.worker-[\w-]+\.js)/.exec(entryJs)?.[1];
    expect(workerChunk, "compute Worker chunk referenced from the entry bundle").toBeTruthy();
    const workerResponse = await request.get(`/assets/${workerChunk}`);
    expect(workerResponse.status()).toBe(200);
    expect(workerResponse.headers()["content-type"]).toMatch(/javascript/);
    const workerJs = await workerResponse.text();
    const wasmFile = /(blake3_js_bg-[\w-]+\.wasm)/.exec(workerJs)?.[1];
    expect(wasmFile, "BLAKE3 WASM referenced from the Worker chunk").toBeTruthy();
    const wasm = await request.get(`/assets/${wasmFile}`);
    expect(wasm.status()).toBe(200);
    const bytes = await wasm.body();
    expect(bytes.length).toBeGreaterThan(10_000);
    expect(wasm.headers()["content-security-policy"] ?? "").not.toContain("unsafe-eval");
    const valid = await page.evaluate(async (base64) => WebAssembly.validate(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))), bytes.toString("base64"));
    expect(valid).toBe(true);
  });
});
