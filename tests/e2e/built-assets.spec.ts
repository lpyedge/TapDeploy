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
    expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
    const session = await request.get("/api/auth/session");
    expect(session.headers()["cache-control"]).toBe("no-store");
    expect(session.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response?.headers()["content-security-policy"] ?? "").not.toMatch(/(?:^|[\s;])'unsafe-eval'(?:[\s;]|$)/);
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
    expect(wasm.headers()["content-security-policy"] ?? "").not.toMatch(/(?:^|[\s;])'unsafe-eval'(?:[\s;]|$)/);
    const valid = await page.evaluate(async (base64) => WebAssembly.validate(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))), bytes.toString("base64"));
    expect(valid).toBe(true);
  });
  test("serves the README deploy button at a stable address", async ({ request }) => {
    const button = await request.get("/button.svg");
    expect(button.status()).toBe(200);
    expect(button.headers()["content-type"]).toMatch(/^image\/svg\+xml/);
    expect(await button.text()).toMatch(/^<svg [^>]*aria-label="Deploy with TapDeploy"/);
  });
  test("CSP blocks inline script but permits publisher HTTPS downloads", async ({ page }) => {
    await page.route("https://publisher.example/config.json", (route) => route.fulfill({
      status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: '{"publisher":true}',
    }));
    await page.goto("/");
    const allowed = await page.evaluate(async () => (await fetch("https://publisher.example/config.json")).json());
    expect(allowed).toEqual({ publisher: true });
    const ran = await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "document.documentElement.dataset.inlineRan = 'yes'";
      document.head.append(script);
      return document.documentElement.dataset.inlineRan;
    });
    expect(ran).toBeUndefined();
    await page.route("**/assets/csp-eval-probe.js", (route) => route.fulfill({ contentType: "application/javascript", body:
      "try { new Function(\"document.documentElement.dataset.evalRan = 'yes'\")(); } catch { document.documentElement.dataset.evalBlocked = 'yes'; }" }));
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const script = document.createElement("script"); script.src = "/assets/csp-eval-probe.js";
      script.onload = () => resolve(); script.onerror = () => reject(new Error("probe did not load")); document.head.append(script);
    }));
    expect(await page.evaluate(() => document.documentElement.dataset.evalRan)).toBeUndefined();
    expect(await page.evaluate(() => document.documentElement.dataset.evalBlocked)).toBe("yes");
  });

});
