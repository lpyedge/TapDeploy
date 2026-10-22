// scripts/ensure-dev-deps.mjs keeps node_modules disposable without ever
// touching a dependency tree it does not own. The installer is injected, so
// these tests need no network and no npm.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type Outcome = "physical" | "ready" | "installed";
type EnsureDevDeps = (options: { root: string; force?: boolean; verifyOnly?: boolean; runInstall?: (root: string) => number }) => Outcome;

const modulePath = new URL("../../scripts/ensure-dev-deps.mjs", import.meta.url).href;
const { ensureDevDeps } = (await import(/* @vite-ignore */ modulePath)) as { ensureDevDeps: EnsureDevDeps };

let root: string;

// A stand-in for `npm ci --prefix temp/deps`: it creates what npm would.
function fakeInstall(calls: string[], status = 0) {
  return (installRoot: string) => {
    calls.push(installRoot);
    if (status === 0) {
      mkdirSync(join(installRoot, "temp", "deps", "node_modules"), { recursive: true });
      writeFileSync(join(installRoot, "temp", "deps", "node_modules", ".package-lock.json"), "{}");
    }
    return status;
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tapdeploy-deps-"));
  writeFileSync(join(root, "package.json"), '{"name":"x"}');
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ensure-dev-deps", () => {
  it("leaves a physical node_modules completely alone", () => {
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", ".package-lock.json"), "{}");
    const calls: string[] = [];
    expect(ensureDevDeps({ root, runInstall: fakeInstall(calls) })).toBe("physical");
    expect(calls).toEqual([]);
    expect(existsSync(join(root, "temp"))).toBe(false);
    expect(lstatSync(join(root, "node_modules")).isSymbolicLink()).toBe(false);
  });

  it("refuses an incomplete physical node_modules instead of replacing it", () => {
    mkdirSync(join(root, "node_modules"));
    expect(() => ensureDevDeps({ root, runInstall: fakeInstall([]) })).toThrow(/incomplete install/);
    expect(lstatSync(join(root, "node_modules")).isDirectory()).toBe(true);
  });

  it("refuses a node_modules symlink that points anywhere else", () => {
    symlinkSync("/etc", join(root, "node_modules"), "dir");
    const calls: string[] = [];
    expect(() => ensureDevDeps({ root, runInstall: fakeInstall(calls) })).toThrow(/refusing to touch/);
    expect(calls).toEqual([]);
    expect(readlinkSync(join(root, "node_modules"))).toBe("/etc");
  });

  it("cold start: mirrors the manifest and lock byte-for-byte, installs into temp/deps and links the root", () => {
    const calls: string[] = [];
    expect(ensureDevDeps({ root, runInstall: fakeInstall(calls) })).toBe("installed");
    expect(calls).toEqual([root]);
    expect(readFileSync(join(root, "temp", "deps", "package.json"), "utf8")).toBe('{"name":"x"}');
    expect(readFileSync(join(root, "temp", "deps", "package-lock.json"), "utf8")).toBe('{"lockfileVersion":3}');
    expect(lstatSync(join(root, "node_modules")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, "node_modules"))).toBe(join("temp", "deps", "node_modules"));
    expect(existsSync(join(root, "node_modules", ".package-lock.json"))).toBe(true);
  });

  it("is idempotent: a second run with an unchanged lock does not reinstall", () => {
    const calls: string[] = [];
    ensureDevDeps({ root, runInstall: fakeInstall(calls) });
    expect(ensureDevDeps({ root, runInstall: fakeInstall(calls) })).toBe("ready");
    expect(calls).toHaveLength(1);
  });

  it("reinstalls when the lock changes, and when temp was deleted (dangling link repaired)", () => {
    const calls: string[] = [];
    ensureDevDeps({ root, runInstall: fakeInstall(calls) });
    writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3,"changed":true}');
    expect(ensureDevDeps({ root, runInstall: fakeInstall(calls) })).toBe("installed");
    expect(calls).toHaveLength(2);
    rmSync(join(root, "temp"), { recursive: true, force: true });
    expect(existsSync(join(root, "node_modules", ".package-lock.json"))).toBe(false);
    expect(ensureDevDeps({ root, runInstall: fakeInstall(calls) })).toBe("installed");
    expect(calls).toHaveLength(3);
    expect(existsSync(join(root, "node_modules", ".package-lock.json"))).toBe(true);
  });

  it("force reinstalls even when the stamp matches", () => {
    const calls: string[] = [];
    ensureDevDeps({ root, runInstall: fakeInstall(calls) });
    expect(ensureDevDeps({ root, force: true, runInstall: fakeInstall(calls) })).toBe("installed");
    expect(calls).toHaveLength(2);
  });

  it("a failed install throws, writes no stamp and creates no link", () => {
    expect(() => ensureDevDeps({ root, runInstall: fakeInstall([], 7) })).toThrow(/exit code 7/);
    expect(existsSync(join(root, "temp", "deps", ".deps-stamp"))).toBe(false);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
  });

  it("verify never installs or links", () => {
    const calls: string[] = [];
    expect(() => ensureDevDeps({ root, verifyOnly: true, runInstall: fakeInstall(calls) })).toThrow(/missing or stale/);
    expect(calls).toEqual([]);
    expect(existsSync(join(root, "temp"))).toBe(false);
    ensureDevDeps({ root, runInstall: fakeInstall(calls) });
    expect(ensureDevDeps({ root, verifyOnly: true, runInstall: fakeInstall(calls) })).toBe("ready");
    expect(calls).toHaveLength(1);
  });
});
