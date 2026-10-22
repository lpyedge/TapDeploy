import { canonicalJson } from "../core/planning/digest.js";
import {
  normalizeWranglerV3,
  type WranglerV3Config,
} from "../manifest/wrangler-v3.js";
import {
  computePrebuiltManifestDigest,
  type PrebuiltZipEntry,
  type PrebuiltZipFile,
  type PrebuiltZipResult,
} from "./prebuilt-zip.js";

// ---------------------------------------------------------------------------
// immutable DeployBundle built from a verified V3 release ZIP plus
// the normalized final Wrangler config.
//
// The bundle is the SINGLE identity a plan approves and every deploy step
// re-verifies. Rules:
//
//   - Nothing declared by the archive is trusted: every module/asset/config
//     file's size and SHA-256 are recomputed here from the raw extracted bytes,
//     and the manifest digest is recomputed over that entry list.
//   - Module layout comes from the EFFECTIVE Wrangler config, never from file
//     extensions alone: `main` names the entry ESM module, remaining `.js`/
//     `.mjs` files outside `assets.directory` are additional ESM modules, and
//     `.wasm` files are CompiledWasm modules. Anything else fails closed.
//   - Canonical module names are the ZIP-relative paths (sorted), so relative
//     imports inside the built entry keep resolving; MIME stays
//     `application/javascript+module` for ESM and `application/wasm` for wasm.
//     The wasm bytes are never routed through TextDecoder.
//   - `wranglerEffectiveHash` is the canonical hash of the normalized config:
//     comment/whitespace edits do not change it, while any semantic change does.
//     The un-normalized config file is also bound byte-exactly via its own
//     sha256 and the source manifest digest.
//   - `bundleDigest` binds the whole identity, so swapping two modules, mutating
//     one byte, injecting an asset or editing the config all change it. Plan
//     approval and deploy steps share this digest, never per-file hashes that a
//     caller supplied.
//   - A multi-unit ZIP (more than one wrangler config) is refused here; that
//     layout is a later task. Single-unit only, fail closed otherwise.
// ---------------------------------------------------------------------------

const BUNDLE_SCHEMA_VERSION = 1;

// Official Worker module part MIME types: built ESM stays JavaScript (never
// re-parsed text) and CompiledWasm is uploaded as the binary `application/wasm`
// part, exactly as the provider multipart API expects.
export const JS_MODULE_MIME = "application/javascript+module";
export const WASM_MODULE_MIME = "application/wasm";

export type DeployBundleTargetKind = "workers" | "pages";
export type DeployBundleModuleKind = "esm" | "wasm";

export interface DeployBundleModule {
  /** Canonical ZIP-relative module name (also the multipart part name). */
  name: string;
  kind: DeployBundleModuleKind;
  mime: string;
  size: number;
  sha256: string;
}

export interface DeployBundleAsset {
  /** Canonical ZIP-relative asset path (serving path is derived from it). */
  path: string;
  size: number;
  sha256: string;
}

export interface DeployBundleSource {
  archiveBytes: number;
  archiveSha256: string;
  manifestDigest: string;
}

export interface DeployBundle {
  schemaVersion: typeof BUNDLE_SCHEMA_VERSION;
  appName: string;
  targetKind: DeployBundleTargetKind;
  /** Canonical name of the entry ESM module (workers only). */
  mainModule?: string;
  /** Normalized assets directory the assets belong to (workers/pages). */
  assetsDirectory?: string;
  /** Sorted by `name`. */
  modules: DeployBundleModule[];
  /** Sorted by `path`. */
  assets: DeployBundleAsset[];
  config: { path: string; size: number; sha256: string };
  source: DeployBundleSource;
  wranglerEffectiveHash: string;
  /** Binds every field above; the plan/step shared identity. */
  bundleDigest: string;
}

export type DeployBundleIssueCode =
  | "ZIP_NOT_VERIFIED"
  | "MULTI_UNIT_NOT_SUPPORTED"
  | "WRANGLER_CONFIG_INVALID"
  | "MAIN_MODULE_MISSING"
  | "UNCLASSIFIED_FILE"
  | "HASH_MISMATCH";

export interface DeployBundleIssue {
  code: DeployBundleIssueCode;
  detail: string;
}

export interface DeployBundleResult {
  ok: boolean;
  bundle?: DeployBundle;
  issues: DeployBundleIssue[];
}

const ESM_EXTENSIONS = new Set([".js", ".mjs"]);

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extensionOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    data as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fail(code: DeployBundleIssueCode, detail: string): DeployBundleResult {
  return { ok: false, issues: [{ code, detail }] };
}

export async function buildDeployBundle(
  zip: PrebuiltZipResult,
): Promise<DeployBundleResult> {
  if (!zip.ok || !zip.files || !zip.manifest) {
    return fail(
      "ZIP_NOT_VERIFIED",
      "the ZIP extraction result is not a verified archive; refusing to build a bundle from unverified files",
    );
  }
  const manifest = zip.manifest;
  const files = [...zip.files].sort((a, b) => (a.path < b.path ? -1 : 1));

  // Never trust declared hashes/sizes: recompute each file from its raw bytes.
  const issues: DeployBundleIssue[] = [];
  const entries: PrebuiltZipEntry[] = [];
  const checked = new Map<string, { size: number; sha256: string; file: PrebuiltZipFile }>();
  for (const file of files) {
    const size = file.bytes.length;
    const sha256 = await sha256Hex(file.bytes);
    if (size !== file.size || sha256 !== file.sha256) {
      issues.push({
        code: "HASH_MISMATCH",
        detail: `"${file.path}" does not match its declared size/SHA-256 (declared ${file.size} bytes / ${file.sha256.slice(0, 12)}…, actual ${size} bytes / ${sha256.slice(0, 12)}…)`,
      });
      continue;
    }
    checked.set(file.path, { size, sha256, file });
    entries.push({ path: file.path, size, sha256, kind: file.kind });
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const recomputedManifestDigest = await computePrebuiltManifestDigest(
    manifest.archiveSha256,
    entries,
  );
  if (recomputedManifestDigest !== manifest.manifestDigest) {
    return fail(
      "HASH_MISMATCH",
      "the ZIP manifest digest does not match the recomputed entry list; refusing to trust the archive descriptor",
    );
  }

  // ---- effective config ------------------------------------------------------
  const wranglerPaths = [...checked.keys()]
    .filter((path) => basename(path) === "wrangler.jsonc")
    .sort();
  if (wranglerPaths.length === 0) {
    return fail("ZIP_NOT_VERIFIED", "no wrangler.jsonc found in the verified ZIP");
  }
  if (wranglerPaths.length > 1) {
    return fail(
      "MULTI_UNIT_NOT_SUPPORTED",
      `multiple wrangler configs found (${wranglerPaths.join(", ")}); multi-unit release ZIPs are not implemented by the V3 pipeline yet`,
    );
  }
  const configPath = wranglerPaths[0]!;
  const configEntry = checked.get(configPath)!;

  let configSource: string;
  try {
    configSource = new TextDecoder("utf-8", { fatal: true }).decode(
      configEntry.file.bytes,
    );
  } catch {
    return fail(
      "WRANGLER_CONFIG_INVALID",
      `"${configPath}" is not valid UTF-8 text`,
    );
  }
  const normalized = normalizeWranglerV3(configSource, { configPath });
  if (!normalized.ok || !normalized.config) {
    const first = normalized.issues[0];
    return fail(
      "WRANGLER_CONFIG_INVALID",
      first
        ? `wrangler config is invalid: ${first.code} (${first.field}) — ${first.detail}`
        : "wrangler config is invalid",
    );
  }
  const wc: WranglerV3Config = normalized.config;

  // ---- classification --------------------------------------------------------
  const assetsDirectory =
    wc.kind === "pages" ? wc.pages_build_output_dir : wc.assets?.directoryPath;
  const modules: DeployBundleModule[] = [];
  const assets: DeployBundleAsset[] = [];
  const unclassified: string[] = [];
  for (const [path, entry] of checked) {
    if (path === configPath) {
      continue;
    }
    if (assetsDirectory !== undefined && path.startsWith(assetsDirectory + "/")) {
      assets.push({ path, size: entry.size, sha256: entry.sha256 });
      continue;
    }
    if (wc.kind === "worker") {
      const ext = extensionOf(path);
      if (ESM_EXTENSIONS.has(ext)) {
        modules.push({
          name: path,
          kind: "esm",
          mime: JS_MODULE_MIME,
          size: entry.size,
          sha256: entry.sha256,
        });
        continue;
      }
      if (ext === ".wasm") {
        modules.push({
          name: path,
          kind: "wasm",
          mime: WASM_MODULE_MIME,
          size: entry.size,
          sha256: entry.sha256,
        });
        continue;
      }
    }
    unclassified.push(path);
  }
  if (unclassified.length > 0) {
    return fail(
      "UNCLASSIFIED_FILE",
      `release ZIP carries files that are neither modules, assets, nor the wrangler config: ${unclassified.join(", ")}`,
    );
  }

  let mainModule: string | undefined;
  if (wc.kind === "worker") {
    mainModule = wc.main;
    if (!mainModule || !modules.some((m) => m.name === mainModule)) {
      return fail(
        "MAIN_MODULE_MISSING",
        `wrangler main "${mainModule ?? "(missing)"}" is not an ESM module part in the ZIP${
          mainModule !== undefined &&
          assetsDirectory !== undefined &&
          mainModule.startsWith(assetsDirectory + "/")
            ? " (it lies inside assets.directory)"
            : ""
        }`,
      );
    }
  }

  modules.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  assets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // ---- identity --------------------------------------------------------------
  const wranglerEffectiveHash = await sha256Hex(
    new TextEncoder().encode(canonicalJson(wc)),
  );
  const targetKind: DeployBundleTargetKind =
    wc.kind === "pages" ? "pages" : "workers";

  const identity = {
    appName: wc.name,
    targetKind,
    mainModule: mainModule ?? null,
    assetsDirectory: assetsDirectory ?? null,
    modules: modules.map((m) => [m.name, m.kind, m.mime, m.size, m.sha256]),
    assets: assets.map((a) => [a.path, a.size, a.sha256]),
    config: [configPath, configEntry.size, configEntry.sha256],
    source: [
      manifest.archiveBytes,
      manifest.archiveSha256,
      manifest.manifestDigest,
    ],
    wranglerEffectiveHash,
  };
  const bundleDigest = await sha256Hex(
    new TextEncoder().encode(canonicalJson(identity)),
  );

  const bundle: DeployBundle = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    appName: wc.name,
    targetKind,
    ...(mainModule !== undefined ? { mainModule } : {}),
    ...(assetsDirectory !== undefined ? { assetsDirectory } : {}),
    modules,
    assets,
    config: { path: configPath, size: configEntry.size, sha256: configEntry.sha256 },
    source: {
      archiveBytes: manifest.archiveBytes,
      archiveSha256: manifest.archiveSha256,
      manifestDigest: manifest.manifestDigest,
    },
    wranglerEffectiveHash,
    bundleDigest,
  };
  return { ok: true, bundle, issues: [] };
}

export interface DeployBundleModulePart {
  name: string;
  kind: DeployBundleModuleKind;
  mime: string;
  size: number;
  sha256: string;
  /** Raw binary bytes, exactly as extracted (wasm is never text-decoded). */
  bytes: Uint8Array;
}

// Collect the raw module parts of an approved bundle from the verified ZIP
// files, re-checking every part against the bundle identity before it may be
// uploaded. Returns the parts in canonical (sorted) order with their MIME
// types; any drift refuses the whole set instead of uploading anything.
export async function collectDeployBundleParts(
  bundle: DeployBundle,
  files: ReadonlyArray<PrebuiltZipFile>,
): Promise<{ ok: boolean; parts: DeployBundleModulePart[]; errors: string[] }> {
  const errors: string[] = [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const parts: DeployBundleModulePart[] = [];
  for (const module of bundle.modules) {
    const file = byPath.get(module.name);
    if (!file) {
      errors.push(
        `MISSING_MODULE: "${module.name}" is not present in the verified ZIP files`,
      );
      continue;
    }
    const size = file.bytes.length;
    const sha256 = await sha256Hex(file.bytes);
    if (size !== module.size || sha256 !== module.sha256) {
      errors.push(
        `HASH_DRIFT: "${module.name}" bytes do not match the approved bundle (size ${size}/${module.size}, sha ${sha256.slice(0, 8)}…/${module.sha256.slice(0, 8)}…)`,
      );
      continue;
    }
    parts.push({
      name: module.name,
      kind: module.kind,
      mime: module.mime,
      size,
      sha256,
      bytes: file.bytes,
    });
  }
  return { ok: errors.length === 0, parts, errors };
}
