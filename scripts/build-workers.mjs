import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { replaceDirWithCopy } from "./lib/replace-dir.mjs";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist/workers");

await mkdir(dist, { recursive: true });

await build({
  entryPoints: [resolve(root, "src/runtime/workers.ts")],
  outfile: resolve(dist, "worker.mjs"),
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "esm",
  sourcemap: false,
  external: ["__STATIC_ASSETS__", "__STATIC_ASSETS_MANIFEST__"],
});

await replaceDirWithCopy(resolve(root, "dist/web"), resolve(dist, "assets"));

console.log("[build:workers] worker.mjs + assets/ -> dist/workers");
