import { afterEach, describe, expect, it, vi } from "vitest";
import { assetUploadHash } from "../../src/cloudflare/assets/manifest.js";
import { buildPagesManifest, pagesAssetHash } from "../../src/cloudflare/pages/manifest.js";
import { UploadHashCache, uploadHashExtension } from "../../src/web/compute/hash-cache.js";
import { createSourceStore } from "../../src/web/compute/source-store.js";
import type { ExtractedFile } from "../../src/release/zip.js";

afterEach(() => vi.restoreAllMocks());

const sha = (n: number) => n.toString(16).padStart(64, "0");
const bytesOf = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) & 255);
let counter = 0;
const file = (path: string, bytes: Uint8Array): ExtractedFile => ({ path, bytes, size: bytes.length, sha256: sha(++counter * 1000 + bytes.length) });
// Same content => same SHA-256 in a real extraction; mimic that for equal bytes.
const sameContent = (path: string, of: ExtractedFile): ExtractedFile => ({ path, bytes: of.bytes, size: of.size, sha256: of.sha256 });

describe("upload hash cache", () => {
  it("is keyed by algorithm, content digest and exact extension", () => {
    const cache = new UploadHashCache();
    cache.set("workers", sha(1), "JS", "w-hash");
    expect(cache.get("workers", sha(1), "JS")).toBe("w-hash");
    expect(cache.get("workers", sha(1), "js")).toBeUndefined();
    expect(cache.get("pages", sha(1), "JS")).toBeUndefined();
    expect(cache.get("workers", sha(2), "JS")).toBeUndefined();
  });
  it("stays bounded and evicts the oldest entry first", () => {
    const cache = new UploadHashCache();
    for (let i = 0; i < 4100; i++) cache.set("workers", sha(i), "js", String(i));
    expect(cache.size).toBeLessThanOrEqual(4096);
    expect(cache.get("workers", sha(0), "js")).toBeUndefined();
    expect(cache.get("workers", sha(4099), "js")).toBe("4099");
  });
  it.each([
    ["/a.js", "js", "js"], ["/A.JS", "JS", "js"], ["/.dotfile", "", ""], ["/noext", "", ""], ["/dir.v2/file", "", ""],
    ["/a.tar.GZ", "GZ", "gz"], ["/trail.", "", ""], ["/テスト/файл.PNG", "PNG", "png"], ["/UPPER.Html", "Html", "html"], ["/x y/z.CSS", "CSS", "css"],
  ])("extension shape %s", (path, workers, pages) => {
    expect(uploadHashExtension("workers", path)).toBe(workers);
    expect(uploadHashExtension("pages", path)).toBe(pages);
  });
});

describe("source store", () => {
  const assets = () => [
    file("units/api/wrangler.jsonc", bytesOf(40, 9)),
    file("units/api/main.mjs", bytesOf(60, 8)),
    file("units/api/public/index.html", bytesOf(300, 1)),
    file("units/api/public/app.JS", bytesOf(500, 2)),
    file("units/api/public/.well-known", bytesOf(20, 3)),
  ];

  it("lists metadata only and hands out copies of exact bytes", async () => {
    const files = assets();
    const store = createSourceStore(files, async () => pagesAssetHash);
    expect(await store.listFiles()).toEqual(files.map(({ path, size, sha256 }) => ({ path, size, sha256 })));
    const bytes = await store.readFile("units/api/main.mjs");
    expect(bytes).toEqual(files[1]!.bytes);
    bytes[0] = bytes[0]! ^ 0xff;
    expect(await store.readFile("units/api/main.mjs")).toEqual(files[1]!.bytes);
    await expect(store.readFile("units/api/missing.mjs")).rejects.toThrow("does not contain");
  });

  it("Worker asset hashes equal the official function for every extension shape", async () => {
    const files = assets();
    const store = createSourceStore(files, async () => pagesAssetHash);
    const index = await store.workerAssetIndex("units/api/public");
    for (const entry of files.filter((f) => f.path.startsWith("units/api/public/"))) {
      const rooted = `/${entry.path.slice("units/api/public/".length)}`;
      expect(index).toContainEqual({ hash: await assetUploadHash(rooted, entry.bytes), size: entry.size });
    }
  });

  it("a retry of the same unit hashes nothing again (Workers and Pages)", async () => {
    const files = assets();
    const pagesHash = vi.fn(pagesAssetHash);
    const store = createSourceStore(files, async () => pagesHash);
    const digest = vi.spyOn(crypto.subtle, "digest");
    const first = await store.workerAssetIndex("units/api/public");
    const hashed = digest.mock.calls.length;
    expect(hashed).toBe(3);
    await store.workerAssetIndex("units/api/public");
    await store.workerAssetFiles("units/api/public", first.map((entry) => entry.hash));
    expect(digest.mock.calls.length).toBe(hashed);
    await store.pagesManifest("units/api/public");
    const pagesCalls = pagesHash.mock.calls.length;
    expect(pagesCalls).toBe(3);
    await store.pagesManifest("units/api/public");
    await store.pagesFiles("units/api/public", Object.values((await store.pagesManifest("units/api/public")).manifest));
    expect(pagesHash.mock.calls.length).toBe(pagesCalls);
  });

  it("identical content with the same extension is hashed once; the case rules stay algorithm-specific", async () => {
    const original = file("site/a.js", bytesOf(100, 4));
    const files = [original, sameContent("site/b.js", original), sameContent("site/C.JS", original), sameContent("site/c.js", original)];
    const pagesHash = vi.fn(pagesAssetHash);
    const store = createSourceStore(files, async () => pagesHash);
    const digest = vi.spyOn(crypto.subtle, "digest");
    const index = await store.workerAssetIndex("site");
    // Workers keeps the extension case: ".js" and ".JS" are two different hashes.
    expect(new Set(index.map((entry) => entry.hash)).size).toBe(2);
    expect(digest.mock.calls.length).toBe(2);
    const { manifest } = await store.pagesManifest("site");
    // Pages lowercases the extension: one hash for all four files, computed once.
    expect(new Set(Object.values(manifest)).size).toBe(1);
    expect(pagesHash.mock.calls.length).toBe(1);
  });

  it("each mutation of any file changes its hash and never reuses a stale entry", async () => {
    const files = assets().filter((f) => f.path.startsWith("units/api/public/"));
    const baseline = createSourceStore(files, async () => pagesAssetHash);
    const baseWorkers = await baseline.workerAssetIndex("units/api/public");
    const basePages = (await baseline.pagesManifest("units/api/public")).manifest;
    for (const target of files) {
      const mutated = files.map((f) => {
        if (f !== target) return f;
        const bytes = f.bytes.slice();
        bytes[0] = bytes[0]! ^ 1;
        return { ...f, bytes, sha256: sha(0xdead00 + bytes.length) };
      });
      const store = createSourceStore(mutated, async () => pagesAssetHash);
      const workers = await store.workerAssetIndex("units/api/public");
      expect(workers.filter((entry) => !baseWorkers.some((b) => b.hash === entry.hash))).toHaveLength(1);
      const pages = (await store.pagesManifest("units/api/public")).manifest;
      expect(Object.values(pages).filter((hash) => !Object.values(basePages).includes(hash))).toHaveLength(1);
    }
  });

  it("the path rules run before the cache is consulted (a path with a dot segment is refused even when its content was hashed before)", async () => {
    const good = file("site/ok.js", bytesOf(50, 2));
    const store = createSourceStore([good, sameContent("site/../evil.js", good)], async () => pagesAssetHash);
    await expect(store.workerAssetIndex("site")).rejects.toThrow();
  });

  it("a mutation of any one of 21 files changes exactly that file's hash and no other", async () => {
    const files = Array.from({ length: 21 }, (_, i) => file(`site/f${i}.${["js", "CSS", "html"][i % 3]}`, bytesOf(30 + i, i + 1)));
    const base = await createSourceStore(files, async () => pagesAssetHash).workerAssetIndex("site");
    const basePages = (await createSourceStore(files, async () => pagesAssetHash).pagesManifest("site")).manifest;
    for (const [i, target] of files.entries()) {
      const bytes = target.bytes.slice(); bytes[0] = bytes[0]! ^ 1;
      const mutated = files.map((f, j) => (j === i ? { ...f, bytes, sha256: sha(0xbeef00 + j) } : f));
      const store = createSourceStore(mutated, async () => pagesAssetHash);
      expect((await store.workerAssetIndex("site")).filter((e) => !base.some((b) => b.hash === e.hash))).toHaveLength(1);
      const pages = (await store.pagesManifest("site")).manifest;
      expect(Object.entries(pages).filter(([path, hash]) => basePages[path] !== hash).map(([path]) => path)).toEqual([`/f${i}.${["js", "CSS", "html"][i % 3]}`]);
    }
  });

  it("a different source starts with no cached hashes", async () => {
    const files = assets();
    const first = vi.fn(pagesAssetHash);
    await createSourceStore(files, async () => first).pagesManifest("units/api/public");
    const second = vi.fn(pagesAssetHash);
    await createSourceStore(files, async () => second).pagesManifest("units/api/public");
    expect(second.mock.calls.length).toBe(first.mock.calls.length);
  });

  it("loads the Pages hash engine only when a Pages unit is addressed", async () => {
    const load = vi.fn(async () => pagesAssetHash);
    const store = createSourceStore(assets(), load);
    await store.listFiles();
    await store.readFile("units/api/main.mjs");
    await store.workerAssetIndex("units/api/public");
    expect(load).not.toHaveBeenCalled();
    await store.pagesManifest("units/api/public");
    expect(load).toHaveBeenCalled();
  });

  it("serves only approved hashes and fails closed on an unknown one", async () => {
    const store = createSourceStore(assets(), async () => pagesAssetHash);
    const [known] = await store.workerAssetIndex("units/api/public");
    await expect(store.workerAssetFiles("units/api/public", [known!.hash, "f".repeat(32)])).rejects.toThrow("absent from the retained source");
    const files = await store.workerAssetFiles("units/api/public", [known!.hash]);
    expect(files).toHaveLength(1);
    expect(files[0]!.contentType).toBeTruthy();
    await expect(store.pagesFiles("units/api/public", ["f".repeat(32)])).rejects.toThrow("absent from the retained source");
  });

  it("Pages manifest equals buildPagesManifest and Pages control files stay refused", async () => {
    const files = assets();
    const store = createSourceStore(files, async () => pagesAssetHash);
    const refs = files.filter((f) => f.path.startsWith("units/api/public/")).map((f) => ({ path: f.path, size: f.size, sha256: f.sha256, bytes: f.bytes }));
    expect((await store.pagesManifest("units/api/public")).manifest).toEqual(buildPagesManifest(refs, "units/api/public"));
    const withControl = createSourceStore([...files, file("units/api/public/_headers", bytesOf(10, 5))], async () => pagesAssetHash);
    await expect(withControl.pagesManifest("units/api/public")).rejects.toThrow("control file");
  });
});
