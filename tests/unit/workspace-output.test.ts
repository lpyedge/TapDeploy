// Regenerable tool output lives under temp/, and Wrangler's local state is
// moved there byte-for-byte (never deleted) by scripts/ensure-wrangler-link.mjs.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import playwrightConfig from "../../playwright.config.js";
import vitestConfig from "../../vitest.config.js";

type EnsureWranglerLink = (options: { root: string }) => "linked" | "created" | "migrated";
const modulePath = new URL("../../scripts/ensure-wrangler-link.mjs", import.meta.url).href;
const { ensureWranglerLink } = (await import(/* @vite-ignore */ modulePath)) as { ensureWranglerLink: EnsureWranglerLink };

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tapdeploy-wrangler-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("tool output locations", () => {
  it("sends Playwright artifacts, Vitest cache and JSON reports to temp/", () => {
    expect(playwrightConfig.outputDir).toBe("temp/playwright/results");
    expect(vitestConfig.cacheDir).toBe("temp/vite-cache");
    expect(vitestConfig.test?.outputFile).toEqual({ json: "temp/vitest/reports/output.json" });
  });

  // The workers-runtime contract test runs `wrangler deploy --dry-run`, which writes
  // .wrangler/tmp; after temp/ is deleted the root link dangles until it is repaired.
  it.each(["predev:workers", "pretest", "pretest:contracts", "pretest:e2e"])("%s repairs the managed .wrangler link before Wrangler runs", (hook) => {
    const scripts = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).scripts as Record<string, string>;
    expect(scripts[hook]).toContain("scripts/ensure-wrangler-link.mjs");
  });
});

describe("ensure-wrangler-link", () => {
  it("creates temp/wrangler and a relative .wrangler link when nothing exists", () => {
    expect(ensureWranglerLink({ root })).toBe("created");
    expect(lstatSync(join(root, ".wrangler")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, ".wrangler"))).toBe(join("temp", "wrangler"));
    expect(ensureWranglerLink({ root })).toBe("linked");
  });

  it("migrates a physical .wrangler with one rename, preserving every byte", () => {
    mkdirSync(join(root, ".wrangler", "state", "v3", "d1"), { recursive: true });
    mkdirSync(join(root, ".wrangler", "tmp"), { recursive: true });
    writeFileSync(join(root, ".wrangler", "state", "v3", "d1", "db.sqlite"), Buffer.from([0, 1, 2, 250, 251]));
    expect(ensureWranglerLink({ root })).toBe("migrated");
    expect(lstatSync(join(root, ".wrangler")).isSymbolicLink()).toBe(true);
    expect([...readFileSync(join(root, "temp", "wrangler", "state", "v3", "d1", "db.sqlite"))]).toEqual([0, 1, 2, 250, 251]);
    expect(existsSync(join(root, ".wrangler", "tmp"))).toBe(true);
  });

  it("recreates temp/wrangler behind a .wrangler link left dangling by deleting temp/", () => {
    expect(ensureWranglerLink({ root })).toBe("created");
    rmSync(join(root, "temp"), { recursive: true, force: true });
    expect(existsSync(join(root, ".wrangler", "tmp"))).toBe(false);
    expect(ensureWranglerLink({ root })).toBe("linked");
    expect(existsSync(join(root, "temp", "wrangler"))).toBe(true);
  });

  it("refuses to merge when both a physical .wrangler and temp/wrangler exist", () => {
    mkdirSync(join(root, ".wrangler"));
    mkdirSync(join(root, "temp", "wrangler"), { recursive: true });
    expect(() => ensureWranglerLink({ root })).toThrow(/refusing to merge/);
    expect(lstatSync(join(root, ".wrangler")).isDirectory()).toBe(true);
  });

  it("refuses a .wrangler symlink that points anywhere else", () => {
    symlinkSync("/etc", join(root, ".wrangler"), "dir");
    expect(() => ensureWranglerLink({ root })).toThrow(/refusing to touch/);
    expect(readlinkSync(join(root, ".wrangler"))).toBe("/etc");
  });
});
