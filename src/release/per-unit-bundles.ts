import { canonicalJson } from "../core/planning/digest.js";
import { normalizeWranglerV3 } from "../manifest/wrangler-v3.js";
import type { PrebuiltZipResult } from "./prebuilt-zip.js";
import { assetUploadHash } from "../cloudflare/assets/manifest.js";
import { pagesAssetHash, pagesControlFileAtRoot, toPagesAssetPath } from "../cloudflare/pages/manifest.js";
import { reachableEsmExports } from "./esm-exports.js";

export interface PerUnitBundle {
  unitId: string;
  wranglerPath: string;
  wranglerSha256: string;
  wranglerEffectiveHash: string;
  /** Normalized nonsecret server-parsed Wrangler material for the sealed proof. */
  canonicalWrangler: Record<string, unknown>;
  mainModule?: { path: string; sha256: string; size: number };
  modules: Array<{ path: string; sha256: string; size: number; mime: "application/javascript+module" | "application/wasm" }>;
  assets: Array<{ path: string; sha256: string; size: number; workersHash?: string; pagesHash?: string }>;
  bundleDigest: string;
}
export interface PerUnitBundlesResult { ok: boolean; units?: PerUnitBundle[]; combinedUnitRootDigest?: string; errors: string[] }

async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)) as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const dirname = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";

/** Builds all identities from verified ZIP bytes; no browser-supplied paths/hashes. */
export async function buildPerUnitBundles(zip: PrebuiltZipResult, options: { resourceOnlyUnitIds?: string[]; unitDeclarations?: Array<{ id: string; kind: "worker" | "pages" | "resources"; wrangler?: string }> } = {}): Promise<PerUnitBundlesResult> {
  if (!zip.ok || !zip.files || !zip.manifest) return { ok: false, errors: ["ZIP_NOT_VERIFIED"] };
  const byPath = new Map(zip.files.map((file) => [file.path, file]));
  const configs = zip.files.filter((file) => file.path.endsWith("wrangler.jsonc")).sort((a, b) => a.path.localeCompare(b.path));
  if (!configs.length) {
    const ids = options.resourceOnlyUnitIds ?? [];
    if (!ids.length || new Set(ids).size !== ids.length) return { ok: false, errors: ["NO_WRANGLER_CONFIG"] };
    // This narrow exception is only available to the server-derived config
    // projection: a resource-only release has no executable artifact.
    const units = await Promise.all([...ids].sort().map(async (unitId) => ({ unitId, wranglerPath: "", wranglerSha256: "", wranglerEffectiveHash: "", canonicalWrangler: {}, modules: [], assets: [], bundleDigest: await hash({ unitId, resourceOnly: true, archive: zip.manifest!.manifestDigest }) })));
    return { ok: true, units, combinedUnitRootDigest: await hash(units.map((unit) => ({ unitId: unit.unitId, bundleDigest: unit.bundleDigest }))), errors: [] };
  }
  const claimed = new Set<string>(); const units: PerUnitBundle[] = [];
  for (const file of configs) {
    let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes); } catch { return { ok: false, errors: [`INVALID_WRANGLER:${file.path}`] }; }
    const normalized = normalizeWranglerV3(text, { configPath: file.path });
    if (!normalized.ok || !normalized.config) return { ok: false, errors: [`INVALID_WRANGLER:${file.path}`] };
    const config = normalized.config; const main = config.main ? byPath.get(config.main) : undefined;
    if (config.kind === "worker" && !main) return { ok: false, errors: [`MAIN_MODULE_MISSING:${file.path}`] };
    const prefix = dirname(file.path);
    const assetDirectory = config.kind === "pages" ? config.pages_build_output_dir : config.assets?.directoryPath;
    const unitFiles = zip.files.filter((candidate) => candidate.path.startsWith(prefix) && candidate.path !== file.path);
    const assetFiles = unitFiles.filter((candidate) => assetDirectory !== undefined && candidate.path.startsWith(assetDirectory + "/"));
    const modules = unitFiles.filter((candidate) => !assetFiles.includes(candidate) && config.kind === "worker" && (candidate.path.endsWith(".mjs") || candidate.path.endsWith(".js") || candidate.path.endsWith(".wasm"))).map((candidate) => ({ path: candidate.path, sha256: candidate.sha256, size: candidate.size, mime: candidate.path.endsWith(".wasm") ? "application/wasm" as const : "application/javascript+module" as const })).sort((a, b) => a.path.localeCompare(b.path));
    for (const module of modules) { if (claimed.has(module.path)) return { ok: false, errors: [`CROSS_UNIT_PATH:${module.path}`] }; claimed.add(module.path); }
    if (main && !modules.some((module) => module.path === main.path)) return { ok: false, errors: [`MAIN_MODULE_OUTSIDE_UNIT:${file.path}`] };
    // Pages Functions material is detected at prepare, never silently
    // dropped. A `_worker.js` at the unit root is not a
    // module, not an asset and not in the sealed unit — without this check the
    // release would seal as a static site and deploy static-only while the
    // publisher shipped Functions. Same for a `functions/` source directory
    // anywhere in the unit (prebuilt releases cannot build it) and for a
    // `_worker.js` at the output root (which would otherwise fall through to
    // the generic static-asset control refusal with the wrong code). A nested
    // `dist/sub/_worker.js` stays a static file (only the roots are special).
    // DEFAULT path (B): explicit PAGES_FUNCTIONS_UNSUPPORTED before any
    // provider read or write: the sealed release never carries a Functions
    // bundle, so sealing a Functions release as static would be a lie.
    if (config.kind === "pages") {
      const distRoot = typeof assetDirectory === "string" && assetDirectory.length > 0 ? assetDirectory.replace(/\/+$/, "") : undefined;
      for (const candidate of unitFiles) {
        const atUnitRoot = prefix.length > 0 ? candidate.path.slice(prefix.length) : candidate.path;
        // Unit-root `_worker.js` and a `functions/`
        // source tree are invisible to the module/asset filters below; dist
        // roots are compared archive-relative, like the asset filter.
        if (
          atUnitRoot === "_worker.js" ||
          (distRoot !== undefined && candidate.path === `${distRoot}/_worker.js`) ||
          atUnitRoot === "functions" ||
          atUnitRoot.startsWith("functions/") ||
          (distRoot !== undefined && (candidate.path === `${distRoot}/functions` || candidate.path.startsWith(`${distRoot}/functions/`)))
        ) {
          return { ok: false, errors: [`PAGES_FUNCTIONS_UNSUPPORTED:${file.path}:${candidate.path}`] };
        }
      }
    }
    // a declared Workflow requires a Worker carrier and its declared
    // class must be provably exported by the entry module graph before the
    // release is sealed. An inconclusive scan (unrecognized export form,
    // bare/unresolvable re-export, non-UTF8 module) refuses exactly like a
    // missing class: the release must never be sealed with an unverifiable
    // WorkflowEntrypoint export.
    if (config.workflows.length > 0) {
      if (config.kind !== "worker") return { ok: false, errors: [`WORKFLOW_REQUIRES_WORKER:${file.path}`] };
      const sources = new Map<string, string>();
      for (const module of modules) {
        if (module.mime !== "application/javascript+module") continue;
        const bytes = byPath.get(module.path)?.bytes;
        try {
          sources.set(module.path, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          return { ok: false, errors: [`WORKFLOW_EXPORTS_UNVERIFIABLE:${file.path}`] };
        }
      }
      const reachable = reachableEsmExports(main!.path, sources);
      if (!reachable.ok) return { ok: false, errors: [`WORKFLOW_EXPORTS_UNVERIFIABLE:${file.path}`] };
      for (const workflow of config.workflows) {
        if (!reachable.names.has(workflow.class_name)) {
          return { ok: false, errors: [`WORKFLOW_CLASS_MISSING:${file.path}:${workflow.class_name}`] };
        }
      }
    }
    // a declared Durable Object requires a Worker carrier, and every
    // class it binds or migrates must be provably exported by the entry
    // module graph before the release is sealed (same scanner, same
    // fail-closed rule as workflows). Foreign script_name and environment
    // vetoes are plan-time checks in the carrier planner; prepare proves only
    // kind + export.
    {
      const doClasses = new Set<string>();
      for (const binding of config.durableObjects) doClasses.add(binding.class_name);
      for (const migration of config.migrations) {
        for (const className of [...(migration.new_classes ?? []), ...(migration.new_sqlite_classes ?? [])]) doClasses.add(className);
      }
      if (doClasses.size > 0) {
        if (config.kind !== "worker") return { ok: false, errors: [`DO_REQUIRES_WORKER:${file.path}`] };
        const sources = new Map<string, string>();
        for (const module of modules) {
          if (module.mime !== "application/javascript+module") continue;
          const bytes = byPath.get(module.path)?.bytes;
          try {
            sources.set(module.path, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          } catch {
            return { ok: false, errors: [`DO_EXPORTS_UNVERIFIABLE:${file.path}`] };
          }
        }
        const reachable = reachableEsmExports(main!.path, sources);
        if (!reachable.ok) return { ok: false, errors: [`DO_EXPORTS_UNVERIFIABLE:${file.path}`] };
        for (const className of [...doClasses].sort()) {
          if (!reachable.names.has(className)) {
            return { ok: false, errors: [`DO_CLASS_MISSING:${file.path}:${className}`] };
          }
        }
      }
    }
    // Platform bindings need a Worker: a static Pages release has no code to bind them to.
    if (config.kind !== "worker" && (config.hyperdrive.length > 0 || config.vectorize.length > 0 || config.secretsStoreSecrets.length > 0 || config.ai || config.browser)) {
      return { ok: false, errors: [`PLATFORM_BINDING_REQUIRES_WORKER:${file.path}`] };
    }
    if (assetFiles.some((asset) => config.kind === "pages" && pagesControlFileAtRoot(toPagesAssetPath(asset.path, assetDirectory)))) return { ok: false, errors: ["PAGES_CONTROL_FILE_UNSUPPORTED"] };
    const assets = await Promise.all(assetFiles.map(async (candidate) => ({ path: candidate.path, sha256: candidate.sha256, size: candidate.size, ...(config.kind === "pages" ? { pagesHash: pagesAssetHash(candidate.path, candidate.bytes) } : { workersHash: await assetUploadHash(candidate.path, candidate.bytes) }) })));
    assets.sort((a, b) => a.path.localeCompare(b.path));
    const declared = options.unitDeclarations?.filter((unit) => unit.wrangler === file.path);
    if (options.unitDeclarations?.length && (declared?.length !== 1 || declared[0]?.kind !== config.kind)) return { ok: false, errors: [`UNDECLARED_WRANGLER:${file.path}`] };
    const unitId = options.unitDeclarations === undefined ? config.name : options.unitDeclarations.length ? declared![0]!.id : "main";
    const material = { unitId, wranglerPath: file.path, wranglerSha256: file.sha256, config, main: main ? { path: main.path, sha256: main.sha256, size: main.size } : null, modules, assets };
    units.push({ unitId, wranglerPath: file.path, wranglerSha256: file.sha256, wranglerEffectiveHash: await hash(config), canonicalWrangler: config as unknown as Record<string, unknown>, ...(main ? { mainModule: { path: main.path, sha256: main.sha256, size: main.size } } : {}), modules, assets, bundleDigest: await hash(material) });
  }
  for (const unitId of [...(options.resourceOnlyUnitIds ?? [])].sort()) {
    if (units.some((unit) => unit.unitId === unitId)) {
      return { ok: false, errors: [`RESOURCE_UNIT_COLLIDES_WITH_WRANGLER:${unitId}`] };
    }
    units.push({ unitId, wranglerPath: "", wranglerSha256: "", wranglerEffectiveHash: "", canonicalWrangler: {}, modules: [], assets: [], bundleDigest: await hash({ unitId, resourceOnly: true, archive: zip.manifest.manifestDigest }) });
  }
  if (new Set(units.map((unit) => unit.unitId)).size !== units.length) return { ok: false, errors: ["DUPLICATE_UNIT_ID"] };
  return { ok: true, units, combinedUnitRootDigest: await hash(units.map((unit) => ({ unitId: unit.unitId, bundleDigest: unit.bundleDigest }))) , errors: [] };
}
