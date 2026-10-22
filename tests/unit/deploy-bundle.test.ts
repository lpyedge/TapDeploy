import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";

import { bundleProofMaterial } from "../../src/core/planning/digest.js";
import { verifyDeployBundleModules } from "../../src/release/artifact-proof.js";
import {
  JS_MODULE_MIME,
  WASM_MODULE_MIME,
  buildDeployBundle,
  collectDeployBundleParts,
  type DeployBundle,
} from "../../src/release/deploy-bundle.js";
import {
  extractPrebuiltZip,
  type PrebuiltZipResult,
} from "../../src/release/prebuilt-zip.js";

const enc = new TextEncoder();
const sha = (data: Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

const WRANGLER_SRC = `{
  "name": "demo",
  "main": "worker/main.mjs",
  "compatibility_date": "2026-10-10",
  "assets": { "directory": "public" }
}
`;
const MAIN = "export default { fetch() { return new Response('ok'); } };\n";
const CHUNK = "export const helper = 1;\n";
const HTML = "<html><body>demo</body></html>";
// Real wasm header plus bytes that are NOT valid UTF-8 (0xde 0xad …): a text
// round-trip through TextDecoder/TextEncoder must visibly corrupt them.
const WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0xde, 0xad, 0xbe, 0xef, 0x00, 0xff, 0x7f, 0x80, 0x01,
]);

function v3Zip(
  overrides: Record<string, string | Uint8Array> = {},
  remove: string[] = [],
): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "wrangler.jsonc": enc.encode(WRANGLER_SRC),
    "worker/main.mjs": enc.encode(MAIN),
    "worker/chunks/helper.mjs": enc.encode(CHUNK),
    "worker/engine.wasm": WASM,
    "public/index.html": enc.encode(HTML),
  };
  for (const [name, content] of Object.entries(overrides)) {
    files[name] = typeof content === "string" ? enc.encode(content) : content;
  }
  for (const name of remove) {
    delete files[name];
  }
  return zipSync(files, { level: 6 });
}

async function verified(zip: Uint8Array): Promise<PrebuiltZipResult> {
  const res = await extractPrebuiltZip(zip);
  expect(res.ok).toBe(true);
  return res;
}

async function bundleOf(zip: Uint8Array): Promise<DeployBundle> {
  const built = await buildDeployBundle(await verified(zip));
  expect(built.ok).toBe(true);
  return built.bundle!;
}

describe("buildDeployBundle — verified ZIP + normalized Wrangler -> immutable identity", () => {
  it("builds the canonical module/asset/config identity from raw bytes", async () => {
    const zip = v3Zip();
    const res = await verified(zip);
    const built = await buildDeployBundle(res);
    expect(built.ok).toBe(true);
    const bundle = built.bundle!;

    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.appName).toBe("demo");
    expect(bundle.targetKind).toBe("workers");
    expect(bundle.mainModule).toBe("worker/main.mjs");
    expect(bundle.assetsDirectory).toBe("public");

    expect(bundle.modules).toEqual([
      {
        name: "worker/chunks/helper.mjs",
        kind: "esm",
        mime: JS_MODULE_MIME,
        size: enc.encode(CHUNK).length,
        sha256: sha(enc.encode(CHUNK)),
      },
      {
        name: "worker/engine.wasm",
        kind: "wasm",
        mime: WASM_MODULE_MIME,
        size: WASM.length,
        sha256: sha(WASM),
      },
      {
        name: "worker/main.mjs",
        kind: "esm",
        mime: JS_MODULE_MIME,
        size: enc.encode(MAIN).length,
        sha256: sha(enc.encode(MAIN)),
      },
    ]);
    expect(bundle.assets).toEqual([
      { path: "public/index.html", size: enc.encode(HTML).length, sha256: sha(enc.encode(HTML)) },
    ]);
    expect(bundle.config).toEqual({
      path: "wrangler.jsonc",
      size: enc.encode(WRANGLER_SRC).length,
      sha256: sha(enc.encode(WRANGLER_SRC)),
    });
    expect(bundle.source).toEqual({
      archiveBytes: zip.length,
      archiveSha256: sha(zip),
      manifestDigest: res.manifest!.manifestDigest,
    });
    expect(bundle.wranglerEffectiveHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.bundleDigest).toMatch(/^[0-9a-f]{64}$/);
    // Serializable identity: a JSON round-trip is lossless.
    expect(JSON.parse(JSON.stringify(bundle))).toEqual(bundle);
  });

  it("is deterministic for the same verified archive", async () => {
    const zip = v3Zip();
    const first = await bundleOf(zip);
    const second = await bundleOf(zip);
    expect(second).toEqual(first);
  });

  it("one byte changed in any module, asset or config changes the digest", async () => {
    const base = await bundleOf(v3Zip());
    const mutatedWasm = WASM.slice();
    mutatedWasm[8] = mutatedWasm[8]! ^ 0xff;
    const cases: [string, Uint8Array][] = [
      ["main module", v3Zip({ "worker/main.mjs": MAIN.replace("'ok'", "'no'") })],
      ["chunk module", v3Zip({ "worker/chunks/helper.mjs": "export const helper = 2;\n" })],
      ["wasm module", v3Zip({ "worker/engine.wasm": mutatedWasm })],
      ["asset", v3Zip({ "public/index.html": HTML.replace("demo", "dem0") })],
      ["config", v3Zip({ "wrangler.jsonc": WRANGLER_SRC.replace('"demo"', '"demo2"') })],
    ];
    for (const [label, zip] of cases) {
      const mutated = await bundleOf(zip);
      expect(mutated.bundleDigest, `${label} mutation must change the digest`).not.toBe(base.bundleDigest);
    }

    // A semantic config edit changes the effective (normalized) hash; a comment
    // only survives normalization but is still bound byte-exactly by the digest.
    const semanticConfig = await bundleOf(
      v3Zip({ "wrangler.jsonc": WRANGLER_SRC.replace('"demo"', '"demo2"') }),
    );
    expect(semanticConfig.wranglerEffectiveHash).not.toBe(base.wranglerEffectiveHash);
    const commentConfig = await bundleOf(
      v3Zip({ "wrangler.jsonc": WRANGLER_SRC + "\n// built by CI\n" }),
    );
    expect(commentConfig.wranglerEffectiveHash).toBe(base.wranglerEffectiveHash);
    expect(commentConfig.bundleDigest).not.toBe(base.bundleDigest);
  });

  it("cross-module content swaps cannot retain the approved digest", async () => {
    const base = await bundleOf(v3Zip());
    const swappedZip = v3Zip({
      "worker/main.mjs": CHUNK,
      "worker/chunks/helper.mjs": MAIN,
    });
    const swapped = await bundleOf(swappedZip);
    expect(swapped.bundleDigest).not.toBe(base.bundleDigest);
    // The server re-verification refuses the swapped bytes against the approved bundle.
    const res = await verified(swappedZip);
    const collected = await collectDeployBundleParts(base, res.files!);
    expect(collected.ok).toBe(false);
    expect(collected.errors.some((e) => e.startsWith("HASH_DRIFT"))).toBe(true);
  });

  it("an injected asset cannot retain the approved digest", async () => {
    const base = await bundleOf(v3Zip());
    const injected = await bundleOf(v3Zip({ "public/injected.html": "<html>evil</html>" }));
    expect(injected.bundleDigest).not.toBe(base.bundleDigest);
    expect(injected.assets.map((a) => a.path)).toEqual([
      "public/index.html",
      "public/injected.html",
    ]);
  });

  it("collects exact raw wasm bytes as an application/wasm part (never text-decoded)", async () => {
    const res = await verified(v3Zip());
    const bundle = (await buildDeployBundle(res)).bundle!;
    const collected = await collectDeployBundleParts(bundle, res.files!);
    expect(collected.ok).toBe(true);
    expect(collected.parts.map((p) => p.name)).toEqual([
      "worker/chunks/helper.mjs",
      "worker/engine.wasm",
      "worker/main.mjs",
    ]);
    const wasmPart = collected.parts.find((p) => p.kind === "wasm")!;
    expect(wasmPart.mime).toBe(WASM_MODULE_MIME);
    expect(Array.from(wasmPart.bytes)).toEqual(Array.from(WASM));
    expect(wasmPart.sha256).toBe(sha(WASM));

    const ok = await verifyDeployBundleModules(
      bundle,
      collected.parts.map((p) => ({ name: p.name, bytes: p.bytes })),
    );
    expect(ok).toEqual({ ok: true, errors: [] });

    // A text round-trip corrupts the wasm bytes; re-verification must refuse them.
    const mangled = enc.encode(new TextDecoder().decode(WASM));
    expect(Array.from(mangled)).not.toEqual(Array.from(WASM));
    const corrupted = await verifyDeployBundleModules(bundle, [
      { name: "worker/main.mjs", bytes: enc.encode(MAIN) },
      { name: "worker/chunks/helper.mjs", bytes: enc.encode(CHUNK) },
      { name: "worker/engine.wasm", bytes: mangled },
    ]);
    expect(corrupted.ok).toBe(false);
    expect(corrupted.errors.join("\n")).toContain('"worker/engine.wasm"');
  });

  it("re-verification fails closed on one corrupted byte, swaps, missing and undeclared parts", async () => {
    const res = await verified(v3Zip());
    const bundle = (await buildDeployBundle(res)).bundle!;
    const mainBytes = enc.encode(MAIN);
    const chunkBytes = enc.encode(CHUNK);

    const flipped = WASM.slice();
    flipped[3] = flipped[3]! ^ 0x01;
    const single = await verifyDeployBundleModules(bundle, [
      { name: "worker/main.mjs", bytes: mainBytes },
      { name: "worker/chunks/helper.mjs", bytes: chunkBytes },
      { name: "worker/engine.wasm", bytes: flipped },
    ]);
    expect(single.ok).toBe(false);
    expect(single.errors).toEqual([
      'HASH_DRIFT: "worker/engine.wasm" bytes do not match the approved module',
    ]);

    const swappedParts = await verifyDeployBundleModules(bundle, [
      { name: "worker/main.mjs", bytes: chunkBytes },
      { name: "worker/chunks/helper.mjs", bytes: mainBytes },
      { name: "worker/engine.wasm", bytes: WASM },
    ]);
    expect(swappedParts.ok).toBe(false);
    expect(swappedParts.errors.join("\n")).toContain('"worker/main.mjs"');
    expect(swappedParts.errors.join("\n")).toContain('"worker/chunks/helper.mjs"');

    const missing = await verifyDeployBundleModules(bundle, [
      { name: "worker/main.mjs", bytes: mainBytes },
      { name: "worker/chunks/helper.mjs", bytes: chunkBytes },
    ]);
    expect(missing.ok).toBe(false);
    expect(missing.errors).toEqual([
      'MISSING_MODULE: "worker/engine.wasm" was not provided',
    ]);

    const duplicated = await verifyDeployBundleModules(bundle, [
      { name: "worker/main.mjs", bytes: mainBytes },
      { name: "worker/main.mjs", bytes: mainBytes },
      { name: "worker/chunks/helper.mjs", bytes: chunkBytes },
      { name: "worker/engine.wasm", bytes: WASM },
    ]);
    expect(duplicated.ok).toBe(false);
    expect(duplicated.errors).toEqual([
      'DUPLICATE_MODULE: "worker/main.mjs" was provided more than once',
    ]);

    const undeclared = await verifyDeployBundleModules(bundle, [
      { name: "worker/main.mjs", bytes: mainBytes },
      { name: "worker/chunks/helper.mjs", bytes: chunkBytes },
      { name: "worker/engine.wasm", bytes: WASM },
      { name: "worker/extra.mjs", bytes: mainBytes },
    ]);
    expect(undeclared.ok).toBe(false);
    expect(undeclared.errors).toEqual([
      'UNDECLARED_MODULE: "worker/extra.mjs" is not part of the approved bundle',
    ]);
  });

  it("fails closed on unverified or tampered extraction results", async () => {
    const notVerified = await buildDeployBundle({ ok: false, errors: ["boom"] });
    expect(notVerified.ok).toBe(false);
    expect(notVerified.issues.map((i) => i.code)).toEqual(["ZIP_NOT_VERIFIED"]);

    const res = await verified(v3Zip());
    const tamperedSha: PrebuiltZipResult = {
      ...res,
      files: res.files!.map((f) =>
        f.path === "worker/chunks/helper.mjs" ? { ...f, sha256: "0".repeat(64) } : f,
      ),
    };
    const shaCase = await buildDeployBundle(tamperedSha);
    expect(shaCase.ok).toBe(false);
    expect(shaCase.issues[0]!.code).toBe("HASH_MISMATCH");

    const flipped = enc.encode(MAIN);
    flipped[0] = flipped[0]! ^ 0xff;
    const tamperedBytes: PrebuiltZipResult = {
      ...res,
      files: res.files!.map((f) =>
        f.path === "worker/main.mjs" ? { ...f, bytes: flipped } : f,
      ),
    };
    const bytesCase = await buildDeployBundle(tamperedBytes);
    expect(bytesCase.ok).toBe(false);
    expect(bytesCase.issues[0]!.code).toBe("HASH_MISMATCH");
  });

  it("refuses multi-unit ZIPs, missing mains, stray files and invalid configs", async () => {
    const multiUnit = zipSync(
      {
        "units/api/wrangler.jsonc": enc.encode(
          '{ "name": "api", "main": "worker/main.mjs", "compatibility_date": "2026-10-10" }',
        ),
        "units/api/worker/main.mjs": enc.encode(MAIN),
        "units/jobs/wrangler.jsonc": enc.encode(
          '{ "name": "jobs", "main": "worker/cron.mjs", "compatibility_date": "2026-10-10" }',
        ),
        "units/jobs/worker/cron.mjs": enc.encode("export default { scheduled() {} };\n"),
      },
      { level: 6 },
    );
    const multi = await buildDeployBundle(await verified(multiUnit));
    expect(multi.ok).toBe(false);
    expect(multi.issues.map((i) => i.code)).toEqual(["MULTI_UNIT_NOT_SUPPORTED"]);

    const missingMain = await buildDeployBundle(
      await verified(v3Zip({}, ["worker/main.mjs"])),
    );
    expect(missingMain.issues.map((i) => i.code)).toEqual(["MAIN_MODULE_MISSING"]);

    const stray = await buildDeployBundle(await verified(v3Zip({ "notes.txt": "hello" })));
    expect(stray.issues.map((i) => i.code)).toEqual(["UNCLASSIFIED_FILE"]);
    expect(stray.issues[0]!.detail).toContain("notes.txt");

    const badConfig = await buildDeployBundle(
      await verified(
        v3Zip({ "wrangler.jsonc": '{ "name": "demo", "main": "worker/main.mjs" }' }),
      ),
    );
    expect(badConfig.issues.map((i) => i.code)).toEqual(["WRANGLER_CONFIG_INVALID"]);

    // An assets.directory that swallows the worker modules cannot silently ship
    // them as assets: the main module disappears from the upload set.
    const swallowed = await buildDeployBundle(
      await verified(
        v3Zip({ "wrangler.jsonc": WRANGLER_SRC.replace('"public"', '"worker"') }, [
          "public/index.html",
        ]),
      ),
    );
    expect(swallowed.issues.map((i) => i.code)).toEqual(["MAIN_MODULE_MISSING"]);
    expect(swallowed.issues[0]!.detail).toContain("assets.directory");
  });

  it("supports pages bundles as assets-only identities", async () => {
    const zip = zipSync(
      {
        "wrangler.jsonc": enc.encode(
          '{ "name": "site", "compatibility_date": "2026-10-10", "pages_build_output_dir": "dist" }',
        ),
        "dist/index.html": enc.encode("<html></html>"),
        "dist/app.js": enc.encode("console.log('app');\n"),
      },
      { level: 6 },
    );
    const built = await buildDeployBundle(await verified(zip));
    expect(built.ok).toBe(true);
    const bundle = built.bundle!;
    expect(bundle.targetKind).toBe("pages");
    expect(bundle.mainModule).toBeUndefined();
    expect(bundle.assetsDirectory).toBe("dist");
    expect(bundle.modules).toEqual([]);
    expect(bundle.assets.map((a) => a.path)).toEqual(["dist/app.js", "dist/index.html"]);
  });

  it("exposes the shared plan/step binding material", async () => {
    const zip = v3Zip();
    const bundle = await bundleOf(zip);
    const material = bundleProofMaterial(bundle);
    expect(material.bundleDigest).toBe(bundle.bundleDigest);
    expect(material.wranglerEffectiveHash).toBe(bundle.wranglerEffectiveHash);
    expect(material.mainModule).toBe("worker/main.mjs");
    expect(material.modules.map((m) => m.name)).toEqual([
      "worker/chunks/helper.mjs",
      "worker/engine.wasm",
      "worker/main.mjs",
    ]);
    expect(material.assets.map((a) => a.path)).toEqual(["public/index.html"]);
    expect(material.source.archiveSha256).toBe(sha(zip));

    const injected = await bundleOf(v3Zip({ "public/injected.html": "<html>evil</html>" }));
    expect(bundleProofMaterial(injected)).not.toEqual(material);
  });
});
