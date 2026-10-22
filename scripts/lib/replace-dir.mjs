// Replace `target` with a copy of `source` so that a concurrent reader sees the
// old tree, the new tree, or (for an instant) no directory - never a half-copied
// one. Used for the served static directories inside dist/.
import { cp, rename, rm } from "node:fs/promises";

export async function replaceDirWithCopy(source, target) {
  const stage = `${target}.new-${process.pid}`;
  const old = `${target}.old-${process.pid}`;
  await rm(stage, { recursive: true, force: true });
  await cp(source, stage, { recursive: true });
  await rm(old, { recursive: true, force: true });
  try {
    await rename(target, old);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await rename(stage, target);
  await rm(old, { recursive: true, force: true });
}
