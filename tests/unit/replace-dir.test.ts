// dist/node/public and dist/workers/assets are replaced without a half-copied
// state and without leaving stale files or staging directories behind.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type ReplaceDirWithCopy = (source: string, target: string) => Promise<void>;
const modulePath = new URL("../../scripts/lib/replace-dir.mjs", import.meta.url).href;
const { replaceDirWithCopy } = (await import(/* @vite-ignore */ modulePath)) as { replaceDirWithCopy: ReplaceDirWithCopy };

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tapdeploy-replace-"));
  mkdirSync(join(root, "web", "assets"), { recursive: true });
  writeFileSync(join(root, "web", "index.html"), "new");
  writeFileSync(join(root, "web", "assets", "app.js"), "new-js");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("replaceDirWithCopy", () => {
  it("creates the target when it does not exist", async () => {
    await replaceDirWithCopy(join(root, "web"), join(root, "dist", "public"));
    expect(readFileSync(join(root, "dist", "public", "assets", "app.js"), "utf8")).toBe("new-js");
  });

  it("drops stale files from the previous build and leaves no staging directories", async () => {
    mkdirSync(join(root, "dist", "public"), { recursive: true });
    writeFileSync(join(root, "dist", "public", "stale-chunk.js"), "old");
    writeFileSync(join(root, "dist", "public", "index.html"), "old");
    await replaceDirWithCopy(join(root, "web"), join(root, "dist", "public"));
    expect(existsSync(join(root, "dist", "public", "stale-chunk.js"))).toBe(false);
    expect(readFileSync(join(root, "dist", "public", "index.html"), "utf8")).toBe("new");
    expect(readdirSync(join(root, "dist"))).toEqual(["public"]);
  });

  it("overlapping calls (same pid, so colliding staging names may fail) still end with a complete tree", async () => {
    await Promise.all([1, 2, 3].map(() => replaceDirWithCopy(join(root, "web"), join(root, "dist", "public")).catch(() => undefined)));
    await replaceDirWithCopy(join(root, "web"), join(root, "dist", "public"));
    expect(readdirSync(join(root, "dist", "public")).sort()).toEqual(["assets", "index.html"]);
    expect(readdirSync(join(root, "dist")).filter((name) => name !== "public")).toEqual([]);
  });
});
