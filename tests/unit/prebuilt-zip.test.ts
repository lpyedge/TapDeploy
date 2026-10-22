import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";

import {
  PREBUILT_ZIP_MAX_ARCHIVE_BYTES,
  computePrebuiltManifestDigest,
  extractPrebuiltZip,
  verifyPrebuiltZipFiles,
} from "../../src/release/prebuilt-zip.js";
import { DEFAULT_ZIP_BOUNDS } from "../../src/release/zip.js";
import { extractPrebuiltZip as webExtractPrebuiltZip } from "../../src/web/lib/zip.js";
import { buildCraftedZip, type ZipBuildEntry } from "./zip-builder.js";

const enc = new TextEncoder();

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const WRANGLER = '{ "name": "demo", "main": "worker/main.mjs" }';
const MAIN_MJS = "export default { fetch() { return new Response('ok'); } };\n";

function bytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? enc.encode(content) : content;
}

function v3Zip(extra: Record<string, string | Uint8Array> = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "wrangler.jsonc": enc.encode(WRANGLER),
    "worker/main.mjs": enc.encode(MAIN_MJS),
  };
  for (const [name, content] of Object.entries(extra)) {
    files[name] = bytes(content);
  }
  return zipSync(files, { level: 6 });
}

function crafted(entries: ZipBuildEntry[]): Uint8Array {
  return buildCraftedZip(entries);
}

// Flip the encryption flag in the first central-directory header.
function setCentralEncryptedFlag(zip: Uint8Array): Uint8Array {
  const out = zip.slice();
  for (let i = 0; i + 4 <= out.length; i++) {
    if (
      out[i] === 0x50 &&
      out[i + 1] === 0x4b &&
      out[i + 2] === 0x01 &&
      out[i + 3] === 0x02
    ) {
      out[i + 8] = (out[i + 8] ?? 0) | 0x1;
      return out;
    }
  }
  throw new Error("central directory header not found");
}

// Flip one byte of the stored data of the first entry carrying `name`
// (local header 30 bytes + name + data layout used by buildCraftedZip).
function flipFirstDataByte(zip: Uint8Array, name: string): Uint8Array {
  const nameBytes = enc.encode(name);
  for (let i = 0; i + nameBytes.length <= zip.length; i++) {
    let match = true;
    for (let j = 0; j < nameBytes.length; j++) {
      if (zip[i + j] !== nameBytes[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      const out = zip.slice();
      const dataStart = i + nameBytes.length;
      out[dataStart] = (out[dataStart] ?? 0) ^ 0xff;
      return out;
    }
  }
  throw new Error(`entry "${name}" not found`);
}

describe("extractPrebuiltZip — V3 layout", () => {
  it("accepts the single-worker layout with multi-module, wasm and assets", async () => {
    const wasm = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0xde, 0xad, 0xbe, 0xef, 0x00, 0xff, 0x7f, 0x80, 0x01,
    ]);
    const zip = zipSync(
      {
        "wrangler.jsonc": enc.encode(WRANGLER),
        "worker/main.mjs": enc.encode(MAIN_MJS),
        "worker/chunks/helper.mjs": enc.encode("export const helper = 1;\n"),
        "worker/engine.wasm": wasm,
        "public/index.html": enc.encode("<html><body>demo</body></html>"),
        "public/assets/app.js": enc.encode("console.log('app');\n"),
      },
      { level: 6 },
    );

    const res = await extractPrebuiltZip(zip);
    expect(res.ok).toBe(true);
    const manifest = res.manifest!;
    expect(manifest.entryCount).toBe(6);
    expect(manifest.archiveBytes).toBe(zip.length);
    expect(manifest.archiveSha256).toBe(sha256Hex(zip));
    expect(manifest.wranglerPaths).toEqual(["wrangler.jsonc"]);

    const byPath = new Map(res.files!.map((f) => [f.path, f]));
    expect(byPath.get("wrangler.jsonc")!.kind).toBe("wrangler");
    expect(byPath.get("worker/main.mjs")!.kind).toBe("esm");
    expect(byPath.get("worker/chunks/helper.mjs")!.kind).toBe("esm");
    expect(byPath.get("worker/engine.wasm")!.kind).toBe("wasm");
    expect(byPath.get("public/assets/app.js")!.kind).toBe("asset");

    // Binary fidelity: .wasm bytes round-trip byte-for-byte.
    expect(Array.from(byPath.get("worker/engine.wasm")!.bytes)).toEqual(
      Array.from(wasm),
    );
    expect(byPath.get("worker/engine.wasm")!.sha256).toBe(sha256Hex(wasm));
    expect(byPath.get("worker/main.mjs")!.sha256).toBe(
      sha256Hex(enc.encode(MAIN_MJS)),
    );

    expect(manifest.entries.map((e) => e.path)).toEqual([
      "public/assets/app.js",
      "public/index.html",
      "worker/chunks/helper.mjs",
      "worker/engine.wasm",
      "worker/main.mjs",
      "wrangler.jsonc",
    ]);
  });

  it("accepts the multi-unit layout and lists every wrangler path", async () => {
    const zip = zipSync(
      {
        "units/api/wrangler.jsonc": enc.encode(
          '{ "name": "api", "main": "worker/main.mjs" }',
        ),
        "units/api/worker/main.mjs": enc.encode(MAIN_MJS),
        "units/api/public/index.html": enc.encode("<html></html>"),
        "units/jobs/wrangler.jsonc": enc.encode('{ "name": "jobs" }'),
        "units/jobs/worker/cron.mjs": enc.encode(
          "export default { scheduled() {} };\n",
        ),
      },
      { level: 6 },
    );
    const res = await extractPrebuiltZip(zip);
    expect(res.ok).toBe(true);
    expect(res.manifest!.wranglerPaths).toEqual([
      "units/api/wrangler.jsonc",
      "units/jobs/wrangler.jsonc",
    ]);
  });

  it("normalizes `./` segments and rejects normalized duplicates", async () => {
    const ok = await extractPrebuiltZip(
      crafted([
        { name: "wrangler.jsonc", content: bytes(WRANGLER) },
        { name: "worker/./main.mjs", content: bytes(MAIN_MJS) },
      ]),
    );
    expect(ok.ok).toBe(true);
    expect(ok.files!.map((f) => f.path)).toEqual([
      "worker/main.mjs",
      "wrangler.jsonc",
    ]);

    const dup = await extractPrebuiltZip(
      crafted([
        { name: "wrangler.jsonc", content: bytes(WRANGLER) },
        { name: "./worker/main.mjs", content: bytes(MAIN_MJS) },
        { name: "worker/main.mjs", content: bytes(MAIN_MJS) },
      ]),
    );
    expect(dup.ok).toBe(false);
    expect(dup.errors[0]).toMatch(/^INVALID_ZIP: duplicate normalized path/);
  });

  it("ignores directory markers", async () => {
    const res = await extractPrebuiltZip(
      crafted([
        { name: "public/", content: new Uint8Array(0) },
        { name: "wrangler.jsonc", content: bytes(WRANGLER) },
        { name: "worker/main.mjs", content: bytes(MAIN_MJS) },
      ]),
    );
    expect(res.ok).toBe(true);
    expect(res.manifest!.entries.map((e) => e.path)).toEqual([
      "worker/main.mjs",
      "wrangler.jsonc",
    ]);
  });
});

describe("extractPrebuiltZip — malicious archives", () => {
  it("rejects zip-slip, absolute and backslash-transformed paths", async () => {
    const names = [
      "../evil.mjs",
      "a/../../b.mjs",
      "a\\..\\b.mjs",
      "/abs.mjs",
      "C:\\evil.mjs",
    ];
    for (const name of names) {
      const res = await extractPrebuiltZip(
        crafted([
          { name: "wrangler.jsonc", content: bytes(WRANGLER) },
          { name, content: bytes("x") },
        ]),
      );
      expect(res.ok, name).toBe(false);
      expect(res.errors[0]?.startsWith("INVALID_ZIP"), name).toBe(true);
    }
  });

  it("rejects symlink entries", async () => {
    const res = await extractPrebuiltZip(
      crafted([
        { name: "wrangler.jsonc", content: bytes(WRANGLER) },
        { name: "worker/main.mjs", content: bytes(MAIN_MJS), isSymlink: true },
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/^INVALID_ZIP: symlink entry/);
  });

  it("rejects encrypted entries", async () => {
    const res = await extractPrebuiltZip(setCentralEncryptedFlag(v3Zip()));
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/^INVALID_ZIP: encrypted ZIP entry/);
  });

  it("rejects case-insensitive path collisions", async () => {
    const res = await extractPrebuiltZip(
      crafted([
        { name: "wrangler.jsonc", content: bytes(WRANGLER) },
        { name: "worker/main.mjs", content: bytes(MAIN_MJS) },
        { name: "Worker/main.mjs", content: bytes(MAIN_MJS) },
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.startsWith("CASE_COLLISION"))).toBe(true);
  });

  it("rejects compression bombs and oversized archives", async () => {
    const bomb = zipSync(
      {
        "wrangler.jsonc": enc.encode(WRANGLER),
        "worker/zeros.bin": new Uint8Array(300000),
      },
      { level: 9 },
    );
    const res = await extractPrebuiltZip(bomb);
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/^INVALID_ZIP: .*compression ratio/);

    const capped = await extractPrebuiltZip(v3Zip(), { maxArchiveBytes: 100 });
    expect(capped.ok).toBe(false);
    expect(capped.errors[0]).toMatch(/^ARCHIVE_TOO_LARGE:/);
    expect(PREBUILT_ZIP_MAX_ARCHIVE_BYTES).toBe(67108864);
  });

  it("enforces bounds against declared and actual sizes", async () => {
    const res = await extractPrebuiltZip(v3Zip(), {
      bounds: { ...DEFAULT_ZIP_BOUNDS, maxPerFile: 10 },
    });
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/^INVALID_ZIP: .*per-file size limit/);
  });

  it("rejects an empty archive", async () => {
    const res = await extractPrebuiltZip(zipSync({}));
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/^INVALID_ZIP/);
  });
});

describe("extractPrebuiltZip — secrets, stale formats and uncompiled sources", () => {
  it("rejects secret/env and key files anywhere in the ZIP", async () => {
    const res = await extractPrebuiltZip(
      v3Zip({
        ".env": "TOKEN=1",
        ".env.example": "TOKEN=",
        "config/.dev.vars": "SECRET=1",
        "config/.dev.vars.production": "SECRET=1",
        "certs/server.pem": "-----BEGIN CERTIFICATE-----",
        "certs/tls.key": "KEY",
        "keys/id_rsa": "KEY",
        "keys/signing.p12": "P12",
      }),
    );
    expect(res.ok).toBe(false);
    const flagged = new Set(
      res.errors
        .filter((e) => e.startsWith("SECRET_FILE"))
        .map((e) => /"([^"]+)"/.exec(e)?.[1]),
    );
    expect(flagged).toEqual(
      new Set([
        ".env",
        ".env.example",
        "config/.dev.vars",
        "config/.dev.vars.production",
        "certs/server.pem",
        "certs/tls.key",
        "keys/id_rsa",
        "keys/signing.p12",
      ]),
    );
  });

  it("rejects node_modules, .git and cache directories", async () => {
    const res = await extractPrebuiltZip(
      v3Zip({
        "node_modules/dep/index.js": "module.exports = {};",
        "public/node_modules/x.js": "x",
        ".git/config": "[core]",
        "public/.wrangler/tmp/x": "cache",
        ".vitest/cache": "cache",
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.filter((e) => e.startsWith("BANNED_PATH")).length).toBe(5);
  });

  it("refuses a ZIP without wrangler.jsonc", async () => {
    const res = await extractPrebuiltZip(
      zipSync({
        "worker/main.mjs": enc.encode(MAIN_MJS),
        "public/index.html": enc.encode("<html></html>"),
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/^NO_WRANGLER_CONFIG/);
  });

  it("rejects wrangler.toml with or without a jsonc present", async () => {
    const tomlOnly = await extractPrebuiltZip(
      zipSync({ "wrangler.toml": enc.encode('name = "demo"') }),
    );
    expect(
      tomlOnly.errors.some((e) => e.startsWith("WRANGLER_TOML_NOT_SUPPORTED")),
    ).toBe(true);
    expect(tomlOnly.errors.some((e) => e.startsWith("NO_WRANGLER_CONFIG"))).toBe(false);

    const ambiguous = await extractPrebuiltZip(
      v3Zip({ "wrangler.toml": 'name = "demo"' }),
    );
    expect(ambiguous.ok).toBe(false);
    expect(
      ambiguous.errors.some((e) => e.startsWith("WRANGLER_TOML_NOT_SUPPORTED")),
    ).toBe(true);
  });

  it("rejects uncompiled TypeScript sources", async () => {
    const res = await extractPrebuiltZip(
      v3Zip({
        "worker/main.ts": "export default {};\n",
        "worker/types.TS": "x",
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.filter((e) => e.startsWith("UNCOMPILED_SOURCE")).length).toBe(
      2,
    );
  });

  it("rejects executable/script hooks", async () => {
    const res = await extractPrebuiltZip(
      v3Zip({ "scripts/postinstall.sh": "#!/bin/sh\n" }),
    );
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.startsWith("EXECUTABLE_HOOK"))).toBe(true);
  });
});

describe("prebuilt ZIP identities and re-verification", () => {
  it("derives a deterministic content-addressed manifest digest", async () => {
    const zip = v3Zip({ "public/index.html": "<html></html>" });
    const a = await extractPrebuiltZip(zip);
    const b = await extractPrebuiltZip(zip.slice());
    expect(a.ok && b.ok).toBe(true);
    expect(a.manifest!.manifestDigest).toBe(b.manifest!.manifestDigest);
    expect(a.manifest!.manifestDigest).toBe(
      await computePrebuiltManifestDigest(
        a.manifest!.archiveSha256,
        a.manifest!.entries,
      ),
    );

    const changed = await extractPrebuiltZip(
      v3Zip({ "public/index.html": "<html>changed</html>" }),
    );
    expect(changed.ok).toBe(true);
    expect(changed.manifest!.manifestDigest).not.toBe(
      a.manifest!.manifestDigest,
    );
  });

  it("verifies extracted files against a sealed entry list", async () => {
    const res = await extractPrebuiltZip(v3Zip());
    expect(res.ok).toBe(true);
    const files = res.files!;
    const entries = res.manifest!.entries;

    expect(verifyPrebuiltZipFiles(files, entries).ok).toBe(true);

    const drifted = entries.map((e) =>
      e.path === "worker/main.mjs" ? { ...e, sha256: "0".repeat(64) } : e,
    );
    const drift = verifyPrebuiltZipFiles(files, drifted);
    expect(drift.ok).toBe(false);
    expect(drift.errors.some((e) => e.startsWith("HASH_DRIFT"))).toBe(true);

    const missing = verifyPrebuiltZipFiles(files.slice(1), entries);
    expect(missing.errors.some((e) => e.startsWith("MISSING_FILE"))).toBe(true);

    const extra = verifyPrebuiltZipFiles(
      [...files, { path: "undeclared.txt", size: 1, sha256: "a".repeat(64) }],
      entries,
    );
    expect(extra.errors.some((e) => e.startsWith("UNDECLARED_FILE"))).toBe(true);

    const malformed = verifyPrebuiltZipFiles(files, [
      { path: "worker/main.mjs", size: 1, sha256: "not-hex" },
    ]);
    expect(malformed.errors.some((e) => e.startsWith("HASH_DRIFT"))).toBe(true);
  });

  it("detects mutated archive bytes via the sealed hashes", async () => {
    const zip = crafted([
      { name: "wrangler.jsonc", content: bytes(WRANGLER) },
      { name: "worker/main.mjs", content: bytes(MAIN_MJS) },
    ]);
    const original = await extractPrebuiltZip(zip);
    expect(original.ok).toBe(true);

    const mutated = flipFirstDataByte(zip, "worker/main.mjs");
    const res = await extractPrebuiltZip(mutated);
    if (res.ok) {
      const check = verifyPrebuiltZipFiles(res.files!, original.manifest!.entries);
      expect(check.ok).toBe(false);
    } else {
      expect(res.errors[0]?.startsWith("INVALID_ZIP")).toBe(true);
    }
  });

  it("re-exports the V3 extractor through the web zip lib", () => {
    expect(webExtractPrebuiltZip).toBe(extractPrebuiltZip);
  });
});
