
// The immutable identity of one deployable unit (Worker or Pages): the verified
// modules, assets and normalized Wrangler config, bound by `bundleDigest`.
// `release/per-unit-bundles.ts` builds it from the verified ZIP; the plan seals
// it into the approval and every deploy step re-verifies the bytes against it.
// Nothing declared by the archive is trusted: sizes and SHA-256 are recomputed
// from the raw extracted bytes.

type DeployBundleTargetKind = "workers" | "pages";
type DeployBundleModuleKind = "esm" | "wasm";

export interface DeployBundleModule {
  /** Canonical ZIP-relative module name (also the multipart part name). */
  name: string;
  kind: DeployBundleModuleKind;
  mime: string;
  size: number;
  sha256: string;
}

interface DeployBundleAsset {
  /** Canonical ZIP-relative asset path (serving path is derived from it). */
  path: string;
  size: number;
  sha256: string;
}

interface DeployBundleSource {
  archiveBytes: number;
  archiveSha256: string;
  manifestDigest: string;
}

export interface DeployBundle {
  schemaVersion: 1;
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
