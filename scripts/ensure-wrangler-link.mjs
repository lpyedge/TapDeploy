#!/usr/bin/env node
// Keeps Wrangler's local state out of the repository root: `.wrangler` becomes a
// relative symlink to the disposable temp/wrangler (simulator state/ and tmp/
// bundles). `--persist-to` alone cannot do this, it leaves `.wrangler/tmp` behind.
// A physical `.wrangler` is migrated with a single rename, so its bytes (the
// simulator data) are preserved; it is never deleted. Node stdlib only.

import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LINK_TARGET = join("temp", "wrangler");

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Returns "linked" (already managed), "created" or "migrated". Throws on anything ambiguous. */
export function ensureWranglerLink({ root }) {
  const link = join(root, ".wrangler");
  const dest = join(root, LINK_TARGET);
  const existing = lstatOrNull(link);

  if (existing?.isSymbolicLink()) {
    if (readlinkSync(link) !== LINK_TARGET) throw new Error(`.wrangler is a symlink to "${readlinkSync(link)}", not the managed ${LINK_TARGET}; refusing to touch it`);
    mkdirSync(dest, { recursive: true });
    return "linked";
  }
  if (existing && !existing.isDirectory()) throw new Error(".wrangler exists but is not a directory; refusing to touch it");
  if (process.platform === "win32") throw new Error("the managed .wrangler link is not supported on Windows; pass --persist-to to wrangler instead");

  if (existing) {
    if (existsSync(dest)) throw new Error(`both .wrangler and ${LINK_TARGET} exist; refusing to merge simulator state`);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(link, dest);
    symlinkSync(LINK_TARGET, link, "dir");
    return "migrated";
  }
  mkdirSync(dest, { recursive: true });
  symlinkSync(LINK_TARGET, link, "dir");
  return "created";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const outcome = ensureWranglerLink({ root: resolve(dirname(fileURLToPath(import.meta.url)), "..") });
    if (outcome === "migrated") console.log("[wrangler] moved .wrangler to temp/wrangler and linked it");
  } catch (error) {
    console.error(`[wrangler] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
