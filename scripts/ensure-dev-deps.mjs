#!/usr/bin/env node
// Keeps the development dependency tree disposable.
//
//   ensure   (default) make node_modules usable; reinstall only when needed
//   install  reinstall into temp/deps even if the stamp matches
//   verify   exit non-zero unless node_modules is usable (never installs)
//
// Managed layout: package.json + package-lock.json are mirrored byte-for-byte
// into temp/deps, `npm ci --prefix temp/deps` fills temp/deps/node_modules, and
// the root `node_modules` is a relative symlink to it so Node/tsc/eslint/vite
// resolve packages normally (NODE_PATH cannot do that for ESM).
// A physical root node_modules (hand or container installed) is never touched.
// Node stdlib only: this must run before any dependency exists.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_NODE_MAJOR = 24;
const LINK_TARGET = join("temp", "deps", "node_modules");

function sha256(...files) {
  const hash = createHash("sha256");
  for (const file of files) hash.update(readFileSync(file));
  return hash.digest("hex");
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function npmCi(root) {
  const depsDir = join(root, "temp", "deps");
  const result = spawnSync("npm", ["ci", "--prefix", depsDir, "--cache", join(root, "temp", "npm-cache")], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return result.status ?? 1;
}

/**
 * Returns "physical" (left alone), "ready" or "installed". Throws on anything
 * it must not guess about. `runInstall(root)` returns the installer exit code.
 */
export function ensureDevDeps({ root, force = false, verifyOnly = false, runInstall = npmCi }) {
  const nodeModules = join(root, "node_modules");
  const existing = lstatOrNull(nodeModules);

  if (existing && !existing.isSymbolicLink()) {
    if (!existing.isDirectory()) throw new Error("node_modules exists but is not a directory; refusing to touch it");
    if (!existsSync(join(nodeModules, ".package-lock.json"))) {
      throw new Error("physical node_modules has no .package-lock.json (incomplete install); not managed by this script - run `npm ci` yourself or remove it");
    }
    return "physical";
  }
  if (existing && readlinkSync(nodeModules) !== LINK_TARGET) {
    throw new Error(`node_modules is a symlink to "${readlinkSync(nodeModules)}", not the managed ${LINK_TARGET}; refusing to touch it`);
  }

  const manifest = join(root, "package.json");
  const lock = join(root, "package-lock.json");
  const depsDir = join(root, "temp", "deps");
  const stampFile = join(depsDir, ".deps-stamp");
  const stamp = sha256(manifest, lock);
  const installed = existsSync(join(depsDir, "node_modules", ".package-lock.json"));
  const current = installed && existsSync(stampFile) && readFileSync(stampFile, "utf8").trim() === stamp;

  if (!current || force) {
    if (verifyOnly) throw new Error("temp/deps is missing or stale; run `npm run deps:install`");
    mkdirSync(depsDir, { recursive: true });
    copyFileSync(manifest, join(depsDir, "package.json"));
    copyFileSync(lock, join(depsDir, "package-lock.json"));
    if (existsSync(stampFile)) unlinkSync(stampFile);
    const status = runInstall(root);
    if (status !== 0) throw new Error(`npm ci failed with exit code ${status}`);
    writeFileSync(stampFile, `${stamp}\n`);
  }

  if (!existing) {
    if (verifyOnly) throw new Error("root node_modules link is missing; run `npm run deps:install`");
    if (process.platform === "win32") throw new Error("the managed node_modules link is not supported on Windows; run `npm ci` in the repository root instead");
    symlinkSync(LINK_TARGET, nodeModules, "dir");
  }
  return current && !force ? "ready" : "installed";
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const mode = process.argv[2] ?? "ensure";
  if (!["ensure", "install", "verify"].includes(mode)) {
    console.error(`[deps] unknown mode "${mode}" (ensure | install | verify)`);
    process.exit(2);
  }
  if (Number(process.versions.node.split(".")[0]) < MIN_NODE_MAJOR) {
    console.error(`[deps] Node >= ${MIN_NODE_MAJOR} is required (found ${process.versions.node})`);
    process.exit(1);
  }
  try {
    const outcome = ensureDevDeps({ root, force: mode === "install", verifyOnly: mode === "verify" });
    if (outcome === "installed") console.log("[deps] installed into temp/deps");
  } catch (error) {
    console.error(`[deps] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
