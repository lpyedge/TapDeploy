import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { replaceDirWithCopy } from "./lib/replace-dir.mjs";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist/node");

await mkdir(dist, { recursive: true });

await build({
  entryPoints: [resolve(root, "src/runtime/node.ts")],
  outfile: resolve(dist, "server.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: false,
  packages: "external",
});

// Replace only this build's generated static directory; never retain stale
// chunks/private canaries from a previous build in the served package.
await replaceDirWithCopy(resolve(root, "dist/web"), resolve(dist, "public"));

console.log("[build:node] server.mjs + public/ -> dist/node");
